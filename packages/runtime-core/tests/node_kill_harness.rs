//! Real-process SIGKILL harness for the two supervisor windows the journal cannot
//! describe on its own: after the claim commits but before the fixture spawns, and
//! after the child is reaped but before its result is persisted.
//!
//! Each test runs an isolated node that launches the real `hack-runtime-candidate`
//! supervisor, built with the test-only `node-kill-harness` feature. The supervisor
//! pauses at an armed point; the test sends SIGKILL there, then checks that the job
//! is quarantined, never started again, keeps its retry identity, and survives a
//! node restart unchanged. The `node_down` variants kill the supervisor while no
//! node is serving, so the restarted node's own reconciliation is what recovers it.
use hack_runtime_core::node::kill_harness::Point;
use hack_runtime_core::node::{self, Mutation, Receipt, Request, Store};
use serde_json::Value;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

static SERIAL: AtomicU32 = AtomicU32::new(0);

#[test]
fn sigkill_between_claim_and_spawn_quarantines_without_replay() {
    kill_at(Point::ClaimSpawn, false);
}

#[test]
fn sigkill_between_claim_and_spawn_is_recovered_by_a_restarted_node() {
    kill_at(Point::ClaimSpawn, true);
}

#[test]
fn sigkill_between_exit_and_persist_quarantines_without_replay() {
    kill_at(Point::ExitPersist, false);
}

#[test]
fn sigkill_between_exit_and_persist_is_recovered_by_a_restarted_node() {
    kill_at(Point::ExitPersist, true);
}

#[test]
fn an_unarmed_point_is_inert() {
    let n = Node::new();
    let accepted = n.ask(&n.submit("unarmed", "success", 5000, 5000));
    let result = n.terminal(accepted["job_id"].as_str().unwrap());
    assert_eq!(result.state, "succeeded");
    assert_eq!(result.starts, 1);
    for point in [Point::ClaimSpawn, Point::ExitPersist] {
        assert!(!point.reached_file(&n.root).exists());
    }
}

fn kill_at(point: Point, node_down: bool) {
    let mut n = Node::new();
    // Arm before submitting: the node may launch the supervisor on its next pass.
    std::fs::write(point.arm_file(&n.root), b"").unwrap();
    let request = n.submit("killed-worker", "success", 5000, 5000);
    let accepted = n.ask(&request);
    let id = accepted["job_id"].as_str().unwrap().to_owned();
    let reached = point.reached_file(&n.root);
    n.until(|| reached.exists());
    let published = std::fs::read_to_string(&reached).unwrap();
    let (pid, paused_job) = published.split_once(' ').unwrap();
    let pid: i32 = pid.parse().unwrap();
    assert_eq!(paused_job, id);
    assert!(!point.arm_file(&n.root).exists(), "pause is one-shot");

    let paused = n.receipt(&id);
    assert_eq!(paused.supervisor_pid, Some(pid));
    assert_eq!(paused.exit_code, None);
    assert_eq!(paused.signal, None);
    let expected_starts = match point {
        Point::ClaimSpawn => {
            assert_eq!(paused.state, "running");
            assert_eq!(paused.child_pid, None, "nothing spawned before the pause");
            0
        }
        Point::ExitPersist => {
            assert_eq!(paused.state, "finishing");
            let child = paused.child_pid.expect("child recorded before exit");
            // The supervisor reaped the child before pausing; no fixture remains.
            assert_eq!(unsafe { libc::kill(child, 0) }, -1);
            1
        }
    };
    assert_eq!(paused.starts, expected_starts);

    if node_down {
        // The supervisor runs in its own session, so it outlives the node.
        n.stop();
    }
    // This test owns the paused supervisor its isolated node launched. Production
    // recovery has no API that signals a PID read from a stored receipt.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    if node_down {
        // Reparented to init or a subreaper; wait until it is reaped.
        n.until(|| unsafe { libc::kill(pid, 0) } == -1);
        n.start();
    }

    let result = n.terminal(&id);
    assert_eq!(result.state, "quarantined");
    assert!(
        result
            .detail
            .as_deref()
            .is_some_and(|d| d.contains("Never automatically replayed")),
        "{:?}",
        result.detail
    );
    assert_eq!(result.starts, expected_starts);
    assert_eq!(result.child_pid, paused.child_pid);
    assert_eq!(
        result.exit_code, None,
        "an unpersisted result is not invented"
    );

    // No replay: the retry returns the original acceptance, and a full fixture
    // duration later the receipt is byte-identical and the pause never recurs.
    assert_eq!(n.ask(&request), accepted);
    std::thread::sleep(Duration::from_millis(600));
    let snapshot = serde_json::to_value(&result).unwrap();
    assert_eq!(serde_json::to_value(n.receipt(&id)).unwrap(), snapshot);
    assert_eq!(std::fs::read_to_string(&reached).unwrap(), published);

    // Quarantine holds execution: new work expires in the queue instead of running.
    let blocked = n.ask(&n.submit("after-quarantine", "success", 400, 5000));
    let blocked = n.terminal(blocked["job_id"].as_str().unwrap());
    assert_eq!(blocked.state, "queue_expired");
    assert_eq!(blocked.starts, 0);

    // A further restart reconciles to the same receipt rather than relaunching it.
    n.stop();
    n.start();
    assert_eq!(serde_json::to_value(n.receipt(&id)).unwrap(), snapshot);
    assert_eq!(n.ask(&request), accepted);
}

