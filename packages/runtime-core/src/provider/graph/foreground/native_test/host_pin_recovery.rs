//! Real CLI path for explicitly witnessed legacy host-pin cleanup. An isolated
//! test VM supplies the guest; only fixture receipt device numbers are changed.
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;
use std::{
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

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

fn legacy_pin(path: &Path, old: u64, before_boot: u64, control: bool) -> Vec<u8> {
    let mut value: Value = state::read(path).unwrap();
    for key in if control {
        ["parent", "endpoint"]
    } else {
        ["parent", "socket"]
    } {
        let pair = value[key].as_array_mut().unwrap();
        assert_ne!(pair[0].as_u64().unwrap(), old);
        pair[0] = json!(old);
    }
    // This is a synthetic previous-physical-boot receipt. The actual owner
    // exited before the test changes its private fixture bytes.
    value["process"]["pid"] = json!(i32::MAX);
    value["process"]["start_micros"] = json!(before_boot - 1);
    state::write(path, &value).unwrap();
    fs::read(path).unwrap()
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
    assert!(process.out.is_empty(), "refused action emitted a result");
    let error: Value = serde_json::from_slice(&process.err).expect("structured CLI error");
    assert_eq!(error["code"], expected_code);
    assert!(error["message"].as_str().is_some_and(|v| !v.is_empty()));
}

fn publish_args<'a>(run: &'a str, expected: &'a str) -> [&'a str; 8] {
    [
        "graph",
        "recover-host-pins",
        "--run-id",
        run,
        "--expect-selection",
        expected,
        "--accept-legacy-device-rebind",
        "--json",
    ]
}

struct TemporarilyMoved {
    original: PathBuf,
    moved: PathBuf,
}
impl TemporarilyMoved {
    fn new(original: PathBuf) -> Self {
        let moved = original.with_extension("host-pin-test-held");
        assert!(!moved.exists());
        fs::rename(&original, &moved).unwrap();
        Self { original, moved }
    }
}
impl Drop for TemporarilyMoved {
    fn drop(&mut self) {
        if self.moved.exists() {
            assert!(!self.original.exists(), "foreign replacement at held path");
            fs::rename(&self.moved, &self.original).unwrap();
        }
    }
}

/// Preserve exact pre-mutation bytes outside managed state. A killed test can
/// be recovered from this private fixture artifact; normal unwinding restores
/// only the bytes this test itself wrote, never a foreign replacement.
struct ProviderReceiptRestore {
    path: PathBuf,
    original: Vec<u8>,
    current: Vec<u8>,
}
impl ProviderReceiptRestore {
    fn new(candidate: &Candidate, path: PathBuf) -> Self {
        let original = fs::read(&path).unwrap();
        let backup = candidate
            .checkout
            .join("host-pin-test-provider-owner-original.json");
        let mut artifact = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&backup)
            .unwrap();
        artifact.write_all(&original).unwrap();
        artifact.sync_all().unwrap();
        fs::File::open(&candidate.checkout)
            .unwrap()
            .sync_all()
            .unwrap();
        Self {
            path,
            current: original.clone(),
            original,
        }
    }
    fn replace(&mut self, bytes: Vec<u8>) {
        assert_eq!(fs::read(&self.path).unwrap(), self.current);
        fs::write(&self.path, &bytes).unwrap();
        self.current = bytes;
    }
    fn restore(&mut self) {
        assert_eq!(fs::read(&self.path).unwrap(), self.current);
        fs::write(&self.path, &self.original).unwrap();
        assert_eq!(fs::read(&self.path).unwrap(), self.original);
        self.current = self.original.clone();
    }
}
impl Drop for ProviderReceiptRestore {
    fn drop(&mut self) {
        if self.current != self.original
            && fs::read(&self.path).ok().as_deref() == Some(self.current.as_slice())
        {
            let _ = fs::write(&self.path, &self.original);
        }
    }
}

