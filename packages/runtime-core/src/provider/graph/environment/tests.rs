use super::*;
use crate::provider::environment::PendingEnvironment;
use std::{io::Read, time::Instant};

fn candidate() -> Candidate {
    Candidate::discover(std::path::Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit root"),
    ))
    .unwrap()
}
fn manifest(candidate: &Candidate) -> PathBuf {
    candidate
        .state_root
        .join("run/environment-attachment-probe.json")
}
#[test]
fn bound_receipt_never_silently_loses_its_redelivery_gate() {
    let old = json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"removed","readiness":{},"resources":{}});
    let mut receipt: Receipt = serde_json::from_value(old).unwrap();
    assert!(!receipt.environment_attached);
    assert!(require_replay_supported(&receipt).is_ok());
    receipt.environment_attached = true;
    let reloaded: Receipt = serde_json::from_slice(&serde_json::to_vec(&receipt).unwrap()).unwrap();
    assert_eq!(
        require_replay_supported(&reloaded).err().unwrap().code,
        "graph_environment_redelivery_required"
    );
}
#[test]
fn history_bindings_cover_only_attached_graph_containers() {
    let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},"resources":{
        "container:app":{"key":"app","kind":"container","name":"hkg-app","phase":"absent"},
        "container:db":{"key":"db","kind":"container","name":"hkg-db","phase":"absent"},
        "volume:data":{"key":"data","kind":"volume","name":"hkg-data","phase":"created"}
    }})).unwrap();
    assert_eq!(
        bound_containers(&receipt),
        None,
        "no environment, no history"
    );
    receipt.environment_attached = true;
    assert_eq!(
        bound_containers(&receipt).unwrap(),
        BTreeMap::from([
            ("app".to_owned(), "hkg-app".to_owned()),
            ("db".to_owned(), "hkg-db".to_owned()),
        ])
    );
}

