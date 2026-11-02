use super::*;
use crate::project::native::{CompileOptions, ManagedValues};
use std::time::{Duration, Instant};

const OWNER: &str = "cccccccccccccccccccccccccccccccc";
fn request(project: Value, metadata: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "request_version":1,"project":project.to_string(),
        "env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,
            "workloads":metadata,"inactive_scopes":[]}
    }))
    .unwrap()
}
fn prepare(project: Value, metadata: Value, values: &ManagedValues) -> native_input::Prepared {
    let request = request(project, metadata);
    let namespace = "a".repeat(64);
    let run = "b".repeat(32);
    let scope = native_input::Scope {
        namespace: &namespace,
        run: &run,
    };
    let review = native_input::review(&request, &[], scope).unwrap();
    native_input::prepare(native_input::PrepareOptions {
        compile: CompileOptions {
            request: &request,
            profiles: &[],
            managed_values: values,
        },
        scope,
        expected_review: &review,
        deadline: Instant::now() + Duration::from_secs(60),
    })
    .unwrap()
}
fn image() -> String {
    format!("sha256:{}", "d".repeat(64))
}
fn basic() -> Value {
    json!({"schema_version":1,"name":"fixture","services":{"web":{"image":image()}}})
}
fn two_bridges() -> Value {
    json!({"schema_version":1,"name":"fixture","networks":{"outbound":{"internal":false},"inside":{"internal":true}},"services":{
        "db":{"image":image(),"networks":{"inside":{"aliases":["db-reader"]}}},
        "web":{"image":image(),"networks":{"inside":{},"outbound":{"aliases":["web-public"]}}}
    }})
}

#[test]
fn selected_two_bridge_aliases_lower_to_distinct_owned_resources_and_receipt_five() {
    let prepared = prepare(
        two_bridges(),
        json!({"db":{},"web":{}}),
        &ManagedValues::new(),
    );
    let config = configuration(&prepared, OWNER).unwrap();
    let resources = config.resources();
    assert_eq!(resources.len(), 4);
    assert!(!resources["network:inside"].outbound);
    assert!(resources["network:outbound"].outbound);
    assert_ne!(
        resources["network:inside"].name,
        resources["network:outbound"].name
    );
    assert_eq!(
        resources["container:db"].networks.as_ref().unwrap(),
        &["inside"]
    );
    assert_eq!(
        resources["container:web"].networks.as_ref().unwrap(),
        &["inside", "outbound"]
    );
    let inside = &resources["network:inside"].name;
    let outbound = &resources["network:outbound"].name;
    assert_eq!(
        config.containers()["db"]["NetworkingConfig"]["EndpointsConfig"][inside]["Aliases"],
        json!(["db", "db-reader"])
    );
    assert_eq!(
        config.containers()["web"]["NetworkingConfig"]["EndpointsConfig"][outbound]["Aliases"],
        json!(["web", "web-public"])
    );
    let receipt =
        Receipt::preparing(&config, OWNER, "12345678-abcd-abcd-abcd-123456789abc").unwrap();
    let wire = serde_json::to_value(&receipt).unwrap();
    assert_eq!(wire["version"], 5);
    assert!(
        wire["resources"]["network:inside"]
            .as_object()
            .unwrap()
            .get("outbound")
            .is_none()
    );
    assert_eq!(wire["resources"]["network:outbound"]["outbound"], true);
    assert!(receipt.validate(receipt.review.scope().run, OWNER).is_ok());
    #[cfg(target_os = "macos")]
    assert!(receipt.require_recovery_ready().is_err());
    let mut crossed = serde_json::to_value(&receipt).unwrap();
    crossed["topology"]["attachments"]["db"]["inside"] = json!(["wrong"]);
    let crossed: Receipt = serde_json::from_value(crossed).unwrap();
    assert!(crossed.check_binding(&receipt).is_err());
    let mut old = serde_json::to_value(&receipt).unwrap();
    old["version"] = json!(2);
    assert!(serde_json::from_value::<Receipt>(old).is_err());
}

struct Fake<'a> {
    configs: &'a BTreeMap<String, Value>,
    intents: Vec<String>,
    started: Vec<String>,
}
impl Driver for Fake<'_> {
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        if let Event::StartIntent { service } = event {
            self.intents.push(service.into());
        }
        Ok(())
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        assert_eq!(self.intents.last().map(String::as_str), Some(service));
        assert!(self.configs.contains_key(service));
        self.started.push(service.into());
        Ok(())
    }
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
        Ok(if matches!(service, "z.seed" | "z.check") {
            Observation::Exited { code: 0 }
        } else {
            Observation::Running {
                health: Health::Healthy,
            }
        })
    }
}

