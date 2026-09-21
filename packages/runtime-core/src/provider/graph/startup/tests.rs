use super::*;

fn config() -> Value {
    json!({
        "Entrypoint":["/bin/app","--mode"],"Cmd":["space argument",""],
        "User":"1001:1002","Env":["PUBLIC_MODE=fixture"],
        "OpenStdin":true,"StdinOnce":false,"AttachStdin":true,"Tty":false,
        "Healthcheck":{"Test":["CMD","/bin/check","argument with spaces"],"Interval":100000000,"Timeout":50000000,"Retries":4,"StartPeriod":250000000},
        "HostConfig":{"Init":true,"Mounts":[]}
    })
}
fn service() -> Service {
    Service {
        generation: "a".repeat(32),
        bindings: BTreeMap::from([(
            "default".into(),
            Binding {
                endpoint_generation: None,
                aliases: vec![],
                slot: 1,
                port: 25252,
                process: None,
            },
        )]),
        phase: Phase::Prepared,
        started_at: None,
    }
}
#[test]
fn exact_aliases_share_a_port_without_sharing_a_listener() {
    let mut selected = service();
    selected.bindings = BTreeMap::from([
        (
            "one".into(),
            Binding {
                endpoint_generation: None,
                slot: 0,
                port: 443,
                aliases: vec!["one.example".into()],
                process: None,
            },
        ),
        (
            "two".into(),
            Binding {
                endpoint_generation: None,
                slot: 1,
                port: 443,
                aliases: vec!["two.example".into()],
                process: None,
            },
        ),
    ]);
    let mut value = config();
    value["HostConfig"]["NetworkMode"] = json!("none");
    value["HostConfig"]["CapDrop"] = json!(["ALL"]);
    value["HostConfig"]["ExtraHosts"] =
        json!(["one.example:host-gateway", "two.example:host-gateway"]);
    let original = value.clone();
    attach(&mut value, &selected, "/storage/start", "/storage/helper").unwrap();
    assert_eq!(
        value["HostConfig"]["ExtraHosts"],
        json!(["one.example:127.0.0.2", "two.example:127.0.0.3"])
    );
    assert_eq!(
        value["HostConfig"]["Sysctls"],
        json!({"net.ipv4.ip_unprivileged_port_start":"0"})
    );
    assert_eq!(value["User"], "1001:1002");
    assert_eq!(value["HostConfig"]["CapDrop"], json!(["ALL"]));
    for mode in ["host", "container:other", "bridge"] {
        let mut unsafe_config = original.clone();
        unsafe_config["HostConfig"]["NetworkMode"] = json!(mode);
        assert!(
            attach(
                &mut unsafe_config,
                &selected,
                "/storage/start",
                "/storage/helper"
            )
            .is_err()
        );
    }
    let mut unrelated = original;
    unrelated["HostConfig"]["ExtraHosts"] = json!([
        "one.example:host-gateway",
        "unselected.example:host-gateway"
    ]);
    assert!(
        attach(
            &mut unrelated,
            &selected,
            "/storage/start",
            "/storage/helper"
        )
        .is_err()
    );
    selected.bindings.get_mut("two").unwrap().aliases = vec!["one.example".into()];
    assert!(!selected.bindings_valid());
}
fn receipt() -> Receipt {
    serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"preparing","readiness":{},"resources":{
        "container:web":{"kind":"container","key":"web","name":"owned-web","id":null,"image":null,"phase":"reserved"},
        "container:worker":{"kind":"container","key":"worker","name":"owned-worker","id":null,"image":null,"phase":"reserved"}
    }})).unwrap()
}
fn startup() -> Startup {
    Startup {
        control_only: false,
        guest_root: None,
        control_root: PathBuf::from("/private/tmp/owned-relay"),
        artifact: "b".repeat(64),
        services: BTreeMap::from([("web".into(), service())]),
    }
}
#[test]
fn gate_wraps_environment_launch_and_health_without_changing_identity_or_stdin() {
    let mut value = config();
    launcher::attach(
        &mut value,
        "/run/owned/values.json",
        "/storage/owned-env-launcher",
    )
    .unwrap();
    let composed = value.clone();
    attach(
        &mut value,
        &service(),
        "/storage/owned-startup",
        "/storage/owned-relay",
    )
    .unwrap();
    let mut expected = vec![
        json!("/run/hack-relay-guest"),
        json!("--await-release"),
        json!("a".repeat(32)),
        json!("--"),
    ];
    expected.extend(composed["Entrypoint"].as_array().unwrap().clone());
    assert_eq!(value["Entrypoint"], json!(expected));
    assert_eq!(value["Cmd"], json!([]));
    // These application arguments must survive both wrappers as distinct argv entries.
    assert_eq!(
        &value["Entrypoint"].as_array().unwrap()[7..],
        &[
            json!("/bin/app"),
            json!("--mode"),
            json!("space argument"),
            json!("")
        ]
    );
    let mut health = vec![
        json!("CMD"),
        json!("/run/hack-relay-guest"),
        json!("--check-release"),
        json!("a".repeat(32)),
        json!("--"),
    ];
    health.extend(composed["Healthcheck"]["Test"].as_array().unwrap()[1..].to_vec());
    assert_eq!(value["Healthcheck"]["Test"], json!(health));
    for field in ["Interval", "Timeout", "Retries", "StartPeriod"] {
        assert_eq!(value["Healthcheck"][field], composed["Healthcheck"][field]);
    }
    for field in [
        "User",
        "Env",
        "OpenStdin",
        "StdinOnce",
        "AttachStdin",
        "Tty",
    ] {
        assert_eq!(value[field], composed[field]);
    }
    let prior = composed["HostConfig"]["Mounts"].as_array().unwrap();
    let mounts = value["HostConfig"]["Mounts"].as_array().unwrap();
    assert_eq!(&mounts[..prior.len()], prior);
    assert_eq!(mounts.len(), prior.len() + 3);
    assert!(mounts.iter().all(|mount| mount["ReadOnly"] == true));
    assert_eq!(
        mounts.last().unwrap()["Source"],
        "/run/hack-dependencies/dependency-01.sock"
    );
    assert_eq!(
        mounts.last().unwrap()["Target"],
        "/run/hack-dependencies/dependency-01.sock"
    );
}
#[test]
fn reserved_mount_ancestors_and_descendants_refuse_before_mutation() {
    for target in [
        "/",
        "/run",
        "/run/hack-startup",
        "/run/hack-startup/release",
        "/run/hack-dependencies",
        "/run/hack-dependencies/dependency-01.sock",
        "/run/hack-relay-guest",
        "/run/hack-relay-guest/child",
    ] {
        let mut value = config();
        value["HostConfig"]["Mounts"] =
            json!([{"Type":"bind","Source":"/fixture","Target":target,"ReadOnly":true}]);
        let before = value.clone();
        assert!(
            attach(&mut value, &service(), "/storage/gate", "/storage/helper").is_err(),
            "accepted reserved overlap {target}"
        );
        assert_eq!(value, before, "mutated refused config {target}");
    }
    let mut adjacent = config();
    adjacent["HostConfig"]["Mounts"] = json!([{"Type":"bind","Source":"/fixture","Target":"/run/hack-startup-other","ReadOnly":true}]);
    attach(
        &mut adjacent,
        &service(),
        "/storage/gate",
        "/storage/helper",
    )
    .unwrap();
}
#[test]
fn receipt_phase_requires_exact_provisioning_evidence() {
    let receipt = receipt();
    let original = startup();
    assert!(original.valid(&receipt));
    for phase in [Phase::ProvisionIntent, Phase::Provisioned, Phase::Released] {
        let mut value = original.clone();
        value.services.get_mut("web").unwrap().phase = phase;
        assert!(!value.valid(&receipt));
        value.services.get_mut("web").unwrap().started_at = Some("2026-09-17T12:00:00Z".into());
        assert_eq!(value.valid(&receipt), phase == Phase::ProvisionIntent);
        value
            .services
            .get_mut("web")
            .unwrap()
            .bindings
            .get_mut("default")
            .unwrap()
            .process = Some(super::super::super::lifecycle::RelayProcess {
            address: std::net::Ipv4Addr::LOCALHOST,
            pid: 42,
            start: 123,
            port: 25252,
        });
        assert!(value.valid(&receipt));
        if phase == Phase::ProvisionIntent {
            continue;
        }
        for process in [(1, 123, 25252), (42, 0, 25252), (42, 123, 25253)] {
            let mut malformed = value.clone();
            malformed
                .services
                .get_mut("web")
                .unwrap()
                .bindings
                .get_mut("default")
                .unwrap()
                .process = Some(super::super::super::lifecycle::RelayProcess {
                address: std::net::Ipv4Addr::LOCALHOST,
                pid: process.0,
                start: process.1,
                port: process.2,
            });
            assert!(!malformed.valid(&receipt));
        }
        for started in ["", "0001-01-01T00:00:00Z", "2026-09-17\n"] {
            let mut malformed = value.clone();
            malformed.services.get_mut("web").unwrap().started_at = Some(started.into());
            assert!(!malformed.valid(&receipt));
        }
    }
    let mut prepared = original.clone();
    prepared.services.get_mut("web").unwrap().started_at = Some("2026-09-17T12:00:00Z".into());
    assert!(!prepared.valid(&receipt));
    let mut unknown = serde_json::to_value(&original).unwrap();
    unknown["services"]["web"]["phase"] = json!("ready");
    assert!(serde_json::from_value::<Startup>(unknown).is_err());
}
#[test]
fn receipt_refuses_duplicate_slots_missing_services_and_invalid_capacity() {
    let receipt = receipt();
    let mut value = startup();
    value.services.insert("worker".into(), service());
    assert!(!value.valid(&receipt));
    value
        .services
        .get_mut("worker")
        .unwrap()
        .bindings
        .get_mut("default")
        .unwrap()
        .slot = 2;
    assert!(value.valid(&receipt));
    value
        .services
        .get_mut("worker")
        .unwrap()
        .bindings
        .get_mut("default")
        .unwrap()
        .slot = 32;
    assert!(!value.valid(&receipt));
    value.services.remove("worker");
    value.services.insert("unknown".into(), {
        let mut service = service();
        service.bindings.get_mut("default").unwrap().slot = 2;
        service
    });
    assert!(!value.valid(&receipt));
}

