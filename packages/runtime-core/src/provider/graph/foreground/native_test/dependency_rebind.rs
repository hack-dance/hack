//! Exercise the actual owner control socket and traffic wake, without manually
//! invoking HostRelayRuntime or granting capabilities. The caller owns the VM.
use super::*;
use crate::provider::{graph::startup::native_test::RestartableBackend, identity};
use base64::Engine as _;
mod terminal_only;

pub(super) fn checked_cli(
    stage: &str,
    binary: &Path,
    candidate: &Candidate,
    args: &[&str],
    deadline: Instant,
) -> Value {
    let mut process = Process::start(binary, candidate, args, None);
    let status = process.wait(deadline);
    if !status.success() {
        let error: Value = serde_json::from_slice(&process.err).unwrap_or(Value::Null);
        eprintln!("foreground-rebind-stage={stage} code={}", error["code"]);
    }
    assert!(status.success(), "owned CLI stage {stage} failed");
    serde_json::from_slice(&process.out).unwrap()
}

pub(super) fn exec(
    binary: &Path,
    candidate: &Candidate,
    run: &str,
    service: &str,
    mode: &str,
    deadline: Instant,
) -> Value {
    let mut process = Process::start(
        binary,
        candidate,
        &[
            "graph",
            "exec",
            "--run-id",
            run,
            "--service",
            service,
            "--timeout-seconds",
            "12",
            "--json",
            "--",
            "/bin/hack-graph-startup-app",
            mode,
        ],
        None,
    );
    let status = process.wait(deadline);
    match exec_result(status, &process.out) {
        Ok(result) => result,
        Err(reason) => {
            // Native refusal is different from an admitted application result.
            // Print only its public code; never accept it as the expected failure.
            let error: Value = serde_json::from_slice(&process.err).unwrap_or(Value::Null);
            eprintln!(
                "foreground-rebind-invalid-exec stage={mode} reason={reason} code={}",
                error["code"]
            );
            panic!("owned application result was invalid: {reason}");
        }
    }
}

fn exec_result(status: ExitStatus, bytes: &[u8]) -> Result<Value, &'static str> {
    let result: Value = serde_json::from_slice(bytes).map_err(|_| "malformed result JSON")?;
    let object = result.as_object().ok_or("non-object result")?;
    if object.len() != 4 || object.get("truncated").and_then(Value::as_bool) != Some(false) {
        return Err("incomplete or truncated result");
    }
    let code = result["exit_code"]
        .as_u64()
        .filter(|code| *code <= 255)
        .ok_or("invalid application exit code")?;
    if status.code().map(i64::from) != Some(code as i64) {
        return Err("process exit does not match application result");
    }
    for key in ["stdout_base64", "stderr_base64"] {
        let encoded = result[key]
            .as_str()
            .ok_or("missing encoded application output")?;
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "invalid encoded application output")?;
    }
    Ok(result)
}

#[test]
fn application_result_accepts_matching_nonzero_exit_and_rejects_native_refusal() {
    use std::os::unix::process::ExitStatusExt;
    let valid = json!({"exit_code":74,"stdout_base64":"","stderr_base64":"","truncated":false});
    let bytes = serde_json::to_vec(&valid).unwrap();
    assert_eq!(
        exec_result(ExitStatus::from_raw(74 << 8), &bytes).unwrap(),
        valid
    );
    assert!(exec_result(ExitStatus::from_raw(0), &bytes).is_err());
    assert!(exec_result(ExitStatus::from_raw(libc::SIGKILL), &bytes).is_err());
    assert!(exec_result(ExitStatus::from_raw(74 << 8), b"not JSON").is_err());
    for invalid in [
        json!({"ok":false,"code":"graph_service_exec"}),
        json!({"exit_code":74,"stdout_base64":"invalid!","stderr_base64":"","truncated":false}),
        json!({"exit_code":74,"stdout_base64":"","stderr_base64":"","truncated":true}),
        json!({"exit_code":74,"stdout_base64":"","stderr_base64":""}),
    ] {
        assert!(
            exec_result(
                ExitStatus::from_raw(74 << 8),
                &serde_json::to_vec(&invalid).unwrap()
            )
            .is_err()
        );
    }
}

