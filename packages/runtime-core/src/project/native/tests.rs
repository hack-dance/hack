use super::*;
use crate::project::execution::{self, Driver, Event, Health, Observation};
use serde_json::{Value, json};
use std::time::Duration;

fn request(project: &Value, metadata: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "request_version":1,
        "project":serde_json::to_string(project).unwrap(),
        "env_metadata":{
            "metadata_version":1,"overlay":null,"overlay_exists":false,
            "workloads":metadata,"inactive_scopes":[]
        }
    }))
    .unwrap()
}

fn lower(
    project: &Value,
    metadata: Value,
    values: &ManagedValues,
) -> Result<NativeInputs, CandidateError> {
    compile(CompileOptions {
        request: &request(project, metadata),
        profiles: &[],
        managed_values: values,
    })
}

fn basic() -> Value {
    json!({"schema_version":1,"name":"fixture","services":{"web":{"image":"fixture/web:1"}}})
}

fn refusal(result: Result<NativeInputs, CandidateError>, code: &str) {
    let error = match result {
        Ok(_) => panic!("expected refusal"),
        Err(error) => error,
    };
    assert_eq!(error.code, code);
    let encoded = serde_json::to_string(&error).unwrap();
    assert!(!encoded.contains("synthetic-private"));
    assert!(!encoded.contains("authored-canary"));
}

#[test]
fn late_workload_and_binding_refusals_never_copy_private_values() {
    let project = json!({"schema_version":1,"name":"fixture","services":{
        "a.first":{"image":"first"},"z.last":{"image":"last"}
    }});
    let metadata = json!({
        "a.first":{"TOKEN":{"scope":"a.first","secret":true}},
        "z.last":{"LATE":{"scope":"z.last","secret":true}}
    });
    let values = BTreeMap::from([
        (
            "a.first".into(),
            BTreeMap::from([("TOKEN".into(), "synthetic-private-first".into())]),
        ),
        (
            "z.last".into(),
            BTreeMap::from([("LATE".into(), "synthetic-private-last".into())]),
        ),
    ]);
    let originals = values.clone();

    // Positive control: real compiler selection reaches the private copy pass.
    PRIVATE_COPIES.with(|copies| copies.set(0));
    let selected = lower(&project, metadata.clone(), &values).unwrap();
    assert_eq!(PRIVATE_COPIES.with(std::cell::Cell::get), 2);
    assert_eq!(selected.managed_environment, values);
    drop(selected);

    let mut unsupported = project.clone();
    unsupported["services"]["z.last"]["entrypoint"] = json!({"exec":[]});
    let mut missing = values.clone();
    missing.get_mut("z.last").unwrap().clear();
    let mut extra = values.clone();
    extra
        .get_mut("z.last")
        .unwrap()
        .insert("UNSELECTED".into(), "synthetic-private-extra".into());
    let mut oversized = values.clone();
    oversized
        .get_mut("z.last")
        .unwrap()
        .insert("LATE".into(), "x".repeat(32 * 1024));
    for (authored, selected, code) in [
        (&unsupported, &values, "native_graph_subset"),
        (&project, &missing, "native_graph_environment"),
        (&project, &extra, "native_graph_environment"),
        (&project, &oversized, "native_graph_environment"),
    ] {
        let request = request(authored, metadata.clone());
        assert!(hack_config_compiler::environment::plan(&request, &[]).complete());
        PRIVATE_COPIES.with(|copies| copies.set(0));
        refusal(
            compile(CompileOptions {
                request: &request,
                profiles: &[],
                managed_values: selected,
            }),
            code,
        );
        assert_eq!(PRIVATE_COPIES.with(std::cell::Cell::get), 0);
    }
    assert_eq!(values, originals);
}

#[derive(Default)]
struct Fake {
    starts: Vec<String>,
    intents: Vec<String>,
    states: BTreeMap<String, Observation>,
    ready: bool,
}