#[test]
fn multiple_bindings_hold_service_until_every_process_is_provisioned() {
    let receipt = receipt();
    let mut value = startup();
    let service = value.services.get_mut("web").unwrap();
    service.bindings.insert(
        "search".into(),
        Binding {
            endpoint_generation: None,
            aliases: vec![],
            slot: 2,
            port: 25253,
            process: None,
        },
    );
    service.phase = Phase::ProvisionIntent;
    service.started_at = Some("2026-09-17T12:00:00Z".into());
    service.bindings.get_mut("default").unwrap().process =
        Some(super::super::super::lifecycle::RelayProcess {
            address: std::net::Ipv4Addr::LOCALHOST,
            pid: 42,
            start: 123,
            port: 25252,
        });
    assert!(value.valid(&receipt));
    assert!(!value.services["web"].all_provisioned());
    for phase in [Phase::Provisioned, Phase::Released] {
        value.services.get_mut("web").unwrap().phase = phase;
        assert!(!value.valid(&receipt));
    }
    value
        .services
        .get_mut("web")
        .unwrap()
        .bindings
        .get_mut("search")
        .unwrap()
        .process = Some(super::super::super::lifecycle::RelayProcess {
        address: std::net::Ipv4Addr::LOCALHOST,
        pid: 43,
        start: 124,
        port: 25253,
    });
    assert!(value.valid(&receipt));
    assert!(value.services["web"].all_provisioned());
    let mut config = config();
    attach(
        &mut config,
        &value.services["web"],
        "/storage/gate",
        "/storage/helper",
    )
    .unwrap();
    let mounts = config["HostConfig"]["Mounts"].as_array().unwrap();
    assert_eq!(mounts.len(), 4);
    for slot in [1, 2] {
        assert_eq!(
            mounts
                .iter()
                .filter(
                    |m| m["Target"] == format!("/run/hack-dependencies/dependency-{slot:02}.sock")
                )
                .count(),
            1
        );
    }
    let service = value.services.get_mut("web").unwrap();
    service.bindings.get_mut("search").unwrap().port = 25252;
    service.bindings.get_mut("search").unwrap().process = None;
    service.phase = Phase::ProvisionIntent;
    assert!(!value.valid(&receipt));
}
#[test]
fn legacy_or_empty_binding_receipts_are_not_silently_adopted() {
    let legacy = json!({"generation":"a".repeat(32),"slot":1,"port":25252,"phase":"prepared","started_at":null,"process":null});
    assert!(serde_json::from_value::<Service>(legacy).is_err());
    let mut value = startup();
    value.services.get_mut("web").unwrap().bindings.clear();
    assert!(!value.valid(&receipt()));
    value.services.get_mut("web").unwrap().bindings.insert(
        "bad/name".into(),
        Binding {
            endpoint_generation: None,
            aliases: vec![],
            slot: 1,
            port: 25252,
            process: None,
        },
    );
    assert!(!value.valid(&receipt()));
}

