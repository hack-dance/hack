//! Controlled partial-stop and immediate-successor recovery against an isolated
//! native pool. The only injected fault is a test-owned Unix socket that accepts
//! one exact immutable container stop request and closes without an HTTP reply.
//! Other stop workers use the real guest engine transport. Failure deliberately
//! leaves the foreground owner and all graph data for explicit inspection.
use super::*;
use crate::{
    error::StopFailureStage,
    provider::{engine, lifecycle},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::BufRead,
    os::unix::net::UnixListener,
    process::Command,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};

const CHILD: &str = "HACK_PARTIAL_STOP_CHILD";
const TEST_NAME: &str = "provider::graph::foreground::native_test::partial_stop::exact_partial_stop_recovers_only_on_immediate_successor_boot";

fn options(project_path: &Path) -> project::PlanOptions<'_> {
    project::PlanOptions {
        branch: None,
        project: project_path,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    }
}

fn token() -> String {
    let mut bytes = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn run_options<'a>(
    project_path: &'a Path,
    plan: &'a str,
    run: &'a str,
    readiness: &'a BTreeMap<String, graph::Condition>,
    values: &'a BTreeMap<String, String>,
) -> graph::RunOptions<'a> {
    graph::RunOptions {
        live_source: false,
        shared_source: false,
        release_initializer_cache: BTreeSet::new(),
        routing_enrolled: false,
        project: options(project_path),
        expected_plan: plan,
        source_revision: None,
        non_secret_values: values,
        readiness,
        run_id: run,
        timeout: Duration::from_secs(90),
    }
}

fn sha(receipt: &graph::Receipt) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(receipt).unwrap())
    )
}

