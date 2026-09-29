//! Kill one real foreground owner, recover on the same VM boot, restore twice,
//! and prove its live sibling and retained data remain intact.
//! The caller provides an isolated capacity-two pool and a pinned static fixture image.
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;
use crate::provider::graph::startup::native_test::RestartableBackend;

fn ready(owner: &mut Process, run: &str, deadline: Instant) {
    loop {
        if let Some(status) = owner.poll() {
            let error: Value = serde_json::from_slice(&owner.err).unwrap_or(Value::Null);
            panic!(
                "dependency graph exited before ready: {status} code={}",
                error["code"]
            );
        }
        if let Some(end) = owner.out.iter().position(|b| *b == b'\n') {
            let value: Value = serde_json::from_slice(&owner.out[..end]).unwrap();
            assert_eq!(value["kind"], "graph_foreground_ready");
            assert_eq!(value["run"], run);
            return;
        }
        assert!(
            Instant::now() < deadline,
            "dependency graph readiness deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "Owned capacity-two development VM, matching all-feature CLI, pinned static image/relay and external 240s watchdog required"]
fn same_boot_dead_owner_recovery_preserves_sibling_and_restores_data() {
    exercise(false);
}

#[test]
#[ignore = "Owned capacity-two development VM, matching all-feature CLI, pinned static image/relay and external 300s watchdog required"]
fn previous_boot_recovery_then_same_boot_recovery_preserves_history_and_data() {
    exercise(true);
}

fn exercise(previous_boot: bool) {
    let deadline = Instant::now() + Duration::from_secs(if previous_boot { 270 } else { 210 });
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let artifact = PathBuf::from(std::env::var("HACK_GRAPH_RELAY_ARTIFACT").unwrap());
    let artifact_hash = std::env::var("HACK_GRAPH_RELAY_SHA256").unwrap();
    let fixtures = [graph::tests::Fixture::new(), graph::tests::Fixture::new()];
    let selections = graph::tests::Fixture::new();
    let backends = [RestartableBackend::start(0), RestartableBackend::start(0)];
    let runs = [
        graph::probes::token().unwrap(),
        graph::probes::token().unwrap(),
    ];
    let mut reviews = Vec::new();
    let mut dependency_plans = Vec::new();
    let mut selection_paths = Vec::new();
    for index in 0..2 {
        state::write(&fixtures[index].0.join("compose.yaml"), &json!({
            "services":{"web":{"image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
            "entrypoint":["/bin/hack-graph-startup-app","serve"],"command":[],"volumes":["data:/data"],
            "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","health"],"interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}}},"volumes":{"data":{}}
        })).unwrap();
        let review = project::plan(
            &candidate,
            project::PlanOptions {
                branch: None,
                project: &fixtures[index].0,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let endpoint = backends[index].endpoint();
        let selection = selections.0.join(format!("dependency-{index}.json"));
        state::write(&selection,&json!({"version":1,"plan":review.plan_id,"artifact":artifact,"artifact_sha256":artifact_hash,
            "dependencies":[{"service":"web","binding":"default","slot":0,"guest_port":25252,"host_pid":endpoint.process_identity().pid,"host_port":backends[index].port}]
        })).unwrap();
        let plan = checked_cli(
            "dependency-plan",
            &binary,
            &candidate,
            &[
                "graph",
                "dependency-plan",
                "--dependencies",
                selection.to_str().unwrap(),
                "--json",
            ],
            deadline,
        );
        reviews.push(review);
        dependency_plans.push(plan);
        selection_paths.push(selection);
    }
    let start = |index: usize, generation: Option<&str>| {
        let normalized = fixtures[index].0.join("compose.yaml");
        let mut args = vec![
            "graph",
            if generation.is_some() {
                "serve-restore"
            } else {
                "serve"
            },
            "--project",
            fixtures[index].0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &reviews[index].plan_id,
            "--run-id",
            &runs[index],
            "--ready",
            "web=healthy",
            "--timeout-seconds",
            "90",
            "--dependencies",
            selection_paths[index].to_str().unwrap(),
            "--expect-dependencies",
            dependency_plans[index]["dependency_plan_id"]
                .as_str()
                .unwrap(),
            "--json",
        ];
        args.extend([
            "--auto-dependency-slots",
            "--normalized-file",
            normalized.to_str().unwrap(),
            "--expect-original",
            &reviews[index].plan.compose_sha256,
            "--expect-namespace",
            &reviews[index].plan.namespace,
        ]);
        if let Some(generation) = generation {
            args.extend(["--expect-generation", generation]);
        }
        Process::start(&binary, &candidate, &args, None)
    };
    let mut first = start(0, None);
    let mut seed_cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &runs[0],
        done: false,
    };
    let old_proof = if previous_boot {
        ready(&mut first, &runs[0], deadline);
        backends[0].traffic(1);
        assert_eq!(
            exec(&binary, &candidate, &runs[0], "web", "write-data", deadline)["exit_code"],
            0
        );
        let before = snapshot(&candidate, &runs[0], deadline).receipt;
        let expected = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec_pretty(&before).unwrap())
        );
        first.child.kill().unwrap();
        first.wait(deadline);
        checked_cli(
            "stop-prior-boot",
            &binary,
            &candidate,
            &["runtime", "down", "--json"],
            deadline,
        );
        checked_cli(
            "start-successor-boot",
            &binary,
            &candidate,
            &[
                "runtime",
                "up",
                "--profile",
                "development",
                "--bridge-sockets",
                "2",
                "--dependency-sockets",
                "2",
                "--internet",
                "--json",
            ],
            deadline,
        );
        checked_cli(
            "recover-prior-boot",
            &binary,
            &candidate,
            &[
                "graph",
                "recover-cleanup",
                "--run-id",
                &runs[0],
                "--expect-receipt",
                &expected,
                "--json",
            ],
            deadline,
        );
        checked_cli(
            "retire-prior-publisher",
            &binary,
            &candidate,
            &[
                "graph",
                "retire-recovered-publisher",
                "--run-id",
                &runs[0],
                "--expect-owner",
                &before.owner,
                "--json",
            ],
            deadline,
        );
        let selection = graph::foreground::restore_selection(&candidate, &runs[0]).unwrap();
        first = start(0, Some(selection["generation"].as_str().unwrap()));
        Some(
            fs::read(
                graph::directory(&candidate, &runs[0])
                    .unwrap()
                    .join("dead-owner-cleanup.json"),
            )
            .unwrap(),
        )
    } else {
        None
    };
    let mut owners = [first, start(1, None)];
    let mut cleanup = [
        Cleanup {
            binary: &binary,
            candidate: &candidate,
            run: &runs[0],
            done: false,
        },
        Cleanup {
            binary: &binary,
            candidate: &candidate,
            run: &runs[1],
            done: false,
        },
    ];
    seed_cleanup.done = true;
    ready(&mut owners[0], &runs[0], deadline);
    ready(&mut owners[1], &runs[1], deadline);
    for backend in &backends {
        backend.traffic(1);
        backend.assert_no_traffic();
    }
    let before = [
        snapshot(&candidate, &runs[0], deadline),
        snapshot(&candidate, &runs[1], deadline),
    ];
    let slots = before
        .iter()
        .map(|s| s.receipt.relay_startup.as_ref().unwrap().services["web"].bindings["default"].slot)
        .collect::<Vec<_>>();
    assert_ne!(slots[0], slots[1]);
    assert_eq!(
        slots
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([0, 1])
    );
    // Verify actual traffic selects only the intended host listener.
    assert_eq!(
        exec(&binary, &candidate, &runs[0], "web", "dependency", deadline)["exit_code"],
        0
    );
    backends[0].traffic(1);
    backends[1].assert_no_traffic();
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "dependency", deadline)["exit_code"],
        0
    );
    backends[1].traffic(1);
    backends[0].assert_no_traffic();
    let sibling = serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap();
    assert_eq!(
        exec(
            &binary,
            &candidate,
            &runs[0],
            "web",
            if previous_boot {
                "read-data"
            } else {
                "write-data"
            },
            deadline
        )["exit_code"],
        0
    );
    let boot = crate::provider::lifecycle::status(&candidate)
        .unwrap()
        .guest_boot_id;
    for cycle in 0..2 {
        let selected = snapshot(&candidate, &runs[0], deadline).receipt;
        let expected = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec_pretty(&selected).unwrap())
        );
        let bytes_before = fs::read(
            graph::directory(&candidate, &runs[0])
                .unwrap()
                .join("state.json"),
        )
        .unwrap();
        assert!(
            graph::recover_live_owner(&candidate, &runs[0], &expected).is_err(),
            "live owner must refuse"
        );
        assert_eq!(
            fs::read(
                graph::directory(&candidate, &runs[0])
                    .unwrap()
                    .join("state.json")
            )
            .unwrap(),
            bytes_before
        );
        owners[0].child.kill().unwrap();
        owners[0].wait(deadline);
        let recovery = [
            "graph",
            "recover-live-owner",
            "--run-id",
            &runs[0],
            "--expect-receipt",
            &expected,
            "--json",
        ];
        for _ in 0..2 {
            checked_cli(
                "same-boot-recover",
                &binary,
                &candidate,
                &recovery,
                deadline,
            );
        }
        if let Some(bytes) = &old_proof {
            assert_eq!(
                &fs::read(
                    graph::directory(&candidate, &runs[0])
                        .unwrap()
                        .join("dead-owner-cleanup.json")
                )
                .unwrap(),
                bytes
            );
        }
        let cleaned = snapshot(&candidate, &runs[0], deadline).receipt;
        assert_eq!(cleaned.phase, "stopped-data-retained");
        assert_eq!(
            cleaned.resources["volume:data"].name,
            selected.resources["volume:data"].name
        );
        assert_eq!(
            crate::provider::lifecycle::status(&candidate)
                .unwrap()
                .guest_boot_id,
            boot
        );
        assert!(owners[1].poll().is_none());
        assert_eq!(
            serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap(),
            sibling
        );
        assert_eq!(
            exec(&binary, &candidate, &runs[1], "web", "dependency", deadline)["exit_code"],
            0
        );
        backends[1].traffic(1);
        for _ in 0..2 {
            checked_cli(
                "retire-same-boot",
                &binary,
                &candidate,
                &[
                    "graph",
                    "retire-recovered-publisher",
                    "--run-id",
                    &runs[0],
                    "--expect-owner",
                    &cleaned.owner,
                    "--json",
                ],
                deadline,
            );
        }
        let selection = graph::foreground::restore_selection(&candidate, &runs[0]).unwrap();
        owners[0] = start(0, Some(selection["generation"].as_str().unwrap()));
        ready(&mut owners[0], &runs[0], deadline);
        backends[0].traffic(1);
        assert_eq!(
            exec(&binary, &candidate, &runs[0], "web", "read-data", deadline)["exit_code"],
            0
        );
        let restored = snapshot(&candidate, &runs[0], deadline).receipt;
        assert_ne!(
            restored.resources["container:web"].id,
            selected.resources["container:web"].id
        );
        assert_eq!(
            restored.resources["volume:data"].name,
            selected.resources["volume:data"].name
        );
        if cycle == 0 {
            checked_cli(
                "ordinary-down-after-recovery",
                &binary,
                &candidate,
                &["graph", "cleanup", "--run-id", &runs[0], "--json"],
                deadline,
            );
            assert!(owners[0].wait(deadline).success());
            let selection = graph::foreground::restore_selection(&candidate, &runs[0]).unwrap();
            owners[0] = start(0, Some(selection["generation"].as_str().unwrap()));
            ready(&mut owners[0], &runs[0], deadline);
            backends[0].traffic(1);
            assert_eq!(
                exec(&binary, &candidate, &runs[0], "web", "read-data", deadline)["exit_code"],
                0
            );
        }
    }
    checked_cli(
        "cleanup-first",
        &binary,
        &candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &runs[0],
            "--remove-data",
            "--json",
        ],
        deadline,
    );
    assert!(owners[0].wait(deadline).success());
    cleanup[0].done = true;
    assert!(owners[1].poll().is_none());
    assert_eq!(
        serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap(),
        sibling
    );
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "dependency", deadline)["exit_code"],
        0
    );
    backends[1].traffic(1);
    let reservations = checked_cli(
        "reservation-inventory",
        &binary,
        &candidate,
        &["graph", "dependency-reservations", "--json"],
        deadline,
    );
    assert_eq!(reservations["reservations"].as_array().unwrap().len(), 1);
    assert_eq!(reservations["reservations"][0]["run"], runs[1]);
    checked_cli(
        "cleanup-second",
        &binary,
        &candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &runs[1],
            "--remove-data",
            "--json",
        ],
        deadline,
    );
    assert!(owners[1].wait(deadline).success());
    cleanup[1].done = true;
    let reservations = checked_cli(
        "reservation-empty",
        &binary,
        &candidate,
        &["graph", "dependency-reservations", "--json"],
        deadline,
    );
    assert_eq!(reservations["reservations"], json!([]));
}
