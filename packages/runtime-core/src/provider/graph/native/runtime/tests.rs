use super::*;
use hack_config_compiler::environment::EnvMetadata;
use std::{
    cell::{Cell, RefCell},
    os::unix::fs::{DirBuilderExt, symlink},
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

const OWNER: &str = "cccccccccccccccccccccccccccccccc";
const BOOT: &str = "12345678-abcd-abcd-abcd-123456789abc";
const RUN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
struct Fixture {
    root: PathBuf,
    project: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new(project: Value) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-consumer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let project_root = root.join("project");
        let home = root.join("home");
        for path in [&project_root, &project_root.join(".hack"), &home] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        fs::write(
            project_root.join(".hack/hack.project.json"),
            project.to_string(),
        )
        .unwrap();
        Self {
            root,
            project: project_root,
            candidate: Candidate::discover(&home).unwrap(),
        }
    }
    fn prepared(
        &self,
        metadata: Value,
        values: &crate::project::native::ManagedValues,
    ) -> selection::Prepared {
        let metadata: EnvMetadata = serde_json::from_value(json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":metadata,"inactive_scopes":[]})).unwrap();
        selection::select(
            &self.candidate,
            selection::Options {
                project: &self.project,
                branch: Some("fixture"),
                run: RUN,
                profiles: &[],
                explicit_overlay: None,
                metadata,
                deadline: Instant::now() + Duration::from_secs(60),
            },
        )
        .unwrap()
        .prepare(&self.candidate, values)
        .unwrap()
    }
    fn session(&self, prepared: selection::Prepared) -> (execution::Graph, Session<'_, Fake>) {
        let (selected, input) = prepared.into_parts(&self.candidate).unwrap();
        let mut config = configuration(&input, OWNER).unwrap();
        for value in config.configs.values_mut() {
            value["StopTimeout"] = json!(10);
        }
        let expected_environment = config
            .configs
            .iter()
            .map(|(name, config)| {
                (
                    name.clone(),
                    image_environment::compose(&Value::Null, &config["Env"]).unwrap(),
                )
            })
            .collect();
        let receipt = Receipt::preparing(&config, OWNER, BOOT).unwrap();
        let root = journal::reserve(&self.candidate, &receipt).unwrap();
        let (_, environments) = input.into_parts().unwrap();
        let backend = Fake {
            root: root.clone(),
            run: RUN.into(),
            state: RefCell::new(FakeState::default()),
        };
        (
            config.graph,
            Session {
                candidate: &self.candidate,
                startup_guard: None,
                selected,
                backend,
                root,
                receipt,
                configs: config.configs,
                expected_environment,
                environments,
            },
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn image() -> String {
    format!("sha256:{}", "d".repeat(64))
}
fn basic() -> Value {
    json!({"schema_version":1,"name":"fixture","services":{"web":{"image":image(),"command":{"exec":["/bin/echo","$EXACT"]}}}})
}

#[test]
fn foreground_guard_refuses_before_provider_connection_or_graph_reservation() {
    let fixture = Fixture::new(basic());
    let prepared = fixture.prepared(json!({"web":{}}), &BTreeMap::new());
    let guard = || Err(error("native_graph_canceled", "canceled"));
    assert_eq!(
        run_guarded(&fixture.candidate, prepared, Some(&guard), None)
            .unwrap_err()
            .code,
        "native_graph_canceled"
    );
    assert!(
        !fixture
            .candidate
            .state_root
            .join("run/native-graphs")
            .exists()
    );
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
}

#[test]
fn foreground_cancellation_after_network_creation_prevents_container_effects_and_replay() {
    let fixture = Fixture::new(basic());
    let prepared = fixture.prepared(json!({"web":{}}), &BTreeMap::new());
    let (graph, mut session) = fixture.session(prepared);
    let canceled = Rc::new(Cell::new(false));
    let check = canceled.clone();
    let guard = || {
        if check.get() {
            Err(error("native_graph_canceled", "canceled"))
        } else {
            Ok(())
        }
    };
    session.startup_guard = Some(&guard);
    session.backend.state.borrow_mut().cancel_after_network = Some(canceled.clone());
    assert_eq!(
        execution::run(&graph, &mut session, Duration::from_secs(1))
            .unwrap_err()
            .code,
        "native_graph_canceled"
    );
    assert_eq!(session.backend.state.borrow().effects, ["create:network"]);
    assert!(session.backend.state.borrow().containers.is_empty());
    let retained = session.backend.receipt();
    assert_eq!(retained.resources["network:default"].phase, "created");
    assert!(retained.resources["network:default"].id.is_some());
    canceled.set(false);
    assert!(execution::run(&graph, &mut session, Duration::from_secs(1)).is_err());
    assert_eq!(session.backend.state.borrow().effects, ["create:network"]);
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
    assert!(session.backend.state.borrow().networks.is_empty());
}

#[derive(Default)]
struct FakeState {
    containers: BTreeMap<String, Value>,
    networks: BTreeMap<String, Value>,
    effects: Vec<String>,
    stop_batches: usize,
    observed_phases: Vec<Phase>,
    fail_create: bool,
    fail_start: bool,
    fail_delete: bool,
    fail_stop: bool,
    fail_network_create: bool,
    fail_network_after_apply: bool,
    staged: Vec<String>,
    cancel_after_network: Option<Rc<Cell<bool>>>,
    cancel_after_stop: Option<Rc<Cell<bool>>>,
    cancel_after_delete: Option<Rc<Cell<bool>>>,
    cancel_on_delete_inspection: Option<Rc<Cell<bool>>>,
}
struct Fake {
    root: PathBuf,
    run: String,
    state: RefCell<FakeState>,
}
impl Fake {
    fn receipt(&self) -> Receipt {
        serde_json::from_slice(&fs::read(self.root.join("state.json")).unwrap()).unwrap()
    }
}
impl Backend for Fake {
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        let mut state = self.state.borrow_mut();
        state.observed_phases.push(self.receipt().phase);
        if method == Method::GET && path.starts_with("/v1.53/networks/") {
            let selected = path.strip_prefix("/v1.53/networks/").unwrap();
            return state
                .networks
                .values()
                .find(|value| value["Id"] == selected || value["Name"] == selected)
                .cloned()
                .ok_or_else(|| error("engine_not_found", "absent"));
        }
        if method == Method::POST && path == "/v1.53/networks/create" {
            let receipt = self.receipt();
            let resource = &receipt.resources["network:default"];
            assert_eq!(resource.phase, "create-intent");
            assert!(resource.id.is_none());
            assert_eq!(receipt.phase, Phase::Preparing);
            state.effects.push("create:network".into());
            if state.fail_network_create {
                return Err(error("fake_network_create_uncertain", "once"));
            }
            let body = body.unwrap();
            assert_eq!(body["Internal"], false);
            assert_eq!(body["Driver"], "bridge");
            let id = "e".repeat(64);
            let mut network = body.clone();
            network["Id"] = json!(id);
            network["Containers"] = json!({});
            if let Some(canceled) = &state.cancel_after_network {
                canceled.set(true);
            }
            state.networks.insert(resource.name.clone(), network);
            if state.fail_network_after_apply {
                return Err(error("fake_network_create_uncertain", "applied once"));
            }
            return Ok(json!({"Id":id}));
        }
        if method == Method::DELETE && path.starts_with("/v1.53/networks/") {
            let id = path.strip_prefix("/v1.53/networks/").unwrap();
            let receipt = self.receipt();
            assert_eq!(receipt.phase, Phase::RemovalIntent);
            let resource = &receipt.resources["network:default"];
            assert_eq!(resource.phase, "remove-intent");
            assert_eq!(resource.id.as_deref(), Some(id));
            assert!(state.containers.is_empty());
            assert!(
                state.networks[&resource.name]["Containers"]
                    .as_object()
                    .unwrap()
                    .is_empty()
            );
            state.effects.push("delete:network".into());
            state.networks.remove(&resource.name);
            return Ok(Value::Null);
        }
        if method == Method::GET {
            if self.receipt().phase == Phase::RemovalIntent
                && let Some(changed) = &state.cancel_on_delete_inspection
            {
                changed.set(true);
            }
            let name = path
                .strip_prefix("/v1.53/containers/")
                .unwrap()
                .strip_suffix("/json")
                .unwrap();
            return state
                .containers
                .values()
                .find(|value| {
                    value["Id"] == name
                        || value["Name"].as_str().unwrap().trim_start_matches('/') == name
                })
                .cloned()
                .ok_or_else(|| error("engine_not_found", "absent"));
        }
        if let Some(name) = path.strip_prefix("/v1.53/containers/create?name=") {
            assert_eq!(method, Method::POST);
            let receipt = self.receipt();
            assert_eq!(receipt.phase, Phase::Preparing);
            let resource = receipt
                .resources
                .values()
                .find(|resource| resource.name == name)
                .unwrap();
            assert_eq!(resource.phase, "create-intent");
            assert!(resource.id.is_none());
            state.effects.push(format!("create:{}", resource.key));
            if state.fail_create {
                return Err(error("fake_create_uncertain", "once"));
            }
            let config = body.unwrap();
            assert!(!config.to_string().contains("private-native-canary"));
            let id = format!("{:064x}", state.containers.len() + 1);
            let mut process = config.clone();
            process.as_object_mut().unwrap().remove("HostConfig");
            let network = &receipt.resources["network:default"];
            assert_eq!(network.phase, "created");
            assert_eq!(config["HostConfig"]["NetworkMode"], network.name);
            let aliases = &config["NetworkingConfig"]["EndpointsConfig"][&network.name]["Aliases"];
            assert_eq!(aliases, &json!([resource.key]));
            let value = json!({"Id":id,"Name":format!("/{name}"),"Image":config["Image"],"Config":process,"HostConfig":config["HostConfig"],"NetworkSettings":{"Networks":{network.name.clone():{"NetworkID":"","Aliases":aliases}}},"State":{"Running":false,"Status":"created","Pid":0,"ExitCode":0,"OOMKilled":false,"Dead":false,"Paused":false,"Restarting":false}});
            state.containers.insert(name.into(), value);
            return Ok(json!({"Id":id}));
        }
        if let Some(id) = path
            .strip_prefix("/v1.53/containers/")
            .and_then(|path| path.strip_suffix("/start"))
        {
            assert_eq!(method, Method::POST);
            let receipt = self.receipt();
            let resource = receipt
                .resources
                .values()
                .find(|resource| resource.id.as_deref() == Some(id))
                .unwrap();
            assert_eq!(resource.phase, "start-intent");
            state.effects.push(format!("start:{}", resource.key));
            if state.fail_start {
                return Err(error("fake_start_uncertain", "once"));
            }
            let value = state.containers.get_mut(&resource.name).unwrap();
            value["State"] = if resource.key == "z.seed" {
                json!({"Running":false,"Status":"exited","Pid":0,"ExitCode":0,"OOMKilled":false,"Dead":false,"Paused":false,"Restarting":false})
            } else {
                json!({"Running":true,"Status":"running","Pid":1,"ExitCode":0,"OOMKilled":false,"Dead":false,"Paused":false,"Restarting":false,"Health":{"Status":"healthy"}})
            };
            let network = &receipt.resources["network:default"];
            let endpoint = "f".repeat(64);
            let ip = "172.20.0.2";
            value["NetworkSettings"]["Networks"][&network.name]["NetworkID"] = json!(network.id);
            value["NetworkSettings"]["Networks"][&network.name]["EndpointID"] = json!(endpoint);
            value["NetworkSettings"]["Networks"][&network.name]["IPAddress"] = json!(ip);
            state.networks.get_mut(&network.name).unwrap()["Containers"][id] = json!({"Name":resource.name,"EndpointID":endpoint,"IPv4Address":format!("{ip}/16")});
            return Ok(Value::Null);
        }
        assert_eq!(method, Method::DELETE);
        let id = path.strip_prefix("/v1.53/containers/").unwrap();
        let receipt = self.receipt();
        assert_eq!(receipt.phase, Phase::RemovalIntent);
        let resource = receipt
            .resources
            .values()
            .find(|resource| resource.id.as_deref() == Some(id))
            .unwrap();
        assert_eq!(
            receipt.terminal[&format!("container:{}", resource.key)].id,
            id
        );
        assert_ne!(state.containers[&resource.name]["State"]["Running"], true);
        state.effects.push(format!("delete:{}", resource.key));
        if state.fail_delete {
            state.fail_delete = false;
            return Err(error("fake_delete_uncertain", "once"));
        }
        state.containers.remove(&resource.name);
        for network in state.networks.values_mut() {
            network["Containers"].as_object_mut().unwrap().remove(id);
        }
        if let Some(canceled) = &state.cancel_after_delete {
            canceled.set(true);
        }
        Ok(Value::Null)
    }
    fn stage(
        &mut self,
        pending: PendingEnvironment,
        binding: native_environment::Binding,
        _config: &mut Value,
    ) -> Result<(), CandidateError> {
        let receipt = self.receipt();
        assert_eq!(binding.review, receipt.review.review_id());
        assert_eq!(binding.run, self.run);
        let service = pending.service();
        assert_eq!(
            receipt.resources[&format!("container:{service}")].phase,
            "create-intent"
        );
        self.state.borrow_mut().staged.push(service.into());
        Ok(())
    }
    fn stop(
        &self,
        selected: &[(String, u64)],
        admitted: &BTreeMap<&str, &str>,
    ) -> Result<(), CandidateError> {
        assert_eq!(self.receipt().phase, Phase::StopIntent);
        let mut state = self.state.borrow_mut();
        state.stop_batches += 1;
        if state.fail_stop {
            return Err(super::super::super::shutdown::stop_error(
                crate::provider::engine::StopBatchFailure {
                    error: error("engine_protocol", "value-free stop refusal"),
                    failures: vec![crate::provider::engine::StopFailure {
                        id: selected[0].0.clone(),
                        stage: crate::error::StopFailureStage::Timeout,
                    }],
                },
                admitted,
            ));
        }
        for (id, timeout) in selected {
            assert_eq!(*timeout, 10);
            assert!(self.receipt().readiness.contains_key(admitted[id.as_str()]));
            let value = state
                .containers
                .values_mut()
                .find(|value| value["Id"] == *id)
                .unwrap();
            value["State"]["Running"] = json!(false);
            value["State"]["Pid"] = json!(0);
            value["State"]["Status"] = json!("exited");
            state.effects.push(format!("stop:{id}"));
        }
        if let Some(canceled) = &state.cancel_after_stop {
            canceled.set(true);
        }
        Ok(())
    }
}

#[test]
fn real_compiler_job_dependency_and_readiness_drive_durable_native_effects_and_cleanup() {
    let mut project = basic();
    project["services"]["web"]["depends_on"] = json!([{"job":"z.seed","condition":"completed"}]);
    project["services"]["web"]["readiness"] = json!({"kind":"exec","command":{"exec":["/bin/true"]},"interval":"1s","timeout":"100ms","retries":2});
    project["jobs"] = json!({"z.seed":{"image":image(),"command":{"exec":["/bin/echo","seed"]}}});
    let fixture = Fixture::new(project);
    let prepared = fixture.prepared(json!({"web":{},"z.seed":{}}), &BTreeMap::new());
    let (graph, mut session) = fixture.session(prepared);
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    assert_eq!(session.receipt.phase, Phase::ReadyObserved);
    assert_eq!(
        session.backend.state.borrow().effects,
        vec![
            "create:network",
            "create:z.seed",
            "start:z.seed",
            "create:web",
            "start:web"
        ]
    );
    assert_eq!(
        session.configs["web"]["Cmd"],
        json!(["/bin/echo", "$EXACT"])
    );
    let snapshot = snapshot(&session.backend, session.receipt.clone()).unwrap();
    assert_eq!(
        snapshot.observations["z.seed"],
        Some(Observation::Exited { code: 0 })
    );
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
    assert!(session.backend.state.borrow().containers.is_empty());
    assert!(session.backend.state.borrow().networks.is_empty());
    assert_eq!(
        session.backend.state.borrow().effects.last().unwrap(),
        "delete:network"
    );
    assert_eq!(session.receipt.terminal.len(), 2);
    assert!(journal::reserve(&fixture.candidate, &session.receipt).is_err());
}

#[test]
fn create_and_start_uncertainty_are_retained_once_without_replay_or_adoption() {
    for fail_start in [false, true] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        {
            let mut fake = session.backend.state.borrow_mut();
            fake.fail_create = !fail_start;
            fake.fail_start = fail_start;
        }
        assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
        let (retained, _) = journal::load(&fixture.candidate, RUN, OWNER, BOOT).unwrap();
        assert_eq!(retained.resources["container:web"].phase, "uncertain");
        assert_eq!(retained.resources["container:web"].id.is_some(), fail_start);
        let count = session.backend.state.borrow().effects.len();
        assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
        assert_eq!(session.backend.state.borrow().effects.len(), count);
    }
}

#[test]
fn project_network_create_uncertainty_is_durable_and_never_replayed() {
    for applied in [false, true] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        session.backend.state.borrow_mut().fail_network_create = !applied;
        session.backend.state.borrow_mut().fail_network_after_apply = applied;
        assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
        let (retained, _) = journal::load(&fixture.candidate, RUN, OWNER, BOOT).unwrap();
        assert_eq!(retained.resources["network:default"].phase, "create-intent");
        assert!(retained.resources["network:default"].id.is_none());
        assert_eq!(retained.resources["container:web"].phase, "reserved");
        assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
        assert_eq!(
            session.backend.state.borrow().effects,
            vec!["create:network"]
        );
        if applied {
            assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
            assert_eq!(
                session.backend.state.borrow().effects,
                vec!["create:network"]
            );
        }
    }
}

#[test]
fn foreign_or_changed_project_networks_refuse_cleanup_before_any_stop_or_delete() {
    for field in ["owner", "driver", "internal", "member"] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        let name = session.receipt.resources["network:default"].name.clone();
        {
            let mut state = session.backend.state.borrow_mut();
            let network = state.networks.get_mut(&name).unwrap();
            match field {
                "owner" => network["Labels"]["io.hack-local.owner"] = json!("d".repeat(32)),
                "driver" => network["Driver"] = json!("host"),
                "internal" => network["Internal"] = json!(true),
                "member" => network["Containers"]["a".repeat(64)] = json!({"Name":"foreign"}),
                _ => unreachable!(),
            }
        }
        let before = session.backend.state.borrow().effects.len();
        assert!(
            cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err(),
            "{field}"
        );
        assert_eq!(session.backend.state.borrow().effects.len(), before);
        assert!(
            snapshot(&session.backend, session.receipt.clone()).is_err(),
            "{field}"
        );
    }
}

