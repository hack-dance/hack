use hack_config_compiler::{compile, environment::plan, local::resolve};
use serde_json::{Value, json};
fn project() -> Value {
    json!({"schema_version":1,"name":"example","profiles":["dev"],"services":{"web":{"image":"web:1"}},"jobs":{"init":{"image":"init:1","profiles":["dev"]}}})
}
fn hook(name: &str) -> Value {
    json!({"name":name,"command":{"exec":["true"]}})
}
fn process() -> Value {
    json!({"command":{"shell":"exit 93"}})
}
fn compiled(p: &Value) -> Value {
    serde_json::to_value(compile(p.to_string().as_bytes(), &[])).unwrap()
}
fn metadata() -> Value {
    json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"init":{}},"inactive_scopes":[],"host":{"default":{},"workloads":{}}})
}
fn planned(p: &Value, m: &Value) -> Value {
    serde_json::to_value(plan(
        json!({"request_version":1,"project":p.to_string(),"env_metadata":m})
            .to_string()
            .as_bytes(),
        &[],
    ))
    .unwrap()
}
fn binding(scope: &str) -> Value {
    json!({"scope":scope,"secret":true})
}
#[test]
fn empty_host_preserves_hostless_plan_hash_and_wire() {
    let p = project();
    let expected = compiled(&p);
    assert!(expected.get("host_env_targets").is_none());
    assert!(expected["plan"].get("host").is_none());
    for host in [
        json!({}),
        json!({"up":{},"down":{"before":[],"after":[]},"processes":{}}),
    ] {
        let mut p = p.clone();
        p["host"] = host;
        assert_eq!(compiled(&p), expected);
    }
    let mut m = metadata();
    m.as_object_mut().unwrap().remove("host");
    let output = planned(&p, &m);
    assert!(output["environment_plan"].get("host").is_none());
    assert!(output.get("host_env_targets").is_none());
}
#[test]
fn host_normalization_preserves_order_and_explicit_defaults_identity() {
    let mut p = project();
    p["host"] = json!({"up":{"before":[hook("z"),hook("a")]},"processes":{"watch":process()}});
    let out = compiled(&p);
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(
        out["host_env_targets"],
        json!({"include_default":true,"workloads":[]})
    );
    let host = &out["plan"]["host"];
    assert_eq!(host["up"]["before"][0]["name"], "z");
    assert_eq!(host["up"]["before"][1]["name"], "a");
    assert_eq!(host["processes"]["watch"]["cwd"], ".");
    assert_eq!(
        host["processes"]["watch"]["env_target"],
        json!({"kind":"host"})
    );
    assert_eq!(host["processes"]["watch"]["startup"], "up");
    assert_eq!(host["processes"]["watch"]["exit"], "stop_on_down");
    p["host"]["processes"]["watch"]["cwd"] = json!("./");
    p["host"]["processes"]["watch"]["env_target"] = json!({"kind":"host"});
    p["host"]["processes"]["watch"]["startup"] = json!("up");
    p["host"]["processes"]["watch"]["exit"] = json!("stop_on_down");
    assert_eq!(compiled(&p)["semantic_hash"], out["semantic_hash"]);
    p["host"]["up"]["before"].as_array_mut().unwrap().reverse();
    assert_ne!(compiled(&p)["semantic_hash"], out["semantic_hash"]);
    let resolved = serde_json::to_value(resolve(
        json!({"request_version":1,"project":p.to_string()})
            .to_string()
            .as_bytes(),
        &[],
    ))
    .unwrap();
    assert_eq!(resolved["host_env_targets"], out["host_env_targets"]);
}
#[test]
fn all_host_names_share_one_namespace_separate_from_workloads() {
    for (phase, stage) in [
        ("up", "before"),
        ("up", "after"),
        ("down", "before"),
        ("down", "after"),
    ] {
        let mut p = project();
        p["host"] = json!({"processes":{"same":process()}});
        p["host"][phase] = json!({stage:[hook("same")]});
        assert_eq!(compiled(&p)["ok"], false);
    }
    let mut p = project();
    p["host"] = json!({"up":{"before":[hook("same")],"after":[hook("same")]}});
    assert_eq!(compiled(&p)["ok"], false);
    p["host"] = json!({"processes":{"web":process(),"host":process(),"global":process()}});
    let out = compiled(&p);
    assert_eq!(out["ok"], true);
    assert_eq!(out["host_env_targets"]["include_default"], true);
    assert_eq!(out["host_env_targets"]["workloads"], json!([]));
}
#[test]
fn targets_include_inactive_jobs_and_refuse_unknown_names() {
    let mut p = project();
    let mut x = process();
    x["env_target"] = json!({"kind":"workload","name":"init"});
    let mut y = process();
    y["env_target"] = json!({"kind":"workload","name":"web"});
    p["host"] = json!({"processes":{"first":y,"second":x.clone(),"third":x}});
    let out = compiled(&p);
    assert_eq!(out["ok"], true);
    assert_eq!(
        out["host_env_targets"],
        json!({"include_default":false,"workloads":["init","web"]})
    );
    assert!(out["plan"]["jobs"].get("init").is_none());
    p["host"]["processes"]["second"]["env_target"]["name"] = json!("absent");
    let out = compiled(&p);
    assert_eq!(out["diagnostics"][0]["code"], "unknown_env_target");
}
#[test]
fn singleton_intent_is_sorted_unique_and_process_only() {
    let mut p = project();
    let mut x = process();
    x["singleton"] = json!({"ports":[9001,9000],"on_conflict":"adopt"});
    p["host"] = json!({"processes":{"watch":x}});
    let out = compiled(&p);
    assert_eq!(out["ok"], true);
    assert_eq!(
        out["plan"]["host"]["processes"]["watch"]["singleton"]["ports"],
        json!([9000, 9001])
    );
    for ports in [json!([]), json!([0]), json!([65536]), json!([80, 80])] {
        p["host"]["processes"]["watch"]["singleton"]["ports"] = ports;
        assert_eq!(compiled(&p)["ok"], false);
    }
    let mut h = hook("hook");
    h["singleton"] = json!({"ports":[80]});
    p["host"] = json!({"up":{"before":[h]}});
    assert_eq!(compiled(&p)["ok"], false);
}
#[test]
fn host_bindings_reuse_immutable_baseline_and_report_ordered_hook_pointer() {
    let mut p = project();
    let mut h = hook("prepare");
    h["environment"] = json!({"A":{"literal":"public"},"B":{"env_ref":"A"},"C":{"default":"fallback"},"D":{"default":"unused"},"E":{"unset":true},"SELF":{"env_ref":"SELF"},"MISSING":{"env_ref":"ABSENT"}});
    p["host"] = json!({"up":{"before":[hook("first"),h]}});
    let mut m = metadata();
    m["host"]["default"] = json!({"A":binding("host"),"D":binding("global"),"E":binding("host"),"SELF":binding("global")});
    let out = planned(&p, &m);
    assert_eq!(out["ok"], true);
    assert_eq!(out["environment_plan"]["complete"], false);
    let b = &out["environment_plan"]["host"]["prepare"]["bindings"];
    assert_eq!(b["A"]["kind"], "literal");
    assert_eq!(b["B"]["kind"], "managed");
    assert_eq!(b["B"]["key"], "A");
    assert_eq!(b["C"]["kind"], "default");
    assert_eq!(b["D"]["kind"], "managed");
    assert!(b.get("E").is_none());
    assert_eq!(b["SELF"]["key"], "SELF");
    let d = &out["environment_plan"]["diagnostics"][0];
    assert_eq!(d["pointer"], "/host/up/before/1/environment/MISSING");
    assert_eq!(d["document"], "project");
    assert!(d["column"].as_u64().unwrap() > 1);
    m["host"]["default"]["B"] = binding("host");
    let out = planned(&p, &m);
    assert_eq!(
        out["environment_plan"]["diagnostics"][0]["code"],
        "env_reference_collision"
    );
}
#[test]
fn generic_host_cannot_read_other_workloads_or_gain_scope_from_its_name() {
    let mut p = project();
    let mut x = process();
    x["environment"] = json!({"DEST":{"env_ref":"KEY"}});
    p["host"] = json!({"processes":{"web":x}});
    let mut m = metadata();
    m["workloads"]["web"]["KEY"] = binding("web");
    let out = planned(&p, &m);
    assert_eq!(out["environment_plan"]["complete"], false);
    m["host"]["default"]["KEY"] = binding("web");
    assert_eq!(planned(&p, &m)["ok"], false);
    p["host"]["processes"]["web"]["env_target"] = json!({"kind":"workload","name":"web"});
    m["host"] = json!({"workloads":{"web":{"KEY":binding("host")}}});
    let out = planned(&p, &m);
    assert_eq!(out["environment_plan"]["complete"], true);
    assert_eq!(
        out["environment_plan"]["host"]["web"]["bindings"]["DEST"]["scope"],
        "host"
    );
}
#[test]
fn workload_named_host_disables_generic_host_scope_for_all_other_targets() {
    let mut p = project();
    p["services"]["host"] = json!({"image":"host:1"});
    let mut target = process();
    target["env_target"] = json!({"kind":"workload","name":"web"});
    p["host"] = json!({"processes":{"generic":process(),"target":target}});
    let mut m = metadata();
    m["workloads"]["host"] = json!({});
    m["host"]["workloads"]["web"] = json!({});
    m["host"]["default"]["KEY"] = binding("host");
    assert_eq!(planned(&p, &m)["ok"], false);
    m["host"]["default"] = json!({});
    m["host"]["workloads"]["web"]["KEY"] = binding("host");
    assert_eq!(planned(&p, &m)["ok"], false);
    p["host"]["processes"]["target"]["env_target"]["name"] = json!("host");
    m["host"]["workloads"] = json!({"host":{"KEY":binding("host")}});
    assert_eq!(planned(&p, &m)["environment_plan"]["complete"], true);
}
#[test]
fn host_metadata_requires_exact_requested_shapes_without_values() {
    let mut p = project();
    p["host"] = json!({"processes":{"watch":process()}});
    for host in [
        json!(null),
        json!([]),
        json!({"workloads":{}}),
        json!({"default":{},"workloads":{"web":{}}}),
        json!({"default":[],"workloads":{}}),
        json!({"default":{"KEY":[]},"workloads":{}}),
        json!({"default":{"KEY":{"scope":"host","secret":true,"value":"private-sentinel"}},"workloads":{}}),
    ] {
        let mut m = metadata();
        m["host"] = host;
        let out = planned(&p, &m);
        assert_eq!(out["ok"], false, "{out}");
        assert!(!out.to_string().contains("private-sentinel"));
    }
    let mut m = metadata();
    m.as_object_mut().unwrap().remove("host");
    assert_eq!(planned(&p, &m)["ok"], false);
    let m = metadata();
    assert_eq!(planned(&project(), &m)["ok"], false);
}
#[test]
fn host_metadata_changes_do_not_enter_portable_hashes() {
    let mut p = project();
    p["host"] = json!({"processes":{"watch":process()}});
    let mut m = metadata();
    let first = planned(&p, &m);
    m["host"]["default"]["KEY"] = binding("host");
    let second = planned(&p, &m);
    assert_eq!(first["semantic_hash"], second["semantic_hash"]);
    assert_eq!(first["local_resolution"], second["local_resolution"]);
    assert_eq!(first["plan"], second["plan"]);
}

