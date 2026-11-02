use hack_config_compiler::{artifacts, compile, environment::plan, local::resolve, protocol};
use serde_json::{Value, json};

fn project() -> Value {
    json!({"schema_version":1,"name":"example","profiles":["dev"],"services":{"web":{"image":"web:1"}},"jobs":{"check":{"image":"check:1"}}})
}
fn compiled(project: &Value, profiles: &[String]) -> Value {
    serde_json::to_value(compile(project.to_string().as_bytes(), profiles)).unwrap()
}
fn refused(project: &Value, code: &str) -> Value {
    let result = compiled(project, &[]);
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["diagnostics"][0]["code"], code, "{result}");
    result
}

#[test]
fn absent_process_fields_preserve_plan_and_resolution_generation() {
    let project = project();
    let compiled = compiled(&project, &[]);
    // Measured with the matching pre-process candidate tree 3926d78d, preserved as an absent-field compatibility fixture.
    assert_eq!(
        compiled["semantic_hash"],
        "ee92e08522a5abe049c81847d8393415197f8c4adb75399360d61b3808f7a7a4"
    );
    for workload in ["web", "check"] {
        let namespace = if workload == "web" {
            "services"
        } else {
            "jobs"
        };
        for field in ["entrypoint", "init", "shutdown", "restart"] {
            assert!(compiled["plan"][namespace][workload].get(field).is_none());
        }
    }
    let request = json!({"request_version":1,"project":project.to_string()});
    let resolved = serde_json::to_value(resolve(request.to_string().as_bytes(), &[])).unwrap();
    assert_eq!(
        resolved["local_resolution"]["resolution_hash"],
        "6bf9f7b546ad21b8ba49eeb2e05844130d7272e0b45a9360ab48bca5d16a03fb"
    );
    let mut request = request;
    request["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"check":{}},"inactive_scopes":[]});
    let planned = serde_json::to_value(plan(request.to_string().as_bytes(), &[])).unwrap();
    for result in [&resolved, &planned] {
        assert_eq!(result["plan"], compiled["plan"]);
        assert_eq!(result["semantic_hash"], compiled["semantic_hash"]);
    }
    assert_eq!(resolved["local_resolution"], planned["local_resolution"]);
    assert_eq!(protocol()["process_plan_version"], 1);
}

#[test]
fn explicit_entrypoint_clear_preserves_normal_command_and_presence() {
    let mut project = project();
    project["services"]["web"]["command"] = json!({"exec":["server","","--foreground"]});
    let omitted = compiled(&project, &[]);
    for value in [
        json!({"exec":[]}),
        json!({"exec":["entrypoint","","--flag"]}),
        json!({"shell":"exec service \"$@\""}),
    ] {
        project["services"]["web"]["entrypoint"] = value.clone();
        let result = compiled(&project, &[]);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["plan"]["services"]["web"]["entrypoint"], value);
        assert_eq!(
            result["plan"]["services"]["web"]["command"],
            omitted["plan"]["services"]["web"]["command"]
        );
        assert_ne!(result["semantic_hash"], omitted["semantic_hash"]);
    }
    project["services"]["web"]["command"] = json!({"exec":[]});
    refused(&project, "invalid_command");
}

#[test]
fn invalid_entrypoints_are_redacted_without_relaxing_host_or_readiness_commands() {
    for value in [
        json!({"exec":[""]}),
        json!({"exec":["exec","private-sentinel\0"]}),
        json!({"shell":""}),
        json!({"shell":"private-sentinel\0"}),
    ] {
        let mut project = project();
        project["services"]["web"]["entrypoint"] = value;
        let result = refused(&project, "invalid_entrypoint");
        assert_eq!(
            result["diagnostics"][0]["pointer"],
            "/services/web/entrypoint"
        );
        assert!(!result.to_string().contains("private-sentinel"));
    }
    let mut project = project();
    project["host"] = json!({"processes":{"watch":{"command":{"exec":[]}}}});
    refused(&project, "invalid_command");
    project.as_object_mut().unwrap().remove("host");
    project["services"]["web"]["readiness"] =
        json!({"kind":"exec","command":{"exec":[]},"interval":"1s","timeout":"1s","retries":1});
    refused(&project, "invalid_command");
}

#[test]
fn false_init_is_distinct_from_omission_and_true() {
    let mut project = project();
    let omitted = compiled(&project, &[]);
    project["services"]["web"]["init"] = json!(false);
    let disabled = compiled(&project, &[]);
    assert_eq!(disabled["plan"]["services"]["web"]["init"], false);
    assert_ne!(disabled["semantic_hash"], omitted["semantic_hash"]);
    project["services"]["web"]["init"] = json!(true);
    let enabled = compiled(&project, &[]);
    assert_eq!(enabled["plan"]["services"]["web"]["init"], true);
    assert_ne!(enabled["semantic_hash"], disabled["semantic_hash"]);
}

