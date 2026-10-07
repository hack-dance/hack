use hack_config_compiler::{compile, environment::plan, local::resolve};
use serde_json::{Value, json};

fn project() -> Value {
    json!({"schema_version":1,"name":"example","profiles":["dev"],"services":{"web":{"image":"web:1"},"db":{"image":"db:1","profiles":["dev"]}},"jobs":{"init":{"image":"init:1"}}})
}
fn request(project: &Value) -> Value {
    json!({"request_version":1,"project":project.to_string()})
}
fn compiled(project: &Value, profiles: &[String]) -> Value {
    serde_json::to_value(compile(project.to_string().as_bytes(), profiles)).unwrap()
}
fn resolved(request: &Value) -> Value {
    serde_json::to_value(resolve(request.to_string().as_bytes(), &[])).unwrap()
}
fn planned(request: &Value) -> Value {
    let mut request = request.clone();
    let project: Value = serde_json::from_str(request["project"].as_str().unwrap()).unwrap();
    let mut workloads = serde_json::Map::new();
    for namespace in ["services", "jobs"] {
        for name in project[namespace]
            .as_object()
            .into_iter()
            .flat_map(|map| map.keys())
        {
            workloads.insert(name.clone(), json!({}));
        }
    }
    request["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":workloads,"inactive_scopes":[]});
    if project.get("host").is_some() {
        request["env_metadata"]["host"] = json!({"default":{},"workloads":{}});
    }
    serde_json::to_value(plan(request.to_string().as_bytes(), &[])).unwrap()
}
fn endpoint(reference: Value) -> Value {
    json!({"endpoint":reference})
}
fn host(port: u16) -> Value {
    json!({"kind":"host","port":port,"protocol":"tcp"})
}
fn local(bindings: Value) -> Value {
    json!({"schema_version":1,"host_bindings":bindings})
}
fn refusal(output: &Value, code: &str, role: Option<&str>) {
    assert_eq!(
        output["ok"], false,
        "diagnostics: {}",
        output["diagnostics"]
    );
    assert_eq!(output["diagnostics"][0]["code"], code, "{output}");
    if let Some(role) = role {
        assert_eq!(output["diagnostics"][0]["document"], role, "{output}");
    }
}

#[test]
fn absent_fields_keep_historical_plan_and_resolution_bytes() {
    let p = json!({"schema_version":1,"name":"example"});
    let output = resolved(&request(&p));
    assert!(output["plan"].get("host_bindings").is_none());
    assert!(output.get("host_binding_resolution").is_none());
    assert_eq!(output["semantic_hash"], compiled(&p, &[])["semantic_hash"]);
    let plan = planned(&request(&p));
    assert_eq!(plan["plan"], output["plan"]);
    assert_eq!(plan["local_resolution"], output["local_resolution"]);
    assert!(plan.get("host_binding_resolution").is_none());
}

