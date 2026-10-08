use hack_config_compiler::{compile, environment::plan, protocol};
use serde_json::{Value, json};

fn project() -> Value {
    json!({"schema_version":1,"name":"files","profiles":["dev"],
        "configs":{"settings":{"file":"./config//settings.bin"}},
        "secrets":{"token":{"env_ref":"TOKEN"},"disk":{"file":"private/token"}},
        "services":{"reader":{"image":"reader:1","environment":{"TOKEN":{"unset":true}},
            "mounts":[{"config":"settings","target":"/etc//fixture/./settings","access":"read-only"},
                {"secret":"token","target":"/run/secrets/token","access":"read-only"}]},
            "inactive":{"image":"reader:1","profiles":["dev"],"mounts":[{"secret":"token","target":"/token","access":"read-only"}]}},
        "jobs":{"check":{"image":"reader:1","mounts":[{"secret":"token","target":"/token","access":"read-only"}]}}})
}

fn request(project: Value) -> Value {
    json!({"request_version":1,"project":project.to_string(),"env_metadata":{
        "metadata_version":1,"overlay":null,"overlay_exists":false,"inactive_scopes":[],
        "workloads":{"reader":{"TOKEN":{"scope":"global","secret":true}},
            "inactive":{},"check":{"TOKEN":{"scope":"check","secret":true}}}}})
}

fn output(request: Value, profiles: &[String]) -> Value {
    serde_json::to_value(plan(request.to_string().as_bytes(), profiles)).unwrap()
}

fn compiled(project: Value) -> Value {
    serde_json::to_value(compile(project.to_string().as_bytes(), &[])).unwrap()
}

#[test]
fn file_contract_negotiates_and_normalizes_without_reading_material() {
    let result = compiled(project());
    assert_eq!(protocol()["file_plan_version"], 1);
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["plan"]["configs"]["settings"]["file"],
        "config/settings.bin"
    );
    assert_eq!(
        result["plan"]["services"]["reader"]["mounts"][0]["target"],
        "/etc/fixture/settings"
    );
    assert_eq!(
        result["plan"]["services"]["reader"]["mounts"][0]["mode"],
        "0444"
    );
    assert!(result["plan"]["services"].get("inactive").is_none());
}

#[test]
fn managed_file_authority_is_separate_from_unset_environment_and_scope_selected() {
    let result = output(request(project()), &[]);
    assert_eq!(result["ok"], true);
    assert_eq!(result["environment_plan"]["complete"], true);
    assert!(
        result["environment_plan"]["workloads"]["reader"]
            .get("TOKEN")
            .is_none()
    );
    let files = &result["file_plan"];
    assert_eq!(files["complete"], true);
    assert_eq!(
        files["workloads"]["reader"][1]["source"],
        json!({"kind":"managed","key":"TOKEN","scope":"global","secret":true})
    );
    assert_eq!(files["workloads"]["check"][0]["source"]["scope"], "check");
    assert!(files["workloads"].get("inactive").is_none());
    assert!(!files.to_string().contains("value"));
}

#[test]
fn removed_managed_source_cannot_be_restored_by_an_authored_literal_or_default() {
    for directive in [
        json!({"unset":true}),
        json!({"literal":"public"}),
        json!({"default":"public"}),
    ] {
        let mut project = project();
        project["services"]["reader"]["environment"]["TOKEN"] = directive;
        let mut input = request(project);
        input["env_metadata"]["workloads"]["reader"] = json!({});
        let bytes = input.to_string();
        let result = plan(bytes.as_bytes(), &[]);
        assert!(!result.complete());
        let result = serde_json::to_value(result).unwrap();
        assert_eq!(result["environment_plan"]["complete"], true);
        assert_eq!(result["file_plan"]["complete"], false);
        assert_eq!(
            result["file_plan"]["diagnostics"][0]["code"],
            "missing_env_reference"
        );
        assert_eq!(
            result["file_plan"]["diagnostics"][0]["pointer"],
            "/services/reader/mounts/1/secret"
        );
        assert!(
            !result["file_plan"]["diagnostics"]
                .to_string()
                .contains("public")
        );
    }
}

#[test]
fn inactive_grants_are_validated_but_do_not_acquire_managed_authority() {
    let input = request(project());
    assert_eq!(output(input.clone(), &[])["file_plan"]["complete"], true);
    assert_eq!(
        output(input, &["dev".into()])["file_plan"]["complete"],
        false
    );
    let mut project = project();
    project["services"]["inactive"]["mounts"][0]["secret"] = json!("missing");
    assert_eq!(
        compiled(project)["diagnostics"][0]["code"],
        "unknown_file_input"
    );
}