#[test]
fn host_semantic_refusals_cover_names_paths_commands_and_environment() {
    for name in ["", "Bad", "a/b", "_bad"] {
        let mut p = project();
        p["host"] = json!({"processes":{name:process()}});
        assert_eq!(compiled(&p)["ok"], false);
    }
    for cwd in [
        "../outside",
        "/absolute",
        "a/../../outside",
        "C:\\outside",
        "nul\0path",
    ] {
        let mut p = project();
        let mut x = process();
        x["cwd"] = json!(cwd);
        p["host"] = json!({"processes":{"watch":x}});
        assert_eq!(compiled(&p)["diagnostics"][0]["code"], "invalid_path");
    }
    for command in [
        json!({"exec":[]}),
        json!({"exec":["bad\0command"]}),
        json!({"shell":"bad\0command"}),
        json!({"exec":["true"],"shell":"true"}),
    ] {
        let mut p = project();
        p["host"] = json!({"processes":{"watch":{"command":command}}});
        assert_eq!(compiled(&p)["ok"], false);
    }
    for environment in [
        json!({"BAD-KEY":{"literal":"public"}}),
        json!({"KEY":{"env_ref":"lowercase"}}),
        json!({"KEY":{"literal":"bad\0value"}}),
        json!({"KEY":{"env_ref":"KEY","scope":"web"}}),
    ] {
        let mut p = project();
        let mut x = process();
        x["environment"] = environment;
        p["host"] = json!({"processes":{"watch":x}});
        assert_eq!(compiled(&p)["ok"], false);
    }
}

