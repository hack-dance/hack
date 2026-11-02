//! A previous-boot dead owner must allow explicit data removal after its
//! recovered publisher retires, without changing a live sibling on the new boot.
//! The caller owns an isolated capacity-two VM and a pinned static fixture image.
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;

struct FaultChild(Option<Child>);
impl Drop for FaultChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
#[ignore = "Only the parent native fixture starts this exact helper in its owned VM"]
fn retired_recovery_cleanup_fault_child() {
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let run = std::env::var("HACK_LOCAL_GRAPH_RUN").unwrap();
    graph::foreground::cleanup_request(&candidate, &run, true).unwrap();
}

fn ready(owner: &mut Process, run: &str, deadline: Instant) {
    loop {
        if let Some(status) = owner.poll() {
            let error: Value = serde_json::from_slice(&owner.err).unwrap_or(Value::Null);
            panic!(
                "foreground owner exited before ready: {status} code={}",
                error["code"]
            );
        }
        if let Some(end) = owner.out.iter().position(|byte| *byte == b'\n') {
            let value: Value = serde_json::from_slice(&owner.out[..end]).unwrap();
            assert_eq!(value["kind"], "graph_foreground_ready");
            assert_eq!(value["run"], run);
            return;
        }
        assert!(Instant::now() < deadline, "foreground readiness deadline");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "Owned capacity-two development VM, matching all-feature CLI, pinned static image and external 300s watchdog required"]
fn previous_boot_recovered_publisher_allows_data_removal_without_touching_sibling() {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let fixtures = [graph::tests::Fixture::new(), graph::tests::Fixture::new()];
    let runs = [
        graph::probes::token().unwrap(),
        graph::probes::token().unwrap(),
    ];
    let selection_root = graph::tests::Fixture::new();
    let mut plans = Vec::new();
    let mut selections = Vec::new();
    let mut dependencies = Vec::new();
    for (index, fixture) in fixtures.iter().enumerate() {
        state::write(
            &fixture.0.join("compose.yaml"),
            &json!({
                "services":{"web":{"image":image,"read_only":true,"network_mode":"none",
                    "init":true,"user":"0:0","entrypoint":["/bin/sleep","300"],
                    "command":[],"volumes":["data:/data"],
                    "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","complete"],
                        "interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}}},
                "volumes":{"data":{}}
            }),
        )
        .unwrap();
        let review = project::plan(
            &candidate,
            project::PlanOptions {
                branch: None,
                project: &fixture.0,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let selection = selection_root.0.join(format!("dependencies-{index}.json"));
        state::write(
            &selection,
            &json!({"version":1,"plan":review.plan_id,
            "artifact":"/tmp/unused-control-only-artifact",
            "artifact_sha256":"a".repeat(64),"dependencies":[]}),
        )
        .unwrap();
        let dependency = checked_cli(
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
        plans.push(review);
        selections.push(selection);
        dependencies.push(dependency);
    }
    let start = |index: usize| {
        let normalized = fixtures[index].0.join("compose.yaml");
        Process::start(
            &binary,
            &candidate,
            &[
                "graph",
                "serve",
                "--project",
                fixtures[index].0.to_str().unwrap(),
                "--file",
                "compose.yaml",
                "--expect-plan",
                &plans[index].plan_id,
                "--run-id",
                &runs[index],
                "--ready",
                "web=healthy",
                "--timeout-seconds",
                "90",
                "--dependencies",
                selections[index].to_str().unwrap(),
                "--expect-dependencies",
                dependencies[index]["dependency_plan_id"].as_str().unwrap(),
                "--normalized-file",
                normalized.to_str().unwrap(),
                "--expect-original",
                &plans[index].plan.compose_sha256,
                "--expect-namespace",
                &plans[index].plan.namespace,
                "--json",
            ],
            None,
        )
    };
    let mut selected_owner = start(0);
    let mut selected_cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &runs[0],
        done: false,
    };
    ready(&mut selected_owner, &runs[0], deadline);
    assert_eq!(
        exec(&binary, &candidate, &runs[0], "web", "write-data", deadline)["exit_code"],
        0
    );
    assert_eq!(
        exec(&binary, &candidate, &runs[0], "web", "read-data", deadline)["exit_code"],
        0
    );
    let selected = snapshot(&candidate, &runs[0], deadline).receipt;
    assert_eq!(selected.phase, "ready-observed");
    let expected = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(&selected).unwrap())
    );
    let before_reboot = crate::provider::lifecycle::status(&candidate).unwrap();
    assert_eq!(before_reboot.phase, "running");
    let old_boot = before_reboot.guest_boot_id.unwrap();

    selected_owner.child.kill().unwrap();
    selected_owner.wait(deadline);
    assert_eq!(
        crate::provider::lifecycle::down(&candidate).unwrap().phase,
        "stopped"
    );
    let restarted = crate::provider::lifecycle::up(&candidate).unwrap();
    assert_eq!(restarted.phase, "running");
    let new_boot = restarted.guest_boot_id.unwrap();
    assert_ne!(new_boot, old_boot);

    // Start the sibling on the successor boot, so recovery must isolate the
    // previous generation without treating all current guests as stale.
    let mut sibling_owner = start(1);
    let mut sibling_cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &runs[1],
        done: false,
    };
    ready(&mut sibling_owner, &runs[1], deadline);
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "write-data", deadline)["exit_code"],
        0
    );
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "read-data", deadline)["exit_code"],
        0
    );
    let sibling = serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap();

    for _ in 0..2 {
        let recovered = checked_cli(
            "previous-boot-recover",
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
        assert_eq!(recovered["phase"], "stopped-data-retained");
    }
    let retained = snapshot(&candidate, &runs[0], deadline).receipt;
    assert_eq!(retained.phase, "stopped-data-retained");
    assert_eq!(
        retained.resources["volume:data"].name,
        selected.resources["volume:data"].name
    );
    for _ in 0..2 {
        let retired = checked_cli(
            "retire-recovered-publisher",
            &binary,
            &candidate,
            &[
                "graph",
                "retire-recovered-publisher",
                "--run-id",
                &runs[0],
                "--expect-owner",
                &retained.owner,
                "--json",
            ],
            deadline,
        );
        assert_eq!(retired["publisher_retired"], true);
    }
    let root = graph::directory(&candidate, &runs[0]).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "provider::graph::foreground::native_test::retired_recovery_cleanup::retired_recovery_cleanup_fault_child",
        ])
        .env("HACK_LOCAL_TEST_ROOT", std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())
        .env("HACK_LOCAL_GRAPH_RUN", &runs[0])
        .env("HACK_LOCAL_GRAPH_FAULT", "cleanup-after-remove")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut fault = FaultChild(Some(child));
    let marker = root.join("fault-cleanup-after-remove.json");
    let fault_deadline = Instant::now() + Duration::from_secs(20);
    while !marker.exists() {
        assert!(fault.0.as_mut().unwrap().try_wait().unwrap().is_none());
        assert!(
            Instant::now() < fault_deadline,
            "cleanup fault marker deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let observed: Value = state::read(&marker).unwrap();
    assert_eq!(observed["point"], "cleanup-after-remove");
    assert_eq!(observed["run"], runs[0]);
    assert!(fault.0.as_mut().unwrap().try_wait().unwrap().is_none());
    let intent: Value = state::read(&root.join("retired-data-removal.json")).unwrap();
    assert_eq!(intent["version"], 1);
    assert!(
        intent["recovery"]
            .as_str()
            .is_some_and(|digest| digest.len() == 64)
    );
    let paused_receipt: graph::Receipt = state::read(&root.join("state.json")).unwrap();
    assert_eq!(paused_receipt.phase, "cleanup-intent");
    fault.0.as_mut().unwrap().kill().unwrap();
    let killed = fault.0.as_mut().unwrap().wait().unwrap();
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&killed),
        Some(libc::SIGKILL)
    );
    fault.0 = None;
    for _ in 0..2 {
        let removed = checked_cli(
            "remove-recovered-data",
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
        assert_eq!(removed["phase"], "removed");
    }
    selected_cleanup.done = true;
    let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
    let (removed, _) = graph::load(&candidate, &engine, &runs[0]).unwrap();
    assert_eq!(removed.phase, "removed");
    for resource in removed.resources.values() {
        assert!(
            graph::inspect_resource(&engine, &removed, resource)
                .unwrap()
                .is_none()
        );
    }
    drop(engine);
    assert!(sibling_owner.poll().is_none());
    assert_eq!(
        serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap(),
        sibling
    );
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "read-data", deadline)["exit_code"],
        0
    );
    let sibling_removed = checked_cli(
        "remove-sibling-data",
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
    assert_eq!(sibling_removed["phase"], "removed");
    assert!(sibling_owner.wait(deadline).success());
    sibling_cleanup.done = true;
}