#[test]
#[ignore = "Owned capacity-two native VM, pinned static image and external 300s watchdog required"]
fn explicit_host_pin_witness_recovers_only_selected_previous_boot_run() {
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
        let selection = selection_root.0.join(format!("dependencies-{index}.json"));
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
        ];
        if let Some(generation) = generation {
            args.extend(["--expect-generation", generation]);
        }
        Process::start(&binary, &candidate, &args, None)
    };
    let mut selected_owner = start(0, None);
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
    let expected_receipt = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(&original).unwrap())
    );
    let old_boot = crate::provider::lifecycle::status(&candidate)
        .unwrap()
        .guest_boot_id
        .unwrap();
    selected_owner.child.kill().unwrap();
    selected_owner.wait(deadline);
    assert_eq!(
        crate::provider::lifecycle::down(&candidate).unwrap().phase,
        "stopped"
    );
    let new_boot = crate::provider::lifecycle::up(&candidate)
        .unwrap()
        .guest_boot_id
        .unwrap();
    assert_ne!(old_boot, new_boot);

    let mut sibling_owner = start(1, None);
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

    let root = graph::directory(&candidate, &runs[0]).unwrap();
    let graph_bytes = fs::read(root.join("state.json")).unwrap();
    let startup = original.relay_startup.as_ref().unwrap();
    let publisher_root = transport::root(&candidate, &runs[0]).unwrap();
    let publisher = publisher_root.join("owner.json");
    let control = startup.control_root.join("relay-control/owner.json");
    let current = fs::symlink_metadata(&publisher_root).unwrap().dev();
    let old = current.checked_add(1).unwrap();
    let before_boot = crate::provider::lifecycle::host_filesystem::host_boot_micros().unwrap();
    let publisher_bytes = legacy_pin(&publisher, old, before_boot, false);
    let control_bytes = legacy_pin(&control, old, before_boot, true);

    // Ordinary recovery remains strict; the new witness is required to use
    // the legacy device-only pins and is scoped to the selected run.
    assert!(graph::foreground::transport::Pin::load(&candidate, &runs[0]).is_err());
    let inspected = checked_cli(
        "inspect-host-pins",
        &binary,
        &candidate,
        &[
            "graph",
            "inspect-host-pin-recovery",
            "--run-id",
            &runs[0],
            "--json",
        ],
        deadline,
    );
    let selection = inspected["selection_sha256"].as_str().unwrap();
    assert_eq!(selection.len(), 64);
    assert_eq!(inspected["old_device"], old);
    assert_eq!(inspected["new_device"], current);
    assert_eq!(fs::read(root.join("state.json")).unwrap(), graph_bytes);
    assert_eq!(fs::read(&publisher).unwrap(), publisher_bytes);
    assert_eq!(fs::read(&control).unwrap(), control_bytes);

    let witness_path = root.join("host-pin-recovery.json");
    let inspect_args = [
        "graph",
        "inspect-host-pin-recovery",
        "--run-id",
        &runs[0],
        "--json",
    ];
    // A stale selection must not publish a witness or rewrite any source
    // receipt. The three temporary path removals also preserve exact bytes.
    refused_cli(
        &binary,
        &candidate,
        &publish_args(&runs[0], &"0".repeat(64)),
        "graph_host_pin_recovery",
        deadline,
    );
    assert!(!witness_path.exists());
    assert_eq!(fs::read(root.join("state.json")).unwrap(), graph_bytes);
    assert_eq!(fs::read(&publisher).unwrap(), publisher_bytes);
    assert_eq!(fs::read(&control).unwrap(), control_bytes);
    {
        let _missing = TemporarilyMoved::new(publisher_root.clone());
        refused_cli(
            &binary,
            &candidate,
            &inspect_args,
            "provider_state",
            deadline,
        );
        assert!(!witness_path.exists());
    }
    assert_eq!(fs::read(&publisher).unwrap(), publisher_bytes);
    {
        let _missing = TemporarilyMoved::new(startup.control_root.join("relay-control"));
        refused_cli(
            &binary,
            &candidate,
            &inspect_args,
            "provider_state",
            deadline,
        );
        assert!(!witness_path.exists());
    }
    assert_eq!(fs::read(&control).unwrap(), control_bytes);

    // The provider receipt is valid JSON throughout. A changed raw byte
    // selection and a changed guest boot must both refuse without writes.
    let provider_path = candidate.state_root.join("run/smolvm/owner.json");
    let mut owner_restore = ProviderReceiptRestore::new(&candidate, provider_path.clone());
    let provider_bytes = owner_restore.original.clone();
    let mut whitespace = provider_bytes.clone();
    whitespace.push(b' ');
    owner_restore.replace(whitespace.clone());
    refused_cli(
        &binary,
        &candidate,
        &publish_args(&runs[0], selection),
        "graph_host_pin_recovery",
        deadline,
    );
    assert_eq!(fs::read(&provider_path).unwrap(), whitespace);
    assert!(!witness_path.exists());
    owner_restore.restore();
    let mut changed_boot: Value = serde_json::from_slice(&provider_bytes).unwrap();
    changed_boot["guest_boot_id"] = json!("f".repeat(32));
    assert_ne!(changed_boot["guest_boot_id"], new_boot);
    owner_restore.replace(serde_json::to_vec_pretty(&changed_boot).unwrap());
    let boot_bytes = fs::read(&provider_path).unwrap();
    refused_cli(
        &binary,
        &candidate,
        &inspect_args,
        "graph_host_pin_recovery",
        deadline,
    );
    assert_eq!(fs::read(&provider_path).unwrap(), boot_bytes);
    assert!(!witness_path.exists());
    owner_restore.restore();
    assert_eq!(fs::read(root.join("state.json")).unwrap(), graph_bytes);
    assert_eq!(fs::read(&publisher).unwrap(), publisher_bytes);
    assert_eq!(fs::read(&control).unwrap(), control_bytes);

    let refreshed = checked_cli(
        "inspect-after-negative-controls",
        &binary,
        &candidate,
        &inspect_args,
        deadline,
    );
    let selection = refreshed["selection_sha256"].as_str().unwrap();
    let recovered = checked_cli(
        "publish-host-pin-witness",
        &binary,
        &candidate,
        &publish_args(&runs[0], selection),
        deadline,
    );
    assert_eq!(recovered["witness_published"], true);
    assert_eq!(fs::read(root.join("state.json")).unwrap(), graph_bytes);
    assert_eq!(fs::read(&publisher).unwrap(), publisher_bytes);
    assert_eq!(fs::read(&control).unwrap(), control_bytes);
    assert_eq!(
        serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap(),
        sibling
    );

    let cleanup = checked_cli(
        "legacy-dead-owner-cleanup",
        &binary,
        &candidate,
        &[
            "graph",
            "recover-cleanup",
            "--run-id",
            &runs[0],
            "--expect-receipt",
            &expected_receipt,
            "--json",
        ],
        deadline,
    );
    assert_eq!(cleanup["phase"], "stopped-data-retained");
    let retained = snapshot(&candidate, &runs[0], deadline).receipt;
    assert_eq!(
        retained.resources["volume:data"].name,
        original.resources["volume:data"].name
    );
    for _ in 0..2 {
        let retired = checked_cli(
            "legacy-publisher-retirement",
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
    let restoration = graph::foreground::restore_selection(&candidate, &runs[0]).unwrap();
    selected_owner = start(0, Some(restoration["generation"].as_str().unwrap()));
    ready(&mut selected_owner, &runs[0], deadline);
    assert_eq!(
        exec(&binary, &candidate, &runs[0], "web", "read-data", deadline)["exit_code"],
        0,
        "selected marker must survive cleanup, retirement and same-run restore"
    );
    let restored = snapshot(&candidate, &runs[0], deadline).receipt;
    assert_eq!(
        restored.resources["volume:data"].name,
        original.resources["volume:data"].name
    );
    assert_ne!(
        restored.resources["container:web"].id,
        original.resources["container:web"].id
    );
    assert!(sibling_owner.poll().is_none());
    assert_eq!(
        serde_json::to_vec(&snapshot(&candidate, &runs[1], deadline).receipt).unwrap(),
        sibling
    );
    assert_eq!(
        exec(&binary, &candidate, &runs[1], "web", "read-data", deadline)["exit_code"],
        0
    );
    let selected_removed = checked_cli(
        "remove-selected-data",
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
    assert_eq!(selected_removed["phase"], "removed");
    assert!(selected_owner.wait(deadline).success());
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
