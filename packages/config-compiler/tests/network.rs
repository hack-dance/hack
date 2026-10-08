use hack_config_compiler::compile;
use serde_json::{Value, json};

fn base() -> Value {
    json!({"schema_version":1,"name":"topology","services":{
        "web":{"image":"web:1"},"db":{"image":"db:1"}
    }})
}
fn compiled(input: &Value, profiles: &[String]) -> Value {
    serde_json::to_value(compile(&serde_json::to_vec(input).unwrap(), profiles)).unwrap()
}
fn refused(input: &Value, code: &str) {
    let result = compiled(input, &[]);
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["diagnostics"][0]["code"], code, "{result}");
    assert!(result.get("plan").is_none());
}

#[test]
fn absent_networks_preserve_default_plan_bytes() {
    let result = compiled(&base(), &[]);
    assert_eq!(result["ok"], true, "{result}");
    assert!(result["plan"].get("networks").is_none());
    assert!(result["plan"]["services"]["web"].get("networks").is_none());
    let mut empty = base();
    empty["networks"] = json!({});
    assert_eq!(compiled(&empty, &[])["plan"], result["plan"]);
}

#[test]
fn explicit_attachments_preserve_internal_policy_and_sort_aliases() {
    let mut input = base();
    input["networks"] = json!({"private":{"internal":true},"public":{}});
    input["services"]["web"]["networks"] =
        json!({"default":{},"private":{"aliases":["frontend-b","frontend-a"]}});
    input["services"]["db"]["networks"] = json!({"private":{}});
    let result = compiled(&input, &[]);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["plan"]["networks"]["private"]["internal"], true);
    assert_eq!(result["plan"]["networks"]["public"]["internal"], false);
    assert_eq!(
        result["plan"]["services"]["web"]["networks"]["private"]["aliases"],
        json!(["frontend-a", "frontend-b"])
    );
    assert_eq!(
        result["plan"]["services"]["db"]["networks"],
        json!({"private":{}})
    );
}

#[test]
fn topology_normalization_is_independent_of_declaration_order() {
    let first = json!({"schema_version":1,"name":"topology","networks":{"b":{},"a":{"internal":true}},"services":{"web":{"image":"web:1","networks":{"b":{},"a":{"aliases":["y","x"]}}}}});
    let second = json!({"services":{"web":{"networks":{"a":{"aliases":["x","y"]},"b":{}},"image":"web:1"}},"networks":{"a":{"internal":true},"b":{"internal":false}},"name":"topology","schema_version":1});
    assert_eq!(compiled(&first, &[]), compiled(&second, &[]));
}

#[test]
fn declaration_and_attachment_shapes_are_closed_objects() {
    for networks in [
        json!(null),
        json!([]),
        json!({"private":[]}),
        json!({"private":null}),
    ] {
        let mut input = base();
        input["networks"] = networks;
        refused(&input, "invalid_shape");
    }
    for networks in [
        json!(null),
        json!([]),
        json!({"default":[]}),
        json!({"default":null}),
    ] {
        let mut input = base();
        input["services"]["web"]["networks"] = networks;
        refused(&input, "invalid_shape");
    }
    for declaration in [
        json!({"external":true}),
        json!({"driver":"host"}),
        json!({"ipam":{}}),
    ] {
        let mut input = base();
        input["networks"] = json!({"private":declaration});
        refused(&input, "unknown_field");
    }
}

#[test]
fn unresolved_empty_reserved_and_invalid_names_refuse_before_plan() {
    let mut input = base();
    input["services"]["web"]["networks"] = json!({});
    refused(&input, "invalid_network_selection");
    input["services"]["web"]["networks"] = json!({"missing":{}});
    refused(&input, "unknown_network");
    for name in ["default", "ingress", "Invalid", "bad/name", ""] {
        let mut input = base();
        input["networks"] = json!({name:{}});
        refused(&input, "invalid_name");
    }
}

#[test]
fn alias_collisions_and_unsupported_attachment_options_refuse() {
    let mut input = base();
    input["services"]["web"]["networks"] = json!({"default":{"aliases":["db"]}});
    refused(&input, "network_alias_collision");
    input["services"]["web"]["networks"] = json!({"default":{"aliases":["alias","alias"]}});
    refused(&input, "invalid_name");
    input["services"]["web"]["networks"] = json!({"default":{"aliases":["alias"]}});
    input["services"]["db"]["networks"] = json!({"default":{"aliases":["alias"]}});
    refused(&input, "network_alias_collision");
    input["services"]["web"]["networks"] = json!({"default":{"ipv4_address":"127.0.0.1"}});
    refused(&input, "unknown_field");
}

#[test]
fn distinct_networks_may_reuse_an_alias_without_sharing_dns() {
    let mut input = base();
    input["networks"] = json!({"a":{},"b":{}});
    input["services"]["web"]["networks"] = json!({"a":{"aliases":["alias"]}});
    input["services"]["db"]["networks"] = json!({"b":{"aliases":["alias"]}});
    assert_eq!(compiled(&input, &[])["ok"], true);
}

#[test]
fn direct_service_endpoint_requires_shared_authored_network() {
    let mut input = base();
    input["networks"] = json!({"private":{"internal":true}});
    input["services"]["db"]["networks"] = json!({"private":{}});
    input["services"]["web"]["environment"] =
        json!({"DB":{"endpoint":{"kind":"service","name":"db","port":5432,"protocol":"tcp"}}});
    refused(&input, "disconnected_endpoint_target");
    input["services"]["web"]["networks"] = json!({"default":{},"private":{}});
    assert_eq!(compiled(&input, &[])["ok"], true);
}

#[test]
fn invalid_inactive_profiles_do_not_escape_topology_validation() {
    let mut input = base();
    input["profiles"] = json!(["optional"]);
    input["services"]["web"]["profiles"] = json!(["optional"]);
    input["services"]["web"]["networks"] = json!({"missing":{}});
    refused(&input, "unknown_network");
    input["services"]["web"]["networks"] = json!({"default":{"aliases":["db"]}});
    refused(&input, "network_alias_collision");
}