#[test]
fn authored_network_intent_refuses_before_private_copy_even_when_inactive() {
    let metadata = json!({"web":{"TOKEN":{"scope":"web","secret":true}}});
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-private-network".into())]),
    )]);
    // Network-free callers still reach the existing private delivery owner.
    PRIVATE_COPIES.with(|copies| copies.set(0));
    let accepted = lower(&basic(), metadata.clone(), &values).unwrap();
    assert_eq!(PRIVATE_COPIES.with(std::cell::Cell::get), 1);
    assert_eq!(accepted.managed_environment, values);
    for field in [
        json!({"networks":{"private":{"internal":true}}}),
        json!({"networks":{}}),
        json!({"services":{"web":{"image":"fixture/web:1","networks":{"default":{}}}}}),
        json!({"profiles":["disabled"],"jobs":{"offline":{"image":"fixture/job:1","profiles":["disabled"],"networks":{"default":{"aliases":["offline-alias"]}}}}}),
    ] {
        let mut project = basic();
        project
            .as_object_mut()
            .unwrap()
            .extend(field.as_object().unwrap().clone());
        let mut declared_metadata = metadata.clone();
        if project["jobs"]["offline"].is_object() {
            // Compiler metadata covers every declaration, including inactive jobs.
            declared_metadata["offline"] = json!({});
        }
        let request = request(&project, declared_metadata);
        assert!(hack_config_compiler::environment::plan(&request, &[]).complete());
        PRIVATE_COPIES.with(|copies| copies.set(0));
        refusal(
            compile(CompileOptions {
                request: &request,
                profiles: &[],
                managed_values: &values,
            }),
            "native_graph_subset",
        );
        assert_eq!(PRIVATE_COPIES.with(std::cell::Cell::get), 0);
        refusal(
            review(&request, &[]).map(|_| unreachable!()),
            "native_graph_subset",
        );
    }
}
impl Driver for Fake {
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        match event {
            Event::StartIntent { service } => self.intents.push(service.into()),
            Event::Ready => self.ready = true,
            _ => {}
        }
        Ok(())
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        assert!(self.intents.iter().any(|intent| intent == service));
        assert!(!self.starts.iter().any(|started| started == service));
        self.starts.push(service.into());
        Ok(())
    }
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
        Ok(self.states[service])
    }
}

#[test]
fn real_compiler_core_matches_nc03_contract_without_compose_escaping() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-plan-graph-core.json"
    ))
    .unwrap();
    let compiler = hack_config_compiler::environment::plan(
        &request(&fixture["project"], json!({"a.web":{},"z.seed":{}})),
        &[],
    );
    let PlanResult::Success {
        plan,
        environment_plan,
        ..
    } = compiler
    else {
        panic!("shared fixture must compile")
    };
    assert_eq!(serde_json::to_value(plan).unwrap(), fixture["plan"]);
    assert_eq!(
        serde_json::to_value(environment_plan).unwrap(),
        fixture["environment_plan"]
    );
    let inputs = lower(
        &fixture["project"],
        json!({"a.web":{},"z.seed":{}}),
        &BTreeMap::new(),
    )
    .unwrap();
    let web = &inputs.workloads["a.web"];
    assert_eq!(json!(web.command), fixture["native"]["command"]);
    assert_eq!(json!(web.entrypoint), fixture["native"]["entrypoint"]);
    assert_eq!(json!(web.environment), fixture["native"]["environment"]);
    assert_eq!(
        json!(web.readiness.as_ref().unwrap().test),
        fixture["native"]["health_test"]
    );
    assert_eq!(web.readiness.as_ref().unwrap().interval_ms, 1000);
    assert_eq!(web.readiness.as_ref().unwrap().timeout_ms, 100);
    assert_eq!(
        json!(inputs.workloads["z.seed"].command),
        fixture["native"]["job_command"]
    );
    assert!(matches!(web.kind, WorkloadKind::Service));
    assert!(matches!(inputs.workloads["z.seed"].kind, WorkloadKind::Job));
    assert_eq!(inputs.graph.services["z.seed"].ready, Condition::Completed);
    assert_eq!(
        inputs.graph.services["a.web"].dependencies["z.seed"],
        Condition::Completed
    );
    let mut driver = Fake {
        states: BTreeMap::from([
            ("z.seed".into(), Observation::Exited { code: 0 }),
            (
                "a.web".into(),
                Observation::Running {
                    health: Health::Healthy,
                },
            ),
        ]),
        ..Fake::default()
    };
    execution::run(&inputs.graph, &mut driver, Duration::from_secs(1)).unwrap();
    assert_eq!(driver.starts, ["z.seed", "a.web"]);
    assert_eq!(driver.intents, driver.starts);
    assert!(driver.ready);
}