#[test]
fn ownership_and_mode_intent_are_preserved_without_claiming_backend_support() {
    let mut project = project();
    let grant = &mut project["services"]["reader"]["mounts"][1];
    grant["uid"] = json!(1000);
    grant["gid"] = json!(2000);
    grant["mode"] = json!("0400");
    grant["access"] = json!("read-write");
    let result = output(request(project), &[]);
    let grant = &result["file_plan"]["workloads"]["reader"][1];
    assert_eq!(grant["uid"], 1000);
    assert_eq!(grant["gid"], 2000);
    assert_eq!(grant["mode"], "0400");
    assert_eq!(grant["access"], "read-write");
}

#[test]
fn invalid_file_sources_and_shapes_refuse_with_redacted_diagnostics() {
    for value in [
        Value::Null,
        json!([]),
        json!({"file":"."}),
        json!({"file":"../private-marker"}),
        json!({"file":"/private-marker"}),
        json!({"file":"config\\private-marker"}),
        json!({"file":"config:private-marker"}),
        json!({"content":"private-marker"}),
        json!({"file":"config","unknown":"private-marker"}),
    ] {
        let mut project = project();
        project["configs"]["settings"] = value;
        let result = compiled(project);
        assert_eq!(result["ok"], false, "{result}");
        assert!(!result["diagnostics"].to_string().contains("private-marker"));
    }
    for value in [
        json!({"env_ref":"bad-key"}),
        json!({"env_ref":"TOKEN","file":"token"}),
        json!({"environment":"TOKEN"}),
    ] {
        let mut project = project();
        project["secrets"]["token"] = value;
        assert_eq!(compiled(project)["ok"], false);
    }
}

#[test]
fn invalid_grant_shapes_and_permissions_refuse() {
    for (field, value) in [
        ("uid", Value::Null),
        ("gid", json!(-1)),
        ("uid", json!(1.5)),
        ("uid", json!(4294967296_u64)),
        ("mode", json!(444)),
        ("mode", json!("444")),
        ("mode", json!("0888")),
        ("mode", json!("1444")),
        ("config", json!("settings")),
        ("target", json!("/")),
    ] {
        let mut project = project();
        project["services"]["reader"]["mounts"][1][field] = value;
        assert_eq!(compiled(project)["ok"], false, "{field}");
    }
}

#[test]
fn file_mount_collisions_and_shadowing_refuse_independent_of_order() {
    for target in [
        "/run/secrets/token",
        "/run/secrets/./token",
        "/run",
        "/",
        "/run/secrets/token/child",
    ] {
        for first in [true, false] {
            let mut project = project();
            let mount = json!({"source":".","target":target,"access":"read-only"});
            let mounts = project["services"]["reader"]["mounts"]
                .as_array_mut()
                .unwrap();
            if first {
                mounts.insert(0, mount);
            } else {
                mounts.push(mount);
            }
            assert_eq!(compiled(project)["ok"], false, "{target}");
        }
    }
    let mut project = project();
    project["services"]["reader"]["mounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"source":".","target":"/run/secrets/tokens","access":"read-only"}));
    assert_eq!(compiled(project)["ok"], true);
}

#[test]
fn managed_metadata_changes_do_not_enter_the_portable_hash() {
    let mut first = request(project());
    let original = output(first.clone(), &[]);
    first["env_metadata"]["workloads"]["reader"]["TOKEN"]["scope"] = json!("reader");
    let changed = output(first, &[]);
    assert_eq!(original["semantic_hash"], changed["semantic_hash"]);
    assert_ne!(original["file_plan"], changed["file_plan"]);
}

#[test]
fn repeated_file_sources_are_charged_against_the_shared_output_bound() {
    let mut project = project();
    project["configs"]["settings"]["file"] = json!("x".repeat(9000));
    project["services"]["reader"]["mounts"] = json!((0..1000).map(|index| json!({"config":"settings","target":format!("/file{index}"),"access":"read-only"})).collect::<Vec<_>>());
    let result = output(request(project), &[]);
    assert_eq!(result["ok"], false);
    assert_eq!(result["diagnostics"][0]["code"], "plan_too_large");
}
