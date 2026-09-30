//! Owned capacity-two VM qualification for absent post-host-reboot publication.
//! The host reboot evidence is explicitly simulated in this isolated fixture;
//! this does not prove physical-volume continuity on a real reboot.
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;
use crate::provider::{lifecycle, state::Owner};
use std::os::unix::fs::MetadataExt;

fn ready(owner: &mut Process, run: &str, deadline: Instant) {
    loop {
        assert!(
            owner.poll().is_none(),
            "foreground owner exited before ready"
        );
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

fn refused_cli(
    binary: &Path,
    candidate: &Candidate,
    args: &[&str],
    expected_code: &str,
    deadline: Instant,
) {
    let mut process = Process::start(binary, candidate, args, None);
    let status = process.wait(deadline);
    assert_eq!(
        status.code(),
        Some(2),
        "expected a CLI refusal, not a crash"
    );
    assert!(process.out.is_empty(), "refusal emitted a result");
    let error: Value = serde_json::from_slice(&process.err).expect("structured CLI error");
    assert_eq!(error["code"], expected_code);
}

fn inspect_args<'a>(run: &'a str, old: &'a str, prior: &'a str) -> [&'a str; 9] {
    [
        "graph",
        "inspect-absent-publication-cleanup",
        "--run-id",
        run,
        "--original-owner-file",
        old,
        "--host-inspection-file",
        prior,
        "--json",
    ]
}
fn recover_args<'a>(run: &'a str, old: &'a str, prior: &'a str, hash: &'a str) -> [&'a str; 13] {
    [
        "graph",
        "recover-absent-publication-cleanup",
        "--run-id",
        run,
        "--original-owner-file",
        old,
        "--host-inspection-file",
        prior,
        "--expect-selection",
        hash,
        "--retain-data",
        "--accept-unpinned-post-reboot",
        "--json",
    ]
}

/// Scoped fixture file mutation restores only bytes it wrote, including on a
/// panic. It never replaces managed provider or graph state.
struct PrivateBytes<'a> {
    path: &'a Path,
    original: Vec<u8>,
    substituted: Vec<u8>,
}
impl<'a> PrivateBytes<'a> {
    fn replace(path: &'a Path, substituted: Vec<u8>) -> Self {
        let original = fs::read(path).unwrap();
        fs::write(path, &substituted).unwrap();
        Self {
            path,
            original,
            substituted,
        }
    }
}
impl Drop for PrivateBytes<'_> {
    fn drop(&mut self) {
        if fs::read(self.path).ok().as_deref() == Some(self.substituted.as_slice()) {
            fs::write(self.path, &self.original).unwrap();
        }
    }
}

struct Moved {
    original: PathBuf,
    moved: PathBuf,
}
impl Moved {
    fn new(original: PathBuf) -> Self {
        let moved = original.with_extension("absent-fixture-held");
        assert!(!moved.exists());
        fs::rename(&original, &moved).unwrap();
        Self { original, moved }
    }
}
impl Drop for Moved {
    fn drop(&mut self) {
        if self.moved.exists() {
            assert!(
                !self.original.exists(),
                "foreign path replaced selected fixture"
            );
            fs::rename(&self.moved, &self.original).unwrap();
        }
    }
}

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
#[ignore = "Only the parent owned VM fixture starts this exact fault helper"]
fn absent_publication_after_bridge_fault_child() {
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    graph::absent_publication_cleanup::recover(
        &candidate,
        &std::env::var("HACK_LOCAL_GRAPH_RUN").unwrap(),
        &std::env::var("HACK_LOCAL_GRAPH_SELECTION").unwrap(),
        Path::new(&std::env::var("HACK_LOCAL_GRAPH_OLD_OWNER").unwrap()),
        Path::new(&std::env::var("HACK_LOCAL_GRAPH_INSPECTION").unwrap()),
    )
    .unwrap();
}