#[test]
fn persistent_sqlite_corpus_preserves_source_commands_drop_all_and_fresh_job_starts() {
    // This executes the real compiler/lowerer and scheduler with observations only.
    // The SQL programs are source-pinned for the later real native acceptance; no
    // test here claims that synthetic observations executed SQLite or Engine effects.
    let project: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/native-persistent-sqlite.json"
    ))
    .unwrap();
    let prepared = prepare(
        project.clone(),
        json!({"a.db":{},"b.web":{},"z.seed":{},"z.check":{}}),
        &ManagedValues::new(),
    );
    let config = configuration(&prepared, OWNER).unwrap();
    assert_eq!(config.storage, BTreeSet::from(["database".into()]));
    assert_eq!(
        config.data_mounts.keys().collect::<Vec<_>>(),
        vec!["a.db", "z.seed"]
    );
    assert_eq!(
        config.graph.services["a.db"].dependencies["z.seed"],
        Condition::Completed
    );
    assert_eq!(
        config.graph.services["b.web"].dependencies["a.db"],
        Condition::Healthy
    );
    assert_eq!(
        config.graph.services["z.check"].dependencies["b.web"],
        Condition::Healthy
    );
    assert_eq!(config.resources.len(), 5);
    assert!(
        config
            .resources
            .values()
            .all(|resource| resource.kind != Kind::Volume)
    );
    for (name, value) in &config.configs {
        let authored = project["services"]
            .get(name)
            .or_else(|| project["jobs"].get(name))
            .unwrap();
        assert_eq!(value["Cmd"], authored["command"]["exec"]);
        assert_eq!(value["Entrypoint"], json!([]));
        assert_eq!(value["HostConfig"]["CapDrop"], json!(["ALL"]));
        assert_eq!(
            value["HostConfig"]["SecurityOpt"],
            json!(["no-new-privileges"])
        );
        assert!(value.get("User").is_none());
        assert!(
            value["HostConfig"]["PortBindings"]
                .as_object()
                .is_none_or(|bindings| bindings.is_empty())
        );
    }
    for _compute_attempt in 0..2 {
        let mut driver = Fake {
            configs: &config.configs,
            intents: vec![],
            started: vec![],
        };
        execution::run(&config.graph, &mut driver, Duration::from_secs(2)).unwrap();
        assert_eq!(
            driver
                .started
                .iter()
                .filter(|name| name.as_str() == "z.seed")
                .count(),
            1
        );
        let position = |name: &str| {
            driver
                .started
                .iter()
                .position(|started| started == name)
                .unwrap()
        };
        assert!(position("z.seed") < position("a.db"));
        assert!(position("a.db") < position("b.web"));
        assert!(position("b.web") < position("z.check"));
    }
}

#[test]
fn real_compiler_native_configs_feed_jobs_readiness_and_exact_process_driver() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/native-plan-graph-core.json"
    ))
    .unwrap();
    let mut project = fixture["project"].clone();
    project["services"]["a.web"]["image"] = json!(image());
    project["jobs"]["z.seed"]["image"] = json!(image());
    let prepared = prepare(
        project,
        json!({"a.web":{},"z.seed":{}}),
        &ManagedValues::new(),
    );
    let lowered = configuration(&prepared, OWNER).unwrap();
    let web = &lowered.containers()["a.web"];
    assert_eq!(web["Cmd"], fixture["native"]["command"]);
    assert_eq!(web["Entrypoint"], json!([]));
    assert_eq!(web["Env"], json!(["MESSAGE=$literal"]));
    assert_eq!(web["Healthcheck"]["Test"], fixture["native"]["health_test"]);
    assert_eq!(web["Healthcheck"]["Interval"], 1_000_000_000u64);
    assert_eq!(web["Healthcheck"]["Timeout"], 100_000_000u64);
    assert_eq!(
        lowered.containers()["z.seed"]["Cmd"],
        fixture["native"]["job_command"]
    );
    assert_eq!(web["Labels"]["io.hack-local.input-kind"], "native");
    assert_eq!(
        web["Labels"]["io.hack-local.plan"],
        lowered.review().review_id()
    );
    for (key, value) in [
        (
            "NetworkMode",
            json!("hkn-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-network-0"),
        ),
        ("Memory", json!(0)),
        ("NanoCpus", json!(0)),
        ("Mounts", json!([])),
        ("CapDrop", json!(["ALL"])),
        ("SecurityOpt", json!(["no-new-privileges"])),
    ] {
        assert_eq!(web["HostConfig"][key], value);
    }
    assert!(
        lowered
            .resources()
            .values()
            .all(|r| r.name.starts_with("hkn-"))
    );
    let network = &lowered.resources()["network:default"];
    assert_eq!(network.kind, Kind::Network);
    assert!(network.outbound);
    assert_eq!(
        web["NetworkingConfig"]["EndpointsConfig"][&network.name]["Aliases"],
        json!(["a.web"])
    );
    assert_eq!(
        lowered.resources()["container:a.web"].networks,
        Some(vec!["default".into()])
    );
    assert!(
        check_network_request(
            &crate::provider::NetworkIntent::Isolated,
            lowered.resources()
        )
        .is_err()
    );
    check_network_request(
        &crate::provider::NetworkIntent::Internet,
        lowered.resources(),
    )
    .unwrap();
    let mut driver = Fake {
        configs: lowered.containers(),
        intents: Vec::new(),
        started: Vec::new(),
    };
    execution::run(lowered.graph(), &mut driver, Duration::from_secs(1)).unwrap();
    assert_eq!(driver.started, ["z.seed", "a.web"]);
}

