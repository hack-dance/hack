//! Actual graph-created ordinary volume and genuine host process loss. This does
//! not qualify orphaned guest writers, VM power loss, or shared-cache collection.
use super::*;
use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const CHILD: &str = "provider::graph::volume_subpaths::native_test::preparation_child";

fn token() -> String {
    let mut bytes = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn project_options(project: &Path) -> PlanOptions<'_> {
    PlanOptions {
        project,
        compose_file: Path::new("compose.yaml"),
        profiles: &[],
    }
}
fn launch(candidate: &Candidate, project: &Path, run_id: &str) -> Result<Receipt, CandidateError> {
    let report = project::plan(candidate, project_options(project))?;
    super::super::run(
        candidate,
        RunOptions {
            live_source: false,
            shared_source: false,
            release_initializer_cache: std::collections::BTreeSet::new(),
            routing_enrolled: false,
            project: project_options(project),
            expected_plan: &report.plan_id,
            source_revision: None,
            non_secret_values: &BTreeMap::new(),
            readiness: &BTreeMap::from([("app".into(), Condition::Started)]),
            run_id,
            timeout: Duration::from_secs(30),
        },
    )
}
struct ChildGuard(Option<Child>);
impl ChildGuard {
    fn kill(&mut self) {
        let child = self.0.as_mut().expect("owned child");
        child.kill().unwrap();
        let status = child.wait().unwrap();
        self.0 = None;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
struct Cleanup<'a> {
    candidate: &'a Candidate,
    run: String,
    done: bool,
}
impl Cleanup<'_> {
    fn finish(&mut self) {
        let receipt = super::super::cleanup(self.candidate, &self.run, true).unwrap();
        assert_eq!(receipt.phase, "removed");
        self.done = true;
    }
}
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if !self.done {
            // Runs after Engine/child guards unwind. The outer harness still
            // owns whole-VM teardown if cleanup itself cannot be verified.
            let _ = super::super::cleanup(self.candidate, &self.run, true);
        }
    }
}

#[test]
#[ignore = "Private child of owned_preparation_host_crash_recovery; never invoke directly"]
fn preparation_child() {
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let project = PathBuf::from(std::env::var("HACK_SUBPATH_PROJECT").unwrap());
    let run = std::env::var("HACK_SUBPATH_RUN").unwrap();
    launch(&candidate, &project, &run).unwrap();
    panic!("fault child escaped its selected boundary");
}