#[test]
fn external_host_service_and_route_endpoint_targets_remain_typed() {
    let mut p = project();
    p["host_bindings"] = json!({"database":host(5432),"external":{"kind":"external","hostname":"api.example.com","port":443,"protocol":"https"}});
    p["routes"] = json!({"domain":"hack.gy","http":{"app":{"service":"web","port":3000,"hostname":"app","protocol":"http"}}});
    p["services"]["web"]["environment"] = json!({
        "PUBLIC":endpoint(json!({"kind":"route","name":"app"})),
        "SERVICE":endpoint(json!({"kind":"service","name":"web","port":3000,"protocol":"http"})),
        "DATABASE":endpoint(json!({"kind":"host_binding","name":"database"})),
        "EXTERNAL":endpoint(json!({"kind":"host_binding","name":"external"}))
    });
    p["host"] = json!({"processes":{"watch":{"command":{"shell":"exit 97"},"environment":{"DATABASE":endpoint(json!({"kind":"host_binding","name":"database"}))}}}});
    let mut r = request(&p);
    r["branch"] = json!("feature");
    let output = planned(&r);
    assert_eq!(output["environment_plan"]["complete"], true, "{output}");
    let bindings = &output["environment_plan"]["workloads"]["web"];
    assert_eq!(
        bindings["PUBLIC"]["target"],
        json!({"kind":"route","origin":"https://app.feature.example.hack.gy"})
    );
    assert_eq!(
        bindings["SERVICE"]["target"],
        json!({"kind":"service","name":"web","port":3000,"protocol":"http"})
    );
    assert_eq!(
        bindings["DATABASE"]["target"],
        json!({"kind":"host","context":"workload","port":5432,"protocol":"tcp"})
    );
    assert_eq!(
        bindings["EXTERNAL"]["target"],
        json!({"kind":"external","hostname":"api.example.com","port":443,"protocol":"https"})
    );
    assert_eq!(
        output["environment_plan"]["host"]["watch"]["bindings"]["DATABASE"]["target"]["context"],
        "host"
    );
    for value in bindings.as_object().unwrap().values() {
        assert_eq!(value["kind"], "endpoint");
        assert!(value.get("value").is_none());
    }
}

#[test]
fn host_bindings_merge_per_name_with_tombstone_and_readdition_provenance() {
    let mut p = project();
    p["host_bindings"] =
        json!({"database":host(1),"retained":host(2),"removed":host(3),"readded":host(4)});
    let mut r = request(&p);
    r["primary_local"] =
        json!(local(json!({"database":host(10),"removed":null,"readded":null})).to_string());
    r["checkout_local"] = json!(
        local(json!({"database":host(11),"readded":host(12),"new":host(13),"absent":null}))
            .to_string()
    );
    let output = resolved(&r);
    assert_eq!(output["ok"], true, "{output}");
    let bindings = &output["host_binding_resolution"];
    assert_eq!(
        bindings["bindings"]["database"],
        json!({"target":host(11),"origin":"checkout_local"})
    );
    assert_eq!(bindings["bindings"]["retained"]["origin"], "project");
    assert_eq!(bindings["bindings"]["readded"]["target"], host(12));
    assert_eq!(
        bindings["removed"],
        json!({"removed":"primary_local","absent":"checkout_local"})
    );
    assert_eq!(output["plan"]["host_bindings"], p["host_bindings"]);
    assert_eq!(planned(&r)["host_binding_resolution"], *bindings);
    assert_eq!(output["semantic_hash"], compiled(&p, &[])["semantic_hash"]);
}

#[test]
fn local_changes_affect_only_resolution_generation_and_inheritance_optout() {
    let mut p = project();
    p["host_bindings"] = json!({"database":host(1)});
    let mut r = request(&p);
    let base = resolved(&r);
    r["primary_local"] = json!(local(json!({"database":host(2)})).to_string());
    let changed = resolved(&r);
    assert_eq!(base["semantic_hash"], changed["semantic_hash"]);
    assert_ne!(
        base["local_resolution"]["resolution_hash"],
        changed["local_resolution"]["resolution_hash"]
    );
    p["worktree"] = json!({"inherit_local":false});
    r["project"] = json!(p.to_string());
    let output = resolved(&r);
    assert_eq!(
        output["host_binding_resolution"]["bindings"]["database"]["target"],
        host(1)
    );
    let omitted = resolved(&request(&p));
    assert_ne!(
        output["local_resolution"]["resolution_hash"],
        omitted["local_resolution"]["resolution_hash"]
    );
    r["checkout_local"] = json!(local(json!({"database":host(3)})).to_string());
    assert_eq!(
        resolved(&r)["host_binding_resolution"]["bindings"]["database"]["target"],
        host(3)
    );
}