#[test]
#[ignore = "Owned capacity-two native VM, pinned image and external 300s watchdog required"]
fn explicit_absent_publication_cleanup_retains_selected_volume_and_sibling() {
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
    let private = graph::tests::Fixture::new();
    let mut plans = Vec::new();
    let mut selections = Vec::new();
    let mut dependencies = Vec::new();
    for (index, fixture) in fixtures.iter().enumerate() {
        state::write(&fixture.0.join("compose.yaml"), &json!({
            "services":{"web":{"image":image,"read_only":true,"network_mode":"none",
                "init":true,"user":"0:0","entrypoint":["/bin/sleep","300"],"command":[],
                "volumes":["data:/data"],"healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","complete"],
                    "interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}}},
            "volumes":{"data":{}}
        })).unwrap();
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
        let selection = private.0.join(format!("dependencies-{index}.json"));
        state::write(&selection, &json!({"version":1,"plan":review.plan_id,
            "artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),"dependencies":[]})).unwrap();
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
    let original = snapshot(&candidate, &runs[0], deadline).receipt;
    assert_eq!(original.phase, "ready-observed");
    let old_owner = Owner::load(&candidate).unwrap();
    let old_boot = old_owner.guest_boot_id.clone().unwrap();
    selected_owner.child.kill().unwrap();
    selected_owner.wait(deadline);
    assert_eq!(lifecycle::down(&candidate).unwrap().phase, "stopped");
    let new_boot = lifecycle::up(&candidate).unwrap().guest_boot_id.unwrap();
    assert_ne!(old_boot, new_boot);

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
    let sibling = serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap();

    let current = Owner::load(&candidate).unwrap();
    let boot = lifecycle::host_filesystem::host_boot_micros().unwrap();
    let new_device = current.storage.as_ref().unwrap().device;
    let old_device = new_device.checked_add(1).unwrap();
    let mut synthetic = old_owner.clone();
    synthetic.storage.as_mut().unwrap().device = old_device;
    synthetic.overlay.as_mut().unwrap().device = old_device;
    if let Some(share) = synthetic.project_share.as_mut() {
        share.device = old_device;
    }
    let prior_process = synthetic.process.as_mut().unwrap();
    prior_process.pid = i32::MAX;
    prior_process.start_micros = boot - 1;
    let old_path = private.0.join("pre-host-boot-owner.json");
    state::write(&old_path, &synthetic).unwrap();
    let old_bytes = fs::read(&old_path).unwrap();
    let pool = fs::symlink_metadata(candidate.state_root.join("run/smolvm")).unwrap();
    let inspection_path = private.0.join("pre-migration-inspection.json");
    state::write(
        &inspection_path,
        &serde_json::from_slice::<Value>(&graph::absent_publication_cleanup::fixture_inspection(
            &old_bytes,
            &current,
            old_device,
            boot,
            pool.ino(),
        ))
        .unwrap(),
    )
    .unwrap();
    let graph_root = graph::directory(&candidate, &runs[0]).unwrap();
    let raw_graph = fs::read(graph_root.join("state.json")).unwrap();
    let publisher_root = transport::root(&candidate, &runs[0]).unwrap();
    let control_root = original
        .relay_startup
        .as_ref()
        .unwrap()
        .control_root
        .clone();
    assert!(publisher_root.exists() && control_root.exists());
    fs::remove_dir_all(&publisher_root).unwrap();
    fs::remove_dir_all(&control_root).unwrap();

    let old = old_path.to_str().unwrap();
    let prior = inspection_path.to_str().unwrap();
    let initial = checked_cli(
        "inspect-absent-publications",
        &binary,
        &candidate,
        &inspect_args(&runs[0], old, prior),
        deadline,
    );
    let selection = initial["selection_sha256"].as_str().unwrap();
    assert_eq!(selection.len(), 64);
    let intent_path = graph_root.join("absent-publication-cleanup.json");
    refused_cli(
        &binary,
        &candidate,
        &recover_args(&runs[0], old, prior, &"0".repeat(64)),
        "graph_absent_publication_recovery",
        deadline,
    );
    assert!(!intent_path.exists());
    assert_eq!(fs::read(graph_root.join("state.json")).unwrap(), raw_graph);
    let refreshed = checked_cli(
        "inspect-after-stale-selection",
        &binary,
        &candidate,
        &inspect_args(&runs[0], old, prior),
        deadline,
    );
    assert_eq!(refreshed["selection_sha256"], selection);
    {
        let mut whitespace = old_bytes.clone();
        whitespace.push(b' ');
        let _changed = PrivateBytes::replace(&old_path, whitespace);
        refused_cli(
            &binary,
            &candidate,
            &recover_args(&runs[0], old, prior, selection),
            "graph_absent_publication_recovery",
            deadline,
        );
        assert!(!intent_path.exists());
    }
    {
        let _missing = Moved::new(inspection_path.clone());
        refused_cli(
            &binary,
            &candidate,
            &recover_args(&runs[0], old, prior, selection),
            "graph_absent_publication_recovery",
            deadline,
        );
        assert!(!intent_path.exists());
    }
    {
        let state_path = graph_root.join("state.json");
        let mut changed = raw_graph.clone();
        changed.push(b' ');
        let _changed = PrivateBytes::replace(&state_path, changed);
        refused_cli(
            &binary,
            &candidate,
            &recover_args(&runs[0], old, prior, selection),
            "graph_absent_publication_recovery",
            deadline,
        );
        assert!(!intent_path.exists());
    }
    {
        let lock = publisher_root.join("operation.lock");
        let _original = Moved::new(lock.clone());
        fs::write(&lock, b"substituted lock path").unwrap();
        refused_cli(
            &binary,
            &candidate,
            &recover_args(&runs[0], old, prior, selection),
            "graph_absent_publication_recovery",
            deadline,
        );
        assert!(!intent_path.exists());
        fs::remove_file(&lock).unwrap();
    }
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact",
            "provider::graph::foreground::native_test::absent_publication_recovery::absent_publication_after_bridge_fault_child"])
        .env("HACK_LOCAL_TEST_ROOT", std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())
        .env("HACK_LOCAL_GRAPH_RUN", &runs[0])
        .env("HACK_LOCAL_GRAPH_SELECTION", selection)
        .env("HACK_LOCAL_GRAPH_OLD_OWNER", old)
        .env("HACK_LOCAL_GRAPH_INSPECTION", prior)
        .env("HACK_LOCAL_GRAPH_FAULT", "absent-after-bridge-release")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap();
    let mut fault = FaultChild(Some(child));
    let marker = graph_root.join("fault-absent-after-bridge-release.json");
    let fault_deadline = Instant::now() + Duration::from_secs(25);
    while !marker.exists() {
        assert!(
            fault.0.as_mut().unwrap().try_wait().unwrap().is_none(),
            "fault child exited before selected boundary"
        );
        assert!(
            Instant::now() < fault_deadline,
            "selected fault boundary deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(state::read::<Value>(&marker).unwrap()["run"], runs[0]);
    assert!(
        intent_path.exists(),
        "absence intent was durable before bridge release"
    );
    assert_eq!(
        state::read::<graph::Receipt>(&graph_root.join("state.json"))
            .unwrap()
            .phase,
        "cleanup-intent",
        "graph intent was durable before bridge release"
    );
    assert!(
        graph::absent_publication_cleanup::publication_allowed(&candidate, &runs[0], false)
            .is_err()
    );
    assert!(
        graph::absent_publication_cleanup::publication_allowed(&candidate, &runs[0], true).is_err()
    );
    fault.0.as_mut().unwrap().kill().unwrap();
    fault.0.as_mut().unwrap().wait().unwrap();
    fault.0 = None;
    let result = checked_cli(
        "recover-absent-publications",
        &binary,
        &candidate,
        &recover_args(&runs[0], old, prior, selection),
        deadline,
    );
    assert_eq!(result["phase"], "stopped-data-retained");
    assert_eq!(result["publisher_retired"], true);
    let stopped = snapshot(&candidate, &runs[0], deadline).receipt;
    assert_eq!(
        stopped.resources["volume:data"].name,
        original.resources["volume:data"].name
    );
    let repeated = checked_cli(
        "idempotent-absent-retirement",
        &binary,
        &candidate,
        &recover_args(&runs[0], old, prior, selection),
        deadline,
    );
    assert_eq!(repeated["publisher_retired"], true);
    assert!(sibling_owner.poll().is_none());
    assert_eq!(
        serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap(),
        sibling
    );
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "read-data", deadline)["exit_code"],
        0
    );

    // Keep the selected retained volume for the later source-continuity
    // fixture. The external harness tears down this isolated test pool.
    selected_cleanup.done = true;
    let removed = checked_cli(
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
    assert_eq!(removed["phase"], "removed");
    assert!(sibling_owner.wait(deadline).success());
    sibling_cleanup.done = true;
}
