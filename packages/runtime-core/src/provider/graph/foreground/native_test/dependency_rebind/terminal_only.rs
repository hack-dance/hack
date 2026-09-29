//! Distinct opt-in VM proof: a completed-only slot lends its newly reviewed
//! endpoint to a fresh one-off, never to the stopped original container.
use super::*;
use std::collections::BTreeSet;

fn job(binary: &Path, candidate: &Candidate, run: &str, mode: &str, deadline: Instant) -> Value {
    let selected = checked_cli(
        "terminal-job-selection",
        binary,
        candidate,
        &[
            "graph",
            "run-selection",
            "--run-id",
            run,
            "--service",
            "init",
            "--json",
        ],
        deadline,
    );
    // The existing managed-input contract requires a nonempty service value map.
    // This private-descriptor envelope injects only a public fixture value.
    let input = Zeroizing::new(
        serde_json::to_vec(&json!({
            "version":1, "plan":selected["plan"], "run":run,
        "lifetime_seconds":120, "services":{"init":{"PUBLIC_MODE":"terminal-one-off"}}
        }))
        .unwrap(),
    );
    let mut process = Process::start(
        binary,
        candidate,
        &[
            "graph",
            "run-service",
            "--run-id",
            run,
            "--service",
            "init",
            "--expect-plan",
            selected["plan"].as_str().unwrap(),
            "--expect-generation",
            selected["generation"].as_str().unwrap(),
            "--expect-boot",
            selected["boot"].as_str().unwrap(),
            "--environment-stdin",
            "--timeout-seconds",
            "12",
            "--json",
            "--",
            mode,
        ],
        Some(&input),
    );
    let status = process.wait(deadline);
    if !status.success() {
        let error: Value = serde_json::from_slice(&process.err).unwrap_or(Value::Null);
        eprintln!("terminal-one-off-stage={mode} code={}", error["code"]);
    }
    assert!(status.success(), "fresh terminal-template one-off failed");
    let value: Value = serde_json::from_slice(&process.out).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["run"], run);
    assert_eq!(value["exit_code"], 0);
    assert_eq!(value["cleanup_confirmed"], true);
    assert_eq!(value["truncated"], false);
    assert_eq!(value["stdout_base64"], "");
    assert_eq!(value["stderr_base64"], "");
    value
}

fn original_exec_refused(binary: &Path, candidate: &Candidate, run: &str, deadline: Instant) {
    let mut process = Process::start(
        binary,
        candidate,
        &[
            "graph",
            "exec",
            "--run-id",
            run,
            "--service",
            "init",
            "--timeout-seconds",
            "12",
            "--json",
            "--",
            "/bin/hack-graph-startup-app",
            "dependency",
        ],
        None,
    );
    assert_eq!(process.wait(deadline).code(), Some(2));
    let error: Value = serde_json::from_slice(&process.err).unwrap();
    assert_eq!(error["code"], "graph_service_exec");
    assert!(process.out.is_empty());
}

fn preserved(
    candidate: &Candidate,
    before: &graph::Receipt,
    after: &graph::Receipt,
    owner: &Process,
    owner_identity: &identity::ProcessIdentity,
    boot: &str,
    volume: &Value,
) {
    assert_eq!(
        &identity::observe(owner.child.id() as i32).unwrap(),
        owner_identity
    );
    assert_eq!(before.run, after.run);
    assert_eq!(before.owner, after.owner);
    assert_eq!(before.plan_id, after.plan_id);
    assert_eq!(before.namespace, after.namespace);
    assert_eq!(
        serde_json::to_value(&before.resources).unwrap(),
        serde_json::to_value(&after.resources).unwrap()
    );
    let old = &before.relay_startup.as_ref().unwrap().services["init"];
    let terminal = &after.relay_startup.as_ref().unwrap().services["init"];
    assert_eq!(old.generation, terminal.generation);
    assert_eq!(old.started_at, terminal.started_at);
    assert_eq!(terminal.phase, graph::startup::Phase::Completed);
    assert!(
        terminal
            .bindings
            .values()
            .all(|binding| binding.process.is_none())
    );
    let engine = graph::Engine::connect_cleanup(candidate).unwrap();
    assert_eq!(engine.guest().boot_id(), boot);
    let container = graph::inspect_resource(&engine, after, &after.resources["container:init"])
        .unwrap()
        .unwrap();
    assert_eq!(container["State"]["Running"], false);
    assert_eq!(container["State"]["Pid"], 0);
    assert_eq!(container["State"]["ExitCode"], 0);
    assert_eq!(container["State"]["OOMKilled"], false);
    assert_eq!(container["State"]["Dead"], false);
    assert_eq!(
        container["State"]["StartedAt"].as_str(),
        terminal.started_at.as_deref()
    );
    assert_eq!(
        graph::inspect_resource(&engine, after, &after.resources["volume:data"])
            .unwrap()
            .as_ref(),
        Some(volume)
    );
    assert_eq!(engine.guest().execute_cleanup(
        "set -eu; test ! -L \"$1/hack-rebind-marker\"; test \"$(cat \"$1/hack-rebind-marker\")\" = retained-dependency-rebind-v1; printf preserved",
        &[volume["Mountpoint"].as_str().unwrap()]).unwrap(), "preserved");
}