fn checkout() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

struct Node {
    root: PathBuf,
    child: Option<Child>,
}
impl Node {
    fn new() -> Self {
        // Supervisors require checkout-local state. Use a short, exclusively created
        // directory so Darwin's Unix socket limit also permits nested worktrees.
        let state = checkout().join(".hack-local");
        std::fs::create_dir_all(&state).unwrap();
        let root = (0..256)
            .find_map(|_| {
                let path = state.join(format!(
                    "k{:02x}",
                    SERIAL.fetch_add(1, Ordering::SeqCst) % 256
                ));
                match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                    Ok(()) => Some(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => panic!("node fixture directory: {error}"),
                }
            })
            .expect("no unowned short node fixture directory is available");
        Store::open(&root, true).unwrap();
        let mut node = Self { root, child: None };
        node.start();
        node
    }
    fn start(&mut self) {
        assert!(self.child.is_none());
        self.child = Some(
            Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "node_service_helper", "--nocapture"])
                .env_clear()
                .env("HACK_NODE_TEST_ROOT", &self.root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        self.until(|| node::call(&self.root, &Request::Status { version: 1 }).is_ok());
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
    fn until(&self, mut condition: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(15);
        while !condition() {
            assert!(Instant::now() < end, "deadline at {}", self.root.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn ask(&self, request: &Request) -> Value {
        let v = node::call(&self.root, &request.clone().seal().unwrap()).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        v["result"].clone()
    }
    fn mutation(&self, id: &str) -> Mutation {
        let s = self.ask(&Request::Status { version: 1 });
        Mutation {
            operation_id: id.into(),
            expected_generation: s["generation"].as_i64().unwrap(),
            target: s["target"].as_str().unwrap().into(),
            principal: unsafe { libc::geteuid() },
            request_digest: String::new(),
            required_capabilities: vec!["fixture_jobs_v1".into()],
        }
    }
    fn submit(&self, id: &str, fixture: &str, queue: u64, execution: u64) -> Request {
        Request::Submit {
            version: 1,
            mutation: self.mutation(id),
            fixture: fixture.into(),
            queue_timeout_ms: queue,
            execution_timeout_ms: execution,
        }
    }
    fn receipt(&self, id: &str) -> Receipt {
        serde_json::from_value(self.ask(&Request::Result {
            version: 1,
            job_id: id.into(),
        }))
        .unwrap()
    }
    fn terminal(&self, id: &str) -> Receipt {
        self.until(|| self.receipt(id).terminal());
        self.receipt(id)
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
#[ignore = "subprocess entrypoint; invoked only by isolated tests"]
fn node_service_helper() {
    let root = PathBuf::from(std::env::var_os("HACK_NODE_TEST_ROOT").expect("test root"));
    node::serve(
        &root,
        &PathBuf::from(env!("CARGO_BIN_EXE_hack-runtime-candidate")),
        &checkout(),
    )
    .unwrap();
}