#[test]
fn changed_network_ids_aliases_extra_attachments_and_endpoint_addresses_refuse_observation_and_admission()
 {
    for field in ["id", "alias", "extra", "endpoint", "address"] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        let name = session.receipt.resources["container:web"].name.clone();
        let network = session.receipt.resources["network:default"].name.clone();
        {
            let mut state = session.backend.state.borrow_mut();
            let container = state.containers.get_mut(&name).unwrap();
            let attached = &mut container["NetworkSettings"]["Networks"];
            match field {
                "id" => attached[&network]["NetworkID"] = json!("a".repeat(64)),
                "alias" => attached[&network]["Aliases"] = json!(["foreign"]),
                "extra" => attached["foreign"] = json!({}),
                "endpoint" => attached[&network]["EndpointID"] = json!("a".repeat(64)),
                "address" => attached[&network]["IPAddress"] = json!("172.20.0.99"),
                _ => unreachable!(),
            }
        }
        assert!(session.observe("web").is_err(), "{field}");
        assert!(
            snapshot(&session.backend, session.receipt.clone()).is_err(),
            "{field}"
        );
        let mut counted = 0;
        assert!(
            reservations_using(
                &fixture.candidate,
                OWNER,
                BOOT,
                true,
                |receipt, resource| inspected(&session.backend, receipt, resource),
                |_| {
                    counted += 1;
                    Ok(())
                }
            )
            .is_err(),
            "{field}"
        );
        assert_eq!(counted, 0);
        let before = session.backend.state.borrow().effects.len();
        assert!(
            cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err(),
            "{field}"
        );
        assert_eq!(session.backend.state.borrow().effects.len(), before);
    }
}

