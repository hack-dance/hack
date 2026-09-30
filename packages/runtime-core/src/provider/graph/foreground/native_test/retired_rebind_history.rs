//! Cross-version owned regression for the historical dependency-rebind journal.
//! A pinned pre-archive binary creates the previously admitted state; this
//! source resumes its exact completed proof without fabricating a journal.
use super::absent_publication_recovery::{inspect_args, ready, recover_args};
use super::dependency_rebind::{checked_cli, exec, snapshot};
use super::*;
use crate::provider::{graph::startup::native_test::RestartableBackend, lifecycle, state::Owner};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;

fn file_hash(path: &Path) -> String {
    let mut file = fs::File::open(path).unwrap();
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let count = file.read(&mut bytes).unwrap();
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    format!("{:x}", digest.finalize())
}

fn selection(
    path: &Path,
    plan: &str,
    artifact: &Path,
    artifact_hash: &str,
    endpoint: &crate::provider::host_endpoint::HostEndpoint,
    port: u16,
) {
    let bindings = ["web", "init"].map(|service| {
        json!({"service":service,"binding":"default","slot":0,"guest_port":25252,
            "host_pid":endpoint.process_identity().pid,"host_port":port,
            "host_executable":std::env::current_exe().unwrap()})
    });
    state::write(
        path,
        &json!({"version":1,"plan":plan,"artifact":artifact,
        "artifact_sha256":artifact_hash,"dependencies":bindings}),
    )
    .unwrap();
}

