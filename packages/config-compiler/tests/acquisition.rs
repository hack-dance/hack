use hack_config_compiler::{artifacts, compile, environment::plan, local::resolve, protocol};
use serde_json::{Value, json};

fn project() -> Value {
    json!({"schema_version":1,"name":"example","profiles":["dev"],"services":{"web":{"image":"web:1"}},"jobs":{"check":{"image":"check:1"}}})
}
fn compiled(project: &Value, profiles: &[String]) -> Value {
    serde_json::to_value(compile(project.to_string().as_bytes(), profiles)).unwrap()
}
fn refusal(result: &Value, code: &str) {
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["diagnostics"][0]["code"], code, "{result}");
}

#[test]
fn omitted_acquisition_policy_preserves_previous_plan_and_hashes() {
    let project = project();
    let result = compiled(&project, &[]);
    assert_eq!(
        result["semantic_hash"],
        "ee92e08522a5abe049c81847d8393415197f8c4adb75399360d61b3808f7a7a4"
    );
    assert!(
        result["plan"]["services"]["web"]
            .get("pull_policy")
            .is_none()
    );
    assert!(result["plan"]["jobs"]["check"].get("pull_policy").is_none());
    let request = json!({"request_version":1,"project":project.to_string()});
    let resolved = serde_json::to_value(resolve(request.to_string().as_bytes(), &[])).unwrap();
    assert_eq!(
        resolved["local_resolution"]["resolution_hash"],
        "6bf9f7b546ad21b8ba49eeb2e05844130d7272e0b45a9360ab48bca5d16a03fb"
    );
    assert_eq!(result["plan"], resolved["plan"]);
    assert_eq!(protocol()["acquisition_plan_version"], 1);
    assert_eq!(protocol()["process_plan_version"], 1);
}

#[test]
fn every_policy_source_combination_preserves_exactly_one_source() {
    for (namespace, name) in [("services", "web"), ("jobs", "check")] {
        for policy in ["always", "never", "missing", "build"] {
            for (image, build) in [(false, false), (true, false), (false, true), (true, true)] {
                let mut project = project();
                project[namespace][name] = json!({"pull_policy":policy});
                if image {
                    project[namespace][name]["image"] = json!("image:1");
                }
                if build {
                    project[namespace][name]["build"] = json!({"context":"."});
                }
                let result = compiled(&project, &[]);
                if image == build {
                    refusal(&result, "image_build_exclusive");
                } else if (policy == "build") != build {
                    refusal(&result, "invalid_pull_policy_source");
                    assert_eq!(
                        result["diagnostics"][0]["pointer"],
                        format!("/{namespace}/{name}/pull_policy")
                    );
                } else {
                    assert_eq!(result["ok"], true, "{result}");
                    assert_eq!(result["plan"][namespace][name]["pull_policy"], policy);
                    assert_eq!(
                        result["plan"][namespace][name].get("image").is_some(),
                        image
                    );
                    assert_eq!(
                        result["plan"][namespace][name].get("build").is_some(),
                        build
                    );
                }
            }
        }
    }
}

#[test]
fn policies_on_inactive_services_and_jobs_are_still_validated() {
    for (namespace, name) in [("services", "web"), ("jobs", "check")] {
        let mut project = project();
        project[namespace][name]["profiles"] = json!(["dev"]);
        project[namespace][name]["pull_policy"] = json!("missing");
        let inactive = compiled(&project, &[]);
        assert_eq!(inactive["ok"], true);
        assert!(inactive["plan"][namespace].get(name).is_none());
        let active = compiled(&project, &["dev".into()]);
        assert_eq!(active["plan"][namespace][name]["pull_policy"], "missing");
        project[namespace][name]["pull_policy"] = json!("build");
        refusal(&compiled(&project, &[]), "invalid_pull_policy_source");
        refusal(
            &compiled(&project, &["dev".into()]),
            "invalid_pull_policy_source",
        );
        project[namespace][name]["pull_policy"] = json!("daily");
        refusal(&compiled(&project, &[]), "invalid_shape");
    }
}

