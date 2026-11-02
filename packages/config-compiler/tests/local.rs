use hack_config_compiler::{
    MAX_INPUT_BYTES, compile,
    local::{MAX_REQUEST_BYTES, local_schema, resolve},
};
use serde_json::{Value, json};
fn project() -> Value {
    json!({"schema_version":1,"name":"example","environment":{"default_overlay":"project"}})
}
fn request() -> Value {
    json!({"request_version":1,"project":project().to_string()})
}
fn local(value: Value) -> String {
    json!({"schema_version":1,"environment":value}).to_string()
}
fn result(request: &Value) -> Value {
    serde_json::to_value(resolve(&serde_json::to_vec(request).unwrap(), &[])).unwrap()
}
fn refusal(request: &Value, code: &str, role: &str) {
    let r = result(request);
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["diagnostics"][0]["code"], code, "{r}");
    assert_eq!(r["diagnostics"][0]["document"], role, "{r}");
}
#[test]
fn precedence_preserves_absent_base_and_named_selections() {
    let mut r = request();
    assert_eq!(result(&r)["local_resolution"]["overlay"], "project");
    assert_eq!(result(&r)["local_resolution"]["origin"], "project");
    r["primary_local"] = json!(local(json!({"default_overlay":"primary"})));
    assert_eq!(result(&r)["local_resolution"]["overlay"], "primary");
    r["checkout_local"] = json!(local(json!({})));
    assert_eq!(result(&r)["local_resolution"]["origin"], "primary_local");
    r["checkout_local"] = json!(local(json!({"default_overlay":null})));
    assert_eq!(result(&r)["local_resolution"]["overlay"], Value::Null);
    assert_eq!(result(&r)["local_resolution"]["origin"], "checkout_local");
    r["checkout_local"] = json!(local(json!({"default_overlay":"checkout"})));
    assert_eq!(result(&r)["local_resolution"]["overlay"], "checkout");
    r["explicit_overlay"] = json!("explicit");
    assert_eq!(result(&r)["local_resolution"]["overlay"], "explicit");
    assert_eq!(result(&r)["local_resolution"]["origin"], "explicit");
    r["explicit_overlay"] = Value::Null;
    assert_eq!(result(&r)["local_resolution"]["overlay"], Value::Null);
    assert_eq!(result(&r)["local_resolution"]["origin"], "explicit");
}
#[test]
fn default_worktree_policy_is_normalized_and_strict() {
    let r = result(&request());
    assert_eq!(
        r["plan"]["worktree"],
        json!({"auto_branch":true,"inherit_local":true})
    );
    for bad in [Value::Null, json!("false"), json!(1)] {
        let mut p = project();
        p["worktree"] = json!({"inherit_local":bad});
        let mut r = request();
        r["project"] = json!(p.to_string());
        refusal(&r, "invalid_shape", "project");
    }
    let mut p = project();
    p["worktree"] = json!({"auto_branch":false,"inherit_local":false});
    let mut r = request();
    r["project"] = json!(p.to_string());
    r["primary_local"] = json!(local(json!({"default_overlay":"primary"})));
    assert_eq!(result(&r)["local_resolution"]["overlay"], "project");
    assert_eq!(result(&r)["local_resolution"]["auto_branch"], false);
    r["checkout_local"] = json!(local(json!({"default_overlay":"checkout"})));
    assert_eq!(result(&r)["local_resolution"]["overlay"], "checkout");
    r["primary_local"] = json!("{broken");
    refusal(&r, "invalid_json", "primary_local");
}
#[test]
fn all_input_versions_shapes_unknown_fields_and_duplicates_refuse() {
    let mut r = request();
    r["request_version"] = json!(2);
    refusal(&r, "unsupported_request_version", "request");
    r = request();
    r["projectRoot"] = json!("private-sentinel");
    refusal(&r, "unknown_field", "request");
    for role in ["primary_local", "checkout_local"] {
        for value in [
            json!({"schema_version":1,"services":{}}),
            json!({"schema_version":1,"worktree":{"inherit_local":false}}),
            json!({"schema_version":1,"environment":{"unknown":"private-sentinel"}}),
        ] {
            r = request();
            r[role] = json!(value.to_string());
            refusal(&r, "unknown_field", role);
        }
        r = request();
        r[role] = json!({"schema_version":1});
        refusal(&r, "invalid_shape", "request");
        r = request();
        r[role] = Value::Null;
        refusal(&r, "invalid_shape", "request");
        r = request();
        r[role] = json!("{\"schema_version\":2}");
        refusal(&r, "unsupported_version", role);
        r = request();
        r[role] = json!(
            "{\"schema_version\":1,\"environment\":{\"default_overlay\":null,\"default_overlay\":\"qa\"}}"
        );
        refusal(&r, "duplicate_key", role);
    }
    let duplicate = br#"{"request_version":1,"request_version":1,"project":"{}"}"#;
    let v = serde_json::to_value(resolve(duplicate, &[])).unwrap();
    assert_eq!(v["diagnostics"][0]["document"], "request");
    assert_eq!(v["diagnostics"][0]["code"], "duplicate_key");
    r = request();
    r["project"] = json!("{\"schema_version\":1,\"name\":\"x\",\"name\":\"y\"}");
    refusal(&r, "duplicate_key", "project");
}
#[test]
fn canonical_local_and_explicit_names_are_validated_without_normalization() {
    for name in ["qa_test", "QA", "qa.test", "qa-", ""] {
        let mut r = request();
        r["explicit_overlay"] = json!(name);
        refusal(&r, "invalid_name", "request");
        r = request();
        r["checkout_local"] = json!(local(json!({"default_overlay":name})));
        refusal(&r, "invalid_name", "checkout_local");
    }
}
#[test]
fn authored_hash_does_not_depend_on_local_resolution() {
    let mut r = request();
    let original = result(&r);
    let compiled = serde_json::to_value(compile(project().to_string().as_bytes(), &[])).unwrap();
    assert_eq!(original["plan"], compiled["plan"]);
    assert_eq!(original["semantic_hash"], compiled["semantic_hash"]);
    r["checkout_local"] = json!(local(json!({"default_overlay":"checkout"})));
    let changed = result(&r);
    assert_eq!(changed["semantic_hash"], original["semantic_hash"]);
    assert_eq!(changed["plan"], original["plan"]);
    assert_ne!(
        changed["local_resolution"]["resolution_hash"],
        original["local_resolution"]["resolution_hash"]
    );
    let mut p = project();
    p["worktree"] = json!({"auto_branch":true,"inherit_local":true});
    r = request();
    r["project"] = json!(p.to_string());
    assert_eq!(result(&r)["semantic_hash"], original["semantic_hash"]);
}
#[test]
fn resolution_hash_binds_shadowed_and_opted_out_locals_and_explicit_presence() {
    let mut p = project();
    p["worktree"] = json!({"inherit_local":false});
    let mut r = request();
    r["project"] = json!(p.to_string());
    r["primary_local"] = json!(local(json!({"default_overlay":"one"})));
    r["explicit_overlay"] = Value::Null;
    let first = result(&r);
    r["primary_local"] = json!(local(json!({"default_overlay":"two"})));
    let second = result(&r);
    assert_eq!(
        first["local_resolution"]["overlay"],
        second["local_resolution"]["overlay"]
    );
    assert_ne!(
        first["local_resolution"]["resolution_hash"],
        second["local_resolution"]["resolution_hash"]
    );
    r["checkout_local"] = json!(local(json!({"default_overlay":null})));
    let explicit = result(&r);
    r.as_object_mut().unwrap().remove("explicit_overlay");
    let inherited = result(&r);
    assert_eq!(
        explicit["local_resolution"]["overlay"],
        inherited["local_resolution"]["overlay"]
    );
    assert_ne!(
        explicit["local_resolution"]["resolution_hash"],
        inherited["local_resolution"]["resolution_hash"]
    );
    r["primary_local"] =
        json!("{ \"environment\": {\"default_overlay\": \"two\"}, \"schema_version\": 1 }");
    assert_eq!(
        result(&r)["local_resolution"]["resolution_hash"],
        inherited["local_resolution"]["resolution_hash"]
    );
}
#[test]
fn request_and_embedded_input_limits_are_separate_and_redacted() {
    let v = serde_json::to_value(resolve(&vec![b' '; MAX_REQUEST_BYTES + 1], &[])).unwrap();
    assert_eq!(v["diagnostics"][0]["code"], "input_too_large");
    assert_eq!(v["diagnostics"][0]["document"], "request");
    for role in ["project", "primary_local", "checkout_local"] {
        let mut r = request();
        r[role] = json!(" ".repeat(MAX_INPUT_BYTES + 1));
        refusal(&r, "input_too_large", role);
    }
    let mut r = request();
    r["checkout_local"] =
        json!("{\"schema_version\":1,\"environment\":{\"default_overlay\":\"private-sentinel\",}");
    let result = result(&r);
    assert_eq!(result["diagnostics"][0]["document"], "checkout_local");
    assert!(!result.to_string().contains("private-sentinel"));
}
#[test]
fn local_schema_preserves_optional_null_and_closed_shapes() {
    let schema: Value = serde_json::from_str(&local_schema().unwrap()).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["$defs"]["LocalEnvironment"]["additionalProperties"],
        false
    );
    assert_eq!(
        schema["$defs"]["LocalEnvironment"]["properties"]["default_overlay"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(local_schema().unwrap(), local_schema().unwrap());
}
#[test]
fn resolution_profiles_preserve_the_same_authored_plan_as_compile() {
    let p = json!({"schema_version":1,"name":"x","profiles":["dev"],"jobs":{"init":{"image":"image:1","profiles":["dev"]}}});
    let mut r = request();
    r["project"] = json!(p.to_string());
    let resolved =
        serde_json::to_value(resolve(&serde_json::to_vec(&r).unwrap(), &["dev".into()])).unwrap();
    let compiled =
        serde_json::to_value(compile(p.to_string().as_bytes(), &["dev".into()])).unwrap();
    assert_eq!(resolved["plan"], compiled["plan"]);
    assert_eq!(resolved["semantic_hash"], compiled["semantic_hash"]);
}

#[test]
fn shared_local_schema_corpus_matches_resolver_shape_acceptance() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/local-schema-corpus.json")).unwrap();
    for case in cases {
        let mut r = request();
        r["checkout_local"] = json!(case["input"].to_string());
        assert_eq!(result(&r)["ok"], case["valid"], "{}", case["name"]);
    }
}
#[test]
fn local_and_request_depth_limits_are_enforced() {
    let mut r = request();
    r["checkout_local"] = json!(format!("{}0{}", "[".repeat(70), "]".repeat(70)));
    refusal(&r, "depth_limit", "checkout_local");
    let bytes = format!("{}0{}", "[".repeat(70), "]".repeat(70));
    let value = serde_json::to_value(resolve(bytes.as_bytes(), &[])).unwrap();
    assert_eq!(value["diagnostics"][0]["document"], "request");
    assert_eq!(value["diagnostics"][0]["code"], "depth_limit");
}
