use super::*;
use serde_json::json;

fn resources(run: &str) -> BTreeMap<String, Resource> {
    let resource = |kind: &str, key: &str, name: String, cache: Option<Value>| -> Resource {
        let mut value =
            json!({"kind":kind,"key":key,"name":name,"id":null,"image":null,"phase":"created"});
        if let Some(cache) = cache {
            value["cache"] = cache;
        }
        serde_json::from_value(value).unwrap()
    };
    BTreeMap::from([
        (
            "network:default".into(),
            resource("network", "default", format!("hkg-{run}-network-0"), None),
        ),
        (
            "volume:data".into(),
            resource("volume", "data", format!("hkg-{run}-volume-0"), None),
        ),
    ])
}

/// The shape `prepare_delivery` compiles for one service, before attachments.
fn config(run: &str, owner: &str, plan: &str) -> Value {
    json!({
        "Image": format!("sha256:{}", "a".repeat(64)),
        "Labels": {
            "io.hack-local.owner": owner, "io.hack-local.graph": run,
            "io.hack-local.namespace": "n".repeat(64), "io.hack-local.plan": plan,
            "io.hack-local.kind": "container", "io.hack-local.resource": "web",
            "hack.inert": "kept"
        },
        "Entrypoint": ["/bin/app"], "Cmd": ["serve", "--port", "3000"],
        "User": "1000:1000", "WorkingDir": "/app", "Env": ["MODE=dev"],
        "ExposedPorts": {"3000/tcp": {}}, "StopTimeout": 10,
        "Healthcheck": {"Test": ["CMD", "true"], "StartPeriod": 1, "StartInterval": 2},
        "HostConfig": {
            "NetworkMode": format!("hkg-{run}-network-0"), "Memory": 0, "NanoCpus": 0,
            "ReadonlyRootfs": false, "CapDrop": ["ALL"], "CapAdd": ["CAP_CHOWN"],
            "SecurityOpt": ["no-new-privileges"], "Init": false, "ShmSize": 67108864,
            "RestartPolicy": {"Name": "no"},
            "LogConfig": {"Type": "json-file", "Config": {"max-size": "1m", "max-file": "1"}},
            "ExtraHosts": ["db.local:10.0.0.2"],
            "Mounts": [
                {"Type": "volume", "Source": format!("hkg-{run}-volume-0"), "Target": "/data", "ReadOnly": false},
                {"Type": "bind", "Source": "/storage/source/tree", "Target": "/src", "ReadOnly": true, "BindOptions": {"Propagation": "rprivate"}}
            ]
        },
        "NetworkingConfig": {"EndpointsConfig": {
            format!("hkg-{run}-network-0"): {"Aliases": ["web"]}
        }}
    })
}

fn context(resources: &BTreeMap<String, Resource>) -> Context<'_> {
    Context {
        resources,
        probe: None,
        managed: false,
        relay: Vec::new(),
        amd64_emulation: None,
    }
}

fn digest(config: &Value, resources: &BTreeMap<String, Resource>) -> Digest {
    of(config, &context(resources)).unwrap().digest
}

#[test]
fn restart_uses_authored_cadence_only_for_the_matching_cold_create_spec() {
    let resources = resources(RUN);
    let context = context(&resources);
    let mut fast = config(RUN, "owner", "plan");
    fast["Healthcheck"]["StartInterval"] = json!(crate::project::DEFAULT_START_INTERVAL_NANOS);
    let mut authored = fast.clone();
    authored["Healthcheck"]
        .as_object_mut()
        .unwrap()
        .remove("StartInterval");
    let mut actual = authored.clone();
    actual["Healthcheck"]["StartInterval"] = json!(5_000_000_000u64);
    for (created, expected) in [(&authored, &authored), (&fast, &fast)] {
        let inspected = json!({"Config":stamped(&actual, &of(created, &context).unwrap())});
        let mut replay = fast.clone();
        super::super::restart_health_cadence(&context, &mut replay, false, &inspected).unwrap();
        assert_eq!(&replay, expected);
    }
}