#[test]
fn authored_change_and_foreign_container_identity_refuse_before_effects() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    fs::write(fixture.project.join(".hack/hack.project.json"), "changed").unwrap();
    assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
    assert!(session.backend.state.borrow().effects.is_empty());

    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    let name = session.receipt.resources["container:web"].name.clone();
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&name)
        .unwrap()["Config"]["Labels"]["io.hack-local.input-kind"] = json!("compose");
    let count = session.backend.state.borrow().effects.len();
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    assert_eq!(session.backend.state.borrow().effects.len(), count);
}

#[test]
fn native_runtime_codec_rejects_version_owner_kind_alias_pending_and_private_fields() {
    let fixture = Fixture::new(basic());
    let (_, session) = fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    let path = session.root.join("state.json");
    let encoded = serde_json::to_value(&session.receipt).unwrap();
    for (field, value) in [
        ("version", json!(1)),
        ("kind", json!("native-graph-preparation")),
        ("owner", json!("e".repeat(32))),
        ("boot", json!("87654321-abcd-abcd-abcd-123456789abc")),
        ("values", json!("private-native-canary")),
    ] {
        let mut bad = encoded.clone();
        bad[field] = value;
        state::write(&path, &bad).unwrap();
        assert!(journal::load(&fixture.candidate, RUN, OWNER, BOOT).is_err());
    }
    journal::save(&session.root, &session.receipt).unwrap();
    state::write(&session.root.join("state.pending"), &encoded).unwrap();
    assert!(journal::load(&fixture.candidate, RUN, OWNER, BOOT).is_err());
    fs::remove_file(session.root.join("state.pending")).unwrap();
    fs::remove_file(&path).unwrap();
    symlink(fixture.project.join(".hack/hack.project.json"), &path).unwrap();
    assert!(journal::load(&fixture.candidate, RUN, OWNER, BOOT).is_err());
}