#[test]
fn invalid_ignored_primary_binding_still_refuses_with_redacted_location() {
    let mut p = project();
    p["worktree"] = json!({"inherit_local":false});
    let mut r = request(&p);
    r["primary_local"] = json!(local(json!({"database":{"kind":"external","hostname":"private-sentinel/secret","port":2,"protocol":"tcp"}})).to_string());
    let output = resolved(&r);
    refusal(&output, "invalid_host_binding", Some("primary_local"));
    assert!(!output.to_string().contains("private-sentinel"));
    assert_eq!(
        output["diagnostics"][0]["pointer"],
        "/host_bindings/database/hostname"
    );
}

#[test]
fn context_free_logical_refs_can_be_locally_provisioned_but_not_guessed() {
    let mut p = project();
    p["services"]["web"]["environment"] =
        json!({"DATABASE":endpoint(json!({"kind":"host_binding","name":"database"}))});
    assert_eq!(compiled(&p, &[])["ok"], true);
    let mut r = request(&p);
    refusal(&resolved(&r), "unknown_host_binding", Some("project"));
    r["checkout_local"] = json!(local(json!({"database":host(5432)})).to_string());
    assert_eq!(resolved(&r)["ok"], true);
    assert_eq!(planned(&r)["environment_plan"]["complete"], true);
    r["checkout_local"] = json!(local(json!({"database":null})).to_string());
    for probe in [false, true] {
        r["routing_probe"] = json!(probe);
        let output = resolved(&r);
        refusal(&output, "removed_host_binding", Some("checkout_local"));
        assert_eq!(
            output["diagnostics"][0]["pointer"],
            "/host_bindings/database"
        );
    }
}

#[test]
fn missing_binding_in_an_inactive_workload_is_still_checked() {
    let mut p = project();
    p["services"]["db"]["environment"] =
        json!({"DATABASE":endpoint(json!({"kind":"host_binding","name":"database"}))});
    let mut r = request(&p);
    refusal(&resolved(&r), "unknown_host_binding", Some("project"));
    r["primary_local"] = json!(local(json!({"database":host(2)})).to_string());
    assert_eq!(resolved(&r)["ok"], true);
    assert!(
        planned(&r)["environment_plan"]["workloads"]
            .get("db")
            .is_none()
    );
}

#[test]
fn all_declared_route_and_service_refs_are_validated_before_profile_filtering() {
    for reference in [
        json!({"kind":"service","name":"init","port":2,"protocol":"tcp"}),
        json!({"kind":"service","name":"missing","port":2,"protocol":"tcp"}),
        json!({"kind":"route","name":"missing"}),
    ] {
        let mut p = project();
        p["services"]["db"]["environment"] = json!({"TARGET":endpoint(reference)});
        refusal(&compiled(&p, &[]), "unknown_endpoint_target", None);
    }
    for reference in [
        json!({"kind":"service","name":"db","port":2,"protocol":"tcp"}),
        json!({"kind":"route","name":"database"}),
    ] {
        let mut p = project();
        p["routes"] = json!({"http":{"database":{"service":"db","port":2,"hostname":"database"}}});
        p["services"]["web"]["environment"] = json!({"TARGET":endpoint(reference.clone())});
        refusal(&compiled(&p, &[]), "inactive_endpoint_target", None);
        assert_eq!(compiled(&p, &["dev".into()])["ok"], true);
        p["services"]["web"]["profiles"] = json!(["dev"]);
        assert_eq!(compiled(&p, &[])["ok"], true);
    }
}