type Edit = Box<dyn Fn(&mut Value)>;

const RUN: &str = "11111111111111111111111111111111";
const OTHER_RUN: &str = "22222222222222222222222222222222";

#[test]
fn golden_body_and_digest_are_pinned() {
    let resources = resources(RUN);
    let body = body(&config(RUN, "o1", "p1"), &context(&resources)).unwrap();
    assert_eq!(body["Labels"], json!({"hack.inert": "kept"}));
    assert_eq!(body["HostConfig"]["NetworkMode"], "network:default");
    assert_eq!(body["HostConfig"]["Mounts"][0]["Source"], "volume:data");
    assert_eq!(
        body["NetworkingConfig"]["EndpointsConfig"],
        json!({"network:default": {"Aliases": ["web"]}})
    );
    assert_eq!(body["x-hack"], json!({}));
    // A change here changes every container's identity: update it only with a
    // reviewed reason (a new compiled field, or a SPEC domain version bump).
    assert_eq!(
        digest(&config(RUN, "o1", "p1"), &resources).to_string(),
        "sha256:42ea3d064ab5aee8c26040a55b11aa9800cd21a7455924b2979af656cae506ca"
    );
}

#[test]
fn per_run_values_leave_the_digest_equal() {
    let base = digest(&config(RUN, "o1", "p1"), &resources(RUN));
    // Another run, another boot incarnation and another plan id.
    assert_eq!(
        digest(&config(OTHER_RUN, "o2", "p2"), &resources(OTHER_RUN)),
        base
    );
    // Probe allocation, generation, owner ids and exec state are per run.
    let probe = |allocation: &str, exec: Option<&str>| -> Probe {
        serde_json::from_value(json!({
            "config": {"port": 3000, "path": "/", "interval_ms": 1000, "timeout_ms": 500,
                       "retries": 3, "start_period_ms": 0},
            "allocation": allocation, "generation": allocation, "binary": "/storage/probe/abc",
            "uid": 1000, "gid": 1000, "exec_id": exec, "started_ms": 7, "phase": "running"
        }))
        .unwrap()
    };
    let resources = resources(RUN);
    let (first, second) = (
        probe(&"a".repeat(32), None),
        probe(&"b".repeat(32), Some("e")),
    );
    let with = |p| {
        of(
            &config(RUN, "o1", "p1"),
            &Context {
                probe: Some(p),
                ..context(&resources)
            },
        )
        .unwrap()
        .digest
    };
    assert_eq!(with(&first), with(&second));
    assert_ne!(with(&first), base);
}