#[test]
fn native_reservations_count_against_the_common_budget_and_uncertainty_blocks_admission() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    for requested in [31, 32] {
        let mut budget = admission::Budget::default();
        for _ in 0..requested {
            budget
                .add(&json!({"HostConfig":{"Memory":0,"NanoCpus":0}}))
                .unwrap();
        }
        let result = reservations_using(
            &fixture.candidate,
            OWNER,
            BOOT,
            true,
            |receipt, resource| inspected(&session.backend, receipt, resource),
            |value| budget.add(value),
        );
        assert_eq!(result.is_ok(), requested == 31);
        if requested == 32 {
            assert_eq!(result.unwrap_err().code, "graph_capacity_reserved");
        }
    }
    session.receipt.phase = Phase::FailedRetained;
    journal::save(&session.root, &session.receipt).unwrap();
    let mut counted = 0;
    assert!(
        reservations_using(
            &fixture.candidate,
            OWNER,
            BOOT,
            true,
            |receipt, resource| inspected(&session.backend, receipt, resource),
            |_| {
                counted += 1;
                Ok(())
            }
        )
        .is_err()
    );
    assert_eq!(counted, 0);
}

#[cfg(feature = "environment-launcher")]
#[test]
fn private_native_input_crosses_typed_stage_intent_without_entering_public_journal_or_create() {
    let fixture = Fixture::new(basic());
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "private-native-canary".into())]),
    )]);
    let prepared = fixture.prepared(
        json!({"web":{"TOKEN":{"scope":"web","secret":true}}}),
        &values,
    );
    let (graph, mut session) = fixture.session(prepared);
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    assert_eq!(session.backend.state.borrow().staged, vec!["web"]);
    assert!(
        !fs::read_to_string(session.root.join("state.json"))
            .unwrap()
            .contains("private-native-canary")
    );
    assert!(
        !serde_json::to_string(&session.configs)
            .unwrap()
            .contains("private-native-canary")
    );
    let resource = &session.receipt.resources["container:web"];
    let binding = native_environment::Binding::new(&session.receipt.review, resource);
    assert!(
        super::super::environment_binding(&fixture.candidate, OWNER, BOOT, &binding, "web", true)
            .is_err()
    );
    session.receipt.phase = Phase::Preparing;
    session
        .receipt
        .resources
        .get_mut("container:web")
        .unwrap()
        .phase = "create-intent".into();
    session
        .receipt
        .resources
        .get_mut("container:web")
        .unwrap()
        .id = None;
    journal::save(&session.root, &session.receipt).unwrap();
    super::super::environment_binding(&fixture.candidate, OWNER, BOOT, &binding, "web", true)
        .unwrap();
    let mut foreign = binding;
    foreign.review = "e".repeat(64);
    assert!(
        super::super::environment_binding(&fixture.candidate, OWNER, BOOT, &foreign, "web", true)
            .is_err()
    );
}