#[test]
fn named_routes_refuse_resolver_mount_shadowing_without_changing_aliasless_policy() {
    for target in [
        "/etc",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/hosts/child",
        "/etc/nsswitch.conf/child",
    ] {
        let mut original = config();
        original["HostConfig"]["Mounts"] =
            json!([{"Type":"bind", "Source":"/storage/source", "Target":target, "ReadOnly":true}]);
        let mut aliasless = original.clone();
        attach(
            &mut aliasless,
            &service(),
            "/storage/gate",
            "/storage/helper",
        )
        .unwrap();
        let mut named = service();
        named.bindings.get_mut("default").unwrap().aliases = vec!["one.example".into()];
        original["HostConfig"]["ExtraHosts"] = json!(["one.example:host-gateway"]);
        assert!(
            attach(&mut original, &named, "/storage/gate", "/storage/helper").is_err(),
            "{target}"
        );
    }
    let mut named = service();
    named.bindings.get_mut("default").unwrap().aliases = vec!["one.example".into()];
    let mut config = config();
    config["HostConfig"]["ExtraHosts"] = json!(["one.example:host-gateway"]);
    config["HostConfig"]["Mounts"] = json!([{"Target":"/etc/hosts-backup"}]);
    attach(&mut config, &named, "/storage/gate", "/storage/helper").unwrap();
}