#[test]
fn every_compiled_field_changes_the_digest() {
    let resources = resources(RUN);
    let base = digest(&config(RUN, "o1", "p1"), &resources);
    let edits: Vec<(&str, Edit)> = vec![
        (
            "Image",
            Box::new(|c| c["Image"] = json!(format!("sha256:{}", "b".repeat(64)))),
        ),
        (
            "Entrypoint",
            Box::new(|c| c["Entrypoint"] = json!(["/bin/other"])),
        ),
        (
            "Cmd",
            Box::new(|c| c["Cmd"] = json!(["serve", "--port", "3001"])),
        ),
        (
            "Cmd order",
            Box::new(|c| c["Cmd"] = json!(["--port", "serve", "3000"])),
        ),
        ("User", Box::new(|c| c["User"] = json!("0:0"))),
        ("WorkingDir", Box::new(|c| c["WorkingDir"] = json!("/srv"))),
        ("Env", Box::new(|c| c["Env"] = json!(["MODE=prod"]))),
        (
            "ExposedPorts",
            Box::new(|c| c["ExposedPorts"] = json!({"3001/tcp": {}})),
        ),
        ("StopTimeout", Box::new(|c| c["StopTimeout"] = json!(11))),
        (
            "Healthcheck",
            Box::new(|c| c["Healthcheck"]["StartInterval"] = json!(3)),
        ),
        (
            "user label",
            Box::new(|c| c["Labels"]["hack.inert"] = json!("other")),
        ),
        ("Memory", Box::new(|c| c["HostConfig"]["Memory"] = json!(1))),
        (
            "NanoCpus",
            Box::new(|c| c["HostConfig"]["NanoCpus"] = json!(1)),
        ),
        (
            "ReadonlyRootfs",
            Box::new(|c| c["HostConfig"]["ReadonlyRootfs"] = json!(true)),
        ),
        (
            "CapAdd",
            Box::new(|c| c["HostConfig"]["CapAdd"] = json!([])),
        ),
        ("Init", Box::new(|c| c["HostConfig"]["Init"] = json!(true))),
        (
            "ShmSize",
            Box::new(|c| c["HostConfig"]["ShmSize"] = json!(1)),
        ),
        (
            "RestartPolicy",
            Box::new(|c| c["HostConfig"]["RestartPolicy"] = json!({"Name": "always"})),
        ),
        (
            "ExtraHosts",
            Box::new(|c| c["HostConfig"]["ExtraHosts"] = json!(["db.local:10.0.0.3"])),
        ),
        (
            "mount target",
            Box::new(|c| c["HostConfig"]["Mounts"][0]["Target"] = json!("/other")),
        ),
        (
            "mount read-only",
            Box::new(|c| c["HostConfig"]["Mounts"][1]["ReadOnly"] = json!(false)),
        ),
        (
            "bind source",
            Box::new(|c| c["HostConfig"]["Mounts"][1]["Source"] = json!("/storage/source/other")),
        ),
        (
            "network alias",
            Box::new(|c| {
                c["NetworkingConfig"]["EndpointsConfig"][format!("hkg-{RUN}-network-0")]["Aliases"] =
                    json!(["api"]);
            }),
        ),
        (
            "unknown new field",
            Box::new(|c| c["HostConfig"]["PidsLimit"] = json!(64)),
        ),
    ];
    for (name, edit) in edits {
        let mut changed = config(RUN, "o1", "p1");
        edit(&mut changed);
        assert_ne!(digest(&changed, &resources), base, "{name}");
    }
}

#[test]
fn attachments_and_platform_change_the_digest() {
    let resources = resources(RUN);
    let config = config(RUN, "o1", "p1");
    let base = of(&config, &context(&resources)).unwrap();
    assert!(base.complete);
    let managed = of(
        &config,
        &Context {
            managed: true,
            ..context(&resources)
        },
    )
    .unwrap();
    let relay = of(
        &config,
        &Context {
            relay: vec!["db".into()],
            ..context(&resources)
        },
    )
    .unwrap();
    let amd64 = of(
        &config,
        &Context {
            amd64_emulation: Some(crate::project::Amd64Emulation::Amd64),
            ..context(&resources)
        },
    )
    .unwrap();
    for (name, other) in [("managed", managed), ("relay", relay), ("amd64", amd64)] {
        assert_ne!(other.digest, base.digest, "{name}");
    }
    // An input known only by name must never be reused on its digest.
    assert!(!managed.complete);
    assert!(!relay.complete);
    assert!(amd64.complete);
}

#[test]
fn a_different_volume_or_network_binding_changes_the_digest() {
    let resources = resources(RUN);
    let base = digest(&config(RUN, "o1", "p1"), &resources);
    // A mount of a volume this graph does not own keeps its engine name.
    let mut foreign = config(RUN, "o1", "p1");
    foreign["HostConfig"]["Mounts"][0]["Source"] = json!("someone-else");
    assert_ne!(digest(&foreign, &resources), base);
    // The same engine name bound to another logical volume is another spec.
    let mut rebound = resources.clone();
    rebound.get_mut("volume:data").unwrap().key = "other".into();
    assert_ne!(digest(&config(RUN, "o1", "p1"), &rebound), base);
}

#[test]
fn ownership_labels_including_the_spec_label_are_excluded() {
    let resources = resources(RUN);
    let base = digest(&config(RUN, "o1", "p1"), &resources);
    let mut labelled = config(RUN, "o1", "p1");
    labelled["Labels"][LABEL] = json!(base.to_string());
    assert_eq!(digest(&labelled, &resources), base);
}