#[test]
fn cleanup_retry_keeps_observed_stop_request_for_the_same_immutable_id() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    session.backend.state.borrow_mut().fail_delete = true;
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    let (mut retained, _) = journal::load(&fixture.candidate, RUN, OWNER, BOOT).unwrap();
    assert!(retained.terminal["container:web"].stop_requested);
    cleanup_using(&session.backend, &mut retained, &session.root).unwrap();
    assert_eq!(retained.phase, Phase::Removed);
    assert!(retained.terminal["container:web"].stop_requested);
    assert_eq!(
        session
            .backend
            .state
            .borrow()
            .effects
            .iter()
            .filter(|event| event.starts_with("stop:"))
            .count(),
        1
    );
}

#[test]
fn committed_removal_retry_does_not_repeat_stop_or_regress_the_receipt_phase() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    session.backend.state.borrow_mut().fail_delete = true;
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    let (mut retained, _) = journal::load(&fixture.candidate, RUN, OWNER, BOOT).unwrap();
    assert_eq!(retained.phase, Phase::RemovalIntent);
    // Valid bounded state with missing terminal detail must persist fresh evidence
    // before Fake's DELETE independently reads the durable journal.
    retained.terminal.clear();
    journal::save(&session.root, &retained).unwrap();
    let before_stops = session.backend.state.borrow().stop_batches;
    session.backend.state.borrow_mut().observed_phases.clear();
    cleanup_using(&session.backend, &mut retained, &session.root).unwrap();
    assert_eq!(retained.phase, Phase::Removed);
    let state = session.backend.state.borrow();
    assert_eq!(state.stop_batches, before_stops);
    assert!(
        state
            .observed_phases
            .iter()
            .all(|phase| *phase == Phase::RemovalIntent)
    );
    assert!(!retained.terminal["container:web"].stop_requested);
}