pub(super) fn snapshot(candidate: &Candidate, run: &str, deadline: Instant) -> graph::Snapshot {
    loop {
        match graph::inspect(candidate, run) {
            Ok(snapshot) => return snapshot,
            Err(error) if error.code == "provider_busy" && Instant::now() < deadline => {
                // Observation may race the final lease release. Never repeat an exec.
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("owned graph observation failed: {}", error.code),
        }
    }
}

fn registered_targets(candidate: &Candidate, receipt: &graph::Receipt) -> Value {
    use crate::provider::relay_owner::{SelectionRequest, publication::PinnedEndpoint};
    let engine = graph::Engine::connect_cleanup(candidate).unwrap();
    let context =
        graph::host_relay::context(engine.guest().incarnation(), engine.guest().boot_id()).unwrap();
    let scope = graph::host_relay::graph_scope(context, &receipt.run).unwrap();
    let endpoint = PinnedEndpoint::load(
        &receipt.relay_startup.as_ref().unwrap().control_root,
        context,
    )
    .unwrap();
    let request = SelectionRequest::new(endpoint.incarnation(), [21; 16], scope).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut exchange = endpoint.select(request, Duration::from_secs(3)).unwrap();
    loop {
        if let Some(selected) = exchange.progress().unwrap() {
            return serde_json::to_value(selected.targets()).unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "owned registration observation timed out"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn await_rebound(
    candidate: &Candidate,
    run: &str,
    endpoint_generation: &str,
    owner: &mut Process,
    deadline: Instant,
) -> graph::Snapshot {
    let root = graph::directory(candidate, run).unwrap();
    loop {
        assert!(
            owner.poll().is_none(),
            "owned foreground exited during refresh"
        );
        let journal = state::read::<Value>(&root.join("dependency-rebind.json"));
        let receipt = state::read::<graph::Receipt>(&root.join("state.json"));
        if let (Ok(journal), Ok(receipt)) = (journal, receipt) {
            let current = receipt.relay_startup.as_ref().is_some_and(|startup| {
                ["web", "search", "init"].iter().all(|name| {
                    startup.services[*name].bindings["default"]
                        .endpoint_generation
                        .as_deref()
                        == Some(endpoint_generation)
                })
            });
            if current && journal["phase"] == "completed" {
                assert_eq!(journal["completed_services"], json!(["init"]));
                assert!(journal["processes"].get("init").is_none());
                let snapshot = snapshot(candidate, run, deadline);
                assert!(!snapshot.journal_incomplete);
                assert_eq!(snapshot.receipt.phase, "ready-observed");
                return snapshot;
            }
        }
        assert!(
            Instant::now() < deadline,
            "foreground refresh did not complete"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct RetainedIdentity<'a> {
    binary: &'a Path,
    candidate: &'a Candidate,
    owner: identity::ProcessIdentity,
    boot: String,
    volume: Value,
    deadline: Instant,
}
impl RetainedIdentity<'_> {
    fn preserved(&self, before: &graph::Receipt, after: &graph::Receipt, owner: &Process) {
        self.verify(before, after, owner, true);
    }
    fn unchanged(&self, before: &graph::Receipt, after: &graph::Receipt, owner: &Process) {
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(after).unwrap()
        );
        self.verify(before, after, owner, false);
    }
    fn verify(
        &self,
        before: &graph::Receipt,
        after: &graph::Receipt,
        owner: &Process,
        replaced_helpers: bool,
    ) {
        let Self {
            binary,
            candidate,
            owner: owner_identity,
            boot,
            volume,
            deadline,
        } = self;
        assert_eq!(
            identity::observe(owner.child.id() as i32).unwrap(),
            *owner_identity
        );
        transport::Pin::load(candidate, &before.run)
            .unwrap()
            .verify()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&before.resources).unwrap(),
            serde_json::to_value(&after.resources).unwrap()
        );
        assert_eq!(before.run, after.run);
        assert_eq!(before.owner, after.owner);
        assert_eq!(before.plan_id, after.plan_id);
        assert_eq!(before.namespace, after.namespace);
        let engine = graph::Engine::connect_cleanup(candidate).unwrap();
        assert_eq!(engine.guest().boot_id(), boot);
        assert_eq!(
            graph::inspect_resource(&engine, after, &after.resources["volume:data"])
                .unwrap()
                .as_ref(),
            Some(volume)
        );
        let before_startup = before.relay_startup.as_ref().unwrap();
        let after_startup = after.relay_startup.as_ref().unwrap();
        for service in ["web", "search"] {
            let old = &before_startup.services[service];
            let new = &after_startup.services[service];
            assert_eq!(old.generation, new.generation);
            assert_eq!(old.started_at, new.started_at);
            if replaced_helpers {
                assert_ne!(
                    old.bindings["default"].process,
                    new.bindings["default"].process
                );
            } else {
                assert_eq!(
                    old.bindings["default"].process,
                    new.bindings["default"].process
                );
            }
            let resource = &after.resources[&format!("container:{service}")];
            assert_eq!(
                graph::inspect_resource(&engine, after, resource)
                    .unwrap()
                    .unwrap()["State"]["Running"],
                true
            );
        }
        let old = &before.relay_startup.as_ref().unwrap().services["init"];
        let new = &after.relay_startup.as_ref().unwrap().services["init"];
        assert_eq!(old.generation, new.generation);
        assert_eq!(old.started_at, new.started_at);
        if replaced_helpers {
            assert_eq!(new.phase, graph::startup::Phase::Completed);
            assert!(
                new.bindings
                    .values()
                    .all(|binding| binding.process.is_none())
            );
        }
        let resource = &after.resources["container:init"];
        let terminal = graph::inspect_resource(&engine, after, resource)
            .unwrap()
            .unwrap();
        assert_eq!(terminal["State"]["Running"], false);
        assert_eq!(terminal["State"]["ExitCode"], 0);
        assert_eq!(terminal["State"]["Pid"], 0);
        assert_eq!(
            terminal["State"]["StartedAt"].as_str(),
            new.started_at.as_deref()
        );
        drop(engine);
        for service in ["web", "search"] {
            let result = exec(
                binary,
                candidate,
                &before.run,
                service,
                "read-data",
                *deadline,
            );
            assert_eq!(result["exit_code"], 0);
            assert_eq!(result["truncated"], false);
        }
    }
}

#[test]
#[ignore = "Owned capacity-one VM, matching installed candidate CLI, static fixture image, reviewed relay and external 240s watchdog required"]
fn foreground_traffic_wake_and_explicit_refresh_preserve_graph() {
    let deadline = Instant::now() + Duration::from_secs(210);
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit isolated candidate root"),
    ))
    .unwrap();
    let binary =
        PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").expect("matching candidate CLI"));
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned static fixture image");
    let artifact =
        PathBuf::from(std::env::var("HACK_GRAPH_RELAY_ARTIFACT").expect("reviewed relay"));
    let artifact_hash = std::env::var("HACK_GRAPH_RELAY_SHA256").expect("pinned relay digest");
    let fixture = graph::tests::Fixture::new();
    let app = json!({"image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
        "entrypoint":["/bin/hack-graph-startup-app","serve"],"command":[],"volumes":["data:/data"],
        "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","health"],"interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}});
    let job = json!({"image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
        "entrypoint":["/bin/hack-graph-startup-app","complete"],"command":[]});
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({"services":{"web":app,"search":app,"init":job},"volumes":{"data":{}}}),
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
    let run = graph::probes::token().unwrap();
    // The reviewed source inventory must stay unchanged. Runtime selection is
    // transient fixture state, retained by a separate RAII directory.
    let selection_fixture = graph::tests::Fixture::new();
    let mut backend = RestartableBackend::start(0);
    let endpoint = backend.endpoint();
    let selection = selection_fixture.0.join("dependencies.json");
    let bindings = ["web", "search", "init"].map(|service| {
        json!({
            "service":service,"binding":"default","slot":0,"guest_port":25252,
            "host_pid":endpoint.process_identity().pid,"host_port":backend.port,
            "host_executable":std::env::current_exe().unwrap()
        })
    });
    state::write(
        &selection,
        &json!({"version":1,"plan":review.plan_id,"artifact":artifact,
        "artifact_sha256":artifact_hash,"dependencies":bindings}),
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
            "web=healthy",
            "--ready",
            "search=healthy",
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
                "foreground exited before ready: {status} code={}",
                error["code"]
            );
        }
        if let Some(end) = owner.out.iter().position(|byte| *byte == b'\n') {
            let ready: Value = serde_json::from_slice(&owner.out[..end]).unwrap();
            assert_eq!(ready["kind"], "graph_foreground_ready");
            assert_eq!(ready["run"], run);
            break;
        }
        assert!(Instant::now() < deadline, "foreground readiness deadline");
        std::thread::sleep(Duration::from_millis(10));
    }
    backend.traffic(2);
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
    let retained = RetainedIdentity {
        binary: &binary,
        candidate: &candidate,
        owner: owner_identity,
        boot,
        volume,
        deadline,
    };
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "write-data", deadline)["exit_code"],
        0
    );

    let port = backend.port;
    let root = graph::directory(&candidate, &run).unwrap();
    let original_generation = graph::service_exec_generation(&before).unwrap();
    let targets = registered_targets(&candidate, &before);
    assert_eq!(targets.as_array().unwrap().len(), 3);
    // The wrapper may need seconds to reopen its listener. Failed authenticated
    // traffic during that gap must not turn a preflight refusal into effects.
    backend.stop();
    let gap_rejected = exec(&binary, &candidate, &run, "web", "dependency", deadline);
    assert_ne!(gap_rejected["exit_code"], 0);
    let gap_status = checked_cli(
        "listener-gap-status",
        &binary,
        &candidate,
        &["graph", "owner-status", "--run-id", &run, "--json"],
        deadline,
    );
    assert_eq!(gap_status["foreground_alive"], true);
    assert_eq!(gap_status["runtime_verified"], false);
    assert_eq!(
        gap_status["runtime_error"],
        "graph_dependency_endpoint_changed"
    );
    assert_eq!(gap_status["generation"], original_generation);
    assert!(owner.poll().is_none());
    let gap = snapshot(&candidate, &run, deadline);
    assert!(!gap.journal_incomplete);
    assert_eq!(gap.receipt.phase, "ready-observed");
    assert!(!root.join("dependency-rebind.json").exists());
    assert!(!root.join("dependency-rebind.pending").exists());
    assert_eq!(registered_targets(&candidate, &gap.receipt), targets);
    retained.unchanged(&before, &gap.receipt, &owner);
    backend = RestartableBackend::start(port);
    let gap_endpoint = backend.endpoint().fingerprint().unwrap();
    let gap_refreshed = checked_cli(
        "listener-gap-refresh",
        &binary,
        &candidate,
        &["graph", "refresh-dependencies", "--run-id", &run, "--json"],
        deadline,
    );
    let recovered_gap =
        await_rebound(&candidate, &run, &gap_endpoint, &mut owner, deadline).receipt;
    assert_eq!(gap_refreshed["changed_slots"], json!([0]));
    retained.preserved(&before, &recovered_gap, &owner);
    assert_eq!(
        registered_targets(&candidate, &recovered_gap)
            .as_array()
            .unwrap()
            .len(),
        2
    );
    backend.assert_no_traffic();
    for service in ["web", "search"] {
        assert_eq!(
            exec(&binary, &candidate, &run, service, "dependency", deadline)["exit_code"],
            0
        );
    }
    backend.traffic(2);
    backend.assert_no_traffic();

    backend.stop();
    backend = RestartableBackend::start(port);
    let automatic_endpoint = backend.endpoint().fingerprint().unwrap();
    // This direct native exec intentionally does not run the TypeScript refresh
    // helper. Its rejected authenticated connection alone must wake the owner.
    // Holding the exec lease also makes notification loss on provider_busy visible.
    let rejected = exec(&binary, &candidate, &run, "web", "dependency", deadline);
    assert_ne!(rejected["exit_code"], 0);
    let automatic = await_rebound(
        &candidate,
        &run,
        &automatic_endpoint,
        &mut owner,
        deadline.min(Instant::now() + Duration::from_secs(30)),
    )
    .receipt;
    backend.assert_no_traffic();
    retained.preserved(&recovered_gap, &automatic, &owner);
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "dependency", deadline)["exit_code"],
        0
    );
    backend.traffic(1);
    backend.assert_no_traffic();

    backend.stop();
    backend = RestartableBackend::start(port);
    let explicit_endpoint = backend.endpoint().fingerprint().unwrap();
    let refreshed = checked_cli(
        "explicit-refresh",
        &binary,
        &candidate,
        &["graph", "refresh-dependencies", "--run-id", &run, "--json"],
        deadline,
    );
    let explicit =
        await_rebound(&candidate, &run, &explicit_endpoint, &mut owner, deadline).receipt;
    assert_eq!(
        refreshed,
        json!({"ok":true,"run":run,"plan":before.plan_id,"owner":before.owner,
        "namespace":before.namespace,"generation":graph::service_exec_generation(&explicit).unwrap(),"changed_slots":[0]})
    );
    retained.preserved(&automatic, &explicit, &owner);
    backend.assert_no_traffic();
    for service in ["web", "search"] {
        assert_eq!(
            exec(&binary, &candidate, &run, service, "dependency", deadline)["exit_code"],
            0
        );
    }
    backend.traffic(2);
    backend.assert_no_traffic();
    let stopped = checked_cli(
        "owned-retain",
        &binary,
        &candidate,
        &["graph", "cleanup", "--run-id", &run, "--json"],
        deadline,
    );
    assert_eq!(stopped["phase"], "stopped-data-retained");
    assert!(owner.wait(deadline).success());
    assert!(owner.child.try_wait().unwrap().is_some());
    assert!(transport::Pin::load(&candidate, &run).is_err());
    {
        let retired = transport::Retired::acquire(&candidate, &run)
            .unwrap()
            .unwrap();
        retired.verify().unwrap();
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        let (receipt, root) = graph::load(&candidate, &engine, &run).unwrap();
        assert_eq!(receipt.phase, "stopped-data-retained");
        graph::host_relay::require_acknowledged_enrollment(&receipt).unwrap();
        assert!(!root.join("dependency-rebind.json").exists());
        assert!(!root.join("dependency-rebind.pending").exists());
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
        let volume = graph::inspect_resource(&engine, &receipt, &receipt.resources["volume:data"])
            .unwrap()
            .unwrap();
        assert_eq!(volume, retained.volume);
        assert_eq!(engine.guest().execute_cleanup(
            "set -eu; test ! -L \"$1/hack-rebind-marker\"; test \"$(cat \"$1/hack-rebind-marker\")\" = retained-dependency-rebind-v1; printf preserved",
            &[volume["Mountpoint"].as_str().unwrap()]
        ).unwrap(), "preserved");
    }
    let cleaned = checked_cli(
        "retired-owned-remove",
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
    assert_eq!(cleaned["phase"], "removed");
    cleanup.done = true;
    let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
    let (removed, _) = graph::load(&candidate, &engine, &run).unwrap();
    for resource in removed.resources.values() {
        assert!(
            graph::inspect_resource(&engine, &removed, resource)
                .unwrap()
                .is_none()
        );
    }
    drop(engine);
    assert!(transport::Pin::load(&candidate, &run).is_err());
    backend.stop();
    println!(
        "graph-foreground-rebind-qualified-v1 listener_gap_refusal=1 listener_gap_recovered=1 automatic_wake=1 explicit_wire=1 replayed_requests=0 shared_bindings=3 running_bindings=2 completed_bindings_retired=1 retained_containers=3 retained_boot=1 retained_data=1 owner_reaped=1 retired_owned_resources_removed=1"
    );
}