#[test]
fn duplicate_host_json_keys_refuse_before_map_insertion() {
    let input=br#"{"schema_version":1,"name":"example","host":{"processes":{"watch":{"command":{"exec":["true"]}},"watch":{"command":{"shell":"private-sentinel"}}}}}"#;
    let output = serde_json::to_value(compile(input, &[])).unwrap();
    assert_eq!(output["diagnostics"][0]["code"], "duplicate_key");
    assert!(!output.to_string().contains("private-sentinel"));
}

fn large_baseline(count: usize, key_length: usize) -> Value {
    let mut result = serde_json::Map::new();
    for index in 0..count {
        let prefix = format!("K{index:05}");
        let key = format!("{prefix}{}", "A".repeat(key_length - prefix.len()));
        result.insert(key, binding("global"));
    }
    Value::Object(result)
}
fn many_processes(count: usize) -> Value {
    let mut result = serde_json::Map::new();
    for index in 0..count {
        result.insert(format!("p{index:04}"), process());
    }
    Value::Object(result)
}
#[test]
fn small_metadata_cannot_amplify_into_an_unbounded_host_report() {
    let mut p = project();
    p["host"] = json!({"processes":many_processes(1000)});
    let mut m = metadata();
    m["host"]["default"] = large_baseline(100, 1000);
    assert!(p.to_string().len() < hack_config_compiler::MAX_INPUT_BYTES);
    assert!(m.to_string().len() < hack_config_compiler::MAX_INPUT_BYTES);
    let out = planned(&p, &m);
    assert_eq!(out["ok"], false);
    assert_eq!(out["diagnostics"][0]["code"], "plan_too_large");
    assert_eq!(out["diagnostics"][0]["document"], "project");
    assert!(
        out["diagnostics"][0]["pointer"]
            .as_str()
            .unwrap()
            .starts_with("/host/processes/")
    );
    assert!(out.to_string().len() < 1024);
}
#[test]
fn workloads_and_host_invocations_share_one_expansion_budget() {
    let mut p = project();
    p["host"] = json!({"processes":many_processes(80)});
    let mut m = metadata();
    m["host"]["default"] = large_baseline(500, 60);
    let host_only = planned(&p, &m);
    assert_eq!(host_only["ok"], true, "{host_only}");
    assert!(host_only.to_string().len() < hack_config_compiler::environment::MAX_PLAN_OUTPUT_BYTES);
    m["workloads"]["web"] = large_baseline(5000, 100);
    assert!(m.to_string().len() < hack_config_compiler::MAX_INPUT_BYTES);
    let mut guest_metadata = m.clone();
    guest_metadata.as_object_mut().unwrap().remove("host");
    assert_eq!(planned(&project(), &guest_metadata)["ok"], true);
    let combined = planned(&p, &m);
    assert_eq!(combined["ok"], false);
    assert_eq!(combined["diagnostics"][0]["code"], "plan_too_large");
}