fn child() {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_PARTIAL_STOP_TEST_ROOT").unwrap(),
    ))
    .unwrap();
    let project_path = PathBuf::from(std::env::var("HACK_PARTIAL_STOP_PROJECT").unwrap());
    let run = std::env::var("HACK_PARTIAL_STOP_RUN").unwrap();
    let plan = std::env::var("HACK_PARTIAL_STOP_PLAN").unwrap();
    let socket = PathBuf::from(std::env::var("HACK_PARTIAL_STOP_SOCKET").unwrap());
    let armed = PathBuf::from(std::env::var("HACK_PARTIAL_STOP_ARMED").unwrap());
    let served = PathBuf::from(std::env::var("HACK_PARTIAL_STOP_SERVED").unwrap());
    let target = Arc::new(OnceLock::new());
    let attempts = Arc::new(AtomicUsize::new(0));
    let listener = UnixListener::bind(&socket).unwrap();
    let expected = Arc::clone(&target);
    let _proxy = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = String::new();
        let mut reader = std::io::BufReader::new(stream);
        reader.read_line(&mut request).unwrap();
        let id = expected.get().unwrap();
        assert!(request.starts_with(&format!("POST /v1.53/containers/{id}/stop?")));
        fs::write(&served, b"refused-one-request").unwrap();
        // An EOF with no status line is a real transport refusal, never an ACK.
        drop(reader);
    });
    let arming_checkout = candidate.checkout.clone();
    let arming_run = run.clone();
    let arming_target = Arc::clone(&target);
    let _arming = std::thread::spawn(move || {
        let arming_candidate = Candidate::discover(&arming_checkout).unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Ok(snapshot) = graph::inspect(&arming_candidate, &arming_run) {
                if snapshot.receipt.phase == "ready-observed" {
                    let id = snapshot.receipt.resources["container:app"]
                        .id
                        .clone()
                        .unwrap();
                    assert_eq!(id.len(), 64);
                    arming_target.set(id).unwrap();
                    fs::write(&armed, b"armed").unwrap();
                    return;
                }
            }
            assert!(Instant::now() < deadline, "foreground admission deadline");
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let runtime = HostRelayRuntime::new_for_run(
        &candidate,
        Path::new("/tmp/unused-control-only-artifact"),
        &"a".repeat(64),
        Vec::new(),
        &run,
    )
    .unwrap();
    let readiness = BTreeMap::from([
        ("app".into(), graph::Condition::Started),
        ("worker".into(), graph::Condition::Started),
        ("completed".into(), graph::Condition::Completed),
    ]);
    let values = BTreeMap::new();
    let result = engine::with_test_stop_socket(target, &socket, Arc::clone(&attempts), || {
        serve(
            &candidate,
            run_options(&project_path, &plan, &run, &readiness, &values),
            runtime,
        )
    })
    .unwrap();
    panic!(
        "foreground owner unexpectedly returned: {:?}; fault attempts: {}",
        result.err().map(|error| error.code),
        attempts.load(Ordering::SeqCst)
    );
}

fn resource(engine: &graph::Engine<'_>, receipt: &graph::Receipt, key: &str) -> Value {
    graph::inspect_resource(engine, receipt, &receipt.resources[key])
        .unwrap()
        .unwrap()
}

#[test]
#[ignore = "fresh owned M3 pool, pinned image, and external 300-second watchdog required"]
fn exact_partial_stop_recovers_only_on_immediate_successor_boot() {
    if std::env::var_os(CHILD).is_some() {
        child();
        return;
    }
    let started = Instant::now();
    let deadline = started + Duration::from_secs(270);
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_PARTIAL_STOP_TEST_ROOT").unwrap(),
    ))
    .unwrap();
    let image = std::env::var("HACK_PARTIAL_STOP_TEST_IMAGE").unwrap();
    assert!(image.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }));
    let graphs = candidate.state_root.join("run/graphs");
    assert!(
        !graphs.exists() || fs::read_dir(&graphs).unwrap().next().is_none(),
        "Use a fresh isolated graph pool"
    );
    let project_path = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("hack-partial-stop-{}", token()));
    fs::create_dir(&project_path).unwrap();
    state::write(&project_path.join("compose.yaml"), &json!({"services":{
        "app":{"image":image,"read_only":true,"network_mode":"none","user":"0:0","cpus":0.1,"mem_limit":"64m","pids_limit":32,"entrypoint":["/bin/sh","-ec","while :; do sleep 1; done"],"command":[],"stop_grace_period":"1s","volumes":["data:/data"]},
        "worker":{"image":image,"read_only":true,"network_mode":"none","user":"0:0","cpus":0.1,"mem_limit":"64m","pids_limit":32,"entrypoint":["/bin/sh","-ec","while :; do sleep 1; done"],"command":[],"stop_grace_period":"1s"},
        "completed":{"image":image,"read_only":true,"network_mode":"none","user":"0:0","cpus":0.1,"mem_limit":"64m","pids_limit":32,"entrypoint":["/bin/sh","-ec","printf complete > /data/completed"],"command":[],"volumes":["data:/data"]}
    },"volumes":{"data":{}}})).unwrap();
    let plan = project::plan(&candidate, options(&project_path))
        .unwrap()
        .plan_id;
    let run = token();

    // The stopped sibling is a separate graph and its receipt cannot be selected
    // by the target run's recovery, even though it shares the same pool.
    let sibling_project = project_path.with_file_name(format!("hack-partial-sibling-{}", token()));
    fs::create_dir(&sibling_project).unwrap();
    state::write(&sibling_project.join("compose.yaml"), &json!({"services":{"idle":{"image":image,"read_only":true,"network_mode":"none","user":"0:0","cpus":0.1,"mem_limit":"64m","pids_limit":32,"entrypoint":["/bin/sh","-ec","while :; do sleep 1; done"],"command":[],"volumes":["data:/data"]}},"volumes":{"data":{}}})).unwrap();
    let sibling_plan = project::plan(&candidate, options(&sibling_project))
        .unwrap()
        .plan_id;
    let sibling_run = token();
    let sibling_readiness = BTreeMap::from([("idle".into(), graph::Condition::Started)]);
    let values = BTreeMap::new();
    graph::run(
        &candidate,
        run_options(
            &sibling_project,
            &sibling_plan,
            &sibling_run,
            &sibling_readiness,
            &values,
        ),
    )
    .unwrap();
    let sibling = graph::cleanup(&candidate, &sibling_run, false).unwrap();
    assert_eq!(sibling.phase, "stopped-data-retained");
    let sibling_sha = sha(&sibling);
    let sibling_created;
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        let volume = resource(&engine, &sibling, "volume:data");
        sibling_created = volume["CreatedAt"].as_str().unwrap().to_owned();
        let path = volume["Mountpoint"].as_str().unwrap();
        assert_eq!(
            path,
            format!(
                "/var/lib/docker/volumes/{}/_data",
                sibling.resources["volume:data"].name
            )
        );
        assert_eq!(engine.guest().execute_cleanup(
            "set -eu; test -d \"$1\"; test ! -L \"$1\"; test ! -e \"$1/sibling-marker\"; printf h1212-sibling-marker > \"$1/sibling-marker\"; printf written", &[path]
        ).unwrap(), "written");
    }

    let socket = PathBuf::from(format!("/private/tmp/hkps-{}.sock", &run[..16]));
    let armed = PathBuf::from(format!("/private/tmp/hkpa-{}", &run[..16]));
    let served = PathBuf::from(format!("/private/tmp/hkpr-{}", &run[..16]));
    let mut owner = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--nocapture", "--exact", TEST_NAME])
        .env(CHILD, "1")
        .env("HACK_PARTIAL_STOP_TEST_ROOT", &candidate.checkout)
        .env("HACK_PARTIAL_STOP_PROJECT", &project_path)
        .env("HACK_PARTIAL_STOP_RUN", &run)
        .env("HACK_PARTIAL_STOP_PLAN", &plan)
        .env("HACK_PARTIAL_STOP_SOCKET", &socket)
        .env("HACK_PARTIAL_STOP_ARMED", &armed)
        .env("HACK_PARTIAL_STOP_SERVED", &served)
        .env_remove("HACK_LOCAL_GRAPH_FAULT")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    while !armed.exists() {
        assert!(
            owner.try_wait().unwrap().is_none(),
            "foreground owner exited before test stop was armed"
        );
        assert!(Instant::now() < deadline, "foreground arm deadline");
        std::thread::sleep(Duration::from_millis(20));
    }
    let before = graph::inspect(&candidate, &run).unwrap().receipt;
    let ready_sha = sha(&before);
    let named_volume = before.resources["volume:data"].name.clone();
    let created;
    {
        let engine = graph::Engine::connect(&candidate).unwrap();
        let volume = resource(&engine, &before, "volume:data");
        created = volume["CreatedAt"].as_str().unwrap().to_owned();
        let path = volume["Mountpoint"].as_str().unwrap();
        assert_eq!(
            path,
            format!("/var/lib/docker/volumes/{named_volume}/_data")
        );
        assert_eq!(engine.guest().execute_cleanup("set -eu; test -d \"$1\"; test ! -L \"$1\"; test ! -e \"$1/marker\"; printf h1212-partial-marker > \"$1/marker\"; printf written", &[path]).unwrap(), "written");
    }
    let error = cleanup_request(&candidate, &run, false).unwrap_err();
    assert!(
        served.exists(),
        "exact test socket did not accept the selected request"
    );
    let public_error = serde_json::to_string(&error).unwrap();
    assert!(!public_error.contains(before.resources["container:app"].id.as_deref().unwrap()));
    assert!(!public_error.contains(candidate.checkout.to_str().unwrap()));
    let detail = error.stop_failures.unwrap();
    assert_eq!(detail.version, 1);
    assert_eq!(detail.failures.len(), 1);
    assert_eq!(detail.failures[0].service, "app");
    assert_eq!(detail.failures[0].stage, StopFailureStage::Transport);
    assert!(
        owner.try_wait().unwrap().is_none(),
        "foreground owner lost after failed stop"
    );
    let pending = graph::inspect(&candidate, &run).unwrap().receipt;
    assert_eq!(pending.phase, "cleanup-intent");
    assert_eq!(
        json!(pending.relay_cleanup.as_ref().unwrap())["phase"],
        "pending"
    );
    assert!(
        !graph::directory(&candidate, &run)
            .unwrap()
            .join("shutdown.json")
            .exists()
    );
    let selected_sha = sha(&pending);
    assert_ne!(ready_sha, selected_sha);
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        assert_eq!(
            resource(&engine, &pending, "container:app")["State"]["Running"],
            true
        );
        assert_eq!(
            resource(&engine, &pending, "container:worker")["State"]["Running"],
            false
        );
        assert_eq!(
            resource(&engine, &pending, "container:completed")["State"]["Running"],
            false
        );
    }
    assert!(graph::cleanup(&candidate, &run, false).is_err());
    assert_eq!(
        sha(&graph::inspect(&candidate, &run).unwrap().receipt),
        selected_sha
    );
    owner.kill().unwrap();
    assert!(!owner.wait().unwrap().success());
    assert!(
        graph::recover_cleanup(&candidate, &run, &selected_sha).is_err(),
        "same-boot recovery must refuse"
    );
    assert_eq!(
        sha(&graph::inspect(&candidate, &run).unwrap().receipt),
        selected_sha
    );

    let prior_boot = state::Owner::load(&candidate)
        .unwrap()
        .guest_boot_id
        .unwrap();
    lifecycle::down(&candidate).unwrap();
    lifecycle::up(&candidate).unwrap();
    let successor = state::Owner::load(&candidate).unwrap();
    assert_eq!(
        successor.previous_guest_boot_id.as_deref(),
        Some(prior_boot.as_str())
    );
    assert_ne!(
        successor.guest_boot_id.as_deref(),
        Some(prior_boot.as_str())
    );
    assert!(
        graph::recover_cleanup(&candidate, &run, &ready_sha).is_err(),
        "stale ready receipt must refuse"
    );
    assert_eq!(
        sha(&graph::inspect(&candidate, &run).unwrap().receipt),
        selected_sha
    );
    let recovered = graph::recover_cleanup(&candidate, &run, &selected_sha).unwrap();
    assert_eq!(recovered["recovered"], true);
    let stopped = graph::inspect(&candidate, &run).unwrap().receipt;
    assert_eq!(stopped.phase, "stopped-data-retained");
    assert_eq!(stopped.resources["volume:data"].name, named_volume);
    assert_eq!(
        sha(&graph::inspect(&candidate, &sibling_run).unwrap().receipt),
        sibling_sha
    );
    {
        let engine = graph::Engine::connect_cleanup(&candidate).unwrap();
        for item in stopped
            .resources
            .values()
            .filter(|item| item.kind == graph::Kind::Container)
        {
            assert!(
                graph::inspect_resource(&engine, &stopped, item)
                    .unwrap()
                    .is_none()
            );
        }
        let volume = resource(&engine, &stopped, "volume:data");
        assert_eq!(volume["CreatedAt"].as_str(), Some(created.as_str()));
        let path = volume["Mountpoint"].as_str().unwrap();
        assert_eq!(engine.guest().execute_cleanup("set -eu; test -f \"$1/marker\"; test ! -L \"$1/marker\"; test \"$(cat \"$1/marker\")\" = h1212-partial-marker; test \"$(cat \"$1/completed\")\" = complete; printf retained", &[path]).unwrap(), "retained");
        let sibling_volume = resource(&engine, &sibling, "volume:data");
        assert_eq!(
            sibling_volume["CreatedAt"].as_str(),
            Some(sibling_created.as_str())
        );
        let sibling_path = sibling_volume["Mountpoint"].as_str().unwrap();
        assert_eq!(
            sibling_path,
            format!(
                "/var/lib/docker/volumes/{}/_data",
                sibling.resources["volume:data"].name
            )
        );
        assert_eq!(engine.guest().execute_cleanup(
            "set -eu; test -f \"$1/sibling-marker\"; test ! -L \"$1/sibling-marker\"; test \"$(cat \"$1/sibling-marker\")\" = h1212-sibling-marker; printf retained", &[sibling_path]
        ).unwrap(), "retained");
    }
    // Final teardown uses the recovered publisher's retained-data authority.
    // Any refusal fails the test and leaves the pool/data for explicit recovery.
    let removed = cleanup_request(&candidate, &run, true).unwrap();
    assert_eq!(removed["phase"], "removed");
    let sibling_removed = graph::cleanup(&candidate, &sibling_run, true).unwrap();
    assert_eq!(sibling_removed.phase, "removed");
    assert_eq!(lifecycle::down(&candidate).unwrap().phase, "stopped");
    assert!(started.elapsed() < Duration::from_secs(270));
    fs::remove_file(socket).unwrap();
    fs::remove_file(armed).unwrap();
    fs::remove_file(served).unwrap();
    fs::remove_dir_all(project_path).unwrap();
    fs::remove_dir_all(sibling_project).unwrap();
}