#[test]
fn stopped_cleanup_resumes_only_terminal_instances_without_another_stop_batch() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    session.backend.state.borrow_mut().fail_delete = true;
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    // Select the durable Stopped boundary with actual matching terminal observations.
    let (mut retained, _) = journal::load(&fixture.candidate, RUN, OWNER, BOOT).unwrap();
    retained.phase = Phase::Stopped;
    journal::save(&session.root, &retained).unwrap();
    let before_stops = session.backend.state.borrow().stop_batches;
    session.backend.state.borrow_mut().observed_phases.clear();
    cleanup_using(&session.backend, &mut retained, &session.root).unwrap();
    assert_eq!(retained.phase, Phase::Removed);
    let state = session.backend.state.borrow();
    assert_eq!(state.stop_batches, before_stops);
    assert!(
        state
            .observed_phases
            .iter()
            .all(|phase| matches!(phase, Phase::Stopped | Phase::RemovalIntent))
    );
}

#[test]
fn cleanup_of_removed_inventory_is_read_only_and_keeps_the_committed_bytes() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    let before = fs::read(session.root.join("state.json")).unwrap();
    let effects = session.backend.state.borrow().effects.clone();
    let stops = session.backend.state.borrow().stop_batches;
    session.backend.state.borrow_mut().observed_phases.clear();
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(fs::read(session.root.join("state.json")).unwrap(), before);
    let state = session.backend.state.borrow();
    assert_eq!(state.effects, effects);
    assert_eq!(state.stop_batches, stops);
    assert!(
        state
            .observed_phases
            .iter()
            .all(|phase| *phase == Phase::Removed)
    );
}

