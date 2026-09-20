//! Signal the actual foreground CLI while the initializer still owns startup.
//! Requires the caller's isolated development VM and external 90-second watchdog.
use super::*;
use std::os::unix::process::ExitStatusExt;

#[test]
#[ignore = "Owned development VM, pinned image, matching candidate CLI, external watchdog required"]
fn startup_signals_stop_initializer_without_starting_dependents() {
    let deadline = Instant::now() + Duration::from_secs(90);
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let mut proofs = Vec::new();
    for signal in [libc::SIGTERM, libc::SIGINT] {
        proofs.push(exercise(&candidate, &binary, &image, signal, deadline));
    }
    println!("startup-cancellation-proof {}", json!({"signals":proofs}));
}

fn exercise(
    candidate: &Candidate,
    binary: &Path,
    image: &str,
    signal: i32,
    deadline: Instant,
) -> Value {
    let fixture = graph::tests::Fixture::new();
    let project = fixture.0.join("project");
    fs::create_dir(&project).unwrap();
    let mut random = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let run: String = random.iter().map(|b| format!("{b:02x}")).collect();
    // The trap precedes the sentinel. Short sleeps let /bin/sh dispatch TERM
    // within the declared grace period; this initializer never completes itself.
    let initializer = "trap 'printf stopped > /data/stopped; exit 0' TERM; printf ready > /data/ready; while :; do sleep 0.1; done";
    state::write(
        &project.join("compose.yaml"),
        &json!({"services":{
            "deps":{"image":image,"read_only":true,"network_mode":"none","user":"0:0",
                "entrypoint":["/bin/sh","-ec",initializer],"command":[],
                "stop_grace_period":"2s","volumes":["data:/data"]},
            "dependent":{"image":image,"read_only":true,"network_mode":"none","user":"0:0",
                "entrypoint":["/bin/sh","-ec","printf forbidden > /data/dependent"],"command":[],
                "depends_on":{"deps":{"condition":"service_completed_successfully"}},"volumes":["data:/data"]}
        },"volumes":{"data":{}}}),
    )
    .unwrap();
    let review = project::plan(
        candidate,
        project::PlanOptions {
            project: &project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    let selection = fixture.0.join("dependencies.json");
    state::write(&selection, &json!({"version":1,"plan":review.plan_id,
        "artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),"dependencies":[]})).unwrap();
    let dependency = checked_cli(
        "dependency-plan",
        binary,
        candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            selection.to_str().unwrap(),
            "--json",
        ],
        None,
        deadline,
    );
    let mut owner = Process::start(
        binary,
        candidate,
        &[
            "graph",
            "serve",
            "--project",
            project.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &review.plan_id,
            "--run-id",
            &run,
            "--ready",
            "deps=completed",
            "--ready",
            "dependent=completed",
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
        binary,
        candidate,
        run: &run,
        done: false,
    };
    let journal = graph::directory(candidate, &run)
        .unwrap()
        .join("state.json");
    // Do not take Engine::connect: the initializer's foreground owns that lease.
    loop {
        if let Some(status) = owner.poll() {
            report_failure("initializer-start", status, &owner.err);
            panic!("owner exited before initializer start");
        }
        if let Ok(bytes) = fs::read(&journal) {
            if let Ok(receipt) = serde_json::from_slice::<graph::Receipt>(&bytes) {
                assert_eq!(receipt.run, run);
                assert_eq!(receipt.plan_id, review.plan_id);
                let dependent = &receipt.resources["container:dependent"];
                assert!(dependent.id.is_none());
                if receipt.resources["container:deps"].phase == "started" {
                    assert_eq!(dependent.phase, "reserved");
                    break;
                }
            }
        }
        assert!(Instant::now() < deadline, "initializer start deadline");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Allow the trivial shell to install its trap, without claiming readiness
    // from elapsed time. Both marker contents are verified after cancellation.
    std::thread::sleep(Duration::from_millis(500));
    assert!(owner.poll().is_none());
    let signalled = Instant::now();
    // SAFETY: the unreaped Child owns this exact PID; it cannot be recycled.
    assert_eq!(unsafe { libc::kill(owner.child.id() as i32, signal) }, 0);
    let status = owner.wait(deadline.min(Instant::now() + Duration::from_secs(20)));
    let elapsed_ms = signalled.elapsed().as_millis();
    assert_ne!(status.signal(), Some(libc::SIGKILL));
    assert!(!status.success());
    let failure: Value = serde_json::from_slice(&owner.err).unwrap();
    assert_eq!(failure["code"], "graph_cancelled");
    assert!(transport::Pin::load(candidate, &run).is_err());
    let owner_key =
        serde_json::to_vec(&("hack-graph-foreground-v1", &candidate.state_root, &run)).unwrap();
    let owner_hash = format!("{:x}", Sha256::digest(owner_key));
    let owner_root = PathBuf::from(format!("/private/tmp/hkgf-{}", &owner_hash[..24]));
    for name in ["owner.json", "control.sock"] {
        assert_eq!(
            fs::symlink_metadata(owner_root.join(name))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }
    assert!(
        status.code().is_some(),
        "owner must handle the signal and complete cleanup"
    );
    for line in owner
        .out
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
    {
        let value: Value = serde_json::from_slice(line).unwrap();
        assert_ne!(value["kind"], "graph_foreground_ready");
    }
    {
        let engine = graph::Engine::connect_cleanup(candidate).unwrap();
        let (receipt, _) = graph::load(candidate, &engine, &run).unwrap();
        assert_eq!(receipt.phase, "stopped-data-retained");
        let shutdown: Value = state::read(&journal.with_file_name("shutdown.json")).unwrap();
        assert_eq!(shutdown["version"], 1);
        assert_eq!(shutdown["run"], run);
        assert_eq!(shutdown["owner"], receipt.owner);
        assert_eq!(shutdown["plan"], receipt.plan_id);
        let terminal = &shutdown["containers"]["container:deps"];
        assert_eq!(
            terminal["id"].as_str(),
            receipt.resources["container:deps"].id.as_deref()
        );
        assert_eq!(terminal["exit_code"], 0);
        assert_eq!(terminal["oom_killed"], false);
        assert_eq!(terminal["stop_requested"], true);
        let dependent = &receipt.resources["container:dependent"];
        assert!(dependent.id.is_none());
        assert!(matches!(dependent.phase.as_str(), "reserved" | "absent"));
        for resource in receipt
            .resources
            .values()
            .filter(|r| r.kind == graph::Kind::Container)
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
        assert_eq!(engine.guest().execute_cleanup(
            "set -eu; test ! -L \"$1\"; test ! -L \"$1/ready\"; test ! -L \"$1/stopped\"; test \"$(cat \"$1/ready\")\" = ready; test \"$(cat \"$1/stopped\")\" = stopped; test ! -e \"$1/dependent\"; printf preserved",
            &[volume["Mountpoint"].as_str().unwrap()]).unwrap(),"preserved");
    }
    println!(
        "startup-cancellation-retained {}",
        json!({"signal":if signal==libc::SIGTERM {"SIGTERM"} else {"SIGINT"},
            "elapsed_ms":elapsed_ms,"error_code":"graph_cancelled",
            "initializer_exit_code":0,"oom_killed":false,
            "dependent_not_launched":true,"data_preserved":true,
            "owner_absent":true,"containers_absent":true})
    );
    let removed = checked_cli(
        "remove-data",
        binary,
        candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &run,
            "--remove-data",
            "--json",
        ],
        None,
        deadline,
    );
    assert_eq!(removed["phase"], "removed");
    let engine = graph::Engine::connect_cleanup(candidate).unwrap();
    let (receipt, _) = graph::load(candidate, &engine, &run).unwrap();
    for resource in receipt.resources.values() {
        assert!(
            graph::inspect_resource(&engine, &receipt, resource)
                .unwrap()
                .is_none()
        );
    }
    cleanup.done = true;
    json!({"signal":if signal==libc::SIGTERM {"SIGTERM"} else {"SIGINT"},
        "elapsed_ms":elapsed_ms,"error_code":"graph_cancelled","no_forced_kill":true,
        "dependent_not_launched":true,"data_preserved":true,"owner_absent":true,
        "containers_absent":true,"data_removed_after_verification":true})
}

// This fixture has no application credentials. Still never print arbitrary CLI
// stderr: a changed binary must not turn diagnostic failure into value export.
fn safe_code(stderr: &[u8]) -> &'static str {
    let parsed = serde_json::from_slice::<Value>(stderr).ok();
    match parsed.as_ref().and_then(|value| value["code"].as_str()) {
        Some("graph_retained_data") => "graph_retained_data",
        Some("graph_arguments") => "graph_arguments",
        Some("checkout_mismatch") => "checkout_mismatch",
        Some("invalid_candidate_root") => "invalid_candidate_root",
        Some("graph_dependencies") => "graph_dependencies",
        Some("graph_cancelled") => "graph_cancelled",
        Some("graph_receipt") => "graph_receipt",
        Some("graph_owner_recovery") => "graph_owner_recovery",
        Some("graph_foreground_unavailable") => "graph_foreground_unavailable",
        Some("graph_shutdown_uncertain") => "graph_shutdown_uncertain",
        Some("graph_relay_cleanup") => "graph_relay_cleanup",
        Some("graph_relay_enrollment") => "graph_relay_enrollment",
        Some("graph_startup") => "graph_startup",
        Some("graph_cleanup_enrollment") => "graph_cleanup_enrollment",
        Some("provider_busy") => "provider_busy",
        Some("runtime_pressure") => "runtime_pressure",
        Some("runtime_not_running") => "runtime_not_running",
        Some("runtime_changed") => "runtime_changed",
        Some("unaudited_provider_config") => "unaudited_provider_config",
        Some("candidate_root") => "candidate_root",
        Some(_) => "other_code",
        None => "unclassified_stderr",
    }
}

fn report_failure(stage: &'static str, status: ExitStatus, stderr: &[u8]) {
    eprintln!(
        "startup-cancellation-diagnostic {}",
        json!({
            "stage":stage,"code":safe_code(stderr),"exit_code":status.code(),
            "signal":status.signal(),"stderr_bytes":stderr.len()
        })
    );
}

fn checked_cli(
    stage: &'static str,
    binary: &Path,
    candidate: &Candidate,
    args: &[&str],
    input: Option<&[u8]>,
    deadline: Instant,
) -> Value {
    let mut process = Process::start(binary, candidate, args, input);
    let status = process.wait(deadline);
    if !status.success() {
        report_failure(stage, status, &process.err);
        panic!("startup cancellation fixture CLI failed at {stage}");
    }
    serde_json::from_slice(&process.out).expect("fixture CLI returned malformed JSON")
}

#[test]
fn diagnostic_codes_suppress_unreviewed_values() {
    assert_eq!(
        safe_code(br#"{"code":"graph_dependencies","message":"unreviewed-value"}"#),
        "graph_dependencies"
    );
    assert_eq!(safe_code(br#"{"code":"unreviewed-value"}"#), "other_code");
    assert_eq!(safe_code(b"unreviewed-value"), "unclassified_stderr");
}