#[test]
fn noncanonical_policies_and_nonstring_shapes_are_redacted() {
    for value in [
        json!(null),
        json!(false),
        json!(1),
        json!(1.5),
        json!([]),
        json!(["always"]),
        json!({"always":null}),
        json!({"kind":"always"}),
        json!({"policy":"private-sentinel"}),
        json!(""),
        json!("ALWAYS"),
        json!(" always "),
        json!("if_not_present"),
        json!("daily"),
        json!("weekly"),
        json!("every_12h"),
        json!("every_private-sentinel"),
        json!("private-sentinel"),
    ] {
        let mut project = project();
        project["services"]["web"]["pull_policy"] = value;
        let result = compiled(&project, &[]);
        refusal(&result, "invalid_shape");
        assert!(!result.to_string().contains("private-sentinel"));
        assert_eq!(
            result["diagnostics"][0]["pointer"],
            "/services/web/pull_policy"
        );
    }
    let mut project = project();
    project["services"]["web"]["pull-policy"] = json!("private-sentinel");
    refusal(&compiled(&project, &[]), "unknown_field");
}

#[test]
fn policy_presence_identity_and_document_order_are_deterministic() {
    let mut project = project();
    let omitted = compiled(&project, &[]);
    let mut hashes = std::collections::BTreeSet::new();
    for policy in ["always", "never", "missing"] {
        project["services"]["web"]["pull_policy"] = json!(policy);
        let result = compiled(&project, &[]);
        assert_ne!(result["semantic_hash"], omitted["semantic_hash"]);
        assert!(hashes.insert(result["semantic_hash"].as_str().unwrap().to_owned()));
        let pretty = serde_json::to_string_pretty(&project).unwrap();
        let reordered = format!(
            "{{\"services\":{},\"jobs\":{},\"profiles\":[\"dev\"],\"name\":\"example\",\"schema_version\":1}}",
            project["services"], project["jobs"]
        );
        assert_eq!(
            serde_json::to_value(compile(pretty.as_bytes(), &[])).unwrap(),
            result
        );
        assert_eq!(
            serde_json::to_value(compile(reordered.as_bytes(), &[])).unwrap(),
            result
        );
    }
    let input = br#"{"schema_version":1,"name":"example","services":{"web":{"image":"web:1","pull_policy":"never","pull_policy":"private-sentinel"}}}"#;
    let result = serde_json::to_value(compile(input, &[])).unwrap();
    refusal(&result, "duplicate_key");
    assert!(!result.to_string().contains("private-sentinel"));
}

#[test]
fn compile_resolve_and_metadata_plan_preserve_symbolic_acquisition_intent() {
    let mut project = project();
    project["services"]["web"]["image"] = json!("image:latest");
    project["services"]["web"]["pull_policy"] = json!("missing");
    project["jobs"]["check"] =
        json!({"build":{"context":"."},"pull_policy":"build","command":{"shell":"exit 97"}});
    let compiled = compiled(&project, &[]);
    let request = json!({"request_version":1,"project":project.to_string()});
    let resolved = serde_json::to_value(resolve(request.to_string().as_bytes(), &[])).unwrap();
    let mut request = request;
    request["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"check":{}},"inactive_scopes":[]});
    let planned = serde_json::to_value(plan(request.to_string().as_bytes(), &[])).unwrap();
    assert_eq!(planned["environment_plan"]["complete"], true);
    for result in [&resolved, &planned] {
        assert_eq!(result["plan"], compiled["plan"]);
        assert_eq!(result["semantic_hash"], compiled["semantic_hash"]);
        assert_eq!(result["plan"]["services"]["web"]["pull_policy"], "missing");
        assert_eq!(result["plan"]["jobs"]["check"]["pull_policy"], "build");
    }
    assert_eq!(planned["local_resolution"], resolved["local_resolution"]);
}

#[test]
fn generated_policy_shape_has_no_default_and_binds_the_source_choice() {
    let (schema, dto) = artifacts().unwrap();
    let schema: Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(
        schema["$defs"]["PullPolicy"]["enum"],
        json!(["always", "never", "missing", "build"])
    );
    assert!(
        schema["$defs"]["Workload"]["properties"]["pull_policy"]
            .get("default")
            .is_none()
    );
    assert_eq!(
        schema["$defs"]["Workload"]["oneOf"][0]["properties"]["pull_policy"]["enum"],
        json!(["always", "never", "missing"])
    );
    assert_eq!(
        schema["$defs"]["Workload"]["oneOf"][1]["properties"]["pull_policy"]["const"],
        "build"
    );
    assert!(
        dto.contains("export type PullPolicy = \"always\" | \"never\" | \"missing\" | \"build\";")
    );
    assert!(dto.contains("pull_policy?: PullPolicy"));
}