#[test]
fn route_probe_defers_origin_collisions_while_binding_refs_are_validated() {
    let mut p = project();
    p["routes"] = json!({"aliases":{"pinned":{"origin":"https://example.hack.local"}},"http":{"app":{"service":"web","port":3000,"hostname":"app"}}});
    p["services"]["web"]["environment"] =
        json!({"PUBLIC":endpoint(json!({"kind":"route","name":"app"}))});
    p["host_bindings"] = json!({});
    let mut r = request(&p);
    r["routing_probe"] = json!(true);
    let probe = resolved(&r);
    assert_eq!(probe["ok"], true, "{probe}");
    assert_eq!(probe["routing_inputs_required"], true);
    assert!(probe.get("routing_resolution").is_none());
    assert_eq!(
        probe["host_binding_resolution"],
        json!({"bindings":{},"removed":{}})
    );
    r["routing_probe"] = json!(false);
    r["global_domain"] = json!("hack.gy");
    let output = resolved(&r);
    assert_eq!(output["ok"], true);
    r.as_object_mut().unwrap().remove("routing_probe");
    let planned = planned(&r);
    assert_eq!(planned["environment_plan"]["complete"], true);
    assert_eq!(
        planned["environment_plan"]["workloads"]["web"]["PUBLIC"]["target"]["origin"],
        "https://app.example.hack.gy"
    );
}

#[test]
fn service_endpoint_for_host_context_is_incomplete_without_guessing_a_url() {
    let mut p = project();
    p["host"] = json!({"processes":{"watch":{"command":{"exec":["false"]},"environment":{"SERVICE":endpoint(json!({"kind":"service","name":"web","port":3000,"protocol":"http"}))}}}});
    let output = planned(&request(&p));
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["environment_plan"]["complete"], false);
    assert_eq!(
        output["environment_plan"]["diagnostics"][0]["code"],
        "unsupported_endpoint_context"
    );
    assert_eq!(
        output["environment_plan"]["diagnostics"][0]["pointer"],
        "/host/processes/watch/environment/SERVICE"
    );
    assert!(
        output["environment_plan"]["host"]["watch"]["bindings"]
            .get("SERVICE")
            .is_none()
    );
}

