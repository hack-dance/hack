//! Real exited/unlaunched bridge recovery; the live sibling uses no bridge slot.
use super::*;
#[test]
#[ignore = "Caller-owned running capacity-two disposable pool, pinned BusyBox HTTP image and 300s watchdog required"]
fn exited_and_reserved_bridges_recover_with_crash_retry_and_live_sibling() {
    exercise(false);
}
#[test]
#[ignore = "Caller-owned capacity-two pool and pinned HTTP image; 300s external watchdog"]
fn late_exited_original_bridge_is_promoted_without_replacing_selection() {
    exercise(true);
}
fn exercise(late_exit: bool) {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate = candidate();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    assert!(
        image
            .strip_prefix("sha256:")
            .is_some_and(|v| graph::hex(v, 64))
    );
    let fixtures = [graph::tests::Fixture::new(), graph::tests::Fixture::new()];
    let runs = [
        graph::probes::token().unwrap(),
        graph::probes::token().unwrap(),
    ];
    let service = json!({"image":image,"read_only":true,"init":true,"user":"0:0",
        "entrypoint":["/bin/sh","-c","printf ok > /data/index.html; exec httpd -f -p 3000 -h /data"],"command":[],"volumes":["data:/data"],
        "healthcheck":{"x-hack-http":{"port":3000,"path":"/","interval_ms":100,"timeout_ms":1000,"retries":20,"start_period_ms":500}}});
    state::write(
        &fixtures[0].0.join("compose.yaml"),
        &json!({"services":{"app":service,"reserved":service},"volumes":{"data":{}},"networks":{"default":{"internal":true}}}),
    )
    .unwrap();
    state::write(&fixtures[1].0.join("compose.yaml"),&json!({"services":{"app":{"image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0","entrypoint":["/bin/sh","-c","exec sleep 300"],"command":[],"volumes":["data:/data"]}},"volumes":{"data":{}},"networks":{"default":{"internal":true}}})).unwrap();
    let mut owners = Vec::new();
    for index in 0..2 {
        let armed = fixtures[index].0.join("armed.json");
        let mut env = vec![
            (
                "HACK_ABSENT_RELAY_PROJECT",
                fixtures[index].0.to_str().unwrap(),
            ),
            ("HACK_ABSENT_RELAY_ARMED", armed.to_str().unwrap()),
        ];
        if index == 0 {
            env.push(("HACK_NORMALIZATION_FIXTURE", "1"));
        }
        let mut owner = child(&candidate, &runs[index], OWNER, &env);
        while !armed.exists() {
            if let Some(status) = owner.poll() {
                panic!(
                    "synthetic normalization owner exited {status}: {}",
                    String::from_utf8_lossy(&owner.out)
                );
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        owners.push(owner);
    }
    let markers = [
        marker(&candidate, &runs[0], true),
        marker(&candidate, &runs[1], true),
    ];
    let sibling = running_container(&candidate, &runs[1]);
    let before = graph::inspect(&candidate, &runs[0]).unwrap();
    let mut assignments = Vec::new();
    for (slot, service) in [(0, "app"), (1, "reserved")] {
        assignments.push(
            graph::reserve_bridge(
                &candidate,
                graph::ReserveBridgeOptions {
                    run: &runs[0],
                    service,
                    slot,
                    expected_generation: &before.guest_endpoints[service].generation,
                },
            )
            .unwrap(),
        );
    }
    assignments[0] =
        graph::start_bridge(&candidate, &runs[0], 0, &assignments[0].reservation).unwrap();
    if late_exit {
        assignments[1] =
            graph::start_bridge(&candidate, &runs[0], 1, &assignments[1].reservation).unwrap();
    }
    let bridge_path = candidate
        .state_root
        .join("run/bridge-assignments/state.json");
    let initial_bridges = fs::read(&bridge_path).unwrap();
    let root = graph::directory(&candidate, &runs[0]).unwrap();
    let expected = sha(&fs::read(root.join("state.json")).unwrap());
    refused(&candidate, &runs[0], &expected);
    assert_eq!(fs::read(&bridge_path).unwrap(), initial_bridges);
    stop_owned_helper(&candidate, 0, &assignments[0]);
    drop(owners[0].child.stdin.take());
    assert!(owners[0].wait(deadline).success());
    pause_recovery(
        &candidate,
        &runs[0],
        &expected,
        "bridge-normalization-after-intent",
        deadline,
    );
    if late_exit {
        stop_owned_helper(&candidate, 1, &assignments[1]);
    }
    let journal = root.join("live-owner-bridge-normalization.json");
    assert_eq!(state::read::<Value>(&journal).unwrap()["complete"], false);
    // Replacing a selected reservation cannot lend the original journal authority.
    let original_registry = fs::read(&bridge_path).unwrap();
    let mut changed: Value = serde_json::from_slice(&original_registry).unwrap();
    changed["slots"]["0"]["reservation"] = json!("f".repeat(32));
    state::write(&bridge_path, &changed).unwrap();
    let refused_registry = fs::read(&bridge_path).unwrap();
    refused(&candidate, &runs[0], &expected);
    assert_eq!(fs::read(&bridge_path).unwrap(), refused_registry);
    fs::write(&bridge_path, &original_registry).unwrap();
    for fault in [
        "bridge-normalization-closing-pending",
        "bridge-normalization-stopped-pending",
    ] {
        let mut interrupted = child(
            &candidate,
            &runs[0],
            RECOVERY,
            &[
                ("HACK_ABSENT_RELAY_RECEIPT", &expected),
                ("HACK_LOCAL_GRAPH_FAULT", fault),
            ],
        );
        assert!(!interrupted.wait(deadline).success());
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        let proof =
            serde_json::from_value(state::read::<Value>(&journal).unwrap()["targets"]["0"].clone())
                .unwrap();
        graph::relay::verify_normalization(&engine, 0, &assignments[0], &proof).unwrap();
        let serial = assignments[0]
            .relay
            .as_ref()
            .unwrap()
            .launch_serial
            .to_string();
        let phase = if fault.ends_with("closing-pending") {
            "closing"
        } else {
            "stopped"
        };
        assert_eq!(engine.guest().execute_cleanup("set -eu; printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" | cmp -s - /run/hack-local/relay-slots/slot-0/pending; printf verified", &[&serial,&assignments[0].reservation,phase]).unwrap(), "verified");
    }
    let mut interrupted = child(
        &candidate,
        &runs[0],
        RECOVERY,
        &[
            ("HACK_ABSENT_RELAY_RECEIPT", &expected),
            (
                "HACK_LOCAL_GRAPH_FAULT",
                "bridge-normalization-socket-unlinked",
            ),
        ],
    );
    assert!(!interrupted.wait(deadline).success());
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        let proof =
            serde_json::from_value(state::read::<Value>(&journal).unwrap()["targets"]["0"].clone())
                .unwrap();
        graph::relay::verify_normalization(&engine, 0, &assignments[0], &proof).unwrap();
    }
    pause_recovery(
        &candidate,
        &runs[0],
        &expected,
        "bridge-normalization-after-guest-stop",
        deadline,
    );
    let mut interrupted = child(
        &candidate,
        &runs[0],
        RECOVERY,
        &[
            ("HACK_ABSENT_RELAY_RECEIPT", &expected),
            (
                "HACK_LOCAL_GRAPH_FAULT",
                "bridge-normalization-owner-unlinked",
            ),
        ],
    );
    assert!(!interrupted.wait(deadline).success());
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        let proof =
            serde_json::from_value(state::read::<Value>(&journal).unwrap()["targets"]["0"].clone())
                .unwrap();
        graph::relay::verify_normalization(&engine, 0, &assignments[0], &proof).unwrap();
    }
    for point in [
        "bridge-normalization-after-removal",
        "bridge-normalization-complete",
    ] {
        pause_recovery(&candidate, &runs[0], &expected, point, deadline);
        assert_eq!(marker(&candidate, &runs[0], false), markers[0]);
        assert_eq!(marker(&candidate, &runs[1], false), markers[1]);
        assert!(owners[1].poll().is_none());
        assert_eq!(running_container(&candidate, &runs[1]), sibling);
    }
    let normalized = fs::read(&journal).unwrap();
    assert_eq!(state::read::<Value>(&journal).unwrap()["complete"], true);
    graph::recover_live_owner(&candidate, &runs[0], &expected).unwrap();
    assert_eq!(fs::read(&journal).unwrap(), normalized);
    assert_eq!(
        graph::inspect(&candidate, &runs[0]).unwrap().receipt.phase,
        "stopped-data-retained"
    );
    assert_eq!(marker(&candidate, &runs[0], false), markers[0]);
    assert_eq!(running_container(&candidate, &runs[1]), sibling);
    assert!(
        graph::inspect_bridges(&candidate, &runs[0]).unwrap()["slots"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    drop(owners[1].child.stdin.take());
    assert!(owners[1].wait(deadline).success());
    let sibling_expected = sha(&fs::read(
        graph::directory(&candidate, &runs[1])
            .unwrap()
            .join("state.json"),
    )
    .unwrap());
    graph::recover_live_owner(&candidate, &runs[1], &sibling_expected).unwrap();
    for run in &runs {
        graph::foreground::cleanup_request(&candidate, run, true).unwrap();
        assert_eq!(
            graph::inspect(&candidate, run).unwrap().receipt.phase,
            "removed"
        );
    }
}

fn stop_owned_helper(candidate: &Candidate, slot: u8, assignment: &graph::bridges::Assignment) {
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        assert!(
            graph::relay::normalization_selection(&engine, slot, assignment)
                .unwrap()
                .is_none()
        );
        let evidence =
            serde_json::to_value(graph::relay::capture_cleanup(&engine, slot, assignment).unwrap())
                .unwrap();
        let relay = format!(
            "/run/hack-local/graph-relays/{}/relay",
            assignment.reservation
        );
        let pid = evidence["pid"].as_u64().unwrap().to_string();
        let start = evidence["start"].as_u64().unwrap().to_string();
        let identity = format!(
            "{}:{}",
            evidence["executable_device"].as_u64().unwrap(),
            evidence["executable_inode"].as_u64().unwrap()
        );
        engine.guest().execute_cleanup("set -eu; test ! -L \"$1\"; test \"$(stat -c %d:%i \"$1\")\" = \"$4\"; \"$1\" --stop \"$2\" \"$3\"",&[&relay,&pid,&start,&identity]).unwrap();
        assert!(
            graph::relay::normalization_selection(&engine, slot, assignment)
                .unwrap()
                .is_some()
        );
    }
}
