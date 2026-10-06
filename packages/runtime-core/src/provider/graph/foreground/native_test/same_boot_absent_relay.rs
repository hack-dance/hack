//! Opt-in production cleanup proof. Children construct real ready graphs, then
//! drop only their managed relay runtime before exiting. No receipt is fabricated
//! to manufacture the absent endpoint. Fault controls affect only owned fixtures.
use super::*;
use crate::provider::{identity::ProcessIdentity, relay_owner::publication::dead};
use std::collections::{BTreeMap, BTreeSet};

const OWNER: &str = "provider::graph::foreground::native_test::same_boot_absent_relay::owner_child";
const RECOVERY: &str =
    "provider::graph::foreground::native_test::same_boot_absent_relay::recovery_child";
const REMOVE_DATA: &str =
    "provider::graph::foreground::native_test::same_boot_absent_relay::remove_data_child";
fn candidate() -> Candidate {
    Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap()
}
fn run() -> String {
    std::env::var("HACK_LOCAL_GRAPH_RUN").unwrap()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn options(project: &Path) -> project::PlanOptions<'_> {
    project::PlanOptions {
        branch: None,
        project,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    }
}
#[test]
#[ignore = "Only the isolated native parent fixture invokes this owned child"]
fn owner_child() {
    let candidate = candidate();
    let run = run();
    let project = PathBuf::from(std::env::var("HACK_ABSENT_RELAY_PROJECT").unwrap());
    let armed = PathBuf::from(std::env::var("HACK_ABSENT_RELAY_ARMED").unwrap());
    let plan = project::plan(&candidate, options(&project)).unwrap();
    let mut runtime = HostRelayRuntime::new_for_run(
        &candidate,
        Path::new("/tmp/unused-control-only-artifact"),
        &"a".repeat(64),
        Vec::new(),
        &run,
    )
    .unwrap();
    let _publication = Publication::bind(&candidate, &run).unwrap();
    let readiness = BTreeMap::from([("app".into(), graph::Condition::Started)]);
    let values = BTreeMap::new();
    let receipt = graph::run_with_host_dependencies_until(
        &candidate,
        graph::RunOptions {
            live_source: false,
            shared_source: false,
            release_initializer_cache: BTreeSet::new(),
            routing_enrolled: false,
            project: options(&project),
            expected_plan: &plan.plan_id,
            source_revision: None,
            non_secret_values: &values,
            readiness: &readiness,
            run_id: &run,
            timeout: Duration::from_secs(90),
        },
        &mut runtime,
        &BTreeMap::new(),
        Instant::now() + Duration::from_secs(90),
    )
    .unwrap();
    assert_eq!(receipt.phase, "ready-observed");
    state::write(&armed, &json!({"run":run})).unwrap();
    let mut input = libc::pollfd {
        fd: 0,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid writable pollfd. Parent EOF also permits owned exit.
    assert!(
        unsafe { libc::poll(&mut input, 1, 270_000) } > 0,
        "owner child deadline"
    );
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte).unwrap();
    drop(runtime);
}
#[test]
#[ignore = "Only the isolated native parent fixture invokes this owned child"]
fn recovery_child() {
    graph::recover_live_owner(
        &candidate(),
        &run(),
        &std::env::var("HACK_ABSENT_RELAY_RECEIPT").unwrap(),
    )
    .unwrap();
}
#[test]
#[ignore = "Only the isolated native parent fixture invokes this owned child"]
fn remove_data_child() {
    graph::foreground::cleanup_request(&candidate(), &run(), true).unwrap();
}
fn child(candidate: &Candidate, run: &str, name: &str, extra: &[(&str, &str)]) -> Process {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    if let Some(home) = std::env::var_os("HOME") {
        command.env("HOME", home);
    }
    command
        .args(["--ignored", "--exact", name])
        .env("HACK_LOCAL_TEST_ROOT", &candidate.checkout)
        .env("HACK_LOCAL_GRAPH_RUN", run)
        .envs(extra.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command.spawn().unwrap();
    nonblocking(child.stdout.as_ref().unwrap().as_raw_fd());
    nonblocking(child.stderr.as_ref().unwrap().as_raw_fd());
    Process {
        child,
        out: Vec::new(),
        err: Vec::new(),
    }
}
fn wait_file(process: &mut Process, path: &Path, deadline: Instant) {
    while !path.exists() {
        assert!(
            process.poll().is_none(),
            "owned child exited before selected boundary"
        );
        assert!(Instant::now() < deadline, "selected boundary deadline");
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn pause_recovery(
    candidate: &Candidate,
    run: &str,
    expected: &str,
    point: &str,
    deadline: Instant,
) {
    let mut process = child(
        candidate,
        run,
        RECOVERY,
        &[
            ("HACK_ABSENT_RELAY_RECEIPT", expected),
            ("HACK_LOCAL_GRAPH_FAULT", point),
        ],
    );
    let marker = graph::directory(candidate, run)
        .unwrap()
        .join(format!("fault-{point}.json"));
    assert!(!marker.exists());
    wait_file(
        &mut process,
        &marker,
        deadline.min(Instant::now() + Duration::from_secs(40)),
    );
    assert_eq!(state::read::<Value>(&marker).unwrap()["run"], run);
    process.child.kill().unwrap();
    process.wait(deadline);
}
fn refused(candidate: &Candidate, run: &str, expected: &str) {
    let path = graph::directory(candidate, run).unwrap().join("state.json");
    let before = fs::read(&path).unwrap();
    assert!(graph::recover_live_owner(candidate, run, expected).is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}
fn marker(candidate: &Candidate, run: &str, write: bool) -> Value {
    let engine = graph::Engine::connect_cleanup(candidate).unwrap();
    let (receipt, _) = graph::load(candidate, &engine, run).unwrap();
    let resource = &receipt.resources["volume:data"];
    let volume = graph::inspect_resource(&engine, &receipt, resource)
        .unwrap()
        .unwrap();
    let mount = volume["Mountpoint"].as_str().unwrap();
    assert_eq!(
        mount,
        format!("/var/lib/docker/volumes/{}/_data", resource.name)
    );
    let script = if write {
        "set -eu; test -d \"$1\"; test ! -L \"$1\"; test ! -e \"$1/absence-marker\"; printf absent-relay-retained-v1 > \"$1/absence-marker\"; printf verified"
    } else {
        "set -eu; test -d \"$1\"; test ! -L \"$1\"; test \"$(cat \"$1/absence-marker\")\" = absent-relay-retained-v1; printf verified"
    };
    assert_eq!(
        engine.guest().execute_cleanup(script, &[mount]).unwrap(),
        "verified"
    );
    json!({"name":resource.name,"created":volume["CreatedAt"]})
}
fn running_container(candidate: &Candidate, run: &str) -> Value {
    let engine = graph::Engine::connect_cleanup(candidate).unwrap();
    let (receipt, _) = graph::load(candidate, &engine, run).unwrap();
    let resource = &receipt.resources["container:app"];
    let container = graph::inspect_resource(&engine, &receipt, resource)
        .unwrap()
        .unwrap();
    assert_eq!(container["State"]["Running"], true);
    assert!(container["Id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(
        container["State"]["StartedAt"]
            .as_str()
            .is_some_and(|started| !started.is_empty())
    );
    json!({"id":container["Id"],"started_at":container["State"]["StartedAt"]})
}
#[test]
#[ignore = "Caller-owned running disposable pool, pinned sh/sleep image, and external 300s watchdog required"]
fn absent_relay_cleanup_retries_preserve_data_and_live_sibling() {
    let deadline = Instant::now() + Duration::from_secs(270);
    let candidate = candidate();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    assert!(
        image
            .strip_prefix("sha256:")
            .is_some_and(|digest| graph::hex(digest, 64))
    );
    let fixtures = [graph::tests::Fixture::new(), graph::tests::Fixture::new()];
    let runs = [
        graph::probes::token().unwrap(),
        graph::probes::token().unwrap(),
    ];
    let mut owners = Vec::new();
    for (fixture, run) in fixtures.iter().zip(&runs) {
        state::write(&fixture.0.join("compose.yaml"), &json!({"services":{"app":{
            "image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
            "entrypoint":["/bin/sh","-c","exec sleep 300"],"command":[],"volumes":["data:/data"]}},"volumes":{"data":{}}})).unwrap();
        let armed = fixture.0.join("armed.json");
        let mut owner = child(
            &candidate,
            run,
            OWNER,
            &[
                ("HACK_ABSENT_RELAY_PROJECT", fixture.0.to_str().unwrap()),
                ("HACK_ABSENT_RELAY_ARMED", armed.to_str().unwrap()),
            ],
        );
        wait_file(&mut owner, &armed, deadline);
        owners.push(owner);
    }
    let before = graph::inspect(&candidate, &runs[0]).unwrap().receipt;
    let sibling = graph::inspect(&candidate, &runs[1]).unwrap().receipt;
    let sibling_container = running_container(&candidate, &runs[1]);
    let root = graph::directory(&candidate, &runs[0]).unwrap();
    let expected = sha(&fs::read(root.join("state.json")).unwrap());
    let boot = crate::provider::lifecycle::status(&candidate)
        .unwrap()
        .guest_boot_id;
    let markers = [
        marker(&candidate, &runs[0], true),
        marker(&candidate, &runs[1], true),
    ];
    refused(&candidate, &runs[0], &expected);
    drop(owners[0].child.stdin.take());
    assert!(owners[0].wait(deadline).success());
    let control = before
        .relay_startup
        .as_ref()
        .unwrap()
        .control_root
        .join("relay-control");
    assert!(!control.join("owner.json").exists() && !control.join("control.sock").exists());
    assert!(control.join("operation.lock").is_file());
    // No partial endpoint can turn into an absence selection.
    for name in ["owner.json", "control.sock"] {
        fs::write(control.join(name), b"owned-negative-control").unwrap();
        refused(&candidate, &runs[0], &expected);
        fs::remove_file(control.join(name)).unwrap();
    }
    let original_bytes = fs::read(root.join("state.json")).unwrap();
    fs::write(
        root.join("state.json"),
        [original_bytes.as_slice(), b"\n"].concat(),
    )
    .unwrap();
    refused(&candidate, &runs[0], &expected);
    fs::write(root.join("state.json"), &original_bytes).unwrap();
    pause_recovery(
        &candidate,
        &runs[0],
        &expected,
        "live-owner-after-intent",
        deadline,
    );
    // Replacing the selected lock or directory cannot resume its committed intent.
    fs::rename(control.join("operation.lock"), control.join("saved.lock")).unwrap();
    drop(state::Lock::acquire(&control).unwrap());
    refused(&candidate, &runs[0], &expected);
    fs::remove_file(control.join("operation.lock")).unwrap();
    fs::rename(control.join("saved.lock"), control.join("operation.lock")).unwrap();
    let saved_control = control.with_file_name("relay-control-saved");
    fs::rename(&control, &saved_control).unwrap();
    state::private_directory(&control).unwrap();
    drop(state::Lock::acquire(&control).unwrap());
    refused(&candidate, &runs[0], &expected);
    fs::remove_file(control.join("operation.lock")).unwrap();
    fs::remove_dir(&control).unwrap();
    fs::rename(saved_control, &control).unwrap();
    pause_recovery(
        &candidate,
        &runs[0],
        &expected,
        "cleanup-after-remove",
        deadline,
    );
    assert_eq!(
        state::read::<graph::Receipt>(&root.join("state.json"))
            .unwrap()
            .phase,
        "cleanup-intent"
    );
    assert_eq!(marker(&candidate, &runs[0], false), markers[0]);
    pause_recovery(
        &candidate,
        &runs[0],
        &expected,
        "live-owner-after-completion",
        deadline,
    );
    let intent_path = root.join("live-owner-cleanup.json");
    let intent_bytes = fs::read(&intent_path).unwrap();
    let mut substituted: Value = serde_json::from_slice(&intent_bytes).unwrap();
    let mut process: ProcessIdentity =
        serde_json::from_value(substituted["relay"]["absent"]["process"].clone()).unwrap();
    process.start_micros += 1;
    let witness = dead::CleanupWitness::acquire(
        &before.relay_startup.as_ref().unwrap().control_root,
        graph::host_relay::context(&before.owner, substituted["boot"].as_str().unwrap()).unwrap(),
        &process,
    )
    .unwrap();
    substituted["relay"]["absent"]["process"] = json!(process);
    substituted["relay"]["absent"]["witness_sha256"] = json!(witness.selection_sha256().unwrap());
    drop(witness);
    state::write(&intent_path, &substituted).unwrap();
    refused(&candidate, &runs[0], &expected);
    fs::write(&intent_path, &intent_bytes).unwrap();
    pause_recovery(
        &candidate,
        &runs[0],
        &expected,
        "live-owner-after-socket-retirement",
        deadline,
    );
    for name in ["owner.json", "control.sock"] {
        fs::write(control.join(name), b"owned-negative-control").unwrap();
        refused(&candidate, &runs[0], &expected);
        fs::remove_file(control.join(name)).unwrap();
    }
    for _ in 0..2 {
        assert_eq!(
            graph::recover_live_owner(&candidate, &runs[0], &expected).unwrap()["publisher_retired"],
            true
        );
    }
    let stopped = graph::inspect(&candidate, &runs[0]).unwrap().receipt;
    assert_eq!(stopped.phase, "stopped-data-retained");
    assert_eq!(marker(&candidate, &runs[0], false), markers[0]);
    assert_eq!(marker(&candidate, &runs[1], false), markers[1]);
    assert_eq!(
        serde_json::to_value(graph::inspect(&candidate, &runs[1]).unwrap().receipt).unwrap(),
        serde_json::to_value(&sibling).unwrap()
    );
    assert!(owners[1].poll().is_none());
    assert_eq!(running_container(&candidate, &runs[1]), sibling_container);
    assert_eq!(
        crate::provider::lifecycle::status(&candidate)
            .unwrap()
            .guest_boot_id,
        boot
    );
    // Stop only the remaining fixture owner, then prove both retaining cleanups.
    drop(owners[1].child.stdin.take());
    assert!(owners[1].wait(deadline).success());
    let sibling_expected = sha(&fs::read(
        graph::directory(&candidate, &runs[1])
            .unwrap()
            .join("state.json"),
    )
    .unwrap());
    graph::recover_live_owner(&candidate, &runs[1], &sibling_expected).unwrap();
    // Interrupt the new destructive request after an actual owned volume removal,
    // before completion publication. Retry must use the persisted same-boot proof.
    let mut removal = child(
        &candidate,
        &runs[0],
        REMOVE_DATA,
        &[(
            "HACK_LOCAL_GRAPH_FAULT",
            "retained-data-after-volume-remove",
        )],
    );
    let removal_marker = root.join("fault-retained-data-after-volume-remove.json");
    wait_file(
        &mut removal,
        &removal_marker,
        deadline.min(Instant::now() + Duration::from_secs(40)),
    );
    assert_eq!(
        state::read::<Value>(&removal_marker).unwrap()["run"],
        runs[0]
    );
    removal.child.kill().unwrap();
    removal.wait(deadline);
    assert_eq!(
        graph::inspect(&candidate, &runs[0]).unwrap().receipt.phase,
        "cleanup-intent"
    );
    assert_eq!(marker(&candidate, &runs[1], false), markers[1]);
    let removal_path = root.join("retired-data-removal.json");
    let removal_bytes = fs::read(&removal_path).unwrap();
    assert_eq!(
        state::read::<Value>(&removal_path).unwrap()["recovery_source"],
        "same-boot"
    );
    for run in &runs {
        graph::foreground::cleanup_request(&candidate, run, true).unwrap();
        graph::foreground::cleanup_request(&candidate, run, true).unwrap();
        assert_eq!(
            graph::inspect(&candidate, run).unwrap().receipt.phase,
            "removed"
        );
    }
    assert_eq!(fs::read(&removal_path).unwrap(), removal_bytes);
}
