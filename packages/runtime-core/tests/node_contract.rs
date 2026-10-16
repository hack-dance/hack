//! Native process evidence for WU04, isolated from provider and enrolled project state.
use hack_runtime_core::node::{self, Mutation, Receipt, Request, Store};
use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

static SERIAL: AtomicU32 = AtomicU32::new(0);

#[test]
fn source_job_refusals_do_not_advance_the_journal_or_create_provider_state() {
    let directory = std::env::temp_dir().join(format!(
        "hkl-source-admission-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir(&directory).unwrap();
    let candidate = hack_runtime_core::Candidate::discover(&directory).unwrap();
    let mut store = Store::open(&node::root(&candidate), true).unwrap();
    let source = hack_runtime_core::provider::SourceJob {
        namespace: "a".repeat(64),
        revision: "b".repeat(64),
        image: "busybox:latest".into(),
        argv: vec!["/bin/true".into()],
        memory_bytes: 64 * 1024 * 1024,
    };
    let make = |generation, source| {
        Request::SubmitSource {
            version: 1,
            mutation: Mutation {
                operation_id: "refused-source".into(),
                expected_generation: generation,
                target: store.target.clone(),
                principal: unsafe { libc::geteuid() },
                request_digest: String::new(),
                required_capabilities: vec!["immutable_source_jobs_v1".into()],
            },
            source,
            queue_timeout_ms: 1000,
            execution_timeout_ms: 1000,
        }
        .seal()
        .unwrap()
    };
    let stale = make(1, source.clone());
    let mutable = make(0, source.clone());
    let unpublished = make(
        0,
        hack_runtime_core::provider::SourceJob {
            image: format!("sha256:{}", "c".repeat(64)),
            ..source
        },
    );
    assert_eq!(
        store
            .handle_for_candidate(&stale, unsafe { libc::geteuid() }, &candidate)
            .unwrap_err()
            .code,
        "stale_generation"
    );
    assert_eq!(
        store
            .handle_for_candidate(&mutable, unsafe { libc::geteuid() }, &candidate)
            .unwrap_err()
            .code,
        "source_job"
    );
    assert!(
        store
            .handle_for_candidate(&unpublished, unsafe { libc::geteuid() }, &candidate)
            .is_err()
    );
    assert_eq!(
        store
            .handle(&unpublished, unsafe { libc::geteuid() })
            .unwrap_err()
            .code,
        "capability_mismatch"
    );
    let status = store
        .handle_for_candidate(
            &Request::Status { version: 1 },
            unsafe { libc::geteuid() },
            &candidate,
        )
        .unwrap();
    assert_eq!(status["generation"], 0);
    assert!(store.list().unwrap().is_empty());
    assert!(!candidate.state_root.join("run").exists());
    assert!(!candidate.state_root.join("providers").exists());
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
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
        let root = checkout().join(format!(
            ".hack-local/t{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::SeqCst)
        ));
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

#[test]
fn lost_acknowledgement_retries_once_and_rejects_changed_input() {
    let n = Node::new();
    let request = n.submit("lost-ack", "success", 10_000, 3000);
    let mut socket = UnixStream::connect(n.root.join("node.sock")).unwrap();
    let bytes = serde_json::to_vec(&request.clone().seal().unwrap()).unwrap();
    socket
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    socket.write_all(&bytes).unwrap();
    drop(socket);
    let first = n.ask(&request);
    let second = n.ask(&request);
    assert_eq!(first, second);
    let id = first["job_id"].as_str().unwrap();
    let result = n.terminal(id);
    assert_eq!(result.state, "succeeded", "{result:?}");
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.stdout, "fixture success\n");
    assert_eq!(result.starts, 1);
    let mut changed = request.clone();
    if let Request::Submit { fixture, .. } = &mut changed {
        *fixture = "failure".into();
    }
    assert_eq!(
        node::call(&n.root, &changed.seal().unwrap()).unwrap()["ok"],
        false
    );
    assert_eq!(n.receipt(id).starts, 1);
}
#[test]
fn restart_does_not_own_or_duplicate_supervisor() {
    let mut n = Node::new();
    let request = n.submit("restart", "tree", 10_000, 1200);
    let accepted = n.ask(&request);
    let id = accepted["job_id"].as_str().unwrap();
    n.until(|| n.receipt(id).child_pid.is_some());
    let original = n.receipt(id);
    n.stop();
    std::thread::sleep(Duration::from_millis(250));
    n.start();
    assert_eq!(n.ask(&request), accepted);
    let result = n.terminal(id);
    assert_eq!(result.state, "timed_out", "{result:?}");
    assert_eq!(result.supervisor_pid, original.supervisor_pid);
    assert_eq!(result.starts, 1);
}
#[test]
fn cancellation_kills_term_resistant_tree_but_preserves_sentinel() {
    let n = Node::new();
    let request = n.submit("tree", "tree", 10_000, 5000);
    let accepted = n.ask(&request);
    let id = accepted["job_id"].as_str().unwrap();
    n.until(|| n.receipt(id).stdout.contains("descendant="));
    let running = n.receipt(id);
    let pids: Vec<i32> = running
        .stdout
        .split_whitespace()
        .map(|s| s.split('=').nth(1).unwrap().parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 2);
    let mut sentinel = Command::new("/bin/sleep").arg("10").spawn().unwrap();
    let cancel = Request::Cancel {
        version: 1,
        mutation: n.mutation("cancel-tree"),
        job_id: id.into(),
    };
    let first = n.ask(&cancel);
    assert_eq!(n.ask(&cancel), first);
    let result = n.terminal(id);
    assert_eq!(result.state, "cancelled", "{result:?}");
    assert_eq!(result.signal, Some(libc::SIGKILL));
    for pid in pids {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    assert!(sentinel.try_wait().unwrap().is_none());
    sentinel.kill().unwrap();
    sentinel.wait().unwrap();
}
#[test]
fn queue_cancellation_deadline_and_stale_generation_do_not_start_jobs() {
    let n = Node::new();
    let active = n.ask(&n.submit("active", "tree", 10_000, 1000));
    let active_id = active["job_id"].as_str().unwrap();
    n.until(|| n.receipt(active_id).child_pid.is_some());
    let stale = n.submit("stale", "success", 1000, 1000);
    let queued = n.ask(&n.submit("queued", "success", 5000, 1000));
    let queued_id = queued["job_id"].as_str().unwrap();
    assert_eq!(
        node::call(&n.root, &stale.seal().unwrap()).unwrap()["ok"],
        false
    );
    let cancel = Request::Cancel {
        version: 1,
        mutation: n.mutation("cancel-queued"),
        job_id: queued_id.into(),
    };
    n.ask(&cancel);
    assert_eq!(n.terminal(queued_id).starts, 0);
    let expired = n.ask(&n.submit("expired", "success", 100, 1000));
    let result = n.terminal(expired["job_id"].as_str().unwrap());
    assert_eq!(result.state, "queue_expired");
    assert_eq!(result.starts, 0);
    n.terminal(active_id);
}
#[test]
fn output_is_drained_beyond_retention_limit_and_failure_is_distinct() {
    let n = Node::new();
    let accepted = n.ask(&n.submit("output", "output", 5000, 3000));
    let result = n.terminal(accepted["job_id"].as_str().unwrap());
    assert_eq!(result.state, "succeeded", "{result:?}");
    assert_eq!(result.stdout.len(), 16384);
    assert_eq!(result.stderr.len(), 16384);
    assert!(result.truncated);
    let failed = n.ask(&n.submit("failure", "failure", 5000, 3000));
    let result = n.terminal(failed["job_id"].as_str().unwrap());
    assert_eq!(result.state, "failed");
    assert_eq!(result.exit_code, Some(23));
    assert_eq!(result.stderr, "fixture failure\n");
}
#[test]
fn malformed_oversized_and_unknown_protocol_requests_leave_node_available() {
    let n = Node::new();
    for (size, bytes) in [(131073u32, Vec::new()), (1, vec![b'{'])] {
        let mut socket = UnixStream::connect(n.root.join("node.sock")).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket.write_all(&size.to_be_bytes()).unwrap();
        socket.write_all(&bytes).unwrap();
        let mut header = [0; 4];
        socket.read_exact(&mut header).unwrap();
        let mut response = vec![0; u32::from_be_bytes(header) as usize];
        socket.read_exact(&mut response).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&response).unwrap()["ok"],
            false
        );
    }
    assert_eq!(
        node::call(&n.root, &Request::Status { version: 2 }).unwrap()["ok"],
        false
    );
    let bad = n.submit("unknown", "shell", 1000, 1000);
    assert_eq!(
        node::call(&n.root, &bad.seal().unwrap()).unwrap()["ok"],
        false
    );
    let mut wrong = n.submit("principal", "success", 1000, 1000);
    if let Request::Submit { mutation, .. } = &mut wrong {
        mutation.principal += 1;
    }
    assert_eq!(
        node::call(&n.root, &wrong.seal().unwrap()).unwrap()["ok"],
        false
    );
    assert_eq!(n.ask(&Request::Status { version: 1 })["generation"], 0);
}

#[test]
fn journal_failure_rolls_back_acceptance_and_retry_remains_safe() {
    let n = Node::new();
    let request = n.submit("commit-failure", "success", 5000, 2000);
    let connection = rusqlite::Connection::open(n.root.join("journal.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_acceptance BEFORE INSERT ON operations BEGIN SELECT RAISE(FAIL,'injected acceptance failure'); END;").unwrap();
    let response = node::call(&n.root, &request.clone().seal().unwrap()).unwrap();
    assert_eq!(response["ok"], false);
    let status = n.ask(&Request::Status { version: 1 });
    assert_eq!(status["generation"], 0);
    assert!(status["jobs"].as_array().unwrap().is_empty());
    connection
        .execute_batch("DROP TRIGGER reject_acceptance;")
        .unwrap();
    let accepted = n.ask(&request);
    let result = n.terminal(accepted["job_id"].as_str().unwrap());
    assert_eq!(result.state, "succeeded");
    assert_eq!(result.starts, 1);
}
#[test]
fn failed_terminal_publication_quarantines_after_process_cleanup() {
    let n = Node::new();
    let connection = rusqlite::Connection::open(n.root.join("journal.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_result BEFORE UPDATE ON jobs WHEN json_extract(NEW.receipt,'$.state')='succeeded' BEGIN SELECT RAISE(FAIL,'injected publication failure'); END;").unwrap();
    let accepted = n.ask(&n.submit("result-failure", "success", 5000, 2000));
    let result = n.terminal(accepted["job_id"].as_str().unwrap());
    assert_eq!(result.state, "quarantined");
    assert!(
        result
            .detail
            .unwrap()
            .contains("injected publication failure")
    );
    assert_eq!(unsafe { libc::kill(result.child_pid.unwrap(), 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
#[test]
fn ambiguous_claim_and_finishing_never_replay_or_signal_recorded_pid() {
    for phase in ["preparing", "finishing"] {
        let mut n = Node::new();
        let request = n.submit("ambiguous", "success", 5000, 2000);
        n.stop();
        let mut store = Store::open(&n.root, false).unwrap();
        let accepted = store
            .handle(&request.clone().seal().unwrap(), unsafe { libc::geteuid() })
            .unwrap();
        let id = accepted["job_id"].as_str().unwrap();
        let mut sentinel = Command::new("/bin/sleep").arg("10").spawn().unwrap();
        let mut receipt = store.get(id).unwrap();
        receipt.state = phase.into();
        receipt.child_pid = Some(sentinel.id() as i32);
        receipt.supervisor_pid = Some(sentinel.id() as i32);
        let connection = rusqlite::Connection::open(n.root.join("journal.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE jobs SET receipt=? WHERE id=?",
                rusqlite::params![serde_json::to_string(&receipt).unwrap(), id],
            )
            .unwrap();
        n.start();
        let result = n.terminal(id);
        assert_eq!(result.state, "quarantined");
        assert_eq!(result.starts, 0);
        assert_eq!(n.ask(&request), accepted);
        assert!(sentinel.try_wait().unwrap().is_none());
        sentinel.kill().unwrap();
        sentinel.wait().unwrap();
    }
}
#[test]
fn supervisor_loss_is_quarantined_and_fixture_self_expires_without_replay() {
    let n = Node::new();
    let request = n.submit("lost-worker", "tree", 5000, 5000);
    let accepted = n.ask(&request);
    let id = accepted["job_id"].as_str().unwrap();
    n.until(|| n.receipt(id).stdout.contains("descendant="));
    let running = n.receipt(id);
    // This test owns the supervisor launched by its isolated node. Production recovery
    // deliberately has no API that signals a PID read from a stored receipt.
    assert_eq!(
        unsafe { libc::kill(running.supervisor_pid.unwrap(), libc::SIGKILL) },
        0
    );
    let result = n.terminal(id);
    assert_eq!(result.state, "quarantined");
    assert_eq!(result.starts, 1);
    assert_eq!(n.ask(&request), accepted);
    n.until(|| unsafe { libc::kill(running.child_pid.unwrap(), 0) } == -1);
    assert_eq!(n.receipt(id).starts, 1);
}
#[test]
fn private_state_and_unknown_schema_fail_closed() {
    let mut n = Node::new();
    n.stop();
    let connection = rusqlite::Connection::open(n.root.join("journal.sqlite")).unwrap();
    connection.execute_batch("PRAGMA user_version=77;").unwrap();
    drop(connection);
    assert!(Store::open(&n.root, true).is_err());
    let connection = rusqlite::Connection::open(n.root.join("journal.sqlite")).unwrap();
    let version: i32 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 77);
    drop(connection);
    let db = n.root.join("journal.sqlite");
    std::fs::rename(&db, n.root.join("original.sqlite")).unwrap();
    std::os::unix::fs::symlink(n.root.join("original.sqlite"), &db).unwrap();
    assert!(Store::open(&n.root, true).is_err());
}
#[test]
fn capacity_refusal_preserves_existing_retry_identity() {
    let mut n = Node::new();
    let first = n.submit("capacity-first", "success", 5000, 2000);
    n.stop();
    let mut store = Store::open(&n.root, false).unwrap();
    let accepted = store
        .handle(&first.clone().seal().unwrap(), unsafe { libc::geteuid() })
        .unwrap();
    for index in 1..128 {
        let mut next = first.clone();
        if let Request::Submit { mutation, .. } = &mut next {
            mutation.operation_id = format!("capacity-{index}");
            mutation.expected_generation = index;
        }
        store
            .handle(&next.clone().seal().unwrap(), unsafe { libc::geteuid() })
            .unwrap();
    }
    let mut overflow = first.clone();
    if let Request::Submit { mutation, .. } = &mut overflow {
        mutation.operation_id = "overflow".into();
        mutation.expected_generation = 128;
    }
    assert!(
        store
            .handle(&overflow.clone().seal().unwrap(), unsafe {
                libc::geteuid()
            })
            .is_err()
    );
    assert_eq!(
        store
            .handle(&first.clone().seal().unwrap(), unsafe { libc::geteuid() })
            .unwrap(),
        accepted
    );
    assert_eq!(store.list().unwrap().len(), 128);
}

#[test]
fn cancellation_racing_completion_cannot_overwrite_a_terminal_result() {
    let n = Node::new();
    let accepted = n.ask(&n.submit("race", "success", 5000, 2000));
    let id = accepted["job_id"].as_str().unwrap();
    n.until(|| n.receipt(id).child_pid.is_some());
    std::thread::sleep(Duration::from_millis(350));
    n.ask(&Request::Cancel {
        version: 1,
        mutation: n.mutation("race-cancel"),
        job_id: id.into(),
    });
    let result = n.terminal(id);
    assert!(["succeeded", "cancelled"].contains(&result.state.as_str()));
    n.ask(&Request::Cancel {
        version: 1,
        mutation: n.mutation("late-cancel"),
        job_id: id.into(),
    });
    assert_eq!(
        serde_json::to_value(n.receipt(id)).unwrap(),
        serde_json::to_value(result).unwrap()
    );
}
#[test]
fn digest_and_capability_refusals_precede_acceptance_and_offline_inspection_is_read_only() {
    let mut n = Node::new();
    let request = n.submit("digest", "success", 1000, 1000);
    assert_eq!(
        node::call(&n.root, &request).unwrap()["error"]["code"],
        "digest_mismatch"
    );
    let mut required = request.clone();
    if let Request::Submit { mutation, .. } = &mut required {
        mutation.required_capabilities = vec!["hostile_process_sandbox".into()];
    }
    assert_eq!(
        node::call(&n.root, &required.seal().unwrap()).unwrap()["error"]["code"],
        "capability_mismatch"
    );
    n.stop();
    let before = std::fs::read(n.root.join("journal.sqlite")).unwrap();
    let mut inspect = Store::inspect(&n.root).unwrap();
    let status = inspect
        .handle(&Request::Status { version: 1 }, unsafe { libc::geteuid() })
        .unwrap();
    assert_eq!(status["generation"], 0);
    assert!(
        inspect
            .handle(&request.seal().unwrap(), unsafe { libc::geteuid() })
            .is_err()
    );
    drop(inspect);
    assert_eq!(
        std::fs::read(n.root.join("journal.sqlite")).unwrap(),
        before
    );
    assert!(node::call(&n.root, &Request::Status { version: 1 }).is_err());
}

#[test]
fn a_new_journal_incarnation_rejects_old_target_and_copied_state() {
    let mut n = Node::new();
    let request = n.submit("old-incarnation", "success", 1000, 1000);
    n.stop();
    let old = Store::open(&n.root, false).unwrap().target;
    std::fs::remove_file(n.root.join("journal.sqlite")).unwrap();
    let mut fresh = Store::open(&n.root, true).unwrap();
    assert_ne!(fresh.target, old);
    assert_eq!(
        fresh
            .handle(&request.seal().unwrap(), unsafe { libc::geteuid() })
            .unwrap_err()
            .code,
        "authority_mismatch"
    );
    drop(fresh);
    let mut other = Node::new();
    other.stop();
    std::fs::copy(
        n.root.join("journal.sqlite"),
        other.root.join("journal.sqlite"),
    )
    .unwrap();
    assert!(Store::open(&other.root, false).is_err());
}
