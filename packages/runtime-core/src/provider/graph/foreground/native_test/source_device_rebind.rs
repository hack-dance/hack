//! Owned synthetic-device fixture. Only a physical host reboot can qualify
//! original APFS volume continuity for an application; this fixture checks the
//! selected source transition, original receipt/history and retained marker.
use super::absent_publication_recovery::{inspect_args, ready, recover_args, refused_cli};
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;
use crate::provider::{ProjectShareIntent, lifecycle, state::Owner};
use base64::Engine as _;
use std::os::unix::fs::MetadataExt;

fn shared_source_marker(
    binary: &Path,
    candidate: &Candidate,
    run: &str,
    expected: &[u8],
    deadline: Instant,
) {
    let mut process = Process::start(
        binary,
        candidate,
        &[
            "graph",
            "exec",
            "--run-id",
            run,
            "--service",
            "web",
            "--timeout-seconds",
            "12",
            "--json",
            "--",
            "/bin/sh",
            "-ec",
            "cat /app/source-marker.txt",
        ],
        None,
    );
    let status = process.wait(deadline);
    let result: Value = serde_json::from_slice(&process.out).unwrap_or(Value::Null);
    assert!(status.success(), "shared-source exec CLI refused");
    assert_eq!(result["exit_code"], 0, "shared-source process failed");
    assert_eq!(result["truncated"], false);
    let stdout = base64::engine::general_purpose::STANDARD
        .decode(result["stdout_base64"].as_str().unwrap())
        .unwrap();
    let stderr = base64::engine::general_purpose::STANDARD
        .decode(result["stderr_base64"].as_str().unwrap())
        .unwrap();
    assert!(stderr.is_empty());
    assert_eq!(stdout, expected);
}

struct ReplacedBytes {
    path: PathBuf,
    original: Vec<u8>,
    substituted: Vec<u8>,
}
impl ReplacedBytes {
    fn new(path: &Path, bytes: Vec<u8>) -> Self {
        let original = fs::read(path).unwrap();
        fs::write(path, &bytes).unwrap();
        Self {
            path: path.to_owned(),
            original,
            substituted: bytes,
        }
    }
}
impl Drop for ReplacedBytes {
    fn drop(&mut self) {
        if fs::read(&self.path).ok().as_deref() == Some(self.substituted.as_slice()) {
            fs::write(&self.path, &self.original).unwrap();
        }
    }
}