#[test]
#[ignore = "Owned capacity-two VM, pinned prior/current binaries, image and relay artifact, external 300s watchdog required"]
fn completed_prior_boot_rebind_archives_after_newer_stopped_generation() {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let binary = PathBuf::from(std::env::var("HACK_LOCAL_TEST_BINARY").unwrap());
    let legacy = PathBuf::from(std::env::var("HACK_LOCAL_TEST_LEGACY_BINARY").unwrap());
    let legacy_hash = std::env::var("HACK_LOCAL_TEST_LEGACY_SHA256").unwrap();
    assert_eq!(legacy_hash.len(), 64);
    assert_eq!(
        file_hash(&legacy),
        legacy_hash,
        "prior binary bytes changed"
    );
    assert_ne!(
        file_hash(&binary),
        legacy_hash,
        "historical setup used current binary"
    );
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    let artifact = PathBuf::from(std::env::var("HACK_GRAPH_RELAY_ARTIFACT").unwrap());
    let artifact_hash = std::env::var("HACK_GRAPH_RELAY_SHA256").unwrap();
    assert_eq!(file_hash(&artifact), artifact_hash);
    let selected = graph::tests::Fixture::new();
    let sibling = graph::tests::Fixture::new();
    let private = graph::tests::Fixture::new();
    state::write(
        &selected.0.join("compose.yaml"),
        &json!({
            "services":{
                "web":{"image":image,"read_only":true,"init":true,"user":"0:0",
                    "entrypoint":["/bin/sh","-ec", "printf ready > /data/index.html; exec /bin/busybox httpd -f -p 3000 -h /data"],
                    "command":[],"volumes":["data:/data"],"networks":["private"],
                    "healthcheck":{"x-hack-http":{"port":3000,"path":"/","interval_ms":100,
                        "timeout_ms":500,"retries":20,"start_period_ms":0}}},
                "init":{"image":image,"read_only":true,"network_mode":"none","init":true,
                    "user":"0:0","entrypoint":["/bin/hack-graph-startup-app","complete"],
                    "command":[]}
            },"networks":{"private":{"internal":true}},"volumes":{"data":{}}
        }),
    )
    .unwrap();
    state::write(
        &sibling.0.join("compose.yaml"),
        &json!({
            "services":{"web":{"image":image,"read_only":true,"network_mode":"none",
                "init":true,"user":"0:0","entrypoint":["/bin/sleep","300"],"command":[],
                "volumes":["data:/data"],"healthcheck":{"test":["CMD",
                    "/bin/hack-graph-startup-app","complete"],"interval":"200ms",
                    "timeout":"2s","retries":10,"start_period":"500ms"}}},
            "volumes":{"data":{}}
        }),
    )
    .unwrap();
    let selected_plan = project::plan(
        &candidate,
        project::PlanOptions {
            branch: None,
            project: &selected.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    let sibling_plan = project::plan(
        &candidate,
        project::PlanOptions {
            branch: None,
            project: &sibling.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    let run = graph::probes::token().unwrap();
    let sibling_run = graph::probes::token().unwrap();
    let selected_dependencies = private.0.join("selected-dependencies.json");
    let sibling_dependencies = private.0.join("sibling-dependencies.json");
    let selected_compose = selected.0.join("compose.yaml");
    state::write(
        &sibling_dependencies,
        &json!({"version":1,"plan":sibling_plan.plan_id,
        "artifact":"/tmp/unused-control-only-artifact","artifact_sha256":"a".repeat(64),
        "dependencies":[]}),
    )
    .unwrap();
    let sibling_plan_id = checked_cli(
        "sibling-dependency-plan",
        &binary,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            sibling_dependencies.to_str().unwrap(),
            "--json",
        ],
        deadline,
    )["dependency_plan_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut backend = RestartableBackend::start(0);
    selection(
        &selected_dependencies,
        &selected_plan.plan_id,
        &artifact,
        &artifact_hash,
        &backend.endpoint(),
        backend.port,
    );
    let mut selected_plan_id = checked_cli(
        "selected-dependency-plan",
        &legacy,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            selected_dependencies.to_str().unwrap(),
            "--json",
        ],
        deadline,
    )["dependency_plan_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let start_selected = |binary: &Path, generation: Option<&str>, plan_id: &str| {
        let mut args = vec![
            "graph",
            if generation.is_some() {
                "serve-restore"
            } else {
                "serve"
            },
            "--project",
            selected.0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            selected_plan.plan_id.as_str(),
            "--run-id",
            run.as_str(),
            "--ready",
            "web=healthy",
            "--ready",
            "init=completed",
            "--timeout-seconds",
            "90",
            "--dependencies",
            selected_dependencies.to_str().unwrap(),
            "--expect-dependencies",
            plan_id,
            "--normalized-file",
            selected_compose.to_str().unwrap(),
            "--expect-original",
            selected_plan.plan.compose_sha256.as_str(),
            "--expect-namespace",
            selected_plan.plan.namespace.as_str(),
            "--json",
        ];
        if let Some(generation) = generation {
            args.extend(["--expect-generation", generation]);
        }
        Process::start(binary, &candidate, &args, None)
    };
    let mut owner = start_selected(&legacy, None, &selected_plan_id);
    let mut selected_cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &run,
        done: false,
    };
    ready(&mut owner, &run, deadline);
    assert_eq!(
        exec(&legacy, &candidate, &run, "web", "write-data", deadline)["exit_code"],
        0
    );
    let before = snapshot(&candidate, &run, deadline).receipt;
    assert!(
        snapshot(&candidate, &run, deadline)
            .guest_endpoints
            .contains_key("web")
    );
    let old_owner = Owner::load(&candidate).unwrap();
    let old_boot = old_owner.guest_boot_id.clone().unwrap();
    let port = backend.port;
    backend.stop();
    backend = RestartableBackend::start(port);
    checked_cli(
        "real-listener-refresh",
        &legacy,
        &candidate,
        &["graph", "refresh-dependencies", "--run-id", &run, "--json"],
        deadline,
    );
    let refreshed = snapshot(&candidate, &run, deadline).receipt;
    let graph_root = graph::directory(&candidate, &run).unwrap();
    let journal_path = graph_root.join("dependency-rebind.json");
    let journal: Value = state::read(&journal_path).unwrap();
    assert_eq!(journal["phase"], "completed");
    assert_eq!(journal["boot"], old_boot);
    assert_eq!(
        journal["completed_generation"],
        graph::service_exec_generation(&refreshed).unwrap()
    );
    assert_eq!(
        before.resources["volume:data"].name,
        refreshed.resources["volume:data"].name
    );
    owner.child.kill().unwrap();
    owner.wait(deadline);
    assert_eq!(lifecycle::down(&candidate).unwrap().phase, "stopped");
    let new_boot = lifecycle::up(&candidate).unwrap().guest_boot_id.unwrap();
    assert_ne!(new_boot, old_boot);
    let mut sibling_owner = Process::start(
        &binary,
        &candidate,
        &[
            "graph",
            "serve",
            "--project",
            sibling.0.to_str().unwrap(),
            "--file",
            "compose.yaml",
            "--expect-plan",
            &sibling_plan.plan_id,
            "--run-id",
            &sibling_run,
            "--ready",
            "web=healthy",
            "--timeout-seconds",
            "90",
            "--dependencies",
            sibling_dependencies.to_str().unwrap(),
            "--expect-dependencies",
            &sibling_plan_id,
            "--normalized-file",
            sibling.0.join("compose.yaml").to_str().unwrap(),
            "--expect-original",
            &sibling_plan.plan.compose_sha256,
            "--expect-namespace",
            &sibling_plan.plan.namespace,
            "--json",
        ],
        None,
    );
    let mut sibling_cleanup = Cleanup {
        binary: &binary,
        candidate: &candidate,
        run: &sibling_run,
        done: false,
    };
    ready(&mut sibling_owner, &sibling_run, deadline);
    assert_eq!(
        exec(
            &binary,
            &candidate,
            &sibling_run,
            "web",
            "write-data",
            deadline
        )["exit_code"],
        0
    );
    let sibling_before = snapshot(&candidate, &sibling_run, deadline).receipt;
    let current_owner = Owner::load(&candidate).unwrap();
    let host_boot = lifecycle::host_filesystem::host_boot_micros().unwrap();
    let old_device = current_owner
        .storage
        .as_ref()
        .unwrap()
        .device
        .checked_add(1)
        .unwrap();
    let mut synthetic = old_owner;
    synthetic.storage.as_mut().unwrap().device = old_device;
    synthetic.overlay.as_mut().unwrap().device = old_device;
    if let Some(share) = synthetic.project_share.as_mut() {
        share.device = old_device;
    }
    synthetic.process.as_mut().unwrap().pid = i32::MAX;
    synthetic.process.as_mut().unwrap().start_micros = host_boot - 1;
    let old_path = private.0.join("prior-owner.json");
    state::write(&old_path, &synthetic).unwrap();
    let pool = fs::symlink_metadata(candidate.state_root.join("run/smolvm")).unwrap();
    let inspection_path = private.0.join("prior-inspection.json");
    state::write(
        &inspection_path,
        &serde_json::from_slice::<Value>(&graph::absent_publication_cleanup::fixture_inspection(
            &fs::read(&old_path).unwrap(),
            &current_owner,
            old_device,
            host_boot,
            pool.ino(),
        ))
        .unwrap(),
    )
    .unwrap();
    let publisher = transport::root(&candidate, &run).unwrap();
    let control = refreshed
        .relay_startup
        .as_ref()
        .unwrap()
        .control_root
        .clone();
    fs::remove_dir_all(&publisher).unwrap();
    fs::remove_dir_all(&control).unwrap();
    let old = old_path.to_str().unwrap();
    let prior = inspection_path.to_str().unwrap();
    let inspected = checked_cli(
        "inspect-absence-with-real-journal",
        &legacy,
        &candidate,
        &inspect_args(&run, old, prior),
        deadline,
    );
    let selection_hash = inspected["selection_sha256"].as_str().unwrap();
    let stopped = checked_cli(
        "legacy-absence-retirement",
        &legacy,
        &candidate,
        &recover_args(&run, old, prior, selection_hash),
        deadline,
    );
    assert_eq!(stopped["phase"], "stopped-data-retained");
    let first_stopped = snapshot(&candidate, &run, deadline).receipt;
    assert!(
        journal_path.exists(),
        "legacy binary must retain the old journal"
    );
    assert!(
        graph_root
            .join("absent-publication-retirement.json")
            .exists()
    );
    assert_eq!(
        first_stopped.resources["volume:data"].name,
        before.resources["volume:data"].name
    );
    // Rotate the external listener so the old journal cannot describe the next
    // generation even if its completed services happen to match.
    backend.stop();
    backend = RestartableBackend::start(port);
    selection(
        &selected_dependencies,
        &selected_plan.plan_id,
        &artifact,
        &artifact_hash,
        &backend.endpoint(),
        backend.port,
    );
    selected_plan_id = checked_cli(
        "new-dependency-plan",
        &legacy,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            selected_dependencies.to_str().unwrap(),
            "--json",
        ],
        deadline,
    )["dependency_plan_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first_generation = checked_cli(
        "legacy-restore-selection",
        &legacy,
        &candidate,
        &["graph", "restore-selection", "--run-id", &run, "--json"],
        deadline,
    )["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut first_owner = start_selected(&legacy, Some(&first_generation), &selected_plan_id);
    ready(&mut first_owner, &run, deadline);
    let first_ready = snapshot(&candidate, &run, deadline);
    assert_eq!(first_ready.receipt.phase, "ready-observed");
    assert_ne!(
        first_ready.receipt.resources["container:web"].id,
        refreshed.resources["container:web"].id
    );
    assert!(first_ready.journal_incomplete);
    assert!(first_ready.guest_endpoints.is_empty());
    let foreground_root = transport::root(&candidate, &run).unwrap();
    let publisher_sha = file_hash(&foreground_root.join("owner.json"));
    let first_cleanup = Process::start(
        &legacy,
        &candidate,
        &["graph", "cleanup", "--run-id", &run, "--json"],
        None,
    );
    let mut first_cleanup = first_cleanup;
    let cleanup_status = first_cleanup.wait(deadline);
    assert_eq!(cleanup_status.code(), Some(2));
    let cleanup_error: Value = serde_json::from_slice(&first_cleanup.err).unwrap();
    assert_eq!(cleanup_error["code"], "graph_owner_recovery");
    assert!(first_owner.poll().is_none(), "failed cleanup retired owner");
    first_owner.child.kill().unwrap();
    assert!(first_owner.wait(deadline).code().is_none());
    let newer_stopped = snapshot(&candidate, &run, deadline).receipt;
    assert_eq!(newer_stopped.phase, "stopped-data-retained");
    let stopped_sha = file_hash(&graph_root.join("state.json"));
    assert!(journal_path.exists());
    assert_eq!(
        newer_stopped.resources["volume:data"].name,
        first_stopped.resources["volume:data"].name
    );
    assert_eq!(
        serde_json::to_value(
            snapshot(&candidate, &sibling_run, deadline)
                .receipt
                .resources
        )
        .unwrap(),
        serde_json::to_value(&sibling_before.resources).unwrap(),
    );
    assert!(sibling_owner.poll().is_none());
    let retired_publisher = checked_cli(
        "retire-acknowledged-publisher",
        &binary,
        &candidate,
        &[
            "graph",
            "retire-acknowledged-publisher",
            "--run-id",
            &run,
            "--expect-owner",
            &newer_stopped.owner,
            "--expect-receipt",
            &stopped_sha,
            "--expect-publisher",
            &publisher_sha,
            "--json",
        ],
        deadline,
    );
    assert_eq!(retired_publisher["publisher_retired"], true);
    assert_eq!(retired_publisher["data_retained"], true);
    assert_eq!(retired_publisher["acknowledged_cleanup"], true);
    assert!(!foreground_root.join("owner.json").exists());
    assert!(!foreground_root.join("control.sock").exists());
    let history_path = graph_root.join(format!(
        "dependency-rebind-history-{}",
        graph::service_exec_generation(&refreshed).unwrap()
    ));
    {
        let retired = transport::Retired::acquire(&candidate, &run)
            .unwrap()
            .unwrap();
        let engine = graph::Engine::connect_cleanup_wait(&candidate).unwrap();
        let interrupted = graph::absent_publication_cleanup::archive_retired_rebind_under(
            &candidate,
            &engine,
            &newer_stopped,
            &|| {
                retired.verify()?;
                if history_path.join("dependency-rebind.json").exists() {
                    return Err(CandidateError::new(
                        "test_archive_fault",
                        "owned archival pause",
                    ));
                }
                Ok(())
            },
        );
        assert!(interrupted.is_err());
        retired.verify().unwrap();
    }
    assert!(!journal_path.exists());
    assert!(history_path.join("dependency-rebind.json").exists());
    assert_eq!(
        state::read::<Value>(&history_path.join("proof.json")).unwrap()["complete"],
        false
    );
    let current_generation = checked_cli(
        "current-restore-selection",
        &binary,
        &candidate,
        &["graph", "restore-selection", "--run-id", &run, "--json"],
        deadline,
    )["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    selected_plan_id = checked_cli(
        "current-dependency-plan",
        &binary,
        &candidate,
        &[
            "graph",
            "dependency-plan",
            "--dependencies",
            selected_dependencies.to_str().unwrap(),
            "--json",
        ],
        deadline,
    )["dependency_plan_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut recovered_owner = start_selected(&binary, Some(&current_generation), &selected_plan_id);
    ready(&mut recovered_owner, &run, deadline);
    let final_snapshot = snapshot(&candidate, &run, deadline);
    assert_eq!(final_snapshot.receipt.phase, "ready-observed");
    assert!(!final_snapshot.journal_incomplete);
    assert!(final_snapshot.guest_endpoints.contains_key("web"));
    assert_eq!(
        state::read::<Value>(&history_path.join("proof.json")).unwrap()["complete"],
        true
    );
    assert!(!journal_path.exists());
    assert_eq!(
        exec(&binary, &candidate, &run, "web", "read-data", deadline)["exit_code"],
        0
    );
    assert_eq!(
        exec(
            &binary,
            &candidate,
            &sibling_run,
            "web",
            "read-data",
            deadline
        )["exit_code"],
        0
    );
    assert_eq!(
        serde_json::to_value(
            snapshot(&candidate, &sibling_run, deadline)
                .receipt
                .resources
        )
        .unwrap(),
        serde_json::to_value(&sibling_before.resources).unwrap(),
    );
    let removed = checked_cli(
        "selected-cleanup",
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
    assert!(recovered_owner.wait(deadline).success());
    selected_cleanup.done = true;
    let sibling_removed = checked_cli(
        "sibling-cleanup",
        &binary,
        &candidate,
        &[
            "graph",
            "cleanup",
            "--run-id",
            &sibling_run,
            "--remove-data",
            "--json",
        ],
        deadline,
    );
    assert_eq!(sibling_removed["phase"], "removed");
    assert!(sibling_owner.wait(deadline).success());
    sibling_cleanup.done = true;
    backend.stop();
}
