use super::*;
#[path = "exec_tests.rs"]
mod authored_exec;
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
        let source = selected.project_source.as_ref().map(|source| {
            source
                .bind(&crate::provider::ProjectShareIntent::approve(&self.project, true).unwrap())
                .unwrap()
        });
        let mut config = configuration_with_source(&input, OWNER, source.clone()).unwrap();
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
            source,
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

fn two_bridges() -> Value {
    json!({"schema_version":1,"name":"fixture","networks":{"outbound":{"internal":false},"inside":{"internal":true}},"services":{
        "db":{"image":image(),"networks":{"inside":{"aliases":["db-reader"]}}},
        "web":{"image":image(),"networks":{"inside":{},"outbound":{"aliases":["web-public"]}}}
    }})
}

#[test]
fn two_owned_bridges_keep_per_network_members_and_aliases_through_cleanup() {
    let fixture = Fixture::new(two_bridges());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"db":{},"web":{}}), &BTreeMap::new()));
    assert_eq!(
        serde_json::to_value(&session.receipt).unwrap()["version"],
        5
    );
    execution::run(&graph, &mut session, Duration::from_secs(2)).unwrap();
    assert_eq!(session.receipt.phase, Phase::ReadyObserved);
    assert_eq!(session.backend.state.borrow().networks.len(), 2);
    snapshot(&session.backend, session.receipt.clone()).unwrap();
    let outbound = session.receipt.resources["network:outbound"].name.clone();
    let web = session.receipt.resources["container:web"].name.clone();
    session
        .backend
        .state
        .borrow_mut()
        .networks
        .get_mut(&outbound)
        .unwrap()["Internal"] = json!(true);
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    session
        .backend
        .state
        .borrow_mut()
        .networks
        .get_mut(&outbound)
        .unwrap()["Internal"] = json!(false);
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&web)
        .unwrap()["NetworkSettings"]["Networks"][&outbound]["Aliases"] = json!(["web", "foreign"]);
    assert!(snapshot(&session.backend, session.receipt.clone()).is_err());
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&web)
        .unwrap()["NetworkSettings"]["Networks"][&outbound]["Aliases"] =
        json!(["web", "web-public"]);
    snapshot(&session.backend, session.receipt.clone()).unwrap();
    let before = session.backend.state.borrow().effects.clone();
    let inside = session.receipt.resources["network:inside"].name.clone();
    session
        .backend
        .state
        .borrow_mut()
        .networks
        .get_mut(&inside)
        .unwrap()["Containers"]["f".repeat(64)] = json!({"Name":"foreign"});
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    assert_eq!(session.backend.state.borrow().effects, before);
    session
        .backend
        .state
        .borrow_mut()
        .networks
        .get_mut(&inside)
        .unwrap()["Containers"]
        .as_object_mut()
        .unwrap()
        .remove(&"f".repeat(64));
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
    assert!(session.backend.state.borrow().networks.is_empty());
    assert!(session.backend.state.borrow().containers.is_empty());
}

#[test]
fn two_bridge_cancellation_before_second_create_retains_exact_first_bridge_for_cleanup() {
    let fixture = Fixture::new(two_bridges());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"db":{},"web":{}}), &BTreeMap::new()));
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
        execution::run(&graph, &mut session, Duration::from_secs(2))
            .unwrap_err()
            .code,
        "native_graph_canceled"
    );
    assert_eq!(session.backend.state.borrow().networks.len(), 1);
    assert!(session.backend.state.borrow().containers.is_empty());
    canceled.set(false);
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
    assert!(session.backend.state.borrow().networks.is_empty());
}

#[test]
fn two_bridge_cleanup_retries_only_the_retained_second_bridge_after_first_delete() {
    let fixture = Fixture::new(two_bridges());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"db":{},"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(2)).unwrap();
    session
        .backend
        .state
        .borrow_mut()
        .fail_network_delete_after_apply = true;
    assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
    assert_eq!(session.receipt.phase, Phase::RemovalIntent);
    assert_eq!(session.backend.state.borrow().networks.len(), 1);
    assert!(session.backend.state.borrow().containers.is_empty());
    assert_eq!(
        session.backend.receipt().resources["network:inside"].phase,
        "remove-intent"
    );
    let stops = session.backend.state.borrow().stop_batches;
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.backend.state.borrow().stop_batches, stops);
    assert_eq!(session.receipt.phase, Phase::Removed);
    assert!(session.backend.state.borrow().networks.is_empty());
}

fn persistent_reference(receipt: &Receipt) -> persistent_data::engine::Reference {
    let namespace = receipt.review.scope().namespace;
    let owner = "9".repeat(32);
    serde_json::from_value(json!({"binding":{"scope":{"namespace":namespace,"storage":"database","owner":owner},"guest":{"owner":receipt.owner,"boot_id":receipt.boot,"storage":{"device":0,"inode":21,"bytes":128,"uuid":"11111111-2222-3333-4444-555555555555"}},"policy":{"driver":"local","scope":"local","options":{}}},"state":{"status":"enrolled","volume":{"name":format!("hkp-{namespace}-{owner}-database"),"created_at":"2026-10-08T00:00:01Z","directory":{"device":0,"inode":42}}}})).unwrap()
}

