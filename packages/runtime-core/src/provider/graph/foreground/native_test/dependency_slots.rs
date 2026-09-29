//! Actual CLI owners share one pool and independently reach distinct host listeners.
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
fn concurrent_graphs_allocate_distinct_dependencies_and_release_only_owned_capacity() {
    let deadline = Instant::now() + Duration::from_secs(210);
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
    let start = |index: usize, automatic: bool| {
        let mut args = vec![
            "graph",
            "serve",
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
        if automatic {
            args.push("--auto-dependency-slots");
        }
        Process::start(&binary, &candidate, &args, None)
    };
    let mut owners = [start(0, true), start(1, true)];
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