#[test]
fn failed_job_never_starts_its_dependent() {
    let project = json!({"schema_version":1,"name":"fixture", "jobs":{"seed":{"image":"seed"}},
        "services":{"web":{"image":"web","depends_on":[{"job":"seed","condition":"completed"}]}}});
    let inputs = lower(&project, json!({"web":{},"seed":{}}), &BTreeMap::new()).unwrap();
    let mut driver = Fake {
        states: BTreeMap::from([("seed".into(), Observation::Exited { code: 7 })]),
        ..Fake::default()
    };
    assert!(execution::run(&inputs.graph, &mut driver, Duration::from_secs(1)).is_err());
    assert_eq!(driver.starts, ["seed"]);
    assert!(!driver.ready);
}

#[test]
fn service_started_ready_and_job_completion_remain_distinct() {
    let project = json!({"schema_version":1,"name":"fixture",
    "services":{
        "z.started":{"image":"started"},
        "m.healthy":{"image":"healthy","depends_on":[{"service":"z.started","condition":"started"}],
            "readiness":{"kind":"exec","command":{"exec":["/bin/check"]},"interval":"1s","timeout":"1s","retries":1}},
        "a.consumer":{"image":"consumer","depends_on":[{"service":"m.healthy","condition":"ready"}]}
    }});
    let inputs = lower(
        &project,
        json!({"z.started":{},"m.healthy":{},"a.consumer":{}}),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(
        inputs.graph.services["m.healthy"].dependencies["z.started"],
        Condition::Started
    );
    assert_eq!(
        inputs.graph.services["a.consumer"].dependencies["m.healthy"],
        Condition::Healthy
    );
    let mut driver = Fake {
        states: BTreeMap::from([
            (
                "z.started".into(),
                Observation::Running {
                    health: Health::None,
                },
            ),
            (
                "m.healthy".into(),
                Observation::Running {
                    health: Health::Healthy,
                },
            ),
            (
                "a.consumer".into(),
                Observation::Running {
                    health: Health::None,
                },
            ),
        ]),
        ..Fake::default()
    };
    execution::run(&inputs.graph, &mut driver, Duration::from_secs(1)).unwrap();
    assert_eq!(driver.starts, ["z.started", "m.healthy", "a.consumer"]);
}

#[test]
fn profiles_are_owned_by_real_compiler_and_inactive_values_refuse() {
    let project = json!({"schema_version":1,"name":"fixture","profiles":["debug"],
        "services":{"web":{"image":"web"},"debug":{"image":"debug","profiles":["debug"]}}});
    let bytes = request(&project, json!({"web":{},"debug":{}}));
    let empty = BTreeMap::new();
    let plain = compile(CompileOptions {
        request: &bytes,
        profiles: &[],
        managed_values: &empty,
    })
    .unwrap();
    assert_eq!(
        plain
            .workloads
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["web"]
    );
    let selected = compile(CompileOptions {
        request: &bytes,
        profiles: &["debug".into()],
        managed_values: &empty,
    })
    .unwrap();
    assert_eq!(selected.selected_profiles, ["debug"]);
    assert!(selected.workloads.contains_key("debug"));
    assert_ne!(selected.semantic_hash, plain.semantic_hash);
    let unexpected = BTreeMap::from([(
        "debug".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-private".into())]),
    )]);
    refusal(
        compile(CompileOptions {
            request: &bytes,
            profiles: &[],
            managed_values: &unexpected,
        }),
        "native_graph_environment",
    );
    let mut dependent = project.clone();
    dependent["services"]["web"]["depends_on"] = json!([{"service":"debug","condition":"started"}]);
    refusal(
        lower(&dependent, json!({"web":{},"debug":{}}), &empty),
        "native_graph_compile",
    );
}

#[test]
fn compiler_environment_remapping_defaults_and_unset_preserve_private_separation() {
    let mut project = basic();
    project["services"]["web"]["environment"] = json!({
        "TOKEN":{"env_ref":"SOURCE_TOKEN"},"MESSAGE":{"literal":"$literal"},
        "FALLBACK":{"default":"public-default"},"OVERRIDE":{"default":"ignored-default"},"DROP":{"unset":true}
    });
    let metadata = json!({"web":{
        "SOURCE_TOKEN":{"scope":"global","secret":true},
        "OVERRIDE":{"scope":"web","secret":false},"DROP":{"scope":"web","secret":true}
    }});
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([
            ("SOURCE_TOKEN".into(), "synthetic-private-$token".into()),
            ("OVERRIDE".into(), "selected-private".into()),
        ]),
    )]);
    let first = lower(&project, metadata.clone(), &values).unwrap();
    assert_eq!(
        first.workloads["web"].environment,
        BTreeMap::from([
            ("MESSAGE".into(), "$literal".into()),
            ("FALLBACK".into(), "public-default".into())
        ])
    );
    assert_eq!(
        first.managed_environment["web"],
        BTreeMap::from([
            ("TOKEN".into(), "synthetic-private-$token".into()),
            ("SOURCE_TOKEN".into(), "synthetic-private-$token".into()),
            ("OVERRIDE".into(), "selected-private".into())
        ])
    );
    assert!(!first.managed_environment["web"].contains_key("DROP"));
    let mut rotated = values.clone();
    rotated
        .get_mut("web")
        .unwrap()
        .insert("SOURCE_TOKEN".into(), "rotated-private".into());
    let second = lower(&project, metadata, &rotated).unwrap();
    assert_eq!(first.semantic_hash, second.semantic_hash);
    assert_eq!(
        first.environment_policy_hash,
        second.environment_policy_hash
    );
    assert_eq!(
        first.local_resolution.resolution_hash,
        second.local_resolution.resolution_hash
    );
}

