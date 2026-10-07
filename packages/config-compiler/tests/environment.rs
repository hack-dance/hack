use hack_config_compiler::{compile, environment::plan, local::resolve};
use serde_json::{Value, json};
fn project() -> Value {
    json!({"schema_version":1,"name":"example","profiles":["dev"],"services":{"web":{"image":"web:1"},"host":{"image":"host:1","profiles":["dev"],"environment":{"REQUIRED":{"env_ref":"ABSENT"}}}},"jobs":{"init":{"image":"init:1"}}})
}
fn metadata() -> Value {
    json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"host":{},"init":{}},"inactive_scopes":[]})
}
fn request(p: Value, m: Value) -> Value {
    json!({"request_version":1,"project":p.to_string(),"env_metadata":m})
}
fn output(r: &Value, profiles: &[String]) -> Value {
    serde_json::to_value(plan(r.to_string().as_bytes(), profiles)).unwrap()
}
fn entry(scope: &str, secret: bool) -> Value {
    json!({"scope":scope,"secret":secret})
}
fn reject(r: &Value) {
    let v = output(r, &[]);
    assert_eq!(v["ok"], false, "{v}");
    assert_eq!(v["diagnostics"][0]["document"], "request", "{v}");
}
#[test]
fn declaration_projection_includes_jobs_inactive_and_host_without_changing_hashes() {
    let p = project();
    let m = metadata();
    let r = request(p.clone(), m);
    let planned = output(&r, &[]);
    let compiled = serde_json::to_value(compile(p.to_string().as_bytes(), &[])).unwrap();
    let resolved = serde_json::to_value(resolve(
        json!({"request_version":1,"project":p.to_string()})
            .to_string()
            .as_bytes(),
        &[],
    ))
    .unwrap();
    for result in [&compiled, &resolved, &planned] {
        assert_eq!(
            result["declared_workloads"],
            json!({"web":"service","host":"service","init":"job"})
        );
        assert_eq!(result["semantic_hash"], compiled["semantic_hash"]);
        assert_eq!(result["plan"], compiled["plan"]);
    }
    assert_eq!(planned["environment_plan"]["complete"], true);
    assert!(
        planned["environment_plan"]["workloads"]
            .get("host")
            .is_none()
    );
    let selected = output(&r, &["dev".into()]);
    assert_eq!(selected["ok"], true);
    assert_eq!(selected["environment_plan"]["complete"], false);
    assert_eq!(
        selected["environment_plan"]["diagnostics"][0]["pointer"],
        "/services/host/environment/REQUIRED"
    );
}
#[test]
fn directives_bind_immutable_baseline_and_preserve_secret_metadata() {
    let mut p = project();
    p["services"]["web"]["environment"] = json!({"A":{"literal":"public"},"B":{"env_ref":"A"},"C":{"default":"fallback"},"D":{"default":"unused"},"E":{"unset":true},"SELF":{"env_ref":"SELF"}});
    let mut m = metadata();
    m["workloads"]["web"] = json!({"A":entry("global",true),"D":entry("web",false),"E":entry("web",true),"SELF":entry("web",true)});
    let out = output(&request(p, m), &[]);
    assert_eq!(out["environment_plan"]["complete"], true);
    let b = &out["environment_plan"]["workloads"]["web"];
    assert_eq!(b["A"], json!({"kind":"literal","value":"public"}));
    assert_eq!(
        b["B"],
        json!({"kind":"managed","key":"A","scope":"global","secret":true})
    );
    assert_eq!(b["C"], json!({"kind":"default","value":"fallback"}));
    assert_eq!(b["D"]["kind"], "managed");
    assert_eq!(b["SELF"]["key"], "SELF");
    assert!(b.get("E").is_none());
}
#[test]
fn missing_references_and_remapped_managed_destinations_are_incomplete() {
    let mut p = project();
    p["jobs"]["init"]["environment"] =
        json!({"DEST":{"env_ref":"SOURCE"},"MISSING":{"env_ref":"NOPE"}});
    let mut m = metadata();
    m["workloads"]["init"] = json!({"DEST":entry("init",false),"SOURCE":entry("global",true)});
    let out = output(&request(p, m), &[]);
    assert_eq!(out["ok"], true);
    assert_eq!(out["environment_plan"]["complete"], false);
    let d = &out["environment_plan"]["diagnostics"];
    assert_eq!(d[0]["code"], "env_reference_collision");
    assert_eq!(d[1]["code"], "missing_env_reference");
    assert_eq!(d[0]["document"], "project");
    assert!(d[0]["column"].as_u64().unwrap() > 1);
}
#[test]
fn unset_and_authored_literals_do_not_create_or_remove_reference_sources() {
    let mut p = project();
    p["services"]["web"]["environment"] = json!({"A":{"unset":true},"B":{"env_ref":"A"},"C":{"literal":"public"},"D":{"env_ref":"C"}});
    let mut m = metadata();
    m["workloads"]["web"] = json!({"A":entry("web",true)});
    let out = output(&request(p, m), &[]);
    assert_eq!(out["environment_plan"]["workloads"]["web"]["B"]["key"], "A");
    assert_eq!(
        out["environment_plan"]["diagnostics"][0]["pointer"],
        "/services/web/environment/D"
    );
}
#[test]
fn metadata_shape_namespace_scope_and_version_are_strict() {
    for field in [
        "metadata_version",
        "overlay",
        "overlay_exists",
        "workloads",
        "inactive_scopes",
    ] {
        let mut m = metadata();
        m.as_object_mut().unwrap().remove(field);
        reject(&request(project(), m));
    }
    for value in [
        json!([]),
        Value::Null,
        json!({"metadata_version":2}),
        json!({}),
    ] {
        reject(&request(project(), value));
    }
    for value in [json!([]), Value::Null, json!("scope")] {
        let mut m = metadata();
        m["workloads"]["web"] = value;
        reject(&request(project(), m));
    }
    for value in [
        json!([]),
        Value::Null,
        json!(["global", true]),
        json!({"scope":"global","secret":true,"value":"private-sentinel"}),
        json!({"scope":"init","secret":true}),
        json!({"scope":"host","secret":true}),
        json!({"scope":"global","secret":"true"}),
    ] {
        let mut m = metadata();
        m["workloads"]["web"]["KEY"] = value;
        let r = request(project(), m);
        reject(&r);
        assert!(!output(&r, &[]).to_string().contains("private-sentinel"));
    }
    for scope in ["global", "host", "web", "bad scope"] {
        let mut m = metadata();
        m["inactive_scopes"] = json!([scope]);
        reject(&request(project(), m));
    }
    let mut m = metadata();
    m["inactive_scopes"] = json!(["old", "old"]);
    reject(&request(project(), m));
    let mut m = metadata();
    m["workloads"].as_object_mut().unwrap().remove("host");
    reject(&request(project(), m));
    let mut m = metadata();
    m["workloads"]["unknown"] = json!({});
    reject(&request(project(), m));
    let mut m = metadata();
    m["workloads"]["web"]["lowercase"] = entry("web", false);
    reject(&request(project(), m));
    let mut m = metadata();
    m["overlay_exists"] = json!(true);
    reject(&request(project(), m));
    let mut m = metadata();
    m["overlay"] = json!("qa");
    reject(&request(project(), m));
    let mut m = metadata();
    m["extra"] = json!("private-sentinel");
    reject(&request(project(), m));
}
#[test]
fn inactive_metadata_is_validated_and_host_workload_owns_only_its_scope() {
    let mut m = metadata();
    m["workloads"]["host"]["KEY"] = entry("host", true);
    assert_eq!(output(&request(project(), m.clone()), &[])["ok"], true);
    m["workloads"]["host"]["KEY"] = entry("web", true);
    reject(&request(project(), m));
}
#[test]
fn missing_overlay_and_inactive_scopes_warn_without_granting_authority() {
    let mut p = project();
    p["environment"] = json!({"default_overlay":"qa"});
    let mut m = metadata();
    m["overlay"] = json!("qa");
    m["inactive_scopes"] = json!(["old"]);
    m["workloads"]["web"]["KEY"] = entry("global", true);
    let out = output(&request(p, m), &[]);
    assert_eq!(out["environment_plan"]["complete"], true);
    assert_eq!(
        out["environment_plan"]["warnings"][0]["code"],
        "missing_overlay"
    );
    assert_eq!(
        out["environment_plan"]["warnings"][1]["code"],
        "inactive_env_scope"
    );
    assert_eq!(
        out["environment_plan"]["workloads"]["web"]["KEY"]["scope"],
        "global"
    );
}
#[test]
fn metadata_does_not_change_authored_or_resolution_hashes() {
    let r = request(project(), metadata());
    let first = output(&r, &[]);
    let mut r = r;
    r["env_metadata"]["workloads"]["web"]["KEY"] = entry("global", true);
    let second = output(&r, &[]);
    assert_eq!(first["semantic_hash"], second["semantic_hash"]);
    assert_eq!(first["local_resolution"], second["local_resolution"]);
    let pretty = serde_json::to_string_pretty(&r).unwrap();
    assert_eq!(
        serde_json::to_value(plan(pretty.as_bytes(), &[])).unwrap(),
        second
    );
}
#[test]
fn duplicates_and_limits_are_rejected_without_exposing_values() {
    let r = request(project(), metadata()).to_string().replace(
        "\"metadata_version\":1",
        "\"metadata_version\":1,\"metadata_version\":1",
    );
    let out = serde_json::to_value(plan(r.as_bytes(), &[])).unwrap();
    assert_eq!(out["diagnostics"][0]["code"], "duplicate_key");
    let mut m = metadata();
    m["inactive_scopes"] = json!(["a".repeat(hack_config_compiler::MAX_INPUT_BYTES)]);
    let out = output(&request(project(), m), &[]);
    assert_eq!(out["diagnostics"][0]["code"], "input_too_large");
    for field in ["project", "primary_local", "checkout_local"] {
        let mut r = request(project(), metadata());
        r[field] = json!("{\"schema_version\":1,\"schema_version\":1}");
        let out = output(&r, &[]);
        assert_eq!(out["diagnostics"][0]["document"], field);
        assert_eq!(out["diagnostics"][0]["code"], "duplicate_key");
    }
    let out = serde_json::to_value(plan(
        &vec![b' '; hack_config_compiler::local::MAX_REQUEST_BYTES + 1],
        &[],
    ))
    .unwrap();
    assert_eq!(out["diagnostics"][0]["code"], "input_too_large");
}

