use hack_config_compiler::{compile, environment::plan, local::resolve};
use serde_json::{Value, json};
fn project() -> Value {
    json!({"schema_version":1,"name":"example","profiles":["dev"],"services":{"web":{"image":"web:1"},"api":{"image":"api:1","profiles":["dev"]}},"jobs":{"init":{"image":"init:1"}}})
}
fn route(service: &str, hostname: &str) -> Value {
    json!({"service":service,"port":3000,"hostname":hostname})
}
fn compile_value(p: &Value) -> Value {
    serde_json::to_value(compile(p.to_string().as_bytes(), &[])).unwrap()
}
fn request(p: &Value) -> Value {
    json!({"request_version":1,"project":p.to_string()})
}
fn result(r: &Value) -> Value {
    serde_json::to_value(resolve(r.to_string().as_bytes(), &[])).unwrap()
}
fn local(domain: &str) -> Value {
    json!({"schema_version":1,"routes":{"domain":domain}})
}
#[test]
fn unrouted_wire_is_unchanged_and_explicit_context_can_preview_origin() {
    let p = project();
    let base = compile_value(&p);
    assert!(base["plan"].get("routes").is_none());
    assert!(base["plan"].get("open").is_none());
    let r = request(&p);
    let unresolved = result(&r);
    assert!(unresolved.get("routing_resolution").is_none());
    let mut r = r;
    r["global_domain"] = json!("custom.test");
    let preview = result(&r);
    assert_eq!(
        preview["routing_resolution"]["project_origin"],
        "https://example.custom.test"
    );
    assert_eq!(preview["routing_resolution"]["routes"], json!({}));
    assert_eq!(preview["semantic_hash"], unresolved["semantic_hash"]);
    assert_ne!(
        preview["local_resolution"]["resolution_hash"],
        unresolved["local_resolution"]["resolution_hash"]
    );
}
#[test]
fn domain_precedence_and_generation_are_separate_from_authored_identity() {
    let mut p = project();
    p["routes"] = json!({"domain":"project.test"});
    let mut r = request(&p);
    r["global_domain"] = json!("global.test");
    r["primary_local"] = json!(local("primary.test").to_string());
    r["checkout_local"] = json!(local("checkout.test").to_string());
    r["explicit_domain"] = json!("explicit.test");
    r["branch"] = json!("feature");
    let out = result(&r);
    assert_eq!(out["routing_resolution"]["domain_origin"], "explicit");
    assert_eq!(
        out["routing_resolution"]["project_origin"],
        "https://feature.example.explicit.test"
    );
    assert_eq!(out["routing_resolution"]["branch"], "feature");
    let first = out["local_resolution"]["resolution_hash"].clone();
    r["global_domain"] = json!("shadowed.test");
    let out = result(&r);
    assert_ne!(out["local_resolution"]["resolution_hash"], first);
    assert_eq!(out["semantic_hash"], compile_value(&p)["semantic_hash"]);
    for (field, origin, domain) in [
        ("explicit_domain", "checkout_local", "checkout.test"),
        ("checkout_local", "primary_local", "primary.test"),
        ("primary_local", "project", "project.test"),
    ] {
        r.as_object_mut().unwrap().remove(field);
        let out = result(&r);
        assert_eq!(out["routing_resolution"]["domain_origin"], origin);
        assert_eq!(out["routing_resolution"]["domain"], domain);
    }
    p["routes"] = json!({});
    r["project"] = json!(p.to_string());
    assert_eq!(result(&r)["routing_resolution"]["domain_origin"], "global");
    r.as_object_mut().unwrap().remove("global_domain");
    assert_eq!(result(&r)["routing_resolution"]["domain"], "hack.local");
}
#[test]
fn optout_ignores_but_still_validates_primary_local_and_empty_fields_inherit() {
    let mut p = project();
    p["routes"] = json!({"domain":"project.test"});
    p["worktree"] = json!({"inherit_local":false});
    let mut r = request(&p);
    r["primary_local"] = json!(local("primary.test").to_string());
    r["checkout_local"] = json!(json!({"schema_version":1,"routes":{},"open":{}}).to_string());
    let out = result(&r);
    assert_eq!(out["routing_resolution"]["domain"], "project.test");
    r["primary_local"] = json!(local("INVALID.test").to_string());
    let out = result(&r);
    assert_eq!(out["ok"], false);
    assert_eq!(out["diagnostics"][0]["document"], "primary_local");
}
#[test]
fn explicit_origins_and_aliases_remain_pinned_while_generated_aliases_follow_branch() {
    let mut p = project();
    p["routes"] = json!({"origin":"http://LOCALHOST:80","aliases":{"oauth":{"origin":"https://LOGIN.example.test:443"},"dev":{"domain":"hack.gy"}},"oauth_alias":"oauth","http":{"web":route("web","project"),"api":route("api","api")}});
    let mut r = request(&p);
    r["explicit_domain"] = json!("ignored.test");
    r["branch"] = json!("feature");
    let out = result(&r);
    assert_eq!(out["ok"], true, "{out}");
    let routing = &out["routing_resolution"];
    assert_eq!(routing["project_origin"], "http://localhost");
    assert_eq!(routing["aliases"]["oauth"], "https://login.example.test");
    assert_eq!(routing["aliases"]["dev"], "https://feature.example.hack.gy");
    assert_eq!(routing["open_origin"], "https://login.example.test");
    assert!(routing["routes"].get("api").is_none());
    assert_eq!(out["plan"]["routes"]["http"].as_object().unwrap().len(), 2);
}
#[test]
fn open_preferences_use_only_explicit_oauth_selection_with_local_provenance() {
    let mut p = project();
    p["routes"] = json!({"aliases":{"oauth":{"domain":"hack.gy"}}});
    p["open"] = json!({"prefer":"alias"});
    let mut r = request(&p);
    let out = result(&r);
    assert_eq!(compile_value(&p)["ok"], true);
    assert_eq!(out["diagnostics"][0]["code"], "missing_open_alias");
    p["routes"]["oauth_alias"] = json!("oauth");
    r["project"] = json!(p.to_string());
    assert_eq!(
        result(&r)["routing_resolution"]["open_origin"],
        "https://example.hack.gy"
    );
    r["primary_local"] = json!(json!({"schema_version":1,"open":{"prefer":"dev"}}).to_string());
    let out = result(&r);
    assert_eq!(
        out["routing_resolution"]["open_preference_origin"],
        "primary_local"
    );
    assert_eq!(
        out["routing_resolution"]["open_origin"],
        "https://example.hack.local"
    );
    r["checkout_local"] = json!(json!({"schema_version":1,"open":{"prefer":"auto"}}).to_string());
    assert_eq!(
        result(&r)["routing_resolution"]["open_origin"],
        "https://example.hack.gy"
    );
    p["routes"].as_object_mut().unwrap().remove("oauth_alias");
    r["project"] = json!(p.to_string());
    r["checkout_local"] = json!("{\n\"schema_version\":1,\n\"open\":{\"prefer\":\"alias\"}\n}");
    let out = result(&r);
    assert_eq!(out["diagnostics"][0]["document"], "checkout_local");
    assert_eq!(out["diagnostics"][0]["pointer"], "/open/prefer");
    assert_eq!(out["diagnostics"][0]["line"], 3);
}
#[test]
fn origin_grammar_supports_loopback_and_rejects_ambiguous_authorities() {
    for (input, expected) in [
        ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
        ("http://[::1]:80", "http://[::1]"),
        ("http://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]"),
        ("https://[0:0:0:0:0:0:0:1]:443", "https://[::1]"),
        ("https://EXAMPLE.test:0443", "https://example.test"),
    ] {
        let mut p = project();
        p["routes"] = json!({"origin":input,"http":{"web":route("web","project")}});
        let out = result(&request(&p));
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["routing_resolution"]["project_origin"], expected);
    }
    for input in [
        "http://user:pass@example.test",
        "https://example.test/",
        "https://example.test/path",
        "https://example.test?x=1",
        "https://example.test#x",
        "https://*.example.test",
        "https://example.test\\evil",
        "https://example.test\n",
        "http://127.00.0.1",
        "http://127.1",
        "http://2130706433",
        "http://0x7f000001",
        "http://example.123",
        "http://[::1%lo0]",
        "http://localhost:0",
        "http://localhost:65536",
        "file://localhost",
        "https://example.test.",
    ] {
        let mut p = project();
        p["routes"] = json!({"origin":input});
        let out = compile_value(&p);
        assert_eq!(out["ok"], false, "accepted {input}");
        assert_eq!(out["diagnostics"][0]["code"], "invalid_origin");
    }
    let mut p = project();
    p["routes"] = json!({"origin":"http://127.0.0.1","http":{"web":route("web","api")}});
    assert_eq!(result(&request(&p))["ok"], false);
}
#[test]
fn collisions_and_service_references_are_validated_before_filtering() {
    for target in ["missing", "init"] {
        let mut p = project();
        p["routes"] = json!({"http":{"route":route(target,"project")}});
        assert_eq!(
            compile_value(&p)["diagnostics"][0]["code"],
            "unknown_route_service"
        );
    }
    let mut p = project();
    p["routes"] =
        json!({"http":{"active":route("web","project"),"inactive":route("api","project")}});
    assert_eq!(
        compile_value(&p)["diagnostics"][0]["code"],
        "route_collision"
    );
    p["routes"] = json!({"aliases":{"overlap":{"origin":"https://api.example.hack.local"}},"http":{"base":route("api","project"),"api":route("web","api")}});
    assert_eq!(
        result(&request(&p))["diagnostics"][0]["code"],
        "route_collision"
    );
    p["routes"] = json!({"aliases":{"same":{"domain":"hack.local"}}});
    assert_eq!(
        result(&request(&p))["diagnostics"][0]["code"],
        "route_collision"
    );
    p["routes"] =
        json!({"aliases":{"a":{"origin":"https://X.test:443"},"b":{"origin":"https://x.test"}}});
    assert_eq!(
        compile_value(&p)["diagnostics"][0]["code"],
        "route_collision"
    );
}
#[test]
fn request_and_local_fields_are_strict_even_when_shadowed() {
    let mut p = project();
    p["routes"] = json!({});
    for key in ["global_domain", "explicit_domain", "branch"] {
        for value in [Value::Null, json!("BAD_NAME"), json!([])] {
            let mut r = request(&p);
            r[key] = value;
            let out = result(&r);
            assert_eq!(out["ok"], false);
            assert_eq!(out["diagnostics"][0]["document"], "request");
        }
    }
    for role in ["primary_local", "checkout_local"] {
        for local in [
            json!({"schema_version":1,"routes":{"domain":null}}),
            json!({"schema_version":1,"routes":{"origin":"https://private-sentinel.test"}}),
            json!({"schema_version":1,"open":null}),
            json!({"schema_version":1,"open":{"prefer":null}}),
            json!({"schema_version":1,"open":[]}),
        ] {
            let mut r = request(&p);
            r[role] = json!(local.to_string());
            let out = result(&r);
            assert_eq!(out["ok"], false);
            assert_eq!(out["diagnostics"][0]["document"], role);
            assert!(!out.to_string().contains("private-sentinel"));
        }
    }
}
#[test]
fn alias_route_expansion_is_bounded_before_allocating_cartesian_output() {
    let mut p = project();
    let mut aliases = serde_json::Map::new();
    let mut http = serde_json::Map::new();
    for i in 0..400 {
        aliases.insert(format!("a{i}"), json!({"domain":format!("a{i}.test")}));
        http.insert(format!("r{i}"), route("web", &format!("r{i}")));
    }
    p["routes"] = json!({"aliases":aliases,"http":http});
    assert!(p.to_string().len() < hack_config_compiler::MAX_INPUT_BYTES);
    let out = result(&request(&p));
    assert_eq!(out["ok"], false);
    assert_eq!(out["diagnostics"][0]["code"], "plan_too_large");
    assert!(out.to_string().len() < 1024);
}
#[test]
fn planning_preserves_routing_hashes_and_symbolic_environment_only() {
    let mut p = project();
    p["routes"] = json!({"http":{"web":route("web","project")}});
    let mut r = request(&p);
    let resolved = result(&r);
    r["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"api":{},"init":{}},"inactive_scopes":[]});
    let planned = serde_json::to_value(plan(r.to_string().as_bytes(), &[])).unwrap();
    assert_eq!(planned["ok"], true);
    assert_eq!(
        planned["routing_resolution"],
        resolved["routing_resolution"]
    );
    assert_eq!(planned["local_resolution"], resolved["local_resolution"]);
    assert_eq!(planned["semantic_hash"], resolved["semantic_hash"]);
}

#[test]
fn domain_suffixes_are_distinct_from_relative_route_hostnames() {
    for suffix in [
        "dev",
        "local",
        "localhost",
        "123",
        "0x7f",
        "example.123",
        "example.0x7f",
        "bad_name.test",
    ] {
        let mut p = project();
        p["routes"] = json!({"domain":suffix});
        assert_eq!(
            compile_value(&p)["diagnostics"][0]["code"],
            "invalid_domain"
        );
        let mut p = project();
        p["routes"] = json!({"aliases":{"oauth":{"domain":suffix}}});
        assert_eq!(compile_value(&p)["ok"], false);
    }
    let mut p = project();
    p["routes"] = json!({"domain":"hack","http":{"web":route("web","123")}});
    let out = result(&request(&p));
    assert_eq!(out["ok"], true);
    assert_eq!(
        out["routing_resolution"]["routes"]["web"]["origin"],
        "https://123.example.hack"
    );
}

#[test]
fn routing_probe_defers_context_dependent_collisions_without_changing_hashes() {
    let mut p = project();
    p["routes"] = json!({"aliases":{"oauth":{"domain":"hack.local"}}});
    let mut r = request(&p);
    assert_eq!(result(&r)["diagnostics"][0]["code"], "route_collision");
    r["routing_probe"] = json!(true);
    let probe = result(&r);
    assert_eq!(probe["ok"], true);
    assert_eq!(probe["routing_inputs_required"], true);
    assert!(probe.get("routing_resolution").is_none());
    r["global_domain"] = json!("custom.test");
    let probe = result(&r);
    r.as_object_mut().unwrap().remove("routing_probe");
    let final_result = result(&r);
    assert_eq!(final_result["ok"], true);
    assert_eq!(probe["local_resolution"], final_result["local_resolution"]);
    p["routes"] = json!({"aliases":{"fixed":{"origin":"https://example.hack.local"}}});
    r = request(&p);
    r["routing_probe"] = json!(true);
    assert_eq!(result(&r)["routing_inputs_required"], true);
    r.as_object_mut().unwrap().remove("routing_probe");
    r["branch"] = json!("feature");
    assert_eq!(result(&r)["ok"], true);
    let mut no_routing = request(&project());
    let expected = result(&no_routing);
    no_routing["routing_probe"] = json!(true);
    assert_eq!(result(&no_routing), expected);
    for value in [true, false] {
        let mut plan_request = request(&project());
        plan_request["routing_probe"] = json!(value);
        plan_request["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"api":{},"init":{}},"inactive_scopes":[]});
        let out = serde_json::to_value(plan(plan_request.to_string().as_bytes(), &[])).unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["diagnostics"][0]["pointer"], "/routing_probe");
    }
}