#[test]
fn public_review_requires_no_private_values_and_binds_compiler_metadata_policy() {
    let project = basic();
    let first_metadata = json!({"web":{"TOKEN":{"scope":"web","secret":true}}});
    let bytes = request(&project, first_metadata.clone());
    let reviewed = review(&bytes, &[]).unwrap();
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-private".into())]),
    )]);
    assert_eq!(
        lower(&project, first_metadata, &values)
            .unwrap()
            .review_identity(),
        reviewed
    );
    let changed = review(
        &request(
            &project,
            json!({"web":{"TOKEN":{"scope":"global","secret":false}}}),
        ),
        &[],
    )
    .unwrap();
    assert_eq!(reviewed.semantic_hash, changed.semantic_hash);
    assert_eq!(
        reviewed.local_resolution_hash,
        changed.local_resolution_hash
    );
    assert_ne!(
        reviewed.environment_policy_hash,
        changed.environment_policy_hash
    );
    assert!(
        !serde_json::to_string(&reviewed)
            .unwrap()
            .contains("synthetic-private")
    );
}

#[test]
fn policy_hash_uses_real_compiler_directives_and_resolved_endpoints_even_when_execution_refuses() {
    let mut project = basic();
    project["services"]["web"]["environment"] =
        json!({"API":{"endpoint":{"kind":"service","name":"web","port":3000,"protocol":"http"}}});
    let hash = |project: &Value| {
        let PlanResult::Success {
            plan,
            environment_plan,
            ..
        } = hack_config_compiler::environment::plan(&request(project, json!({"web":{}})), &[])
        else {
            panic!("endpoint policy must really compile")
        };
        policy_hash(&plan, &environment_plan).unwrap()
    };
    let first = hash(&project);
    project["services"]["web"]["environment"]["API"]["endpoint"]["port"] = json!(3001);
    assert_ne!(first, hash(&project));
    refusal(
        lower(&project, json!({"web":{}}), &BTreeMap::new()),
        "native_graph_subset",
    );
    refusal(
        review(&request(&project, json!({"web":{}})), &[]).map(|_| unreachable!()),
        "native_graph_subset",
    );
}

#[test]
fn missing_extra_nul_and_oversized_private_values_refuse_without_echo() {
    let mut project = basic();
    project["services"]["web"]["environment"] = json!({"TOKEN":{"env_ref":"SOURCE_TOKEN"}});
    let metadata = json!({"web":{"SOURCE_TOKEN":{"scope":"web","secret":true}}});
    refusal(
        lower(&project, metadata.clone(), &BTreeMap::new()),
        "native_graph_environment",
    );
    for values in [
        BTreeMap::from([
            ("EXTRA".into(), "synthetic-private".into()),
            ("SOURCE_TOKEN".into(), "ok".into()),
        ]),
        BTreeMap::from([("SOURCE_TOKEN".into(), "synthetic-private\0".into())]),
        BTreeMap::from([("SOURCE_TOKEN".into(), "x".repeat(32 * 1024))]),
        BTreeMap::from([("SOURCE_TOKEN".into(), "\n".repeat(16 * 1024))]),
    ] {
        refusal(
            lower(
                &project,
                metadata.clone(),
                &BTreeMap::from([("web".into(), values)]),
            ),
            "native_graph_environment",
        );
    }
}