#[test]
fn persistent_journal_has_distinct_version_and_exact_data_membership_without_volume_ids() {
    let fixture = Fixture::new(basic());
    let (_, session) = fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    let mut receipt = session.receipt;
    let image_only = serde_json::to_value(&receipt).unwrap();
    for fields in [
        json!({"data":{}}),
        json!({"data_mounts":{}}),
        json!({"data":{},"data_mounts":{}}),
        json!({"data":null}),
        json!({"data_mounts":null}),
        json!({"data":null,"data_mounts":null}),
        json!({"data_tool":null}),
        json!({"data_tool":{"version":1,"artifact":"a".repeat(64),"bytes":8192,"root":null,"helper":null}}),
    ] {
        let mut wire = image_only.clone();
        wire.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        assert!(serde_json::from_value::<Receipt>(wire).is_err());
    }
    serde_json::from_value::<Receipt>(image_only)
        .unwrap()
        .validate(RUN, OWNER)
        .unwrap();
    receipt
        .data
        .insert("database".into(), persistent_reference(&receipt));
    receipt.data_mounts.insert(
        "web".into(),
        vec![crate::project::native::StorageMount {
            storage: "database".into(),
            target: "/data".into(),
            read_only: false,
        }],
    );
    let mut persistent_wire = serde_json::to_value(&receipt).unwrap();
    persistent_wire["version"] = json!(4);
    receipt = serde_json::from_value(persistent_wire).unwrap();
    receipt.validate(RUN, OWNER).unwrap();
    let mut installed = serde_json::to_value(&receipt).unwrap();
    installed["data_tool"] = json!({"version":1,"artifact":"a".repeat(64),"bytes":8192,"root":{"device":0,"inode":1},"helper":{"device":0,"inode":2}});
    let with_tool: Receipt = serde_json::from_value(installed.clone()).unwrap();
    with_tool.validate(RUN, OWNER).unwrap();
    assert!(with_tool.check_binding(&receipt).is_err());
    installed["data_tool"]["helper"]["inode"] = json!(0);
    assert!(
        serde_json::from_value::<Receipt>(installed)
            .unwrap()
            .validate(RUN, OWNER)
            .is_err()
    );
    assert_eq!(receipt.resources.len(), 2);
    assert!(
        receipt
            .resources
            .values()
            .all(|resource| resource.kind != Kind::Volume)
    );
    let observed = json!({"Mounts":[{"Type":"volume","Name":receipt.data["database"].name(),"Source":receipt.data["database"].mountpoint(),"Destination":"/data","RW":true,"Driver":"local"}]});
    verify_data_mounts(&receipt, "web", &observed).unwrap();
    for field in ["Name", "Source", "Destination", "Driver", "RW", "Type"] {
        let mut wrong = observed.clone();
        wrong["Mounts"][0][field] = json!("foreign");
        assert!(verify_data_mounts(&receipt, "web", &wrong).is_err());
    }
    let mut extra = observed.clone();
    extra["Mounts"]
        .as_array_mut()
        .unwrap()
        .push(observed["Mounts"][0].clone());
    assert!(verify_data_mounts(&receipt, "web", &extra).is_err());
    for version in [2, 3, 5] {
        let mut wrong = serde_json::to_value(&receipt).unwrap();
        wrong["version"] = json!(version);
        if let Ok(wrong) = serde_json::from_value::<Receipt>(wrong) {
            assert!(wrong.validate(RUN, OWNER).is_err());
        }
    }
    let mut omitted = receipt.clone();
    omitted.data.clear();
    assert!(omitted.validate(RUN, OWNER).is_err());
    let encoded = serde_json::to_value(&receipt).unwrap();
    let mut pending = encoded.clone();
    pending["data"]["database"]["state"] = json!({"status":"reserved","intent":"8".repeat(32)});
    let mut pending: Receipt = serde_json::from_value(pending).unwrap();
    pending.resources.get_mut("container:web").unwrap().id = Some("6".repeat(64));
    assert!(pending.validate(RUN, OWNER).is_err());
    let mut independent = receipt.clone();
    let run = "7".repeat(32);
    independent.review = native_input::Review::new(
        native_input::Scope {
            namespace: receipt.review.scope().namespace,
            run: &run,
        },
        receipt.review.compiler_identity().clone(),
    )
    .unwrap();
    independent
        .resources
        .get_mut("network:default")
        .unwrap()
        .name = format!("hkn-{run}-network-0");
    independent.resources.get_mut("container:web").unwrap().name = format!("hkn-{run}-container-0");
    independent.validate(&run, OWNER).unwrap();
    assert_eq!(independent.data, receipt.data);
    assert!(independent.check_binding(&receipt).is_err());
    assert!(verify_prior_data_retirement(&receipt, &independent.data).is_err());
    receipt.phase = Phase::Removed;
    verify_prior_data_retirement(&receipt, &independent.data).unwrap();
    // Compute-only retirement cannot turn an uncertain original data create into
    // authority for a second attempt, even if an enrolled pathname appeared late.
    let mut reserved = encoded;
    reserved["data"]["database"]["state"] = json!({"status":"reserved","intent":"8".repeat(32)});
    let mut reserved: Receipt = serde_json::from_value(reserved).unwrap();
    reserved.phase = Phase::Removed;
    assert!(verify_prior_data_retirement(&reserved, &independent.data).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn ready_graph4_recovery_requires_complete_saved_helper_and_enrolled_data() {
    let fixture = Fixture::new(basic());
    let (_, session) = fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    let mut receipt = session.receipt;
    receipt.phase = Phase::ReadyObserved;
    for resource in receipt.resources.values_mut() {
        resource.id = Some(if resource.kind == Kind::Network {
            "1".repeat(64)
        } else {
            "2".repeat(64)
        });
        resource.phase = if resource.kind == Kind::Network {
            "created".into()
        } else {
            "started".into()
        };
    }
    receipt.require_recovery_ready().unwrap();
    receipt
        .data
        .insert("database".into(), persistent_reference(&receipt));
    receipt.data_mounts.insert(
        "web".into(),
        vec![crate::project::native::StorageMount {
            storage: "database".into(),
            target: "/data".into(),
            read_only: false,
        }],
    );
    let mut persistent_wire = serde_json::to_value(&receipt).unwrap();
    persistent_wire["version"] = json!(4);
    receipt = serde_json::from_value(persistent_wire).unwrap();
    receipt.validate(RUN, OWNER).unwrap();
    assert!(receipt.require_recovery_ready().is_err());
    let mut wire = serde_json::to_value(&receipt).unwrap();
    wire["data_tool"] = json!({"version":1,"artifact":"a".repeat(64),"bytes":8192,"root":{"device":0,"inode":1},"helper":{"device":0,"inode":2}});
    let ready: Receipt = serde_json::from_value(wire.clone()).unwrap();
    ready.require_recovery_ready().unwrap();
    wire["data_tool"]["helper"] = Value::Null;
    assert!(
        serde_json::from_value::<Receipt>(wire)
            .unwrap()
            .require_recovery_ready()
            .is_err()
    );
}

#[test]
fn ordinary_persistent_start_refuses_before_provider_or_any_owner_publication() {
    let mut project = basic();
    project["storage"] = json!({"database":{"kind":"persistent","scope":"worktree"}});
    project["services"]["web"]["mounts"] =
        json!([{"storage":"database","target":"/data","access":"read-write"}]);
    let fixture = Fixture::new(project);
    let prepared = fixture.prepared(json!({"web":{}}), &BTreeMap::new());
    assert_eq!(
        run_guarded(&fixture.candidate, prepared, None, None, None)
            .unwrap_err()
            .code,
        "native_graph_storage_unqualified"
    );
    for path in ["run/smolvm", "run/native-graphs"] {
        assert!(!fixture.candidate.state_root.join(path).exists());
    }
    assert!(!fixture.candidate.state_root.exists());
}

fn witnessed_receipt(fixture: &Fixture) -> Receipt {
    let (_, session) = fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    let mut wire = serde_json::to_value(&session.receipt).unwrap();
    wire["version"] = json!(4);
    wire["data"] = json!({"database":persistent_reference(&session.receipt)});
    wire["data_mounts"] =
        json!({"web":[{"storage":"database","target":"/data","read_only":false}]});
    wire["data_tool"] = json!({"version":1,"artifact":"a".repeat(64),"bytes":8192,"root":{"device":0,"inode":1},"helper":{"device":0,"inode":2}});
    let receipt: Receipt = serde_json::from_value(wire).unwrap();
    receipt.validate(RUN, OWNER).unwrap();
    journal::save(&session.root, &receipt).unwrap();
    receipt
}

#[test]
fn storage_reservation_exception_requires_exact_current_complete_pre_effect_receipt() {
    let fixture = Fixture::new(basic());
    let receipt = witnessed_receipt(&fixture);
    reserved_data_admission(&receipt, &receipt).unwrap();
    for changed in 0..7 {
        let mut other = receipt.clone();
        match changed {
            0 => other.phase = Phase::ReadyObserved,
            1 => other.resources.get_mut("container:web").unwrap().id = Some("4".repeat(64)),
            2 => other.resources.get_mut("network:default").unwrap().phase = "create-intent".into(),
            3 => other.data_tool = None,
            4 => other.data_tool.as_mut().unwrap().helper = None,
            5 => other.data_tool.as_mut().unwrap().artifact = "5".repeat(64),
            6 => other.data.clear(),
            _ => unreachable!(),
        }
        assert!(reserved_data_admission(&receipt, &other).is_err());
    }
    let mut incomplete = receipt.clone();
    incomplete.data_tool.as_mut().unwrap().helper = None;
    assert!(reserved_data_admission(&incomplete, &incomplete).is_err());
    // Without the exact exception, this durable Preparing reservation continues
    // to block ordinary admission; no unknown intent is silently skipped.
    assert!(
        reservations_using(
            &fixture.candidate,
            OWNER,
            BOOT,
            true,
            |_, _| unreachable!(),
            |_| unreachable!()
        )
        .is_err()
    );
    reservations_using_except(
        &fixture.candidate,
        OWNER,
        BOOT,
        false,
        Some(RUN),
        |_, _| unreachable!(),
        |_| unreachable!(),
    )
    .unwrap();
}

#[test]
fn target_receipt_pin_survives_no_transition_and_requires_fresh_admission_after_save() {
    let fixture = Fixture::new(basic());
    let mut receipt = witnessed_receipt(&fixture);
    let pin =
        persistent_data::tool::ReceiptAdmission::capture(&fixture.candidate, &receipt).unwrap();
    pin.verify().unwrap();
    let root = journal::directory(&fixture.candidate, RUN).unwrap();
    receipt.phase = Phase::FailedRetained;
    journal::save(&root, &receipt).unwrap();
    let effects = Cell::new(0);
    let admitted = || {
        pin.verify()?;
        effects.set(effects.get() + 1);
        Ok::<_, CandidateError>(())
    };
    assert!(admitted().is_err());
    assert_eq!(effects.get(), 0);
    let fresh =
        persistent_data::tool::ReceiptAdmission::capture(&fixture.candidate, &receipt).unwrap();
    fresh.verify().unwrap();
    // Pending publication is never a settled receipt, even with identical data.
    fs::write(root.join("state.pending"), b"pending").unwrap();
    assert!(fresh.verify().is_err());
    assert!(
        persistent_data::tool::ReceiptAdmission::capture(&fixture.candidate, &receipt).is_err()
    );
}

#[test]
fn sqlite_process_policy_refuses_image_entrypoints_and_unqualified_owner_handoffs() {
    let mut config = config::container_base(&image(), json!({}));
    config["Entrypoint"] = json!([]);
    config["Cmd"] = json!(["/usr/local/bin/bun", "-e", "explicit program"]);
    storage_process_policy(&config).unwrap();
    config["User"] = json!("0:0");
    storage_process_policy(&config).unwrap();
    for (field, value) in [
        ("Entrypoint", json!(["docker-entrypoint.sh"])),
        ("Entrypoint", Value::Null),
        ("Cmd", json!(["postgres"])),
        ("User", json!("70:70")),
        ("User", json!(70)),
    ] {
        let mut other = config.clone();
        other[field] = value;
        assert_eq!(
            storage_process_policy(&other).unwrap_err().code,
            "native_graph_storage_process_unqualified"
        );
    }
}

#[test]
fn new_storage_attempt_refuses_pending_prior_work_before_another_tool_installation() {
    let fixture = Fixture::new(basic());
    let mut receipt = witnessed_receipt(&fixture);
    let root = journal::directory(&fixture.candidate, RUN).unwrap();
    assert!(storage_attempt_preflight(&fixture.candidate, OWNER, BOOT).is_err());
    receipt.phase = Phase::Removed;
    for resource in receipt.resources.values_mut() {
        resource.phase = "removed".into();
    }
    journal::save(&root, &receipt).unwrap();
    storage_attempt_preflight(&fixture.candidate, OWNER, BOOT).unwrap();
    // Even otherwise valid Removed history may retain an unknown verifier.
    // The new run must not create a second helper or attempt data enrollment.
    let effects = Cell::new(0);
    fs::write(
        root.join("storage-call.pending"),
        b"native-storage-call-v1\n",
    )
    .unwrap();
    let install = || {
        storage_attempt_preflight(&fixture.candidate, OWNER, BOOT)?;
        effects.set(effects.get() + 1);
        Ok::<_, CandidateError>(())
    };
    assert!(install().is_err());
    assert_eq!(effects.get(), 0);
    assert!(
        reservations_using(
            &fixture.candidate,
            OWNER,
            BOOT,
            true,
            |_, _| unreachable!(),
            |_| unreachable!()
        )
        .is_err()
    );
}

#[test]
fn foreground_guard_refuses_before_provider_connection_or_graph_reservation() {
    let fixture = Fixture::new(basic());
    let prepared = fixture.prepared(json!({"web":{}}), &BTreeMap::new());
    let guard = || Err(error("native_graph_canceled", "canceled"));
    assert_eq!(
        run_guarded(&fixture.candidate, prepared, Some(&guard), None, None)
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
    log_reads: Vec<(String, u16)>,
    log_source_deadlines: Vec<Instant>,
    log_data_deadlines: Vec<Instant>,
    expire_source_check: usize,
    restart_on_logs: bool,
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
    fail_network_delete_after_apply: bool,
    staged: Vec<String>,
    cancel_after_network: Option<Rc<Cell<bool>>>,
    cancel_after_stop: Option<Rc<Cell<bool>>>,
    cancel_after_delete: Option<Rc<Cell<bool>>>,
    cancel_on_delete_inspection: Option<Rc<Cell<bool>>>,
    replace_source_after_create: Option<PathBuf>,
}
struct Fake {
    root: PathBuf,
    run: String,
    source: Option<source::Binding>,
    state: RefCell<FakeState>,
}
impl Fake {
    fn receipt(&self) -> Receipt {
        serde_json::from_slice(&fs::read(self.root.join("state.json")).unwrap()).unwrap()
    }
}
impl Backend for Fake {
    fn logs(&self, id: &str, tail: u16) -> Result<(String, String, bool), CandidateError> {
        let mut state = self.state.borrow_mut();
        state.log_reads.push((id.into(), tail));
        if state.restart_on_logs {
            state.containers.values_mut().next().unwrap()["State"]["StartedAt"] =
                json!("2026-10-09T00:00:01.000000000Z");
        }
        Ok(("authored stdout\n".into(), "authored stderr\n".into(), true))
    }
    fn verify_source(&self, receipt: &Receipt, active: bool) -> Result<(), CandidateError> {
        // This fake verifies the admitted binding and real host selection. The
        // real backend separately checks the provider lease and virtiofs mapping.
        if receipt.source != self.source {
            return Err(refused());
        }
        if active && let Some(source) = &receipt.source {
            source.verify_host()?;
        }
        Ok(())
    }
    fn verify_source_until(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        crate::provider::managed_environment::remaining_until(deadline)?;
        let expire = {
            let mut state = self.state.borrow_mut();
            state.log_source_deadlines.push(deadline);
            state.expire_source_check == state.log_source_deadlines.len()
        };
        self.verify_source(receipt, true)?;
        if expire {
            std::thread::sleep(
                deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
            );
        }
        crate::provider::managed_environment::remaining_until(deadline)?;
        Ok(())
    }
    fn verify_data(
        &self,
        receipt: &Receipt,
        deadline: Instant,
        _fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        self.state.borrow_mut().log_data_deadlines.push(deadline);
        if receipt.data.is_empty() {
            Ok(())
        } else {
            Err(refused())
        }
    }
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
            let body = body.unwrap();
            let resource = receipt
                .resources
                .values()
                .find(|resource| resource.kind == Kind::Network && body["Name"] == resource.name)
                .unwrap();
            assert_eq!(resource.phase, "create-intent");
            assert!(resource.id.is_none());
            assert_eq!(receipt.phase, Phase::Preparing);
            state.effects.push(if receipt.topology.is_some() {
                format!("create:network:{}", resource.key)
            } else {
                "create:network".into()
            });
            if state.fail_network_create {
                return Err(error("fake_network_create_uncertain", "once"));
            }
            assert_eq!(body["Internal"], !resource.outbound);
            assert_eq!(body["Driver"], "bridge");
            let id = format!("{:064x}", state.networks.len() + 100);
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
            let resource = receipt
                .resources
                .values()
                .find(|resource| {
                    resource.kind == Kind::Network && resource.id.as_deref() == Some(id)
                })
                .unwrap();
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
            if state.fail_network_delete_after_apply {
                state.fail_network_delete_after_apply = false;
                return Err(error("fake_network_delete_uncertain", "applied once"));
            }
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
            let selected = resource.networks.as_ref().unwrap();
            let mut attached = serde_json::Map::new();
            for logical in selected {
                let network = &receipt.resources[&format!("network:{logical}")];
                assert_eq!(network.phase, "created");
                let aliases =
                    &config["NetworkingConfig"]["EndpointsConfig"][&network.name]["Aliases"];
                assert!(
                    aliases
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|alias| alias == &resource.key)
                );
                attached.insert(
                    network.name.clone(),
                    json!({"NetworkID":"","Aliases":aliases}),
                );
            }
            assert_eq!(
                config["HostConfig"]["NetworkMode"],
                receipt.resources[&format!("network:{}", selected[0])].name
            );
            let value = json!({"Id":id,"Name":format!("/{name}"),"Image":config["Image"],"Config":process,"HostConfig":config["HostConfig"],"Mounts":[],"NetworkSettings":{"Networks":attached},"State":{"Running":false,"Status":"created","Pid":0,"ExitCode":0,"OOMKilled":false,"Dead":false,"Paused":false,"Restarting":false}});
            state.containers.insert(name.into(), value);
            if let Some(path) = &state.replace_source_after_create {
                fs::rename(path, path.with_extension("original")).unwrap();
                fs::DirBuilder::new().mode(0o700).create(path).unwrap();
            }
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
            value["Mounts"] = json!(value["HostConfig"]["Mounts"].as_array().map(|mounts| mounts.iter().map(|mount| json!({"Type":mount["Type"],"Source":mount["Source"],"Destination":mount["Target"],"RW":!mount["ReadOnly"].as_bool().unwrap(),"Propagation":mount["BindOptions"]["Propagation"]})).collect::<Vec<_>>()).unwrap_or_default());
            value["State"] = if resource.key == "z.seed" {
                json!({"Running":false,"Status":"exited","Pid":0,"ExitCode":0,"OOMKilled":false,"Dead":false,"Paused":false,"Restarting":false})
            } else {
                json!({"Running":true,"Status":"running","Pid":1,"ExitCode":0,"OOMKilled":false,"Dead":false,"Paused":false,"Restarting":false,"Health":{"Status":"healthy"}})
            };
            let mut members = Vec::new();
            for (index, logical) in resource.networks.as_ref().unwrap().iter().enumerate() {
                let network = &receipt.resources[&format!("network:{logical}")];
                let endpoint = format!("{:064x}", index + 200);
                let ip = format!("172.20.{}.2", index + 1);
                value["NetworkSettings"]["Networks"][&network.name]["NetworkID"] =
                    json!(network.id);
                value["NetworkSettings"]["Networks"][&network.name]["EndpointID"] = json!(endpoint);
                value["NetworkSettings"]["Networks"][&network.name]["IPAddress"] = json!(ip);
                members.push((network.name.clone(), json!({"Name":resource.name,"EndpointID":endpoint,"IPv4Address":format!("{ip}/16")})));
            }
            for (network, member) in members {
                state.networks.get_mut(&network).unwrap()["Containers"][id] = member;
            }
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

fn source_fixture() -> Fixture {
    let mut project = basic();
    project["services"]["web"]["mounts"] =
        json!([{"source":"src","target":"/app","access":"read-only"}]);
    let fixture = Fixture::new(project);
    fs::write(fixture.project.join("package.json"), "{}").unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(fixture.project.join("src"))
        .unwrap();
    fs::write(fixture.project.join("src/main.js"), "initial live source").unwrap();
    fixture
}

#[test]
fn source_and_storage_receipt_wire_families_refuse_cross_fields() {
    let fixture = source_fixture();
    let (_, session) = fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    let source = serde_json::to_value(&session.receipt).unwrap();
    serde_json::from_value::<Receipt>(source.clone())
        .unwrap()
        .validate(RUN, OWNER)
        .unwrap();
    for fields in [
        json!({"data":{}}),
        json!({"data_mounts":{}}),
        json!({"data_tool":null}),
    ] {
        let mut wire = source.clone();
        wire.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        assert!(serde_json::from_value::<Receipt>(wire).is_err());
    }
    for version in [2, 4, 5] {
        let mut wire = source.clone();
        wire["version"] = json!(version);
        assert!(serde_json::from_value::<Receipt>(wire).is_err());
    }
    let mut wire = source;
    wire["version"] = json!(4);
    wire["data"] = json!({});
    wire["data_mounts"] = json!({});
    assert!(serde_json::from_value::<Receipt>(wire).is_err());
}

#[test]
fn live_source_controller_preserves_edits_and_cleans_only_original_owned_resources_after_move() {
    let fixture = source_fixture();
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    assert_eq!(
        serde_json::to_value(&session.receipt).unwrap()["version"],
        3
    );
    fs::write(fixture.project.join("src/new"), "atomic edit").unwrap();
    fs::rename(
        fixture.project.join("src/new"),
        fixture.project.join("src/main.js"),
    )
    .unwrap();
    snapshot(&session.backend, session.receipt.clone()).unwrap();
    let moved = fixture.project.join("moved");
    fs::rename(fixture.project.join("src"), &moved).unwrap();
    fs::write(
        fixture.project.join("foreign-canary"),
        "preserve foreign data",
    )
    .unwrap();
    assert!(snapshot(&session.backend, session.receipt.clone()).is_err());
    cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
    assert_eq!(session.receipt.phase, Phase::Removed);
    assert!(session.backend.state.borrow().containers.is_empty());
    assert!(session.backend.state.borrow().networks.is_empty());
    assert_eq!(
        fs::read_to_string(moved.join("main.js")).unwrap(),
        "atomic edit"
    );
    assert_eq!(
        fs::read_to_string(fixture.project.join("foreign-canary")).unwrap(),
        "preserve foreign data"
    );
    snapshot(&session.backend, session.receipt.clone()).unwrap();
}

#[test]
fn selected_source_replacement_before_effect_or_after_create_refuses_without_start_or_adoption() {
    for after_create in [false, true] {
        let fixture = source_fixture();
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        let path = fixture.project.join("src");
        if after_create {
            session
                .backend
                .state
                .borrow_mut()
                .replace_source_after_create = Some(path);
        } else {
            fs::rename(&path, fixture.project.join("original")).unwrap();
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        }
        assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
        assert!(
            !session
                .backend
                .state
                .borrow()
                .effects
                .iter()
                .any(|effect| effect.starts_with("start:"))
        );
        if after_create {
            assert_eq!(
                session.backend.state.borrow().effects,
                ["create:network", "create:web"]
            );
            cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
            assert_eq!(session.receipt.phase, Phase::Removed);
        } else {
            assert!(session.backend.state.borrow().effects.is_empty());
        }
        assert!(execution::run(&graph, &mut session, Duration::from_secs(5)).is_err());
    }
}

#[test]
fn retained_source_bind_or_approved_share_drift_refuses_cleanup_before_mutation() {
    for changed_share in [false, true] {
        let fixture = source_fixture();
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        if changed_share {
            session.backend.source.as_mut().unwrap().share.inode += 1;
        } else {
            let mut state = session.backend.state.borrow_mut();
            state.containers.values_mut().next().unwrap()["Mounts"][0]["RW"] = json!(true);
        }
        let effects = session.backend.state.borrow().effects.clone();
        assert!(cleanup_using(&session.backend, &mut session.receipt, &session.root).is_err());
        assert_eq!(session.backend.state.borrow().effects, effects);
    }
}

#[test]
fn source_cleanup_does_not_recapture_a_moved_or_deleted_host_project() {
    for deleted in [false, true] {
        let fixture = source_fixture();
        let (graph, mut session) =
            fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
        execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
        let moved = fixture.root.join("moved-project");
        if deleted {
            fs::remove_dir_all(&fixture.project).unwrap();
        } else {
            fs::rename(&fixture.project, &moved).unwrap();
        }
        assert!(snapshot(&session.backend, session.receipt.clone()).is_err());
        cleanup_using(&session.backend, &mut session.receipt, &session.root).unwrap();
        assert_eq!(session.receipt.phase, Phase::Removed);
        assert!(session.backend.state.borrow().containers.is_empty());
        assert!(session.backend.state.borrow().networks.is_empty());
        assert!(!fixture.project.exists());
        if !deleted {
            assert_eq!(
                fs::read_to_string(moved.join("src/main.js")).unwrap(),
                "initial live source"
            );
        }
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
fn cleanup_guard_loss_during_first_observation_prevents_next_request_and_stop_intent() {
    struct Changed<'a> {
        backend: &'a Fake,
        changed: &'a Cell<bool>,
        requests: Cell<usize>,
    }
    impl Backend for Changed<'_> {
        fn request(
            &self,
            method: Method,
            path: &str,
            body: Option<&Value>,
        ) -> Result<Value, CandidateError> {
            self.requests.set(self.requests.get() + 1);
            let result = self.backend.request(method, path, body);
            self.changed.set(true);
            result
        }
    }
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(5)).unwrap();
    let changed = Cell::new(false);
    let backend = Changed {
        backend: &session.backend,
        changed: &changed,
        requests: Cell::new(0),
    };
    let guard = || {
        if changed.get() {
            Err(error("native_graph_foreground", "changed"))
        } else {
            Ok(())
        }
    };
    let before = fs::read(session.root.join("state.json")).unwrap();
    let effects = session.backend.state.borrow().effects.clone();
    assert_eq!(
        cleanup_using_guarded(&backend, &mut session.receipt, &session.root, Some(&guard))
            .unwrap_err()
            .code,
        "native_graph_foreground"
    );
    assert_eq!(backend.requests.get(), 1);
    assert_eq!(session.backend.state.borrow().effects, effects);
    assert_eq!(session.backend.state.borrow().stop_batches, 0);
    assert_eq!(fs::read(session.root.join("state.json")).unwrap(), before);
}

#[test]
fn cleanup_guard_rechecks_failed_stop_and_refuses_before_followup_request() {
    struct FailedStop<'a>(&'a Cell<bool>);
    impl Backend for FailedStop<'_> {
        fn request(
            &self,
            _method: Method,
            _path: &str,
            _body: Option<&Value>,
        ) -> Result<Value, CandidateError> {
            panic!("lost guard cannot admit another engine request")
        }
        fn stop(
            &self,
            _selected: &[(String, u64)],
            _admitted: &BTreeMap<&str, &str>,
        ) -> Result<(), CandidateError> {
            self.0.set(true);
            Err(error("fake_stop_uncertain", "fixed"))
        }
    }
    let changed = Cell::new(false);
    let guard = || {
        if changed.get() {
            Err(error("native_graph_foreground", "changed"))
        } else {
            Ok(())
        }
    };
    let backend = FailedStop(&changed);
    let guarded = GuardedBackend {
        backend: &backend,
        guard: Some(&guard),
    };
    assert_eq!(
        guarded.stop(&[], &BTreeMap::new()).unwrap_err().code,
        "native_graph_foreground"
    );
    assert_eq!(
        guarded
            .request(Method::GET, "/unused", None)
            .unwrap_err()
            .code,
        "native_graph_foreground"
    );
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
        if after_delete {
            assert_eq!(retained.phase, Phase::RemovalIntent);
            assert!(retained.terminal["container:web"].stop_requested);
        } else {
            // Authority was lost inside the admitted stop batch: its result is
            // retained as uncertain, with no unauthorized terminal observation.
            assert_eq!(retained.phase, Phase::StopIntent);
            assert!(retained.terminal.is_empty());
        }
        changed.set(false);
        session.backend.state.borrow_mut().cancel_after_stop = None;
        session.backend.state.borrow_mut().cancel_after_delete = None;
        cleanup_using_guarded(&session.backend, &mut retained, &session.root, Some(&guard))
            .unwrap();
        assert_eq!(retained.phase, Phase::Removed);
        assert_eq!(
            retained.terminal["container:web"].stop_requested,
            after_delete
        );
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

// This owned synthetic fixture never approves a share or initializes a provider
// pool. The caller must use the explicit development project-share setup first.
#[cfg(target_os = "macos")]
mod live_source {
    use super::*;

    use std::{
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    };

    fn identity(metadata: &fs::Metadata) -> Value {
        // SAFETY: geteuid has no caller preconditions.
        assert_eq!(
            metadata.uid(),
            unsafe { libc::geteuid() },
            "synthetic fixture owner differs"
        );
        json!({"device":metadata.dev(),"inode":metadata.ino(),"mode":metadata.mode(),
            "uid":metadata.uid(),"gid":metadata.gid(),
            "kind":if metadata.is_dir(){"directory"}else{"file"}})
    }
    fn directory(path: &Path, mode: u32) -> Value {
        crate::reject_aliased_state(path).unwrap();
        let metadata = path.symlink_metadata().unwrap();
        assert!(metadata.is_dir(), "synthetic fixture directory differs");
        assert_eq!(
            metadata.mode() & 0o7777,
            mode,
            "synthetic fixture directory mode differs"
        );
        identity(&metadata)
    }
    fn file(path: &Path, mode: u32, write: bool) -> (File, Value) {
        crate::reject_aliased_state(path.parent().unwrap()).unwrap();
        let opened = OpenOptions::new()
            .read(true)
            .write(write)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .unwrap();
        let metadata = opened.metadata().unwrap();
        assert!(
            metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= 128 * 1024,
            "synthetic fixture file differs"
        );
        assert_eq!(
            metadata.mode() & 0o7777,
            mode,
            "synthetic fixture file mode differs"
        );
        let anchor = identity(&metadata);
        assert_eq!(
            identity(&path.symlink_metadata().unwrap()),
            anchor,
            "synthetic fixture file incarnation differs"
        );
        (opened, anchor)
    }
    fn bytes(path: &Path, mode: u32, anchor: &Value) -> Vec<u8> {
        let (opened, observed) = file(path, mode, false);
        assert_eq!(&observed, anchor, "synthetic fixture file changed");
        let mut bytes = Vec::new();
        opened.take(128 * 1024 + 1).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 128 * 1024, "synthetic fixture input grew");
        assert_eq!(
            file(path, mode, false).1,
            observed,
            "synthetic fixture input replaced"
        );
        bytes
    }
    fn entries(path: &Path, expected: &[&str]) {
        let mut found: Vec<_> = fs::read_dir(path)
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .into_string()
                    .expect("synthetic fixture name differs")
            })
            .collect();
        found.sort();
        let mut expected: Vec<_> = expected.iter().map(|name| (*name).to_string()).collect();
        expected.sort();
        assert!(
            found == expected,
            "synthetic fixture contains unexpected entries"
        );
    }
    struct Scope {
        root: PathBuf,
        project: PathBuf,
        roots: BTreeMap<PathBuf, Value>,
        src: Value,
        files: BTreeMap<String, Value>,
        marker: Value,
        manifest: Value,
        started: Option<Value>,
    }
    impl Scope {
        fn admit(
            root: &Path,
            candidate: &Candidate,
            project: &Path,
            image: &str,
            run: &str,
        ) -> Self {
            let root = root.to_path_buf();
            assert_eq!(root.file_name().unwrap(), "live-fixture");
            assert_eq!(root.canonicalize().unwrap(), root);
            assert_eq!(project, root.join("project"));
            assert_eq!(candidate.checkout, root.join("native-home"));
            let roots = [&root, project, &project.join(".hack"), &candidate.checkout]
                .into_iter()
                .map(|path| (path.to_owned(), directory(path, 0o700)))
                .collect::<BTreeMap<_, _>>();
            let src = directory(&project.join("src"), 0o755);
            entries(&root, &["fixture.json", "native-home", "project"]);
            entries(project, &[".hack", "package.json", "src"]);
            entries(&project.join(".hack"), &["hack.project.json"]);
            entries(
                &project.join("src"),
                &["health.txt", "message.txt", "server.js"],
            );

            let files = [
                "package.json",
                ".hack/hack.project.json",
                "src/server.js",
                "src/health.txt",
                "src/message.txt",
            ]
            .into_iter()
            .map(|name| {
                let mode = if name.starts_with("src/") {
                    0o644
                } else {
                    0o600
                };
                (name.to_owned(), file(&project.join(name), mode, false).1)
            })
            .collect();
            let marker_path = root.join("fixture.json");
            let marker = file(&marker_path, 0o600, false).1;
            let manifest = json!({"version":1,"run":run,"image":image,
                "fixture":roots[&root],"project":roots[project],"home":roots[&candidate.checkout],
                "hack":roots[&project.join(".hack")],"src":src,"files":files});
            let stored: Value =
                serde_json::from_slice(&bytes(&marker_path, 0o600, &marker)).unwrap();
            assert!(stored == manifest, "synthetic fixture manifest differs");
            let mut scope = Self {
                root,
                project: project.into(),
                roots,
                src,
                files,
                marker,
                manifest,
                started: None,
            };
            scope.verify();
            // Exclusive, nonrenewable invocation marker before native graph effects.
            let claimed = scope.root.join("started.json");
            let mut opened = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&claimed)
                .unwrap();
            assert!(
                opened.metadata().unwrap().is_file() && opened.metadata().unwrap().nlink() == 1
            );
            assert_eq!(opened.metadata().unwrap().mode() & 0o7777, 0o600);
            opened
                .write_all(
                    serde_json::to_string(&json!({"version":1,"run":run}))
                        .unwrap()
                        .as_bytes(),
                )
                .unwrap();
            opened.sync_all().unwrap();
            let started = identity(&opened.metadata().unwrap());
            assert_eq!(started, identity(&claimed.symlink_metadata().unwrap()));
            scope.started = Some(started);
            let root_fd = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&scope.root)
                .unwrap();
            assert_eq!(
                identity(&root_fd.metadata().unwrap()),
                scope.roots[&scope.root]
            );
            root_fd.sync_all().unwrap();
            scope.verify();
            scope
        }
        fn verify_roots(&self) {
            for (path, anchor) in &self.roots {
                assert_eq!(
                    &directory(path, 0o700),
                    anchor,
                    "synthetic fixture directory replaced"
                );
            }
            let current: Value = serde_json::from_slice(&bytes(
                &self.root.join("fixture.json"),
                0o600,
                &self.marker,
            ))
            .unwrap();
            assert!(
                current == self.manifest,
                "synthetic fixture manifest changed"
            );
            if let Some(anchor) = &self.started {
                let current: Value =
                    serde_json::from_slice(&bytes(&self.root.join("started.json"), 0o600, anchor))
                        .unwrap();
                assert!(
                    current == json!({"version":1,"run":self.manifest["run"]}),
                    "synthetic invocation marker changed"
                );
            }
        }
        fn verify(&self) {
            self.verify_roots();
            assert_eq!(
                directory(&self.project.join("src"), 0o755),
                self.src,
                "synthetic source directory replaced"
            );
            for (name, anchor) in &self.files {
                let mode = if name.starts_with("src/") {
                    0o644
                } else {
                    0o600
                };
                assert_eq!(
                    &file(&self.project.join(name), mode, false).1,
                    anchor,
                    "synthetic fixture file replaced"
                );
            }
            self.expect("package.json", b"{}\n");
            self.expect("src/server.js", APP.as_bytes());
            self.expect("src/health.txt", b"live-source-ready\n");
            let authored: Value = serde_json::from_slice(&bytes(
                &self.project.join(".hack/hack.project.json"),
                0o600,
                &self.files[".hack/hack.project.json"],
            ))
            .unwrap();
            assert!(
                authored == document(self.manifest["image"].as_str().unwrap()),
                "synthetic authored document changed"
            );
        }
        fn expect(&self, name: &str, expected: &[u8]) {
            let mode = if name.starts_with("src/") {
                0o644
            } else {
                0o600
            };
            assert!(
                bytes(&self.project.join(name), mode, &self.files[name]) == expected,
                "synthetic fixture input differs"
            );
        }
        fn edit(&self, expected: &[u8]) {
            self.verify();
            let path = self.project.join("src/message.txt");
            let (mut opened, anchor) = file(&path, 0o644, true);
            assert_eq!(anchor, self.files["src/message.txt"]);
            opened.set_len(0).unwrap();
            opened.write_all(expected).unwrap();
            opened.sync_all().unwrap();
            self.verify();
            self.expect("src/message.txt", expected);
        }
        fn replace(&mut self, expected: &[u8]) {
            self.verify();
            let source = self.project.join("src/message-next.txt");
            let target = self.project.join("src/message.txt");
            let mut opened = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o644)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&source)
                .unwrap();
            assert!(
                opened.metadata().unwrap().is_file() && opened.metadata().unwrap().nlink() == 1
            );
            // Exact new owned descriptor only; do not path-chmod an existing input.
            opened
                .set_permissions(fs::Permissions::from_mode(0o644))
                .unwrap();
            opened.write_all(expected).unwrap();
            opened.sync_all().unwrap();
            let anchor = identity(&opened.metadata().unwrap());
            assert_eq!(file(&source, 0o644, false).1, anchor);
            self.verify();
            fs::rename(&source, &target).unwrap();
            self.files.insert("src/message.txt".into(), anchor);
            self.verify();
            self.expect("src/message.txt", expected);
        }
        fn withdraw(&self) {
            self.verify();
            entries(
                &self.project.join("src"),
                &["health.txt", "message.txt", "server.js"],
            );
            assert!(!self.project.join("src-withdrawn").try_exists().unwrap());
            fs::rename(self.project.join("src"), self.project.join("src-withdrawn")).unwrap();
            self.verify_roots();
            assert_eq!(
                directory(&self.project.join("src-withdrawn"), 0o755),
                self.src
            );
            entries(
                &self.project.join("src-withdrawn"),
                &["health.txt", "message.txt", "server.js"],
            );
        }
        fn verify_withdrawn(&self, expected: &[u8]) {
            self.verify_roots();
            assert_eq!(
                directory(&self.project.join("src-withdrawn"), 0o755),
                self.src
            );
            assert!(!self.project.join("src").try_exists().unwrap());
            entries(
                &self.project.join("src-withdrawn"),
                &["health.txt", "message.txt", "server.js"],
            );
            assert!(
                bytes(
                    &self.project.join("src-withdrawn/message.txt"),
                    0o644,
                    &self.files["src/message.txt"]
                ) == expected,
                "withdrawn synthetic source differs"
            );
        }
    }

    const INITIAL: &[u8] = b"source-initial\n";
    const EDITED: &[u8] = b"source-edited\n";
    const REPLACED: &[u8] = b"source-atomic-replacement\n";
    const APP: &str = "const routes = new Map([[\"/health.txt\", \"/app/health.txt\"], [\"/message.txt\", \"/app/message.txt\"]]);\nBun.serve({hostname: \"0.0.0.0\", port: 8080, fetch(request) { const file = routes.get(new URL(request.url).pathname); return file ? new Response(Bun.file(file), {headers: {\"cache-control\": \"no-store\"}}) : new Response(\"missing\", {status: 404}); }});\n";

    fn document(image: &str) -> Value {
        json!({"schema_version":1,"name":"native-source-fixture",
            "source":{"mode":"host-mounted","root":"."},
            "services":{"web":{"image":image,"entrypoint":{"exec":[]},
                "command":{"exec":["/usr/local/bin/bun","/app/server.js"]},"init":true,
                "restart":{"kind":"no"},"shutdown":{"signal":"SIGTERM","grace":"5s"},
                "mounts":[{"source":"src","target":"/app","access":"read-only"}],
                "readiness":{"kind":"exec","command":{"exec":["/usr/local/bin/bun","-e",
                    "if (await (await fetch(\"http://127.0.0.1:8080/health.txt\", {signal: AbortSignal.timeout(1000)})).text() !== \"live-source-ready\\n\") process.exit(1)"]},
                    "interval":"200ms","timeout":"2s","retries":20}}}})
    }

    fn remaining(deadline: Instant) -> Duration {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .expect("owned live-source fixture deadline expired")
    }

    // Use the existing engine and source owners under the same mutation lease.
    // This is a native backend proof, not a new native frontend exec capability.
    fn exec(
        candidate: &Candidate,
        ready: &Receipt,
        argv: &[&str],
        deadline: Instant,
    ) -> (i32, Vec<u8>, Vec<u8>) {
        remaining(deadline);
        let engine = Engine::connect(candidate).unwrap();
        let (receipt, _) = journal::load(
            candidate,
            ready.review.scope().run,
            engine.guest().incarnation(),
            engine.guest().boot_id(),
        )
        .unwrap();
        receipt.check_binding(ready).unwrap();
        let backend = OwnedBackend {
            engine,
            launcher: None,
            leases: BTreeMap::new(),
        };
        let before = snapshot(&backend, receipt.clone()).unwrap();
        assert_eq!(before.receipt.phase, Phase::ReadyObserved);
        assert_eq!(
            before.observations["web"],
            Some(Observation::Running {
                health: execution::Health::Healthy,
            })
        );
        let workload = &receipt.resources["container:web"];
        let observed = inspected(&backend, &receipt, workload).unwrap().unwrap();
        assert_eq!(observed["HostConfig"]["PublishAllPorts"], false);
        let bindings = &observed["HostConfig"]["PortBindings"];
        assert!(
            bindings.is_null()
                || bindings
                    .as_object()
                    .is_some_and(|bindings| bindings.is_empty()),
            "fixture publishes host ports"
        );
        let ports = &observed["NetworkSettings"]["Ports"];
        assert!(
            ports.is_null()
                || ports
                    .as_object()
                    .is_some_and(|ports| ports.values().all(|bindings| bindings.is_null()
                        || bindings
                            .as_array()
                            .is_some_and(|bindings| bindings.is_empty()))),
            "fixture has dynamic host ports"
        );
        let id = workload.id.as_deref().unwrap();
        let result = backend
            .engine
            .service_exec(
                id,
                &argv.iter().map(|arg| (*arg).into()).collect::<Vec<_>>(),
                None,
                remaining(deadline).min(Duration::from_secs(12)),
            )
            .unwrap();
        let after = snapshot(&backend, receipt).unwrap();
        after.receipt.check_binding(ready).unwrap();
        assert_eq!(before.observations, after.observations);
        assert!(!result.truncated);
        remaining(deadline);
        (result.exit_code, result.stdout, result.stderr)
    }

    fn http(candidate: &Candidate, ready: &Receipt, expected: &[u8], deadline: Instant) {
        let result = exec(
            candidate,
            ready,
            &[
                "/usr/local/bin/bun",
                "-e",
                "process.stdout.write(await (await fetch(\"http://127.0.0.1:8080/message.txt\", {signal: AbortSignal.timeout(2000)})).text())",
            ],
            deadline,
        );
        assert_eq!(result.0, 0);
        assert!(result.2.is_empty());
        assert!(result.1 == expected, "synthetic HTTP data differs");
    }

    fn fixture() -> (
        crate::provider::graph::tests::Fixture,
        PathBuf,
        Candidate,
        String,
    ) {
        let owner = crate::provider::graph::tests::Fixture::new();
        let root = owner.0.join("live-fixture");
        let project = root.join("project");
        let home = root.join("native-home");
        for path in [
            &root,
            &project,
            &project.join(".hack"),
            &home,
            &project.join("src"),
        ] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        let src = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(project.join("src"))
            .unwrap();
        src.set_permissions(fs::Permissions::from_mode(0o755))
            .unwrap();
        let image = image();
        for (name, data, mode) in [
            ("package.json", b"{}\n".to_vec(), 0o600),
            (
                ".hack/hack.project.json",
                serde_json::to_vec(&document(&image)).unwrap(),
                0o600,
            ),
            ("src/server.js", APP.as_bytes().to_vec(), 0o644),
            ("src/health.txt", b"live-source-ready\n".to_vec(), 0o644),
            ("src/message.txt", INITIAL.to_vec(), 0o644),
        ] {
            let mut opened = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(project.join(name))
                .unwrap();
            opened
                .set_permissions(fs::Permissions::from_mode(mode))
                .unwrap();
            opened.write_all(&data).unwrap();
        }
        let files = [
            "package.json",
            ".hack/hack.project.json",
            "src/server.js",
            "src/health.txt",
            "src/message.txt",
        ]
        .into_iter()
        .map(|name| {
            let mode = if name.starts_with("src/") {
                0o644
            } else {
                0o600
            };
            (name.to_owned(), file(&project.join(name), mode, false).1)
        })
        .collect::<BTreeMap<_, _>>();
        let manifest = json!({"version":1,"run":RUN,"image":image,
            "fixture":directory(&root,0o700),"project":directory(&project,0o700),
            "home":directory(&home,0o700),"hack":directory(&project.join(".hack"),0o700),
            "src":directory(&project.join("src"),0o755),"files":files});
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join("fixture.json"))
            .unwrap();
        marker
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        (
            owner,
            root,
            Candidate::discover_installed(&home).unwrap(),
            image,
        )
    }

    #[test]
    fn fixture_edits_preserve_descriptor_ownership_and_original_source_directory() {
        let (_owner, root, candidate, image) = fixture();
        let mut scope = Scope::admit(&root, &candidate, &root.join("project"), &image, RUN);
        scope.expect("src/message.txt", INITIAL);
        scope.edit(EDITED);
        scope.replace(REPLACED);
        scope.withdraw();
        scope.verify_withdrawn(REPLACED);
        assert!(root.join("started.json").is_file());
    }
    #[test]
    fn fixture_scope_refuses_source_aliases_without_changing_foreign_data() {
        for hardlink in [false, true] {
            let (_owner, root, candidate, image) = fixture();
            let foreign = root.parent().unwrap().join("foreign-message");
            let mut opened = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o644)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&foreign)
                .unwrap();
            opened
                .set_permissions(fs::Permissions::from_mode(0o644))
                .unwrap();
            opened.write_all(INITIAL).unwrap();
            let original = identity(&opened.metadata().unwrap());
            let message = root.join("project/src/message.txt");
            fs::remove_file(&message).unwrap();
            if hardlink {
                fs::hard_link(&foreign, &message).unwrap();
            } else {
                symlink(&foreign, &message).unwrap();
            }
            assert!(
                std::panic::catch_unwind(|| Scope::admit(
                    &root,
                    &candidate,
                    &root.join("project"),
                    &image,
                    RUN
                ))
                .is_err()
            );
            assert!(!root.join("started.json").exists());
            assert!(fs::read(&foreign).unwrap() == INITIAL);
            assert_eq!(identity(&foreign.symlink_metadata().unwrap()), original);
        }
    }
    #[test]
    fn fixture_scope_refuses_rebound_project_and_existing_invocation_before_edit() {
        let (_owner, root, candidate, image) = fixture();
        let scope = Scope::admit(&root, &candidate, &root.join("project"), &image, RUN);
        assert!(
            std::panic::catch_unwind(|| Scope::admit(
                &root,
                &candidate,
                &root.join("project"),
                &image,
                RUN
            ))
            .is_err()
        );
        let old = root.join("project-original");
        fs::rename(root.join("project"), &old).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("project"))
            .unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("project/src"))
            .unwrap();
        let replacement = root.join("project/src/message.txt");
        fs::write(&replacement, b"unrelated replacement").unwrap();
        assert!(std::panic::catch_unwind(|| scope.edit(EDITED)).is_err());
        assert!(fs::read(&replacement).unwrap() == b"unrelated replacement");
        assert!(fs::read(old.join("src/message.txt")).unwrap() == INITIAL);
    }
    #[test]
    fn fixture_edits_refuse_replaced_inode_and_preexisting_atomic_target() {
        for atomic in [false, true] {
            let (_owner, root, candidate, image) = fixture();
            let mut scope = Scope::admit(&root, &candidate, &root.join("project"), &image, RUN);
            let message = root.join("project/src/message.txt");
            let target = if atomic {
                root.join("project/src/message-next.txt")
            } else {
                fs::rename(&message, root.join("project/src/message-original.txt")).unwrap();
                message.clone()
            };
            let mut opened = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o644)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&target)
                .unwrap();
            opened
                .set_permissions(fs::Permissions::from_mode(0o644))
                .unwrap();
            opened.write_all(b"unrelated replacement").unwrap();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if atomic {
                        scope.replace(REPLACED);
                    } else {
                        scope.edit(EDITED);
                    }
                }))
                .is_err()
            );
            assert!(fs::read(&target).unwrap() == b"unrelated replacement");
            assert!(
                fs::read(if atomic {
                    message
                } else {
                    root.join("project/src/message-original.txt")
                })
                .unwrap()
                    == INITIAL
            );
        }
    }

    #[test]
    fn fixture_withdrawal_refuses_an_added_descendant_before_renaming_source() {
        let (_owner, root, candidate, image) = fixture();
        let scope = Scope::admit(&root, &candidate, &root.join("project"), &image, RUN);
        let added = root.join("project/src/foreign-descendant");
        fs::write(&added, b"foreign retained").unwrap();
        assert!(std::panic::catch_unwind(|| scope.withdraw()).is_err());
        assert!(root.join("project/src").is_dir());
        assert!(!root.join("project/src-withdrawn").exists());
        assert!(fs::read(&added).unwrap() == b"foreign retained");
        assert!(fs::read(root.join("project/src/message.txt")).unwrap() == INITIAL);
    }

    #[test]
    #[ignore = "Caller-prepared exact synthetic project share, isolated development pool, pinned Linux ARM64 Bun image and 300s external watchdog required"]
    fn approved_live_source_preserves_host_edits_and_cleanup_after_selected_source_moves() {
        let deadline = Instant::now() + Duration::from_secs(180);
        let candidate = Candidate::discover_installed(Path::new(
            &std::env::var("HACK_LOCAL_TEST_ROOT").unwrap(),
        ))
        .unwrap();
        let project = PathBuf::from(std::env::var("HACK_NATIVE_SOURCE_TEST_PROJECT").unwrap());
        let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
        let run_id = std::env::var("HACK_NATIVE_SOURCE_TEST_RUN").unwrap();
        assert!(image_id(&image));
        assert!(super::super::super::hex(&run_id, 32));
        let fixture = PathBuf::from(std::env::var("HACK_NATIVE_SOURCE_TEST_FIXTURE").unwrap());
        let mut scope = Scope::admit(&fixture, &candidate, &project, &image, &run_id);
        assert!(
            !candidate
                .state_root
                .join("run/native-graphs")
                .join(&run_id)
                .exists()
        );
        scope.expect("package.json", b"{}\n");
        scope.expect("src/server.js", APP.as_bytes());
        scope.expect("src/health.txt", b"live-source-ready\n");
        scope.expect("src/message.txt", INITIAL);
        assert!(!project.join("src-withdrawn").exists());
        assert!(!project.join("src/guest-write").exists());
        let authored: Value = serde_json::from_slice(&bytes(
            &project.join(".hack/hack.project.json"),
            0o600,
            &scope.files[".hack/hack.project.json"],
        ))
        .unwrap();
        assert!(
            authored == document(&image),
            "synthetic authored document differs"
        );
        {
            let engine = Engine::connect(&candidate).unwrap();
            assert_eq!(
                engine.guest().profile(),
                crate::provider::Profile::Development
            );
            let share = engine.guest().project_share().unwrap();
            assert_eq!(share.project, project);
            assert!(share.unfiltered_source);
            share.validate().unwrap();
        }
        let metadata: EnvMetadata = serde_json::from_value(json!({"metadata_version":1,
            "overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[]}))
        .unwrap();
        scope.verify();
        let prepared = selection::select(
            &candidate,
            selection::Options {
                project: &project,
                branch: Some("live-source-fixture"),
                run: &run_id,
                profiles: &[],
                explicit_overlay: None,
                metadata,
                deadline,
            },
        )
        .unwrap()
        .prepare(&candidate, &BTreeMap::new())
        .unwrap();
        scope.verify();
        let ready = run(&candidate, prepared).unwrap();
        assert_eq!(serde_json::to_value(&ready).unwrap()["version"], 3);
        assert_eq!(ready.phase, Phase::ReadyObserved);
        assert_eq!(ready.source.as_ref().unwrap().share.project, project);
        http(&candidate, &ready, INITIAL, deadline);
        scope.edit(EDITED);
        http(&candidate, &ready, EDITED, deadline);
        scope.replace(REPLACED);
        http(&candidate, &ready, REPLACED, deadline);
        let denied = exec(
            &candidate,
            &ready,
            &[
                "/usr/local/bin/bun",
                "-e",
                "try { await Bun.write(\"/app/guest-write\", \"synthetic-denied\"); process.exit(71); } catch (error) { if (!error || error.code !== \"EROFS\") process.exit(72); } if (await Bun.file(\"/app/guest-write\").exists()) process.exit(73); process.stdout.write(\"read-only\")",
            ],
            deadline,
        );
        assert_eq!(denied.0, 0);
        assert_eq!(denied.1, b"read-only");
        assert!(!project.join("src/guest-write").exists());
        remaining(deadline);
        scope.withdraw();
        assert_eq!(
            inspect(&candidate, &run_id).unwrap_err().code,
            "native_graph_source"
        );
        let removed = cleanup(&candidate, &run_id).unwrap();
        assert_eq!(removed.phase, Phase::Removed);
        removed.check_binding(&ready).unwrap();
        let final_state = inspect(&candidate, &run_id).unwrap();
        assert_eq!(final_state.receipt.phase, Phase::Removed);
        assert!(final_state.observations.values().all(Option::is_none));
        scope.verify_withdrawn(REPLACED);
        scope.expect("package.json", b"{}\n");
        assert!(!project.join("src").exists());
        remaining(deadline);
    }
}

#[test]
fn finite_native_logs_bind_exact_member_tail_and_restart_generation_without_effects() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(2)).unwrap();
    let name = session.receipt.resources["container:web"].name.clone();
    let id = session.receipt.resources["container:web"]
        .id
        .clone()
        .unwrap();
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&name)
        .unwrap()["State"]["StartedAt"] = json!("2026-10-09T00:00:00.000000000Z");
    let effects = session.backend.state.borrow().effects.clone();
    let deadline = Instant::now() + Duration::from_secs(2);
    let logs = logs_with(
        &session.backend,
        session.receipt.clone(),
        "web",
        17,
        deadline,
    )
    .unwrap();
    assert_eq!(logs.container, id);
    assert_eq!(logs.stdout, "authored stdout\n");
    assert_eq!(logs.stderr, "authored stderr\n");
    assert!(logs.truncated);
    assert_eq!(session.backend.state.borrow().log_reads, [(id.clone(), 17)]);
    assert_eq!(session.backend.state.borrow().effects, effects);
    for (service, tail) in [("foreign", 17), ("web", 0), ("web", 1001)] {
        assert!(
            logs_with(
                &session.backend,
                session.receipt.clone(),
                service,
                tail,
                deadline
            )
            .is_err()
        );
    }
    assert_eq!(session.backend.state.borrow().log_reads.len(), 1);
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&name)
        .unwrap()["Config"]["Labels"]["io.hack-local.graph"] = json!("f".repeat(32));
    assert!(
        logs_with(
            &session.backend,
            session.receipt.clone(),
            "web",
            17,
            deadline
        )
        .is_err()
    );
    assert_eq!(session.backend.state.borrow().log_reads.len(), 1);
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&name)
        .unwrap()["Config"]["Labels"]["io.hack-local.graph"] = json!(RUN);
    session.backend.state.borrow_mut().restart_on_logs = true;
    assert!(
        logs_with(
            &session.backend,
            session.receipt.clone(),
            "web",
            17,
            deadline
        )
        .is_err()
    );
    assert_eq!(session.backend.state.borrow().log_reads.len(), 2);
    assert_eq!(session.backend.state.borrow().effects, effects);
}