#[test]
fn omission_empty_override_and_whole_second_shutdown_remain_distinct() {
    let prepared = prepare(basic(), json!({"web":{}}), &ManagedValues::new());
    let omitted = configuration(&prepared, OWNER).unwrap();
    for key in [
        "Cmd",
        "Entrypoint",
        "Env",
        "StopSignal",
        "StopTimeout",
        "Healthcheck",
        "WorkingDir",
    ] {
        assert!(omitted.containers()["web"].get(key).is_none());
    }
    let mut project = basic();
    project["services"]["web"]["command"] = json!({"exec":["/bin/echo","$X"]});
    project["services"]["web"]["entrypoint"] = json!({"exec":[]});
    project["services"]["web"]["init"] = json!(true);
    project["services"]["web"]["shutdown"] = json!({"signal":"SIGINT","grace":"2s"});
    let prepared = prepare(project, json!({"web":{}}), &ManagedValues::new());
    let configured = configuration(&prepared, OWNER).unwrap();
    let web = &configured.containers()["web"];
    assert_eq!(web["Entrypoint"], json!([]));
    assert_eq!(web["Cmd"], json!(["/bin/echo", "$X"]));
    assert_eq!(web["HostConfig"]["Init"], true);
    assert_eq!(web["StopSignal"], "SIGINT");
    assert_eq!(web["StopTimeout"], 2);
}

#[test]
fn mutable_images_subsecond_shutdown_and_owner_shapes_refuse() {
    for (pointer, value) in [
        ("/services/web/image", json!("latest")),
        ("/services/web/shutdown", json!({"grace":"1500ms"})),
        ("/services/web/shutdown", json!({"grace":"31s"})),
    ] {
        let mut project = basic();
        project["services"]["web"][pointer.rsplit('/').next().unwrap()] = value;
        let prepared = prepare(project, json!({"web":{}}), &ManagedValues::new());
        assert_eq!(
            configuration(&prepared, OWNER).err().unwrap().code,
            "native_graph_admission"
        );
    }
    let prepared = prepare(basic(), json!({"web":{}}), &ManagedValues::new());
    assert_eq!(
        configuration(&prepared, "owner").err().unwrap().code,
        "native_graph_admission"
    );
}

#[test]
fn custom_source_refuses_before_native_private_preparation() {
    let mut project = basic();
    project["services"]["web"]["environment"] = json!({"TOKEN":{"env_ref":"TOKEN"}});
    let metadata = json!({"web":{"TOKEN":{"scope":"global","secret":true}}});
    let namespace = "a".repeat(64);
    let run = "b".repeat(32);
    let scope = native_input::Scope {
        namespace: &namespace,
        run: &run,
    };
    let valid = request(project.clone(), metadata.clone());
    let review = native_input::review(&valid, &[], scope).unwrap();
    project["source"] = json!({"root":"./other"});
    let unsupported = request(project, metadata);
    assert_eq!(
        native_input::review(&unsupported, &[], scope)
            .err()
            .unwrap()
            .code,
        "native_graph_subset"
    );
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-source-private-canary".into())]),
    )]);
    let before = values.clone();
    assert_eq!(
        native_input::prepare(native_input::PrepareOptions {
            compile: CompileOptions {
                request: &unsupported,
                profiles: &[],
                managed_values: &values,
            },
            scope,
            expected_review: &review,
            deadline: Instant::now() + Duration::from_secs(60),
        })
        .err()
        .unwrap()
        .code,
        "native_graph_subset"
    );
    assert_eq!(values, before);
}

#[cfg(feature = "environment-launcher")]
#[test]
fn managed_values_never_enter_public_create_configuration() {
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-native-private-canary".into())]),
    )]);
    let prepared = prepare(
        basic(),
        json!({"web":{"TOKEN":{"scope":"web","secret":true}}}),
        &values,
    );
    let configured = configuration(&prepared, OWNER).unwrap();
    let bytes = serde_json::to_string(configured.containers()).unwrap();
    assert!(!bytes.contains("synthetic-native-private-canary"));
    assert!(configured.containers()["web"].get("Env").is_none());
    let (_, pending) = prepared.into_parts().unwrap();
    assert_eq!(pending.len(), 1);
}
