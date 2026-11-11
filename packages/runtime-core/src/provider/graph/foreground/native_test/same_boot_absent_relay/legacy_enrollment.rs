//! Execute the production Ready/Pending recovery, including an orphan publisher
//! and retry after publisher exit but before its registry commit. No legacy
//! receipt or coordinator is fabricated: the old failure boundary is paused.
use super::*;
const LEGACY_OWNER: &str = "provider::graph::foreground::native_test::same_boot_absent_relay::legacy_enrollment::legacy_owner_child";

#[test]
#[ignore = "Only the isolated native parent fixture invokes this owned child"]
fn legacy_owner_child() {
    let candidate = candidate();
    let run = run();
    let project = PathBuf::from(std::env::var("HACK_ABSENT_RELAY_PROJECT").unwrap());
    let armed = PathBuf::from(std::env::var("HACK_ABSENT_RELAY_ARMED").unwrap());
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let plan = project::plan(&candidate, options(&project)).unwrap();
    let bytes = fs::read(project.join("compose.yaml")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut runtime = HostRelayRuntime::new_for_run(
        &candidate,
        Path::new("/tmp/unused-control-only-artifact"),
        &"a".repeat(64),
        Vec::new(),
        &run,
    )
    .unwrap();
    let mut publication = Publication::bind(&candidate, &run).unwrap();
    let values = BTreeMap::new();
    let receipt = graph::run_normalized_with_host_dependencies_until(
        &candidate,
        graph::NormalizedRunOptions {
            run: graph::RunOptions {
                live_source: false,
                shared_source: false,
                release_initializer_cache: BTreeSet::new(),
                routing_enrolled: false,
                loopback_ports: true,
                project: options(&project),
                expected_plan: &plan.plan_id,
                source_revision: None,
                non_secret_values: &values,
                readiness: &BTreeMap::from([("app".into(), graph::Condition::Started)]),
                run_id: &run,
                timeout: Duration::from_secs(90),
            },
            compose: project::NormalizedComposeOptions {
                project: &project,
                branch: None,
                expected_namespace: &plan.plan.namespace,
                compose_file: Path::new("compose.yaml"),
                expected_compose_sha256: &plan.plan.compose_sha256,
                compose_bytes: &bytes,
                profiles: &[],
            },
        },
        &mut runtime,
        &BTreeMap::new(),
        &graph::ManagedFiles::new(),
        deadline,
    )
    .unwrap();
    let reserved = graph::bridges::reserve_loopback_ports(&candidate, &receipt).unwrap();
    assert_eq!(reserved.len(), 1);
    let mut publishers = Vec::new();
    for (port, selected) in reserved {
        let reservation = selected.assignment.reservation;
        graph::start_bridge(&candidate, &run, selected.slot, &reservation).unwrap();
        let slot = selected.slot.to_string();
        let port_text = port.to_string();
        let mut publisher = Process::start(
            &binary,
            &candidate,
            &[
                "graph",
                "publish-bridge",
                "--run-id",
                &run,
                "--slot",
                &slot,
                "--expect-reservation",
                &reservation,
                "--port",
                &port_text,
            ],
            None,
        );
        while crate::provider::publication::lookup_port(&candidate, &run, &reservation, port)
            .is_err()
        {
            assert!(publisher.poll().is_none(), "publisher exited before ready");
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        publishers.push(publisher);
    }
    state::write(&armed, &json!({"run":run})).unwrap();
    let mut poll = libc::pollfd {
        fd: 0,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: this owned helper's stdin is held by its parent; the wait is bounded.
    assert!(unsafe { libc::poll(&mut poll, 1, 120_000) } > 0);
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte).unwrap();
    let publisher_exit =
        std::env::var("HACK_LEGACY_PUBLISHER_EXIT").unwrap_or_else(|_| "live".into());
    if publisher_exit != "live" {
        for publisher in &mut publishers {
            let signal = if publisher_exit == "interrupt" {
                libc::SIGINT
            } else {
                libc::SIGKILL
            };
            // SAFETY: this exact unreaped direct child is owned by the fixture.
            assert_eq!(
                unsafe { libc::kill(publisher.child.id() as i32, signal) },
                0
            );
            let mut status = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: valid writable output; WNOWAIT confirms this child's exit
            // without reaping it, reproducing next.13's publisher/cleanup cycle.
            assert_eq!(
                unsafe {
                    libc::waitid(
                        libc::P_PID,
                        publisher.child.id(),
                        status.as_mut_ptr(),
                        libc::WEXITED | libc::WNOWAIT,
                    )
                },
                0
            );
        }
        let error = runtime.cleanup(&candidate, false).unwrap_err();
        assert!(matches!(
            error.code,
            "publisher_stop_uncertain" | "process_identity_unavailable"
        ));
        state::write(
            &graph::directory(&candidate, &run)
                .unwrap()
                .join("legacy-cleanup-failed.json"),
            &json!({"code":error.code}),
        )
        .unwrap();
        // Normal exit drops the managed relay and reaps our exact publishers,
        // leaving the legacy Ready/Pending receipt and publication untouched.
        drop(runtime);
        return;
    }
    runtime.cleanup(&candidate, false).unwrap();
    for mut publisher in publishers {
        assert!(publisher.wait(deadline).success());
    }
    publication.finish().unwrap();
}

#[test]
#[ignore = "Caller-owned disposable capacity-one VM, all-feature CLI, pinned BusyBox HTTP image, exclusive port and external 300s watchdog required"]
fn same_boot_legacy_pending_cleanup_releases_port_and_bridge_after_retry() {
    exercise(false, "kill");
}

#[test]
#[ignore = "Caller-owned disposable capacity-one VM, all-feature CLI, pinned BusyBox HTTP image, exclusive port and external 300s watchdog required"]
fn previous_boot_legacy_pending_cleanup_releases_port_and_bridge() {
    exercise(true, "kill");
}

#[test]
#[ignore = "Caller-owned disposable capacity-one VM, pinned BusyBox HTTP image, all-feature CLI and 300s watchdog required"]
fn same_boot_interrupted_publisher_cleanup_releases_port_and_bridge() {
    exercise(false, "interrupt");
}

#[test]
#[ignore = "Caller-owned disposable capacity-one VM, pinned BusyBox HTTP image, all-feature CLI and 300s watchdog required"]
fn same_boot_live_orphan_publisher_cleanup_releases_port_and_bridge() {
    exercise(false, "live");
}

fn exercise(previous_boot: bool, publisher_exit: &str) {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate = candidate();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    assert!(
        image
            .strip_prefix("sha256:")
            .is_some_and(|value| graph::hex(value, 64))
    );
    let binary_text = std::env::var("HACK_LOCAL_TEST_BINARY").unwrap();
    let binary = Path::new(&binary_text);
    let port: u16 = std::env::var("HACK_LOCAL_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(port, 0);
    crate::provider::publication::require_loopback_port_free(port).unwrap();
    let fixture = graph::tests::Fixture::new();
    state::write(&fixture.0.join("compose.yaml"), &json!({
        "services":{"app":{"image":image,"read_only":true,"init":true,"user":"0:0",
        "entrypoint":["/bin/sh","-c","printf ok > /data/index.html; exec httpd -f -p 3000 -h /data"],"command":[],"volumes":["data:/data"],
        "ports":[format!("127.0.0.1:{port}:3000")]}},"volumes":{"data":{}},"networks":{"default":{"internal":true}}
    })).unwrap();
    let runs = [
        graph::probes::token().unwrap(),
        graph::probes::token().unwrap(),
    ];
    let armed = fixture.0.join("armed-first.json");
    let mut owner = child(
        &candidate,
        &runs[0],
        LEGACY_OWNER,
        &[
            ("HACK_ABSENT_RELAY_PROJECT", fixture.0.to_str().unwrap()),
            ("HACK_ABSENT_RELAY_ARMED", armed.to_str().unwrap()),
            ("HACK_LOCAL_TEST_BINARY", binary_text.as_str()),
            (
                "HACK_LOCAL_GRAPH_FAULT",
                if publisher_exit == "live" {
                    "cleanup-before-publisher-stop"
                } else {
                    ""
                },
            ),
            ("HACK_LEGACY_PUBLISHER_EXIT", publisher_exit),
        ],
    );
    wait_file(&mut owner, &armed, deadline);
    assert_http(port);
    let data = marker(&candidate, &runs[0], true);
    owner
        .child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stop")
        .unwrap();
    let root = graph::directory(&candidate, &runs[0]).unwrap();
    wait_file(
        &mut owner,
        &root.join(if publisher_exit == "live" {
            "fault-cleanup-before-publisher-stop.json"
        } else {
            "legacy-cleanup-failed.json"
        }),
        deadline,
    );
    if publisher_exit != "live" {
        assert!(owner.wait(deadline).success());
    }
    let receipt = state::read::<graph::Receipt>(&root.join("state.json")).unwrap();
    assert_eq!(receipt.phase, "ready-observed");
    assert_eq!(
        receipt.relay_cleanup.as_ref().unwrap().phase,
        graph::cleanup_enrollment::Phase::Pending
    );
    let coordinator = receipt
        .relay_cleanup
        .as_ref()
        .unwrap()
        .control_root
        .join("relay-lifecycle/state.json");
    let coordinator_bytes = fs::read(&coordinator).unwrap();
    let expected = sha(&fs::read(root.join("state.json")).unwrap());
    if publisher_exit == "live" {
        owner.child.kill().unwrap();
        owner.wait(deadline);
    }
    if previous_boot {
        super::super::dependency_rebind::checked_cli(
            "stop-legacy-boot",
            binary,
            &candidate,
            &["runtime", "down", "--json"],
            deadline,
        );
        super::super::dependency_rebind::checked_cli(
            "start-successor-boot",
            binary,
            &candidate,
            &[
                "runtime",
                "up",
                "--profile",
                "development",
                "--bridge-sockets",
                "1",
                "--dependency-sockets",
                "1",
                "--internet",
                "--json",
            ],
            deadline,
        );
        assert_eq!(
            graph::foreground_owner(&candidate, &runs[0]).unwrap()["dead_owner_recovery"],
            expected
        );
        pause_recovery(
            &candidate,
            &runs[0],
            &expected,
            "publisher-recovery-registry-pending",
            deadline,
        );
        assert!(
            candidate
                .state_root
                .join("run/publications/state.pending")
                .exists()
        );
        pause_recovery(
            &candidate,
            &runs[0],
            &expected,
            "dead-owner-after-stop",
            deadline,
        );
        assert!(
            !candidate
                .state_root
                .join("run/publications/state.pending")
                .exists()
        );
        assert_eq!(
            graph::foreground_owner(&candidate, &runs[0]).unwrap()["dead_owner_recovery_complete"],
            false
        );
        graph::recover_cleanup(&candidate, &runs[0], &expected).unwrap();
        assert_eq!(
            graph::foreground_owner(&candidate, &runs[0]).unwrap()["dead_owner_recovery_complete"],
            true
        );
        graph::retire_recovered_publisher(&candidate, &runs[0], &receipt.owner).unwrap();
    } else {
        pause_recovery(
            &candidate,
            &runs[0],
            &expected,
            "publisher-recovery-after-stop",
            deadline,
        );
        pause_recovery(
            &candidate,
            &runs[0],
            &expected,
            "publisher-recovery-registry-pending",
            deadline,
        );
        assert!(
            candidate
                .state_root
                .join("run/publications/state.pending")
                .exists()
        );
        pause_recovery(
            &candidate,
            &runs[0],
            &expected,
            "live-owner-after-completion",
            deadline,
        );
        assert!(
            !candidate
                .state_root
                .join("run/publications/state.pending")
                .exists()
        );
        graph::recover_live_owner(&candidate, &runs[0], &expected).unwrap();
        let intent: Value = state::read(&root.join("live-owner-cleanup.json")).unwrap();
        assert_eq!(
            intent["version"],
            if publisher_exit == "live" { 3 } else { 4 }
        );
    }
    assert_eq!(marker(&candidate, &runs[0], false), data);
    assert_eq!(fs::read(&coordinator).unwrap(), coordinator_bytes);
    assert_eq!(
        graph::inspect(&candidate, &runs[0]).unwrap().receipt.phase,
        "stopped-data-retained"
    );
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    let armed = fixture.0.join("armed-second.json");
    let mut second = child(
        &candidate,
        &runs[1],
        LEGACY_OWNER,
        &[
            ("HACK_ABSENT_RELAY_PROJECT", fixture.0.to_str().unwrap()),
            ("HACK_ABSENT_RELAY_ARMED", armed.to_str().unwrap()),
            ("HACK_LOCAL_TEST_BINARY", binary_text.as_str()),
        ],
    );
    wait_file(&mut second, &armed, deadline);
    assert_http(port);
    second
        .child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stop")
        .unwrap();
    assert!(second.wait(deadline).success());
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
}

fn assert_http(port: u16) {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200"));
    assert!(response.ends_with("ok"));
}