#[test]
#[ignore = "Owned development VM, pinned local image, and external 90-second watchdog required"]
fn owned_preparation_host_crash_recovery() {
    let started = Instant::now();
    let candidate =
        Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap())).unwrap();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").unwrap();
    for point in [
        "volume-preparation-pending",
        "volume-preparation-guest-complete",
    ] {
        let fixture = super::super::tests::Fixture::new();
        state::write(&fixture.0.join("compose.yaml"), &json!({
            "services":{"app":{"image":image,"read_only":true,"network_mode":"none","user":"0:0",
                "entrypoint":["/bin/sh","-c","sleep 300"],"command":[],
                "volumes":[
                    {"type":"volume","source":"data","target":"/one","volume":{"subpath":"workspace/one"}},
                    {"type":"volume","source":"data","target":"/two","volume":{"subpath":"workspace/two"}}
                ]}},"volumes":{"data":{}}
        })).unwrap();
        let run = token();
        let mut cleanup = Cleanup {
            candidate: &candidate,
            run: run.clone(),
            done: false,
        };
        let root = directory(&candidate, &run).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([CHILD, "--ignored", "--exact", "--test-threads=1"])
            .env("HACK_LOCAL_GRAPH_FAULT", point)
            .env("HACK_SUBPATH_PROJECT", &fixture.0)
            .env("HACK_SUBPATH_RUN", &run)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = ChildGuard(Some(child));
        let marker = root.join(format!("fault-{point}.json"));
        let deadline = Instant::now() + Duration::from_secs(25);
        while !marker.exists() {
            assert!(
                child.0.as_mut().unwrap().try_wait().unwrap().is_none(),
                "fault child exited before marker"
            );
            assert!(Instant::now() < deadline, "fault boundary deadline");
            std::thread::sleep(Duration::from_millis(20));
        }
        let reached: Value = state::read(&marker).unwrap();
        assert_eq!(reached["run"], run);
        assert_eq!(reached["point"], point);
        child.kill();
        // Ordinary graph execution remains non-replayable even though the
        // narrowly authorized preparation can be recovered independently.
        assert_eq!(
            launch(&candidate, &fixture.0, &run).unwrap_err().code,
            "graph_replay_refused"
        );
        {
            let engine = Engine::connect(&candidate).unwrap();
            let (receipt, _) = load(&candidate, &engine, &run).unwrap();
            let resource = receipt
                .resources
                .values()
                .find(|r| r.kind == Kind::Volume)
                .unwrap();
            assert!(resource.cache.is_none());
            let path = journal_path(&candidate, &resource.name, false).unwrap();
            let pending = read_preparation(&path).unwrap().unwrap();
            assert!(!pending.completed);
            let report = project::plan(&candidate, project_options(&fixture.0)).unwrap();
            let inputs = project::inputs::compile(
                &candidate,
                project_options(&fixture.0),
                &report.plan_id,
                &BTreeMap::new(),
            )
            .unwrap();
            let prepared = config::prepare(
                inputs,
                &BTreeMap::from([("app".into(), Condition::Started)]),
                &run,
                &receipt.owner,
                None,
            )
            .unwrap();
            let configs = prepared.configs;
            let data = pending.volume["Mountpoint"].as_str().unwrap();
            let before = engine.guest().execute(
                "set -eu; test ! -L \"$1\"; test -d \"$1\"; find \"$1\" -mindepth 1 -maxdepth 3 -type d | wc -l",
                &[data],None).unwrap();
            assert_eq!(
                before.trim().parse::<usize>().unwrap(),
                if point.ends_with("pending") { 0 } else { 3 }
            );

            // A genuine stopped Docker container still holds a reference. Use
            // the graph's owned name/labels so unconditional cleanup can find it.
            let container = &receipt.resources["container:app"];
            let mut consumer = configs["app"].clone();
            consumer["Entrypoint"] = json!(["/bin/sh", "-c", "exit 0"]);
            consumer["Cmd"] = json!([]);
            consumer["HostConfig"]["Mounts"] = json!([{"Type":"volume","Source":resource.name,
                "Target":"/hack-subpath-fixture","ReadOnly":true,"VolumeOptions":{"NoCopy":true}}]);
            let created = engine
                .request(
                    Method::POST,
                    &format!("/v1.53/containers/create?name={}", container.name),
                    Some(&consumer),
                )
                .unwrap();
            let id = created["Id"].as_str().filter(|id| hex(id, 64)).unwrap();
            engine
                .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)
                .unwrap();
            let exit_deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let inspected = inspect_resource(&engine, &receipt, container)
                    .unwrap()
                    .unwrap();
                assert_eq!(inspected["Id"], id);
                if inspected["State"]["Status"] == "exited" {
                    assert_eq!(inspected["State"]["ExitCode"], 0);
                    assert_eq!(inspected["State"]["OOMKilled"], false);
                    assert_eq!(inspected["State"]["Running"], false);
                    break;
                }
                assert!(
                    Instant::now() < exit_deadline,
                    "owned consumer did not exit successfully"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            let authority_before = fs::read(&path).unwrap();
            assert_eq!(
                prepare(&engine, &receipt, resource, &configs, false)
                    .unwrap_err()
                    .code,
                "graph_volume_subpath"
            );
            assert_eq!(fs::read(&path).unwrap(), authority_before);
            assert_eq!(engine.guest().execute(
                "set -eu; test ! -L \"$1\"; test -d \"$1\"; find \"$1\" -mindepth 1 -maxdepth 3 -type d | wc -l",
                &[data],None).unwrap(),before);

            engine
                .request(
                    Method::DELETE,
                    &format!("/v1.53/containers/{id}?force=true&v=true"),
                    None,
                )
                .unwrap();
            assert!(
                inspect_resource(&engine, &receipt, container)
                    .unwrap()
                    .is_none()
            );

            prepare(&engine, &receipt, resource, &configs, false).unwrap();
            assert!(read_preparation(&path).unwrap().unwrap().completed);
            // Completion cannot be changed back into authority by lost data.
            // Only remove this fixture's known empty reviewed directory.
            engine
                .guest()
                .execute(
                    "set -eu; test ! -L \"$1/workspace/two\"; rmdir \"$1/workspace/two\"",
                    &[data],
                    None,
                )
                .unwrap();
            let completed = fs::read(&path).unwrap();
            assert!(prepare(&engine, &receipt, resource, &configs, false).is_err());
            assert_eq!(fs::read(&path).unwrap(), completed);
            assert_eq!(engine.guest().execute("set -eu; test ! -e \"$1/workspace/two\"; test ! -L \"$1/workspace/two\"; printf absent",&[data],None).unwrap(),"absent");
        }
        cleanup.finish();
        let engine = Engine::connect_cleanup(&candidate).unwrap();
        let (receipt, _) = load(&candidate, &engine, &run).unwrap();
        let resource = receipt
            .resources
            .values()
            .find(|r| r.kind == Kind::Volume)
            .unwrap();
        assert!(
            inspect_resource(&engine, &receipt, resource)
                .unwrap()
                .is_none()
        );
        assert!(
            read_preparation(&journal_path(&candidate, &resource.name, false).unwrap())
                .unwrap()
                .is_none()
        );
    }
    assert!(started.elapsed() < Duration::from_secs(85));
}
