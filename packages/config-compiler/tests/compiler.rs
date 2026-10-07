use hack_config_compiler::{CompileResult, MAX_INPUT_BYTES, artifacts, compile};
use serde_json::{Value, json};
fn base() -> Value {
    json!({"schema_version":1,"name":"example","services":{"web":{"image":"example/web:1"}}})
}
fn result(v: &Value) -> Value {
    serde_json::to_value(compile(&serde_json::to_vec(v).unwrap(), &[])).unwrap()
}
fn bad(v: &Value, code: &str) {
    let r = result(v);
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["diagnostics"][0]["code"], code, "{r}");
}
#[test]
fn defaults_and_symbolic_environment_are_explicit() {
    let mut v = base();
    v["services"]["web"]["environment"] = json!({"TOKEN":{"env_ref":"TOKEN"},"MODE":{"default":"dev"},"PUBLIC":{"literal":"yes"},"DROP":{"unset":true}});
    let r = result(&v);
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(
        r["plan"]["source"],
        json!({"root":".","mode":"host-mounted"})
    );
    assert_eq!(
        r["plan"]["services"]["web"]["environment"],
        v["services"]["web"]["environment"]
    );
    assert_eq!(r["semantic_hash"].as_str().unwrap().len(), 64);
}
#[test]
fn duplicate_keys_are_refused_at_any_depth_before_replacement() {
    for (text, pointer) in [
        (r#"{"schema_version":1,"name":"one","name":"two"}"#, "/name"),
        (
            r#"{"schema_version":1,"name":"x","services":{"web":{"image":"a","image":"b"}}}"#,
            "/services/web/image",
        ),
        (
            r#"{"schema_version":1,"name":"x","services":{"web":{"image":"a","mounts":[{"source":".","source":"b"}]}}}"#,
            "/services/web/mounts/0/source",
        ),
        (
            r#"{"schema_version":1,"name":"x","na\u006de":"y"}"#,
            "/name",
        ),
    ] {
        let r = serde_json::to_value(compile(text.as_bytes(), &[])).unwrap();
        assert_eq!(r["diagnostics"][0]["code"], "duplicate_key");
        assert_eq!(r["diagnostics"][0]["pointer"], pointer);
        assert!(r["diagnostics"][0]["column"].as_u64().unwrap() > 1);
    }
}
#[test]
fn invalid_json_is_redacted_and_has_position() {
    let r = serde_json::to_value(compile(
        b"{\n\"schema_version\":1,\"name\": \"private-sentinel\",}",
        &[],
    ))
    .unwrap();
    assert_eq!(r["diagnostics"][0]["code"], "invalid_json");
    assert_eq!(r["diagnostics"][0]["line"], 2);
    assert!(!r.to_string().contains("private-sentinel"));
    for text in ["{", "{} {}", "[1,]", "{\"a\":01}", "{\"a\":NaN}"] {
        assert!(matches!(
            compile(text.as_bytes(), &[]),
            CompileResult::Failure { .. }
        ));
    }
}
#[test]
fn parsing_has_byte_depth_and_utf8_bounds() {
    for (bytes, code) in [
        (vec![b' '; MAX_INPUT_BYTES + 1], "input_too_large"),
        (vec![255], "invalid_utf8"),
        (
            format!("{}0{}", "[".repeat(66), "]".repeat(66)).into_bytes(),
            "depth_limit",
        ),
    ] {
        let r = serde_json::to_value(compile(&bytes, &[])).unwrap();
        assert_eq!(r["diagnostics"][0]["code"], code);
    }
}
#[test]
fn versions_unknown_fields_nulls_and_mixed_forms_refuse() {
    let mut v = base();
    v["schema_version"] = json!(2);
    bad(&v, "unsupported_version");
    v = base();
    v["networks"] = json!({});
    bad(&v, "unknown_field");
    v = base();
    v["services"]["web"]["backend_options"] = json!({});
    bad(&v, "unknown_field");
    for value in [
        Value::Null,
        json!({"exec":[],"shell":"echo ignored"}),
        json!("echo hi"),
    ] {
        v = base();
        v["services"]["web"]["command"] = value;
        bad(&v, "invalid_shape");
    }
    for value in [
        json!({"literal":"x","env_ref":"KEY"}),
        json!({"unset":false}),
        Value::Null,
        json!("bare"),
    ] {
        v = base();
        v["services"]["web"]["environment"] = json!({"KEY":value});
        bad(&v, "invalid_shape");
    }
    for field in [
        "image",
        "build",
        "command",
        "working_directory",
        "readiness",
    ] {
        v = base();
        v["services"]["web"][field] = Value::Null;
        bad(&v, "invalid_shape");
    }
}
#[test]
fn command_and_image_build_contracts() {
    let mut v = base();
    v["services"]["web"]["build"] = json!({"context":"."});
    bad(&v, "image_build_exclusive");
    v["services"]["web"]
        .as_object_mut()
        .unwrap()
        .remove("image");
    assert_eq!(result(&v)["ok"], true);
    assert_eq!(
        result(&v)["plan"]["services"]["web"]["build"]["dockerfile"],
        "Dockerfile"
    );
    v["services"]["web"]["command"] = json!({"exec":[]});
    bad(&v, "invalid_command");
    v["services"]["web"]["command"] = json!({"shell":"echo hello"});
    assert_eq!(result(&v)["ok"], true);
}
#[test]
fn storage_and_paths_are_symbolic_and_checked() {
    let mut v = base();
    v["storage"] = json!({"data":{"kind":"persistent","scope":"worktree"}});
    v["services"]["web"]["mounts"] = json!([{"source":"./src/.","target":"/app/.","access":"read-only"},{"storage":"data","target":"/data","access":"read-write"}]);
    assert_eq!(result(&v)["ok"], true);
    v["services"]["web"]["mounts"][1]["target"] = json!("/app");
    bad(&v, "duplicate_mount_target");
    v["services"]["web"]["mounts"][1]["target"] = json!("/data");
    v["services"]["web"]["mounts"][1]["storage"] = json!("missing");
    bad(&v, "unknown_storage");
    for path in ["/outside", "../outside", "C:\\host", "a/../../b"] {
        v = base();
        v["source"] = json!({"root":path});
        bad(&v, "invalid_path");
    }
}
#[test]
fn dependencies_require_correct_kind_readiness_and_acyclic_namespace() {
    let mut v = base();
    v["jobs"] = json!({"init":{"image":"init:1"}});
    v["services"]["web"]["depends_on"] = json!([{"job":"init","condition":"completed"}]);
    assert_eq!(result(&v)["ok"], true);
    v["jobs"]["init"]["depends_on"] = json!([{"service":"web","condition":"started"}]);
    bad(&v, "dependency_cycle");
    v = base();
    v["services"]["web"]["depends_on"] = json!([{"service":"missing","condition":"started"}]);
    bad(&v, "unknown_dependency");
    v["services"]["db"] = json!({"image":"db:1"});
    v["services"]["web"]["depends_on"] = json!([{"service":"db","condition":"ready"}]);
    bad(&v, "missing_readiness");
    v["services"]["db"]["readiness"] =
        json!({"kind":"tcp","port":5432,"interval":"1s","timeout":"500ms","retries":3});
    assert_eq!(result(&v)["ok"], true);
    v["jobs"] = json!({"web":{"image":"job:1"}});
    bad(&v, "duplicate_workload");
}
#[test]
fn profiles_are_explicit_and_cannot_hide_missing_dependencies() {
    let mut v = base();
    v["profiles"] = json!(["dev"]);
    v["jobs"] = json!({"init":{"image":"init:1","profiles":["dev"]}});
    assert!(result(&v)["plan"]["jobs"].as_object().unwrap().is_empty());
    let selected =
        serde_json::to_value(compile(&serde_json::to_vec(&v).unwrap(), &["dev".into()])).unwrap();
    assert!(selected["plan"]["jobs"]["init"].is_object());
    v["services"]["web"]["depends_on"] = json!([{"job":"init","condition":"completed"}]);
    bad(&v, "inactive_dependency");
    let r = serde_json::to_value(compile(
        &serde_json::to_vec(&v).unwrap(),
        &["unknown".into()],
    ))
    .unwrap();
    assert_eq!(r["diagnostics"][0]["code"], "unknown_profile");
}
#[test]
fn semantic_hash_normalizes_defaults_paths_order_and_durations() {
    let mut a = base();
    a["services"]["web"]["readiness"] = json!({"kind":"http","port":80,"path":"/health","interval":"1s","timeout":"1m","retries":3});
    let mut b = a.clone();
    b["source"] = json!({"root":"./.","mode":"host-mounted"});
    b["services"]["web"]["readiness"]["interval"] = json!("1000ms");
    b["services"]["web"]["readiness"]["timeout"] = json!("60000ms");
    assert_eq!(result(&a)["semantic_hash"], result(&b)["semantic_hash"]);
    b["services"]["web"]["image"] = json!("example/web:2");
    assert_ne!(result(&a)["semantic_hash"], result(&b)["semantic_hash"]);
}
#[test]
fn schema_generation_is_deterministic_and_closed() {
    let (schema, dto) = artifacts().unwrap();
    assert_eq!(artifacts().unwrap(), (schema.clone(), dto.clone()));
    let v: Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(v["$schema"], "https://json-schema.org/draft/2020-12/schema");
    assert_eq!(v["additionalProperties"], false);
    assert_eq!(v["$defs"]["Workload"]["additionalProperties"], false);
    assert!(dto.contains("env_ref"));
    assert!(dto.contains("plan_version: 1"));
    assert_eq!(dto.matches("export type WorkloadKind =").count(), 1);
}

#[test]
fn shared_schema_corpus_matches_rust_acceptance() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/schema-corpus.json")).unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(
            result(&case["input"])["ok"],
            case["valid"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn long_dependency_chains_do_not_use_recursive_graph_traversal() {
    let mut v = base();
    for i in 0..2000 {
        let mut job = json!({"image":"job:1"});
        if i > 0 {
            job["depends_on"] = json!([{"job":format!("job{}",i-1),"condition":"completed"}]);
        }
        v["jobs"][format!("job{i}")] = job;
    }
    assert_eq!(result(&v)["ok"], true);
    v["jobs"]["job0"]["depends_on"] = json!([{"job":"job1999","condition":"completed"}]);
    bad(&v, "dependency_cycle");
}

#[test]
fn managed_overlay_and_reference_grammar_preserves_owner_selection() {
    for name in ["qa", "qa-test", "qatest", "prod-2"] {
        let mut v = base();
        v["environment"] = json!({"default_overlay":name});
        assert_eq!(result(&v)["ok"], true);
    }
    for name in [
        "qa_test", "qa.test", "qa-", "-qa", "qa--test", "QA", "qa/test", " qa ", "",
    ] {
        let mut v = base();
        v["environment"] = json!({"default_overlay":name});
        bad(&v, "invalid_name");
    }
    for name in ["lowercase", "Mixed_CASE", "1KEY", ""] {
        let mut v = base();
        v["services"]["web"]["environment"] = json!({"TARGET":{"env_ref":name}});
        bad(&v, "invalid_environment_key");
    }
    let mut v = base();
    v["services"]["web"]["environment"] = json!({"lowercase_destination":{"env_ref":"VALID_KEY"},"lowercase_literal":{"literal":"public"}});
    assert_eq!(result(&v)["ok"], true);
}

#[test]
fn diagnostic_columns_count_all_commas_and_utf8_bytes() {
    for text in [
        "{\"schema_version\":1,\"name\":\"x\",\"name\":\"y\"}",
        "{\"nested\":[0,1,{\"name\":\"é\",\"name\":\"y\"}]}",
        "{\n\"nested\":[0,1,{\"name\":\"é\",\"name\":\"y\"}]}",
    ] {
        let r = serde_json::to_value(compile(text.as_bytes(), &[])).unwrap();
        let offset = text.rfind("\"name\"").unwrap();
        let prefix = &text[..offset];
        assert_eq!(
            r["diagnostics"][0]["column"],
            prefix.rsplit('\n').next().unwrap().len() + 1
        );
        assert_eq!(
            r["diagnostics"][0]["line"],
            prefix.bytes().filter(|b| *b == b'\n').count() + 1
        );
    }
}