#[test]
fn private_delivery_budget_matches_json_without_serializing_in_adapter() {
    for value in ["plain", "quote\"slash\\", "\n\t\u{1}", "unicode-字"] {
        assert_eq!(
            json_string_bytes(value),
            serde_json::to_vec(value).unwrap().len()
        );
    }
    let mut project = basic();
    project["services"]["web"]["environment"] = json!({"TOKEN":{"env_ref":"TOKEN"}});
    let metadata = json!({"web":{"TOKEN":{"scope":"web","secret":true}}});
    let mut values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "x".repeat(32 * 1024 - 12))]),
    )]);
    let exact = lower(&project, metadata.clone(), &values).unwrap();
    assert_eq!(
        serde_json::to_vec(&exact.managed_environment["web"])
            .unwrap()
            .len(),
        32 * 1024
    );
    values
        .get_mut("web")
        .unwrap()
        .get_mut("TOKEN")
        .unwrap()
        .push('x');
    refusal(
        lower(&project, metadata, &values),
        "native_graph_environment",
    );
}

#[test]
fn graph_names_remain_exact_and_invalid_targets_refuse_before_driver_effects() {
    for (name, dependency, code) in [
        (".alias", None, "graph_service"),
        ("../alias", None, "graph_service"),
        ("web", Some("missing"), "graph_dependency"),
        ("web", Some("web"), "graph_cycle"),
    ] {
        let dependencies = dependency.map_or_else(BTreeMap::new, |name| {
            BTreeMap::from([(name.into(), Condition::Started)])
        });
        let result = Graph::from_services(BTreeMap::from([(
            name.into(),
            Service {
                dependencies,
                ready: Condition::Started,
            },
        )]));
        assert_eq!(result.unwrap_err().code, code);
    }
}

#[test]
fn explicit_shell_empty_entrypoint_and_process_omissions_survive() {
    let omitted = lower(&basic(), json!({"web":{}}), &BTreeMap::new()).unwrap();
    assert!(omitted.workloads["web"].command.is_none());
    assert!(omitted.workloads["web"].entrypoint.is_none());
    assert!(omitted.workloads["web"].init.is_none());
    assert!(omitted.workloads["web"].restart.is_none());
    let mut project = basic();
    project["services"]["web"]["command"] = json!({"shell":"printf '%s' '$literal'"});
    project["services"]["web"]["entrypoint"] = json!({"shell":"exec \"$@\""});
    project["services"]["web"]["init"] = json!(false);
    project["services"]["web"]["shutdown"] = json!({"signal":"SIGINT","grace":"1001ms"});
    project["services"]["web"]["working_directory"] = json!("/app/./work");
    let explicit = lower(&project, json!({"web":{}}), &BTreeMap::new()).unwrap();
    assert_eq!(
        explicit.workloads["web"].entrypoint.as_ref().unwrap(),
        &["/bin/sh", "-c", "exec \"$@\"", "hack-native-entrypoint"]
    );
    assert_eq!(
        explicit.workloads["web"].command.as_ref().unwrap(),
        &["/bin/sh", "-c", "printf '%s' '$literal'"]
    );
    assert_eq!(explicit.workloads["web"].init, Some(false));
    assert_eq!(
        explicit.workloads["web"]
            .shutdown
            .as_ref()
            .unwrap()
            .grace_ms,
        Some(1001)
    );
    assert!(matches!(
        explicit.workloads["web"].shutdown.as_ref().unwrap().signal,
        Some(ShutdownSignal::Int)
    ));
    assert_eq!(
        explicit.workloads["web"].working_directory.as_deref(),
        Some("/app/work")
    );
}

#[test]
fn entrypoint_overrides_without_authored_command_refuse_until_image_cmd_is_qualified() {
    for entrypoint in [
        json!({"exec":["/bin/entrypoint"]}),
        json!({"exec":[]}),
        json!({"shell":"exec \"$@\""}),
    ] {
        let mut project = basic();
        project["services"]["web"]["entrypoint"] = entrypoint;
        let authored = serde_json::to_vec(&project).unwrap();
        assert!(matches!(
            hack_config_compiler::compile(&authored, &[]),
            hack_config_compiler::CompileResult::Success { .. }
        ));
        refusal(
            lower(&project, json!({"web":{}}), &BTreeMap::new()),
            "native_graph_subset",
        );
    }
}