#[test]
fn only_the_create_body_carries_the_label_and_the_inspect_must_echo_it() {
    let resources = resources(RUN);
    let compiled = config(RUN, "o1", "p1");
    let spec = of(&compiled, &context(&resources)).unwrap();
    let body = stamped(&compiled, &spec);
    assert_eq!(body["Labels"][LABEL], json!(spec.digest.to_string()));
    assert!(compiled["Labels"].get(LABEL).is_none());
    // Everything else in the request is the compiled config.
    let mut unlabelled = body.clone();
    unlabelled["Labels"].as_object_mut().unwrap().remove(LABEL);
    assert_eq!(unlabelled, compiled);
    verify_label(&json!({"Config": {"Labels": body["Labels"]}}), &spec).unwrap();
    let other = of(
        &config(RUN, "o1", "p1"),
        &Context {
            managed: true,
            ..context(&resources)
        },
    )
    .unwrap();
    for inspected in [
        json!({"Config": {"Labels": compiled["Labels"]}}),
        json!({"Config": {"Labels": stamped(&compiled, &other)["Labels"]}}),
        json!({"Config": {}}),
    ] {
        assert_eq!(
            verify_label(&inspected, &spec).unwrap_err().code,
            "graph_spec_label"
        );
    }
}

#[test]
fn engine_nanosecond_values_beyond_double_precision_are_identified() {
    // Compose accepts `interval: 3000h`; it compiles to nanoseconds above 2^53.
    let resources = resources(RUN);
    let mut long = config(RUN, "o1", "p1");
    long["Healthcheck"]["Interval"] = json!(10_800_000_000_000_000_u64);
    let mut longer = long.clone();
    longer["Healthcheck"]["Interval"] = json!(10_800_000_000_000_001_u64);
    let first = of(&long, &context(&resources)).unwrap();
    assert_ne!(
        first.digest,
        of(&longer, &context(&resources)).unwrap().digest
    );
    assert_eq!(
        stamped(&long, &first)["Healthcheck"]["Interval"],
        json!(10_800_000_000_000_000_u64)
    );
}

#[test]
fn the_digest_span_names_the_step_and_index_and_never_the_digest() {
    use crate::timings::{Clock, Collector, Config, Role, Sink, Step, TimeSource};
    use std::sync::{Arc, Mutex};
    #[derive(Default)]
    struct Memory(Mutex<Vec<String>>);
    impl Sink for Memory {
        fn write_line(&self, line: &[u8]) -> bool {
            self.0
                .lock()
                .unwrap()
                .push(String::from_utf8(line.to_vec()).unwrap());
            true
        }
    }
    struct Fixed;
    impl TimeSource for Fixed {
        fn sample(&self) -> Option<(u64, u64)> {
            Some((1_000_000, 1_000))
        }
    }
    let sink = Arc::new(Memory::default());
    let collector = Collector::new(
        Config {
            trace: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
            parent: None,
            role: Role::Owner,
            clock: Clock::Host,
            spawn_mono_us: None,
            service_index_stable: false,
        },
        Arc::new(Fixed),
        sink.clone(),
    )
    .unwrap();
    let resources = resources(RUN);
    let spec = of(&config(RUN, "o1", "p1"), &context(&resources));
    let digest = spec.as_ref().unwrap().digest.to_string();
    finish_span(
        collector.start(Step::SpecDigest, None).unwrap(),
        &spec,
        &format!("hkg-{RUN}-container-3"),
    );
    let failed = Err(CandidateError::new("canonical_value", "refused"));
    finish_span(
        collector.start(Step::SpecDigest, None).unwrap(),
        &failed,
        "x",
    );
    let lines = sink.0.lock().unwrap().clone();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains(r#""step":"spec.digest""#), "{}", lines[0]);
    assert!(lines[0].contains(r#""outcome":"ok""#));
    assert!(lines[0].contains(r#""service_index":3"#));
    assert!(lines[1].contains(r#""outcome":"error""#));
    assert!(!lines.iter().any(|line| line.contains(&digest[7..])));
}