#[test]
fn missing_overlay_warning_tracks_local_and_explicit_selection_provenance() {
    let local_text = "{\n  \"schema_version\": 1,\n  \"environment\": {\n    \"default_overlay\": \"qa\"\n  }\n}";
    let selection_line = local_text.lines().nth(3).unwrap();
    for role in ["primary_local", "checkout_local"] {
        let mut m = metadata();
        m["overlay"] = json!("qa");
        let mut r = request(project(), m);
        r[role] = json!(local_text);
        let out = output(&r, &[]);
        let warning = &out["environment_plan"]["warnings"][0];
        assert_eq!(warning["code"], "missing_overlay");
        assert_eq!(warning["document"], role);
        assert_eq!(warning["pointer"], "/environment/default_overlay");
        assert_eq!(warning["line"], 4);
        assert_eq!(
            warning["column"],
            selection_line.find("\"qa\"").unwrap() + 1
        );
        assert!(!warning["message"].as_str().unwrap().contains("qa"));
    }
    let mut m = metadata();
    m["overlay"] = json!("qa");
    let mut r = request(project(), m);
    r["checkout_local"] = json!(local_text);
    r["explicit_overlay"] = json!("qa");
    let text = serde_json::to_string_pretty(&r).unwrap();
    let (line, content) = text
        .lines()
        .enumerate()
        .find(|(_, text)| text.contains("\"explicit_overlay\""))
        .unwrap();
    let out = serde_json::to_value(plan(text.as_bytes(), &[])).unwrap();
    let warning = &out["environment_plan"]["warnings"][0];
    assert_eq!(warning["code"], "missing_overlay");
    assert_eq!(warning["document"], "request");
    assert_eq!(warning["pointer"], "/explicit_overlay");
    assert_eq!(warning["line"], line + 1);
    assert_eq!(warning["column"], content.find("\"qa\"").unwrap() + 1);
}