#[test]
fn shutdown_signal_and_grace_are_independent_authored_intents() {
    for signal in [
        "SIGHUP",
        "SIGINT",
        "SIGQUIT",
        "SIGILL",
        "SIGTRAP",
        "SIGABRT",
        "SIGBUS",
        "SIGFPE",
        "SIGKILL",
        "SIGUSR1",
        "SIGSEGV",
        "SIGUSR2",
        "SIGPIPE",
        "SIGALRM",
        "SIGTERM",
        "SIGSTKFLT",
        "SIGCHLD",
        "SIGCONT",
        "SIGSTOP",
        "SIGTSTP",
        "SIGTTIN",
        "SIGTTOU",
        "SIGURG",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGVTALRM",
        "SIGPROF",
        "SIGWINCH",
        "SIGIO",
        "SIGPWR",
        "SIGSYS",
    ] {
        let mut project = project();
        project["services"]["web"]["shutdown"] = json!({"signal":signal});
        assert_eq!(
            compiled(&project, &[])["plan"]["services"]["web"]["shutdown"],
            json!({"signal":signal})
        );
        project["services"]["web"]["shutdown"]["grace"] = json!("45s");
        assert_eq!(
            compiled(&project, &[])["plan"]["services"]["web"]["shutdown"],
            json!({"signal":signal,"grace":"45000ms"})
        );
    }
    let mut project = project();
    project["jobs"]["check"]["shutdown"] = json!({"grace":"2m"});
    assert_eq!(
        compiled(&project, &[])["plan"]["jobs"]["check"]["shutdown"],
        json!({"grace":"120000ms"})
    );
    project["services"]["web"]["shutdown"] = json!({});
    refused(&project, "invalid_shutdown");
}

#[test]
fn shutdown_grace_uses_the_existing_positive_duration_parser_without_admission_caps() {
    for (authored, normalized) in [
        ("1ms", "1ms"),
        ("0001s", "1000ms"),
        ("45s", "45000ms"),
        ("2m", "120000ms"),
        ("1h", "3600000ms"),
        ("4294967295ms", "4294967295ms"),
    ] {
        let mut project = project();
        project["services"]["web"]["shutdown"] = json!({"grace":authored});
        let result = compiled(&project, &[]);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(
            result["plan"]["services"]["web"]["shutdown"]["grace"],
            normalized
        );
    }
    for authored in [
        "",
        "0ms",
        "0s",
        "0m",
        "0h",
        "1.5s",
        "-1s",
        "+1s",
        "1sec",
        " 1s",
        "1s ",
        "1S",
        "4294967296ms",
        "4294968s",
        "71583m",
        "1194h",
        "18446744073709551616ms",
        "private-sentinel",
    ] {
        let mut project = project();
        project["services"]["web"]["shutdown"] = json!({"grace":authored});
        let result = refused(&project, "invalid_duration");
        assert_eq!(
            result["diagnostics"][0]["pointer"],
            "/services/web/shutdown/grace"
        );
        assert!(!result.to_string().contains("private-sentinel"));
    }
    let mut project = project();
    project["services"]["web"]["shutdown"] = json!({"grace":"1s"});
    let first = compiled(&project, &[]);
    project["services"]["web"]["shutdown"]["grace"] = json!("1000ms");
    assert_eq!(
        compiled(&project, &[])["semantic_hash"],
        first["semantic_hash"]
    );
}

#[test]
fn restart_tags_preserve_no_restart_and_failure_retry_presence() {
    for value in [
        json!({"kind":"no"}),
        json!({"kind":"always"}),
        json!({"kind":"unless-stopped"}),
        json!({"kind":"on-failure"}),
        json!({"kind":"on-failure","max_retries":1}),
        json!({"kind":"on-failure","max_retries":4294967295_u32}),
    ] {
        let mut project = project();
        project["services"]["web"]["restart"] = value.clone();
        let result = compiled(&project, &[]);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["plan"]["services"]["web"]["restart"], value);
    }
    let mut project = project();
    let omitted = compiled(&project, &[]);
    project["services"]["web"]["restart"] = json!({"kind":"no"});
    assert_ne!(
        compiled(&project, &[])["semantic_hash"],
        omitted["semantic_hash"]
    );
    project["services"]["web"]["restart"] = json!({"kind":"on-failure","max_retries":0});
    let result = refused(&project, "invalid_restart");
    assert_eq!(
        result["diagnostics"][0]["pointer"],
        "/services/web/restart/max_retries"
    );
}