#[test]
fn unsupported_intent_is_never_dropped() {
    let empty = BTreeMap::new();
    for field in [
        json!({"mounts":[{"source":".","target":"/app","access":"read-only"}]}),
        json!({"pull_policy":"never"}),
        json!({"restart":{"kind":"on-failure","max_retries":2}}),
        json!({"readiness":{"kind":"http","port":8080,"path":"/","interval":"1s","timeout":"1s","retries":1}}),
        json!({"readiness":{"kind":"tcp","port":8080,"interval":"1s","timeout":"1s","retries":1}}),
    ] {
        let mut project = basic();
        project["services"]["web"]
            .as_object_mut()
            .unwrap()
            .extend(field.as_object().unwrap().clone());
        refusal(
            lower(&project, json!({"web":{}}), &empty),
            "native_graph_subset",
        );
    }
    let mut build = basic();
    build["services"]["web"] = json!({"build":{"context":"."}});
    refusal(
        lower(&build, json!({"web":{}}), &empty),
        "native_graph_subset",
    );
    let mut endpoint = basic();
    endpoint["services"]["web"]["environment"] =
        json!({"API":{"endpoint":{"kind":"service","name":"web","port":8080,"protocol":"http"}}});
    refusal(
        lower(&endpoint, json!({"web":{}}), &empty),
        "native_graph_subset",
    );
    for field in [
        json!({"storage":{"data":{"kind":"persistent","scope":"worktree"}}}),
        json!({"open":{}}),
        json!({"host_bindings":{"database":{"kind":"host","port":5432,"protocol":"tcp"}}}),
        json!({"routes":{"http":{"web":{"service":"web","port":8080,"hostname":"web"}}}}),
    ] {
        let mut project = basic();
        project
            .as_object_mut()
            .unwrap()
            .extend(field.as_object().unwrap().clone());
        refusal(
            lower(&project, json!({"web":{}}), &empty),
            "native_graph_subset",
        );
    }
    let mut host = basic();
    host["host"] = json!({"processes":{"tunnel":{"command":{"exec":["/bin/tunnel"]}}}});
    let mut bytes: Value = serde_json::from_slice(&request(&host, json!({"web":{}}))).unwrap();
    bytes["env_metadata"]["host"] = json!({"default":{},"workloads":{}});
    refusal(
        compile(CompileOptions {
            request: &serde_json::to_vec(&bytes).unwrap(),
            profiles: &[],
            managed_values: &empty,
        }),
        "native_graph_subset",
    );
}

#[test]
fn compiler_refuses_duplicate_keys_cycles_missing_readiness_and_malformed_input() {
    let empty = BTreeMap::new();
    let duplicate = request(&basic(), json!({"web":{}}));
    let mut duplicate: Value = serde_json::from_slice(&duplicate).unwrap();
    duplicate["project"] =
        json!("{\"schema_version\":1,\"name\":\"authored-canary\",\"name\":\"other\"}");
    refusal(
        compile(CompileOptions {
            request: &serde_json::to_vec(&duplicate).unwrap(),
            profiles: &[],
            managed_values: &empty,
        }),
        "native_graph_compile",
    );
    for project in [
        json!({"schema_version":1,"name":"fixture","services":{"web":{"image":"web","depends_on":[{"service":"web","condition":"started"}]}}}),
        json!({"schema_version":1,"name":"fixture","services":{"web":{"image":"web","depends_on":[{"service":"dependency","condition":"ready"}]},"dependency":{"image":"dep"}}}),
    ] {
        let names = project["services"]
            .as_object()
            .unwrap()
            .keys()
            .map(|name| (name.clone(), json!({})))
            .collect::<serde_json::Map<_, _>>();
        refusal(
            lower(&project, Value::Object(names), &empty),
            "native_graph_compile",
        );
    }
    refusal(
        compile(CompileOptions {
            request: b"authored-canary",
            profiles: &[],
            managed_values: &empty,
        }),
        "native_graph_compile",
    );
    refusal(
        lower(
            &json!({"schema_version":1,"name":"empty"}),
            json!({}),
            &empty,
        ),
        "graph_budget",
    );
}