#[test]
fn stopped_or_removing_inventory_refuses_a_restarted_instance_before_effects() {
    for phase in [Phase::Stopped, Phase::RemovalIntent] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        session.backend.state.borrow_mut().fail_delete = true;
        assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
        session.receipt.phase = phase;
        journal::save(&session.root, &session.receipt).unwrap();
        let name = &session.receipt.resources["container:web"].name;
        {
            let mut state = session.backend.state.borrow_mut();
            let value = state.containers.get_mut(name).unwrap();
            value["State"]["Running"] = json!(true);
            value["State"]["Status"] = json!("running");
            value["State"]["Pid"] = json!(1234);
        }
        let before = fs::read(session.root.join("state.json")).unwrap();
        let effects = session.backend.state.borrow().effects.clone();
        let stops = session.backend.state.borrow().stop_batches;
        assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
        assert_eq!(fs::read(session.root.join("state.json")).unwrap(), before);
        assert_eq!(session.backend.state.borrow().effects, effects);
        assert_eq!(session.backend.state.borrow().stop_batches, stops);
    }
}

#[test]
fn removed_inventory_refuses_even_matching_resource_reappearance_without_effects() {
    for container in [false, true] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        let containers = session.backend.state.borrow().containers.clone();
        let networks = session.backend.state.borrow().networks.clone();
        cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
        {
            let mut state = session.backend.state.borrow_mut();
            if container {
                state.containers = containers;
            } else {
                state.networks = networks;
            }
        }
        let before = fs::read(session.root.join("state.json")).unwrap();
        let effects = session.backend.state.borrow().effects.clone();
        let stops = session.backend.state.borrow().stop_batches;
        assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
        assert_eq!(fs::read(session.root.join("state.json")).unwrap(), before);
        assert_eq!(session.backend.state.borrow().effects, effects);
        assert_eq!(session.backend.state.borrow().stop_batches, stops);
    }
}

#[test]
fn cleanup_owner_guard_refuses_before_provider_connection_or_receipt_mutation() {
    let fixture = Fixture::new(basic());
    let guard = || Err(error("native_graph_foreground", "changed"));
    assert_eq!(
        cleanup_guarded(&fixture.candidate, RUN, None, Some(&guard))
            .unwrap_err()
            .code,
        "native_graph_foreground"
    );
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    let before = session.backend.state.borrow().effects.clone();
    assert!(
        cleanup_using_guarded(
            &session.backend,
            &mut session.receipt,
            &session.root,
            Some(&guard)
        )
        .is_err()
    );
    assert_eq!(session.backend.state.borrow().effects, before);
    assert_eq!(session.backend.receipt().phase, Phase::ReadyObserved);
}

#[test]
fn native_stop_failure_keeps_reservation_and_maps_only_owned_ids_to_workload_names() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    session.backend.state.borrow_mut().fail_stop = true;
    let error = cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap_err();
    let detail = error.stop_failures.as_ref().unwrap();
    assert_eq!(detail.failures[0].service, "web");
    assert_eq!(
        detail.failures[0].stage,
        crate::error::StopFailureStage::Timeout
    );
    let id = session.receipt.resources["container:web"]
        .id
        .as_ref()
        .unwrap();
    assert!(!serde_json::to_string(&error).unwrap().contains(id));
    assert_eq!(session.backend.receipt().phase, Phase::StopIntent);
    assert!(
        !session
            .backend
            .state
            .borrow()
            .effects
            .iter()
            .any(|effect| effect.starts_with("delete:"))
    );
    session.backend.state.borrow_mut().fail_stop = false;
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
}