#[test]
fn control_only_receipt_is_explicit_and_cannot_claim_guest_artifacts() {
    let mut value = startup();
    value.services.clear();
    assert!(!value.valid(&receipt()));
    value.control_only = true;
    assert!(value.valid(&receipt()));
    let serialized = serde_json::to_value(&value).unwrap();
    assert!(
        serde_json::from_value::<Startup>(serialized.clone())
            .unwrap()
            .valid(&receipt())
    );
    let mut legacy = serialized;
    legacy.as_object_mut().unwrap().remove("control_only");
    assert!(
        !serde_json::from_value::<Startup>(legacy)
            .unwrap()
            .valid(&receipt())
    );
    value.guest_root = Some((1, 2));
    assert!(!value.valid(&receipt()));
    value.guest_root = None;
    value.services.insert("web".into(), service());
    assert!(!value.valid(&receipt()));
}

#[test]
fn shared_listener_receipt_retains_72_grants_on_six_exact_transports() {
    let mut receipt = receipt();
    let resource = receipt.resources["container:web"].clone();
    let mut value = startup();
    value.services.clear();
    for index in 0..12 {
        let name = format!("service-{index}");
        receipt
            .resources
            .insert(format!("container:{name}"), resource.clone());
        let mut selected = service();
        selected.bindings = (0..6)
            .map(|slot| {
                (
                    format!("binding-{slot}"),
                    Binding {
                        slot,
                        endpoint_generation: Some(format!("{slot:064x}")),
                        port: 9000 + u16::from(slot),
                        aliases: vec![format!("dependency-{slot}.example")],
                        process: None,
                    },
                )
            })
            .collect();
        value.services.insert(name, selected);
    }
    let retained: Startup = serde_json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(retained.valid(&receipt));
    assert_eq!(
        retained
            .services
            .values()
            .map(|s| s.bindings.len())
            .sum::<usize>(),
        72
    );
    for changed in [None, Some("f".repeat(64)), Some("not-a-generation".into())] {
        let mut bad = retained.clone();
        bad.services
            .get_mut("service-11")
            .unwrap()
            .bindings
            .get_mut("binding-0")
            .unwrap()
            .endpoint_generation = changed;
        assert!(!bad.valid(&receipt));
    }
    let mut collision = retained.clone();
    collision
        .services
        .get_mut("service-11")
        .unwrap()
        .bindings
        .get_mut("binding-1")
        .unwrap()
        .slot = 0;
    assert!(!collision.valid(&receipt));
    let mut excessive = retained;
    for index in 12..22 {
        let name = format!("service-{index}");
        receipt
            .resources
            .insert(format!("container:{name}"), resource.clone());
        excessive
            .services
            .insert(name, excessive.services["service-0"].clone());
    }
    assert!(!excessive.valid(&receipt));
}