#[test]
fn perpetual_job_restarts_refuse_before_profile_filtering() {
    for kind in ["always", "unless-stopped"] {
        let mut project = project();
        project["jobs"]["check"]["profiles"] = json!(["dev"]);
        project["jobs"]["check"]["restart"] = json!({"kind":kind});
        refused(&project, "invalid_restart");
        assert_eq!(compiled(&project, &["dev".into()])["ok"], false);
    }
    for value in [
        json!({"kind":"no"}),
        json!({"kind":"on-failure"}),
        json!({"kind":"on-failure","max_retries":3}),
    ] {
        let mut project = project();
        project["jobs"]["check"]["restart"] = value.clone();
        let result = compiled(&project, &[]);
        assert_eq!(result["ok"], true);
        assert_eq!(result["plan"]["jobs"]["check"]["restart"], value);
    }
    for (field, value, code) in [
        ("entrypoint", json!({"exec":[""]}), "invalid_entrypoint"),
        ("shutdown", json!({}), "invalid_shutdown"),
        (
            "restart",
            json!({"kind":"on-failure","max_retries":0}),
            "invalid_restart",
        ),
    ] {
        let mut project = project();
        project["services"]["web"]["profiles"] = json!(["dev"]);
        project["services"]["web"][field] = value;
        refused(&project, code);
    }
}

#[test]
fn process_fields_are_strict_objects_and_do_not_leak_invalid_values() {
    for (field, invalid) in [
        (
            "entrypoint",
            vec![
                json!(null),
                json!([]),
                json!([[]]),
                json!("private-sentinel"),
                json!({}),
                json!({"exec":[],"shell":"private-sentinel"}),
                json!({"exec":[],"secret":"private-sentinel"}),
            ],
        ),
        (
            "init",
            vec![json!(null), json!(0), json!("false"), json!([]), json!({})],
        ),
        (
            "shutdown",
            vec![
                json!(null),
                json!([]),
                json!(["SIGTERM", "1s"]),
                json!({"signal":null}),
                json!({"signal":"TERM"}),
                json!({"signal":15}),
                json!({"signal":"sigterm"}),
                json!({"signal":"SIGUNKNOWN"}),
                json!({"signal":"SIGRTMIN+1"}),
                json!({"grace":null}),
                json!({"grace":1}),
                json!({"signal":"SIGTERM","command":"private-sentinel"}),
            ],
        ),
        (
            "restart",
            vec![
                json!(null),
                json!([]),
                json!(["always"]),
                json!("no"),
                json!({}),
                json!({"kind":"unless_stopped"}),
                json!({"kind":"no","max_retries":1}),
                json!({"kind":"always","max_retries":1}),
                json!({"kind":"on-failure","max_retries":null}),
                json!({"kind":"on-failure","max_retries":-1}),
                json!({"kind":"on-failure","max_retries":1.5}),
                json!({"kind":"on-failure","max_retries":4294967296_u64}),
                json!({"kind":"on-failure","max_retries":"1"}),
                json!({"kind":"no","secret":"private-sentinel"}),
            ],
        ),
    ] {
        for value in invalid {
            let mut project = project();
            project["services"]["web"][field] = value;
            let result = compiled(&project, &[]);
            assert_eq!(result["ok"], false, "{field}: {result}");
            assert!(!result.to_string().contains("private-sentinel"));
        }
    }
}

#[test]
fn generated_process_contracts_keep_closed_tags_and_presence() {
    let (schema, dto) = artifacts().unwrap();
    let schema: Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(schema["$defs"]["Shutdown"]["additionalProperties"], false);
    assert_eq!(schema["$defs"]["Shutdown"]["minProperties"], 1);
    assert_eq!(
        schema["$defs"]["Shutdown"]["properties"]["grace"]["type"],
        "string"
    );
    assert_eq!(
        schema["$defs"]["Workload"]["properties"]["init"]["type"],
        "boolean"
    );
    assert!(
        !schema["$defs"]["Workload"]["required"]
            .as_array()
            .is_some_and(|required| required.contains(&json!("init")))
    );
    assert!(dto.contains("entrypoint?: Entrypoint"));
    assert!(dto.contains("init?: boolean"));
    assert!(dto.contains("shutdown?: Shutdown"));
    assert!(dto.contains("restart?: Restart"));
    assert!(dto.contains("max_retries?: number"));
}
