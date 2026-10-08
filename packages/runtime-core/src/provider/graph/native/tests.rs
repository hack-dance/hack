use super::*;
use crate::project::native::{CompileOptions, ManagedValues};
use std::time::{Duration, Instant};

const OWNER: &str = "cccccccccccccccccccccccccccccccc";
fn prepare(project: Value, metadata: Value, values: &ManagedValues) -> native_input::Prepared {
    let request = serde_json::to_vec(&json!({
        "request_version":1,"project":project.to_string(),
        "env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,
            "workloads":metadata,"inactive_scopes":[]}
    }))
    .unwrap();
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
        Ok(if service == "z.seed" {
            Observation::Exited { code: 0 }
        } else {
            Observation::Running {
                health: Health::Healthy,
            }
        })
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
        ("NetworkMode", json!("none")),
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
            .all(|r| r.kind == Kind::Container && r.name.starts_with("hkn-"))
    );
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
fn mutable_images_subsecond_shutdown_custom_source_and_owner_shapes_refuse() {
    for (pointer, value) in [
        ("/services/web/image", json!("latest")),
        ("/services/web/shutdown", json!({"grace":"1500ms"})),
        ("/services/web/shutdown", json!({"grace":"31s"})),
        ("/source", json!({"root":"./other"})),
    ] {
        let mut project = basic();
        if pointer == "/source" {
            project["source"] = value;
        } else {
            project["services"]["web"][pointer.rsplit('/').next().unwrap()] = value;
        }
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