#[test]
fn endpoint_never_replaces_the_same_managed_key_and_other_unset_cannot_authorize_it() {
    let mut p = project();
    p["services"]["web"]["environment"] = json!({"TARGET":endpoint(json!({"kind":"service","name":"web","port":3000,"protocol":"http"})),"OTHER":{"unset":true}});
    let mut r = request(&p);
    r["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{"TARGET":{"scope":"global","secret":true},"OTHER":{"scope":"web","secret":true}},"db":{},"init":{}},"inactive_scopes":[]});
    let output = serde_json::to_value(plan(r.to_string().as_bytes(), &[])).unwrap();
    assert_eq!(output["environment_plan"]["complete"], false);
    assert_eq!(
        output["environment_plan"]["diagnostics"][0]["code"],
        "env_endpoint_collision"
    );
    assert_eq!(
        output["environment_plan"]["workloads"]["web"]["TARGET"],
        json!({"kind":"managed","key":"TARGET","scope":"global","secret":true})
    );
    assert!(
        output["environment_plan"]["workloads"]["web"]
            .get("OTHER")
            .is_none()
    );
    p["services"]["web"]["environment"]["TARGET"]["unset"] = json!(true);
    refusal(&compiled(&p, &[]), "invalid_shape", None);
}

#[test]
fn canonical_external_hosts_accept_dns_and_ip_but_not_ambiguous_authorities() {
    for hostname in [
        "api.example.com",
        "localhost",
        "internal",
        "127.0.0.1",
        "[::1]",
        "[::ffff:7f00:1]",
    ] {
        let mut p = project();
        p["host_bindings"] =
            json!({"external":{"kind":"external","hostname":hostname,"port":80,"protocol":"http"}});
        assert_eq!(compiled(&p, &[])["ok"], true, "{hostname}");
    }
    for hostname in [
        "API.example.com",
        "foo.",
        "a..com",
        "1",
        "0x7f000001",
        "127.1",
        "127.00.0.1",
        "[0:0:0:0:0:0:0:1]",
        "[::ffff:127.0.0.1]",
        "localhost:3000",
        "user@host",
        "host/path",
        "host?query",
        "host#secret",
        "*.example.com",
        "https://example.com",
        "host%2ecom",
    ] {
        let mut p = project();
        p["host_bindings"] =
            json!({"external":{"kind":"external","hostname":hostname,"port":80,"protocol":"http"}});
        refusal(&compiled(&p, &[]), "invalid_host_binding", None);
    }
}

#[test]
fn strict_endpoint_and_binding_shapes_refuse_tuple_and_secret_input_without_echo() {
    for binding in [
        json!([]),
        json!(["host", 2, "tcp"]),
        json!(null),
        json!({"kind":"host","port":0,"protocol":"tcp"}),
        json!({"kind":"host","port":1,"protocol":"udp"}),
        json!({"kind":"host","port":1,"protocol":"tcp","command":"private-sentinel"}),
        json!({"kind":"external","hostname":"api.example.com","port":1,"protocol":"https","credentials":"private-sentinel"}),
    ] {
        let mut p = project();
        p["host_bindings"] = json!({"database":binding});
        let output = compiled(&p, &[]);
        assert_eq!(output["ok"], false, "{output}");
        assert!(!output.to_string().contains("private-sentinel"));
    }
    for reference in [
        json!([]),
        json!(["service", "web", 2, "tcp"]),
        json!(null),
        json!({"kind":"service","name":"web","port":2}),
        json!({"kind":"service","name":"web","port":2,"protocol":"tcp","path":"private-sentinel"}),
        json!({"kind":"route","name":"web","port":2}),
        json!({"kind":"host_binding","name":"database","credential":"private-sentinel"}),
    ] {
        let mut p = project();
        p["services"]["web"]["environment"] = json!({"TARGET":endpoint(reference.clone())});
        let output = compiled(&p, &[]);
        assert_eq!(output["ok"], false, "{output}");
        assert!(!output.to_string().contains("private-sentinel"));
        p["services"]["web"]["environment"] = json!({});
        p["host"] = json!({"processes":{"watch":{"command":{"exec":["false"]},"environment":{"TARGET":endpoint(reference)}}}});
        assert_eq!(compiled(&p, &[])["ok"], false);
    }
    for name in [
        "DB",
        "db_name",
        "db.name",
        "db-",
        "-db",
        "db--name",
        "",
        &"a".repeat(64),
    ] {
        let mut p = project();
        p["host_bindings"] = json!({name:host(2)});
        refusal(&compiled(&p, &[]), "invalid_name", None);
        let mut r = request(&project());
        r["checkout_local"] = json!(local(json!({name:null})).to_string());
        refusal(&resolved(&r), "invalid_name", Some("checkout_local"));
    }
}

#[test]
fn endpoint_replication_uses_shared_preallocation_budget() {
    let mut p = project();
    let hostname = (0..4).map(|_| "a".repeat(60)).collect::<Vec<_>>().join(".");
    p["host_bindings"] =
        json!({"external":{"kind":"external","hostname":hostname,"port":443,"protocol":"https"}});
    let mut processes = serde_json::Map::new();
    let mut directives = serde_json::Map::new();
    for index in 0..100 {
        directives.insert(
            format!("TARGET{index}"),
            endpoint(json!({"kind":"host_binding","name":"external"})),
        );
    }
    for index in 0..130 {
        processes.insert(
            format!("p{index}"),
            json!({"command":{"exec":["false"]},"environment":directives}),
        );
    }
    p["host"] = json!({"processes":processes});
    assert!(p.to_string().len() < hack_config_compiler::MAX_INPUT_BYTES);
    let mut r = request(&p);
    let mut baseline = serde_json::Map::new();
    for index in 0..100 {
        baseline.insert(
            format!("BASE{index}{}", "A".repeat(200)),
            json!({"scope":"global","secret":true}),
        );
    }
    r["env_metadata"] = json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{},"db":{},"init":{}},"inactive_scopes":[],"host":{"default":baseline,"workloads":{}}});
    let output = serde_json::to_value(plan(r.to_string().as_bytes(), &[])).unwrap();
    refusal(&output, "plan_too_large", Some("project"));
    assert!(output.to_string().len() < 1024);
}