#[test]
#[ignore = "Owned development VM, private synthetic prior-device fault, pinned image and 300s watchdog required"]
fn selected_source_device_rebind_restores_same_run_and_two_ordinary_generations() {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let image_archive = std::env::var("HACK_LOCAL_TEST_IMAGE_ARCHIVE").unwrap();
    let image_sha256 = std::env::var("HACK_LOCAL_TEST_IMAGE_SHA256").unwrap();
    let fixture = graph::tests::Fixture::new();
    let project = fixture.0.join("project");
    fs::create_dir(&project).unwrap();
    state::write(
        &project.join("compose.yaml"),
        &json!({
            "services":{"web":{"image":image,"read_only":true,"network_mode":"none",
                "init":true,"user":"0:0","entrypoint":["/bin/sleep","300"],"command":[],
                "volumes":["data:/data",".:/app:ro"],
                "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","complete"],
                    "interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}}},
            "volumes":{"data":{}}
        }),
    )
    .unwrap();
    let marker_path = project.join("source-marker.txt");
    let initial_marker = b"source-initial\n";
    fs::write(&marker_path, initial_marker).unwrap();
    // This fixture starts an otherwise uninitialized owned pool with one exact
    // approved source root; the external harness supplies the candidate binary.
    assert_eq!(
        lifecycle::status(&candidate).unwrap().phase,
        "uninitialized"
    );
    let share = ProjectShareIntent::approve(&project, true).unwrap();
    lifecycle::up_with_project_share(
        &candidate,
        crate::provider::Profile::Development,
        None,
        None,
        None,
        Some(share.clone()),
    )
    .unwrap();
    checked_cli(
        "load-pinned-image",
        &binary,
        &candidate,
        &[
            "runtime",
            "load-image",
            "--archive",
            &image_archive,
            "--sha256",
            &image_sha256,
            "--image-id",
            &image,
        ],
        deadline,
    );
    let run = graph::probes::token().unwrap();
    let review = project::plan(
        &candidate,
        project::PlanOptions {
            branch: None,
            project: &project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    let normalized = project.join("compose.yaml");
    let dependencies_path = fixture.0.join("dependencies.json");
    state::write(
        &dependencies_path,
        &json!({"version":1,"plan":review.plan_id,
        "artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),
        "dependencies":[]}),
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
            dependencies_path.to_str().unwrap(),
            "--json",
        ],
        deadline,
    );
    let start = |generation: Option<&str>| {
        let mut args = vec![
            "graph",
            if generation.is_some() {
                "serve-restore"
            } else {
                "serve"
            },
            "--project",
            project.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &review.plan_id,
            "--run-id",
            &run,
            "--ready",
            "web=healthy",
            "--timeout-seconds",
            "90",
            "--dependencies",
            dependencies_path.to_str().unwrap(),
            "--expect-dependencies",
            dependency["dependency_plan_id"].as_str().unwrap(),
            "--shared-source",
            "--normalized-file",
            normalized.to_str().unwrap(),
            "--expect-original",
            &review.plan.compose_sha256,
            "--expect-namespace",
            &review.plan.namespace,
            "--json",
        ];
        if let Some(generation) = generation {
            args.extend(["--expect-generation", generation]);
        }
        Process::start(&binary, &candidate, &args, None)
    };
    let mut owner = start(None);
    let mut cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &run,
        done: false,
    };
    ready(&mut owner, &run, deadline);
    shared_source_marker(&binary, &candidate, &run, initial_marker, deadline);
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "write-data", deadline)["exit_code"],
        0
    );
    let ready_receipt = snapshot(&candidate, &run, deadline).receipt;
    let original_volume = ready_receipt.resources["volume:data"].name.clone();
    let original_container = ready_receipt.resources["container:web"].id.clone();
    let old_owner = Owner::load(&candidate).unwrap();
    owner.child.kill().unwrap();
    owner.wait(deadline);
    assert_eq!(lifecycle::down(&candidate).unwrap().phase, "stopped");
    lifecycle::up(&candidate).unwrap();
    let current = Owner::load(&candidate).unwrap();
    assert_eq!(current.project_share.as_ref(), Some(&share));
    let old_device = share.device.checked_add(1).unwrap();
    let boot = lifecycle::host_filesystem::host_boot_micros().unwrap();
    let mut synthetic_owner = old_owner.clone();
    synthetic_owner.storage.as_mut().unwrap().device = old_device;
    synthetic_owner.overlay.as_mut().unwrap().device = old_device;
    synthetic_owner.project_share.as_mut().unwrap().device = old_device;
    synthetic_owner.process.as_mut().unwrap().pid = i32::MAX;
    synthetic_owner.process.as_mut().unwrap().start_micros = boot - 1;
    let old_owner_path = fixture.0.join("prior-owner.json");
    state::write(&old_owner_path, &synthetic_owner).unwrap();
    let old_bytes = fs::read(&old_owner_path).unwrap();
    let pool = fs::symlink_metadata(candidate.state_root.join("run/smolvm")).unwrap();
    let inspection_path = fixture.0.join("prior-inspection.json");
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
    let graph_root = graph::directory(&candidate, &run).unwrap();
    // Test-only host-device fault: a real reboot changes st_dev without
    // rewriting the original graph. This isolated synthetic receipt is fixed
    // before selection and remains byte-for-byte immutable thereafter.
    let mut synthetic_ready = ready_receipt.clone();
    synthetic_ready
        .source
        .as_mut()
        .unwrap()
        .shared
        .as_mut()
        .unwrap()
        .device = old_device;
    state::write(&graph_root.join("state.json"), &synthetic_ready).unwrap();
    let original_ready_bytes = fs::read(graph_root.join("state.json")).unwrap();
    let publisher_root = transport::root(&candidate, &run).unwrap();
    fs::remove_dir_all(&publisher_root).unwrap();
    fs::remove_dir_all(
        synthetic_ready
            .relay_startup
            .as_ref()
            .unwrap()
            .control_root
            .clone(),
    )
    .unwrap();
    let prior = inspection_path.to_str().unwrap();
    let old = old_owner_path.to_str().unwrap();
    let absent_selection = checked_cli(
        "select-absence",
        &binary,
        &candidate,
        &inspect_args(&run, old, prior),
        deadline,
    );
    let absent_hash = absent_selection["selection_sha256"].as_str().unwrap();
    let stopped = checked_cli(
        "recover-absence",
        &binary,
        &candidate,
        &recover_args(&run, old, prior, absent_hash),
        deadline,
    );
    assert_eq!(stopped["phase"], "stopped-data-retained");
    let original_stopped_bytes = fs::read(graph_root.join("state.json")).unwrap();
    let original_stopped: graph::Receipt = serde_json::from_slice(&original_stopped_bytes).unwrap();
    assert_eq!(
        original_stopped
            .source
            .as_ref()
            .unwrap()
            .shared
            .as_ref()
            .unwrap()
            .device,
        old_device
    );
    let original_history_hash = format!("{:x}", Sha256::digest(&original_stopped_bytes));
    let witness_path = graph_root.join("source-device-rebind.json");
    let inspect = checked_cli(
        "select-source",
        &binary,
        &candidate,
        &[
            "graph",
            "inspect-source-device-rebind",
            "--run-id",
            &run,
            "--json",
        ],
        deadline,
    );
    let witness_hash = inspect["selection_sha256"].as_str().unwrap();
    refused_cli(
        &binary,
        &candidate,
        &[
            "graph",
            "recover-source-device-rebind",
            "--run-id",
            &run,
            "--expect-selection",
            &"0".repeat(64),
            "--accept-legacy-device-rebind",
            "--json",
        ],
        "graph_source_device_rebind",
        deadline,
    );
    assert!(!witness_path.exists());
    let pending = witness_path.with_extension("pending");
    fs::write(&pending, b"foreign incomplete witness").unwrap();
    refused_cli(
        &binary,
        &candidate,
        &[
            "graph",
            "recover-source-device-rebind",
            "--run-id",
            &run,
            "--expect-selection",
            witness_hash,
            "--accept-legacy-device-rebind",
            "--json",
        ],
        "graph_source_device_rebind",
        deadline,
    );
    assert_eq!(fs::read(&pending).unwrap(), b"foreign incomplete witness");
    fs::remove_file(&pending).unwrap(); // Only this fixture's known pending file.
    checked_cli(
        "commit-source",
        &binary,
        &candidate,
        &[
            "graph",
            "recover-source-device-rebind",
            "--run-id",
            &run,
            "--expect-selection",
            witness_hash,
            "--accept-legacy-device-rebind",
            "--json",
        ],
        deadline,
    );
    assert_eq!(
        fs::read(graph_root.join("state.json")).unwrap(),
        original_stopped_bytes
    );
    let committed_bytes = fs::read(&witness_path).unwrap();
    {
        let mut changed = committed_bytes.clone();
        changed.push(b' ');
        let _changed = ReplacedBytes::new(&witness_path, changed);
        refused_cli(
            &binary,
            &candidate,
            &["graph", "restore-selection", "--run-id", &run, "--json"],
            "graph_source_device_rebind",
            deadline,
        );
    }
    {
        let _changed = ReplacedBytes::new(
            &witness_path,
            graph::source_device_rebind::fixture_wrong_volume_projection(&committed_bytes),
        );
        refused_cli(
            &binary,
            &candidate,
            &["graph", "restore-selection", "--run-id", &run, "--json"],
            "graph_source_device_rebind",
            deadline,
        );
    }
    assert_eq!(fs::read(&witness_path).unwrap(), committed_bytes);
    let selection = checked_cli(
        "restore-selection-source",
        &binary,
        &candidate,
        &["graph", "restore-selection", "--run-id", &run, "--json"],
        deadline,
    );
    let selected_generation = selection["generation"].as_str().unwrap();
    fs::write(&pending, b"appeared after selection").unwrap();
    let mut blocked = start(Some(selected_generation));
    assert_eq!(blocked.wait(deadline).code(), Some(2));
    assert!(blocked.out.is_empty());
    let refusal: Value = serde_json::from_slice(&blocked.err).unwrap();
    assert_eq!(refusal["code"], "graph_source_device_rebind");
    assert_eq!(fs::read(&pending).unwrap(), b"appeared after selection");
    assert!(!publisher_root.join("control.sock").exists());
    assert!(!publisher_root.join("owner.json").exists());
    fs::remove_file(&pending).unwrap(); // The fixture owns this exact pending file.
    owner = start(Some(selected_generation));
    ready(&mut owner, &run, deadline);
    shared_source_marker(&binary, &candidate, &run, initial_marker, deadline);
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "read-data", deadline)["exit_code"],
        0
    );
    let restored = snapshot(&candidate, &run, deadline).receipt;
    assert_eq!(restored.resources["volume:data"].name, original_volume);
    assert_ne!(restored.resources["container:web"].id, original_container);
    assert_eq!(
        restored
            .source
            .as_ref()
            .unwrap()
            .shared
            .as_ref()
            .unwrap()
            .device,
        share.device
    );
    assert!(fs::read(graph_root.join("restore-history.json")).is_ok());
    assert_eq!(fs::read(&witness_path).unwrap(), committed_bytes);
    assert_eq!(
        fs::read(graph_root.join("state.json")).unwrap(),
        serde_json::to_vec_pretty(&restored).unwrap()
    );
    assert!(
        graph::restore_history::completed_for_recovery(
            &graph_root,
            &restored,
            &original_history_hash
        )
        .unwrap()
        .is_some()
    );
    assert_ne!(
        fs::read(graph_root.join("state.json")).unwrap(),
        original_ready_bytes
    );
    // The selected witness is now historical. Each later cleanup/restore takes
    // an ordinary generation and reads the same named retained data.
    for generation in 0..2 {
        let cleaned = checked_cli(
            "ordinary-cleanup",
            &binary,
            &candidate,
            &["graph", "cleanup", "--run-id", &run, "--json"],
            deadline,
        );
        assert_eq!(cleaned["phase"], "stopped-data-retained");
        assert!(owner.wait(deadline).success());
        let next = checked_cli(
            "ordinary-selection",
            &binary,
            &candidate,
            &["graph", "restore-selection", "--run-id", &run, "--json"],
            deadline,
        );
        owner = start(Some(next["generation"].as_str().unwrap()));
        ready(&mut owner, &run, deadline);
        shared_source_marker(&binary, &candidate, &run, initial_marker, deadline);
        assert_eq!(
            exec(&binary, &candidate, &run, "web", "read-data", deadline)["exit_code"],
            0
        );
        let observed = snapshot(&candidate, &run, deadline).receipt;
        assert_eq!(
            observed.resources["volume:data"].name, original_volume,
            "ordinary generation {generation}"
        );
        assert_eq!(
            observed
                .source
                .as_ref()
                .unwrap()
                .shared
                .as_ref()
                .unwrap()
                .device,
            share.device
        );
    }
    // A source edit changes the reviewed plan's metadata identity even if its
    // bytes are changed back. Prove the live share after all pinned-plan restores.
    fs::write(&marker_path, b"source-host-edit\n").unwrap();
    shared_source_marker(&binary, &candidate, &run, b"source-host-edit\n", deadline);
    let removed = checked_cli(
        "remove-selected-data",
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
    assert!(owner.wait(deadline).success());
    cleanup.done = true;
}