#[test]
#[ignore = "Owned capacity-one VM, matching shipped-feature candidate CLI, pinned static fixture image, reviewed relay and external 240s watchdog required"]
fn rotated_completed_only_slot_admits_fresh_jobs_and_preserves_stopped_original() {
    let deadline = Instant::now() + Duration::from_secs(210);
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("isolated candidate root"),
    ))
    .unwrap();
    let binary = PathBuf::from(
        std::env::var("HACK_LOCAL_TEST_BINARY").expect("matching shipped-feature candidate CLI"),
    );
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned static fixture image");
    let artifact =
        PathBuf::from(std::env::var("HACK_GRAPH_RELAY_ARTIFACT").expect("reviewed relay"));
    let artifact_hash = std::env::var("HACK_GRAPH_RELAY_SHA256").expect("pinned relay digest");
    let fixture = graph::tests::Fixture::new();
    state::write(&fixture.0.join("compose.yaml"), &json!({"services":{"init":{
        "image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
        "entrypoint":["/bin/hack-graph-startup-app"],"command":["write-data"],"volumes":["data:/data"]
    }},"volumes":{"data":{}}})).unwrap();
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
    let run = graph::probes::token().unwrap();
    let selection_fixture = graph::tests::Fixture::new();
    let selection = selection_fixture.0.join("dependencies.json");
    let mut backend = RestartableBackend::start(0);
    let endpoint = backend.endpoint();
    state::write(&selection, &json!({
        "version":1,"plan":review.plan_id,"artifact":artifact,"artifact_sha256":artifact_hash,
        "dependencies":[{"service":"init","binding":"default","slot":0,"guest_port":25252,
            "host_pid":endpoint.process_identity().pid,"host_port":backend.port,"host_executable":std::env::current_exe().unwrap()}]
    })).unwrap();
    let dependency = checked_cli(
        "terminal-dependency-plan",
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
    let mut owner = Process::start(
        &binary,
        &candidate,
        &[
            "graph",
            "serve",
            "--project",
            fixture.0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &review.plan_id,
            "--run-id",
            &run,
            "--ready",
            "init=completed",
            "--timeout-seconds",
            "60",
            "--dependencies",
            selection.to_str().unwrap(),
            "--expect-dependencies",
            dependency["dependency_plan_id"].as_str().unwrap(),
            "--json",
        ],
        None,
    );
    let mut cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &run,
        done: false,
    };
    loop {
        if let Some(status) = owner.poll() {
            let error: Value = serde_json::from_slice(&owner.err).unwrap_or(Value::Null);
            panic!(
                "terminal foreground exited before ready: {status} code={}",
                error["code"]
            );
        }
        if let Some(end) = owner.out.iter().position(|byte| *byte == b'\n') {
            let ready: Value = serde_json::from_slice(&owner.out[..end]).unwrap();
            assert_eq!(ready["kind"], "graph_foreground_ready");
            assert_eq!(ready["run"], run);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "terminal foreground ready deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    backend.assert_no_traffic();
    let before = snapshot(&candidate, &run, deadline).receipt;
    let owner_identity = identity::observe(owner.child.id() as i32).unwrap();
    let (boot, volume) = {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        (
            engine.guest().boot_id().to_owned(),
            graph::inspect_resource(&engine, &before, &before.resources["volume:data"])
                .unwrap()
                .unwrap(),
        )
    };
    original_exec_refused(&binary, &candidate, &run, deadline);
    assert_eq!(
        registered_targets(&candidate, &before)
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let root = graph::directory(&candidate, &run).unwrap();
    let port = backend.port;
    let mut jobs = BTreeSet::new();
    for turn in 0..3 {
        backend.stop();
        backend = RestartableBackend::start(port);
        let fingerprint = backend.endpoint().fingerprint().unwrap();
        let refreshed = checked_cli(
            "terminal-refresh",
            &binary,
            &candidate,
            &["graph", "refresh-dependencies", "--run-id", &run, "--json"],
            deadline,
        );
        assert_eq!(refreshed["changed_slots"], json!([0]));
        let after = snapshot(&candidate, &run, deadline);
        assert!(!after.journal_incomplete);
        preserved(
            &candidate,
            &before,
            &after.receipt,
            &owner,
            &owner_identity,
            &boot,
            &volume,
        );
        assert_eq!(
            after.receipt.relay_startup.as_ref().unwrap().services["init"].bindings["default"]
                .endpoint_generation
                .as_deref(),
            Some(fingerprint.as_str())
        );
        let journal: Value = state::read(&root.join("dependency-rebind.json")).unwrap();
        assert_eq!(journal["phase"], "completed");
        assert_eq!(journal["slots"]["0"]["terminal_only"], true);
        assert_eq!(journal["completed_services"], json!(["init"]));
        assert_eq!(journal["processes"], json!({}));
        assert!(
            registered_targets(&candidate, &after.receipt)
                .as_array()
                .unwrap()
                .is_empty()
        );
        backend.assert_no_traffic();
        original_exec_refused(&binary, &candidate, &run, deadline);
        let noop = checked_cli(
            "terminal-refresh-noop",
            &binary,
            &candidate,
            &["graph", "refresh-dependencies", "--run-id", &run, "--json"],
            deadline,
        );
        assert_eq!(noop["changed_slots"], json!([]));
        if turn != 1 {
            let request = job(&binary, &candidate, &run, "dependency", deadline);
            assert!(jobs.insert(request["job"].as_str().unwrap().to_owned()));
            backend.traffic(1);
            backend.assert_no_traffic();
            let marker = job(&binary, &candidate, &run, "read-data", deadline);
            assert!(jobs.insert(marker["job"].as_str().unwrap().to_owned()));
            let after_jobs = snapshot(&candidate, &run, deadline);
            assert!(!after_jobs.journal_incomplete);
            preserved(
                &candidate,
                &before,
                &after_jobs.receipt,
                &owner,
                &owner_identity,
                &boot,
                &volume,
            );
            assert!(!root.join("one-off.json").exists());
        }
    }
    assert_eq!(jobs.len(), 4);
    let stopped = checked_cli(
        "terminal-retain",
        &binary,
        &candidate,
        &["graph", "cleanup", "--run-id", &run, "--json"],
        deadline,
    );
    assert_eq!(stopped["phase"], "stopped-data-retained");
    assert!(owner.wait(deadline).success());
    assert!(transport::Pin::load(&candidate, &run).is_err());
    {
        let retired = transport::Retired::acquire(&candidate, &run)
            .unwrap()
            .unwrap();
        retired.verify().unwrap();
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        let (receipt, _) = graph::load(&candidate, &engine, &run).unwrap();
        for resource in receipt
            .resources
            .values()
            .filter(|resource| resource.kind != graph::Kind::Volume)
        {
            assert!(
                graph::inspect_resource(&engine, &receipt, resource)
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            graph::inspect_resource(&engine, &receipt, &receipt.resources["volume:data"])
                .unwrap()
                .as_ref(),
            Some(&volume)
        );
        assert_eq!(engine.guest().boot_id(), boot);
    }
    let removed = checked_cli(
        "terminal-remove-owned-data",
        &binary,
        &candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &run,
            "--remove-data",
            "--json",
        ],
        deadline,
    );
    assert_eq!(removed["phase"], "removed");
    cleanup.done = true;
    let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
    let (receipt, _) = graph::load(&candidate, &engine, &run).unwrap();
    for resource in receipt.resources.values() {
        assert!(
            graph::inspect_resource(&engine, &receipt, resource)
                .unwrap()
                .is_none()
        );
    }
    backend.stop();
    println!(
        "graph-terminal-only-reuse-qualified-v1 rotations=3 empty_rotations=1 fresh_one_offs=4 stopped_original_exec_refused=4 terminal_grants=0 terminal_helpers=0 retained_boot=1 retained_container_identity=1 retained_data=1 owner_reaped=1 retired_owned_resources_removed=1"
    );
}