#[test]
fn finite_native_logs_share_one_deadline_with_all_source_and_data_checks() {
    let fixture = Fixture::new(basic());
    let (graph, mut session) =
        fixture.session(fixture.prepared(json!({"web":{}}), &BTreeMap::new()));
    execution::run(&graph, &mut session, Duration::from_secs(2)).unwrap();
    let name = session.receipt.resources["container:web"].name.clone();
    session
        .backend
        .state
        .borrow_mut()
        .containers
        .get_mut(&name)
        .unwrap()["State"]["StartedAt"] = json!("2026-10-09T00:00:00.000000000Z");
    session
        .backend
        .state
        .borrow_mut()
        .log_data_deadlines
        .clear();
    let deadline = Instant::now() + Duration::from_secs(2);
    logs_with(
        &session.backend,
        session.receipt.clone(),
        "web",
        17,
        deadline,
    )
    .unwrap();
    {
        let state = session.backend.state.borrow();
        assert_eq!(state.log_source_deadlines, vec![deadline; 4]);
        assert_eq!(state.log_data_deadlines, vec![deadline; 4]);
    }
    let effects = session.backend.state.borrow().effects.clone();
    {
        let mut state = session.backend.state.borrow_mut();
        state.log_source_deadlines.clear();
        state.log_data_deadlines.clear();
        state.expire_source_check = 4;
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    assert!(
        logs_with(
            &session.backend,
            session.receipt.clone(),
            "web",
            17,
            deadline
        )
        .is_err()
    );
    let state = session.backend.state.borrow();
    assert_eq!(state.log_source_deadlines, vec![deadline; 4]);
    assert_eq!(state.log_data_deadlines, vec![deadline; 3]);
    assert_eq!(state.log_reads.len(), 2);
    assert_eq!(state.effects, effects);
    drop(state);
    assert!(
        logs_with(
            &session.backend,
            session.receipt.clone(),
            "web",
            17,
            Instant::now()
        )
        .is_err()
    );
    assert_eq!(session.backend.state.borrow().log_reads.len(), 2);
}