/// Wiring guard. The trigger points need an owned VM and engine, so their effects are proven
/// natively, not here; this only fails if a trigger is removed or moved past the point where
/// the new generation allocates. The state machine itself is covered by compaction's tests.
#[test]
fn compaction_triggers_stay_wired_at_their_lease_points() {
    fn body<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let from = source.find(start).expect("function start");
        let to = from + source[from..].find(end).expect("function end");
        &source[from..to]
    }
    let cleanup = body(
        include_str!("../mod.rs"),
        "pub fn cleanup(",
        "fn cleanup_owned(",
    );
    let committed = cleanup.find("cleanup_owned(").expect("cleanup effect");
    let compacted = cleanup
        .find("environment::compact_history(")
        .expect("ordinary cleanup compacts");
    assert!(
        committed < compacted,
        "compaction follows the committed cleanup"
    );

    let restore = body(
        include_str!("../restore.rs"),
        "fn restore_inputs(",
        "fn retain_restore_failure(",
    );
    let retired = restore
        .find("environment_recovery::retire(")
        .expect("prior slots re-retired");
    let captured = restore
        .find("environment::bound_containers(&receipt)")
        .expect("history bindings captured");
    let replaced = restore
        .find("*resource = prepared.resources[key].clone()")
        .expect("fresh resources");
    let prepared = restore
        .find("driver.prepare(")
        .expect("fresh owner prepare");
    let compacted = restore
        .find("environment::compact_history(")
        .expect("restore compacts");
    let allocated = restore
        .find("session.create_resources(true)")
        .expect("new generation allocates");
    assert!(
        retired < captured && captured < replaced,
        "bindings of the retired generation"
    );
    assert!(
        prepared < compacted && compacted < allocated,
        "superseded, then allocate"
    );

    let relay = body(
        include_str!("../host_relay.rs"),
        "pub(super) fn cleanup_with_relay_expected(",
        "pub fn resume_relay_cleanup(",
    );
    assert!(
        !relay.contains("compact_history("),
        "acknowledged relay cleanup re-verifies its inventory; it must not compact"
    );

    let archive = body(
        include_str!("../environment.rs"),
        "pub(super) fn archive_slots(",
        "environment_recovery::archive_graph(",
    );
    assert!(archive.contains("environment_recovery::resume_graph("));
}
#[test]
#[ignore = "Manual owned development VM, pinned Bun image, explicit candidate and external watchdog"]
fn container_attachment_records_ownership_before_create_and_omits_values_from_metadata() {
    let candidate = candidate();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned Bun image");
    assert!(image_id(&image));
    let mut runs = Vec::new();
    for phase in 0..3 {
        let mut bytes = [0; 16];
        fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let run: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let root = directory(&candidate, &run).unwrap();
        state::private_directory(&root).unwrap();
        let engine = Engine::connect(&candidate).unwrap();
        let resource = Resource {
            routing: None,
            networks: None,
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind: Kind::Container,
            key: "job".into(),
            name: format!("hkg-{run}-container-0"),
            id: None,
            image: Some(image.clone()),
            phase: "reserved".into(),
        };
        let mut receipt = Receipt {
            normalized_input: None,
            relay_startup: None,
            relay_cleanup: None,
            probes: BTreeMap::new(),
            version: 1,
            run: run.clone(),
            owner: engine.guest().incarnation().into(),
            namespace: "a".repeat(64),
            plan_id: "b".repeat(64),
            phase: "preparing".into(),
            environment_attached: false,
            startup_failure: None,
            initializer_cache_release: BTreeMap::new(),
            source: None,
            readiness: BTreeMap::from([("job".into(), Condition::Completed)]),
            resources: BTreeMap::from([("container:job".into(), resource.clone())]),
        };
        state::write(&root.join("state.json"), &receipt).unwrap();
        drop(engine);
        let value = format!("synthetic-attachment-{run}\n'\"$UNCHANGED");
        let values = BTreeMap::from([("TOKEN".into(), value.clone())]);
        let pending = || PendingEnvironment::new("job", &values, Duration::from_secs(120)).unwrap();
        let lease = stage_environment(&candidate, &run, pending()).unwrap();
        assert_eq!(
            stage_environment(&candidate, &run, pending())
                .err()
                .unwrap()
                .code,
            "graph_environment_replay"
        );
        let path = lease.verified_path(&candidate).unwrap();
        receipt.environment_attached = true;
        assert_eq!(
            require_replay_supported(&receipt).err().unwrap().code,
            "graph_environment_redelivery_required"
        );
        let engine = Engine::connect(&candidate).unwrap();
        if phase > 0 {
            // This finite root-only fixture proves child environment delivery, not a general entrypoint wrapper.
            let child = "const expected=await Bun.file('/run/hack-environment.json').json();if(process.env.TOKEN!==expected.TOKEN)process.exit(23)";
            let program = format!(
                "const values=await Bun.file('/run/hack-environment.json').json();const child=Bun.spawn(['/usr/local/bin/bun','-e',{}],{{env:{{...process.env,...values}},stdin:'ignore',stdout:'ignore',stderr:'ignore'}});if(await child.exited!==0)process.exit(24);console.log('environment-child-verified-v1')",
                serde_json::to_string(child).unwrap()
            );
            let config = json!({"Image":image,"Entrypoint":["/usr/local/bin/bun","-e",program],"Cmd":[],"Labels":expected_labels(&receipt,&resource),"HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"Memory":268435456,"NanoCpus":500000000,"PidsLimit":32,"RestartPolicy":{"Name":"no"},"LogConfig":{"Type":"json-file","Config":{"max-size":"1m","max-file":"1"}},"Mounts":[{"Type":"bind","Source":path,"Target":"/run/hack-environment.json","ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}}]}});
            receipt.resources.get_mut("container:job").unwrap().phase = "create-intent".into();
            state::write(&root.join("state.json"), &receipt).unwrap();
            let created = engine
                .request(
                    Method::POST,
                    &format!("/v1.53/containers/create?name={}", resource.name),
                    Some(&config),
                )
                .unwrap();
            let id = created["Id"].as_str().unwrap();
            assert!(hex(id, 64));
            let inspected = inspect_resource(&engine, &receipt, &resource)
                .unwrap()
                .unwrap();
            assert!(
                inspected["Mounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["Source"] == path
                        && m["Destination"] == "/run/hack-environment.json"
                        && m["Type"] == "bind"
                        && m["RW"] == false)
            );
            assert!(
                !serde_json::to_string(&inspected)
                    .unwrap()
                    .contains("synthetic-attachment-")
            );
            assert!(
                !inspected["Config"]["Env"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v.as_str().unwrap_or_default().starts_with("TOKEN="))
            );
            assert_eq!(
                lease.remove_with_guest(engine.guest()).err().unwrap().code,
                "environment_container_present"
            );
            if phase == 2 {
                engine
                    .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(20);
                loop {
                    let observed = inspect_resource(&engine, &receipt, &resource)
                        .unwrap()
                        .unwrap();
                    if observed["State"]["Running"] == false {
                        assert_eq!(observed["State"]["ExitCode"], 0);
                        break;
                    }
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(100));
                }
                let (out, err, truncated) = engine.logs(id).unwrap();
                assert_eq!(out, "environment-child-verified-v1\n");
                assert!(err.is_empty() && !truncated);
                assert_eq!(
                    lease.remove_with_guest(engine.guest()).err().unwrap().code,
                    "environment_container_present"
                );
            }
        }
        let slots = environment_recovery::graph_slots(&candidate, engine.guest(), &run).unwrap();
        assert_eq!(slots.len(), 1);
        let record = fs::read_to_string(
            candidate
                .state_root
                .join("run/environment-leases")
                .join(format!("{}.json", slots[0].0)),
        )
        .unwrap();
        assert!(!record.contains("TOKEN") && !record.contains("synthetic-attachment-"));
        // Keep create-intent without the returned ID: recovery must use the durable name and labels.
        runs.push(run);
        drop(engine);
        drop(lease);
    }
    state::write(&manifest(&candidate), &runs).unwrap();
}
#[test]
#[ignore = "Second process after attachment phase; same owned VM and external watchdog"]
fn graph_cleanup_recovers_bound_slots_without_in_memory_leases() {
    let candidate = candidate();
    let runs: Vec<String> = state::read(&manifest(&candidate)).unwrap();
    assert_eq!(runs.len(), 3);
    for run in runs {
        let root = directory(&candidate, &run).unwrap();
        let original: Receipt = state::read(&root.join("state.json")).unwrap();
        let mut mismatched = original.clone();
        mismatched.resources.get_mut("container:job").unwrap().name =
            format!("hkg-{run}-container-9");
        state::write(&root.join("state.json"), &mismatched).unwrap();
        let refused = cleanup(&candidate, &run, true);
        state::write(&root.join("state.json"), &original).unwrap();
        assert_eq!(refused.err().unwrap().code, "graph_environment_identity");
        let removed = cleanup(&candidate, &run, true).unwrap();
        assert_eq!(removed.phase, "removed");
        cleanup(&candidate, &run, true).unwrap();
        let engine = Engine::connect_cleanup(&candidate).unwrap();
        for (slot, _, _) in
            environment_recovery::graph_slots(&candidate, engine.guest(), &run).unwrap()
        {
            let output=engine.guest().execute_cleanup("(test ! -e \"/run/$1\" && test ! -L \"/run/$1\") >/dev/null 2>&1 || exit 1; printf 'absent\\n'",&[&slot]).unwrap();
            assert_eq!(output, "absent\n");
        }
        drop(engine);
        let values = BTreeMap::from([("TOKEN".into(), "synthetic-no-renewal".into())]);
        assert_eq!(
            stage_environment(
                &candidate,
                &run,
                PendingEnvironment::new("job", &values, Duration::from_secs(60)).unwrap()
            )
            .err()
            .unwrap()
            .code,
            "graph_environment_phase"
        );
    }
}