#[test]
fn cleanup_owner_guard_fences_delete_after_stop_and_network_delete_after_container_removal() {
    for after_delete in [false, true] {
        let fixture = Fixture::new(basic());
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        let changed = Rc::new(Cell::new(false));
        {
            let mut state = session.backend.state.borrow_mut();
            if after_delete {
                state.cancel_after_delete = Some(changed.clone());
            } else {
                state.cancel_after_stop = Some(changed.clone());
            }
        }
        let guard = || {
            if changed.get() {
                Err(error("native_graph_foreground", "changed"))
            } else {
                Ok(())
            }
        };
        assert!(
            cleanup_using_guarded(
                &session.backend,
                &mut session.receipt,
                &session.root,
                Some(&guard)
            )
            .is_err()
        );
        assert!(
            !session
                .backend
                .state
                .borrow()
                .effects
                .iter()
                .any(|effect| effect == "delete:network")
        );
        assert_eq!(
            session.backend.state.borrow().containers.is_empty(),
            after_delete
        );
        let (mut retained, _) = journal::load(&fixture.candidate, RUN, OWNER, BOOT).unwrap();
        assert!(retained.terminal["container:web"].stop_requested);
        changed.set(false);
        session.backend.state.borrow_mut().cancel_after_stop = None;
        session.backend.state.borrow_mut().cancel_after_delete = None;
        cleanup_using_guarded(&session.backend, &mut retained, &session.root, Some(&guard))
            .unwrap();
        assert_eq!(retained.phase, Phase::Removed);
        let effects = &session.backend.state.borrow().effects;
        assert_eq!(
            effects
                .iter()
                .filter(|effect| effect.starts_with("stop:"))
                .count(),
            1
        );
        assert_eq!(
            effects
                .iter()
                .filter(|effect| *effect == "delete:web")
                .count(),
            1
        );
        assert_eq!(effects.last().unwrap(), "delete:network");
    }
}

#[test]
fn owner_change_during_final_terminal_inspection_refuses_container_delete() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    let changed = Rc::new(Cell::new(false));
    session
        .backend
        .state
        .borrow_mut()
        .cancel_on_delete_inspection = Some(changed.clone());
    let guard = || {
        if changed.get() {
            Err(error("native_graph_foreground", "changed"))
        } else {
            Ok(())
        }
    };
    assert!(
        cleanup_using_guarded(
            &session.backend,
            &mut session.receipt,
            &session.root,
            Some(&guard)
        )
        .is_err()
    );
    assert!(changed.get());
    assert!(
        session
            .backend
            .state
            .borrow()
            .effects
            .iter()
            .all(|effect| !effect.starts_with("delete:"))
    );
    assert_eq!(session.backend.receipt().phase, Phase::RemovalIntent);
    assert!(session.backend.receipt().terminal["container:web"].stop_requested);
    changed.set(false);
    session
        .backend
        .state
        .borrow_mut()
        .cancel_on_delete_inspection = None;
    cleanup_using_guarded(
        &session.backend,
        &mut session.receipt,
        &session.root,
        Some(&guard),
    )
    .unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
}

#[test]
fn old_boot_removed_history_releases_capacity_only_after_strict_owner_and_removal_validation() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    let new_boot = "87654321-abcd-abcd-abcd-123456789abc";
    let check = || {
        reservations_using(
            &fixture.candidate,
            OWNER,
            new_boot,
            true,
            |_, _| panic!("removed history must not inspect or allocate"),
            |_| panic!("removed history must not reserve capacity"),
        )
    };
    check().unwrap();
    assert!(journal::load(&fixture.candidate, RUN, OWNER, new_boot).is_err());
    let path = session.root.join("state.json");
    let valid = serde_json::to_value(&session.receipt).unwrap();
    for (pointer, value) in [
        ("/phase", json!("ready-observed")),
        ("/resources/container:web/phase", json!("started")),
        ("/owner", json!("e".repeat(32))),
        ("/version", json!(1)),
        ("/boot", json!("invalid")),
        ("/kind", json!("native-graph-preparation")),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        state::write(&path, &bad).unwrap();
        assert!(check().is_err());
    }
    journal::save(&session.root, &session.receipt).unwrap();
    state::write(&session.root.join("state.pending"), &valid).unwrap();
    assert!(check().is_err());
}
