use super::transport::{Pin, Publication};
use super::*;
use std::{
    fs,
    io::Write,
    net::Shutdown,
    os::unix::{fs::MetadataExt, net::UnixStream},
    time::Instant,
};
fn fixture() -> (super::super::tests::Fixture, Candidate, String) {
    let fixture = super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let mut bytes = [0; 16];
    use std::io::Read;
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut bytes)
        .unwrap();
    let run = bytes.iter().map(|b| format!("{b:02x}")).collect();
    (fixture, candidate, run)
}
fn root(candidate: &Candidate, run: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let bytes =
        serde_json::to_vec(&("hack-graph-foreground-v1", &candidate.state_root, run)).unwrap();
    format!(
        "/private/tmp/hkgf-{}",
        &format!("{:x}", Sha256::digest(bytes))[..24]
    )
    .into()
}
#[test]
fn publication_serializes_and_pins_exact_server_socket() {
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    let mut published = Publication::bind(&candidate, &run).unwrap();
    assert!(Publication::bind(&candidate, &run).is_err());
    let pin = Pin::load(&candidate, &run).unwrap();
    let mut client = pin.connect().unwrap();
    let mut server = published.accept().unwrap().unwrap();
    transport::write(&mut client, &json!({"test":true}), Duration::from_secs(1)).unwrap();
    let value: Value = transport::read(&mut server, Duration::from_secs(1), 1024).unwrap();
    assert_eq!(value, json!({"test":true}));
    published.finish().unwrap();
    drop(published);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn replaced_socket_refuses_and_is_never_unlinked() {
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    let mut published = Publication::bind(&candidate, &run).unwrap();
    let pin = Pin::load(&candidate, &run).unwrap();
    fs::remove_file(path.join("control.sock")).unwrap();
    let replacement = std::os::unix::net::UnixListener::bind(path.join("control.sock")).unwrap();
    let inode = fs::symlink_metadata(path.join("control.sock"))
        .unwrap()
        .ino();
    assert!(pin.connect().is_err());
    assert!(published.finish().is_err());
    drop(published);
    assert_eq!(
        fs::symlink_metadata(path.join("control.sock"))
            .unwrap()
            .ino(),
        inode
    );
    drop(replacement);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn frames_require_exact_length_eof_and_bounded_wait() {
    for bytes in [
        u32::MAX.to_be_bytes().to_vec(),
        vec![0, 0, 0, 2, b'{', b'}', b'x'],
    ] {
        let (mut read, mut write) = UnixStream::pair().unwrap();
        write.write_all(&bytes).unwrap();
        write.shutdown(Shutdown::Write).unwrap();
        assert!(transport::read::<Value>(&mut read, Duration::from_millis(100), 1024).is_err());
    }
    let (mut read, _write) = UnixStream::pair().unwrap();
    let started = Instant::now();
    assert!(transport::read::<Value>(&mut read, Duration::from_millis(50), 1024).is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
}
#[test]
fn missing_owner_requires_explicit_recovery_without_creating_state() {
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    assert_eq!(
        request(&candidate, &run, None).unwrap_err().code,
        "graph_owner_recovery"
    );
    assert!(!path.exists());
}
#[test]
fn abandoned_client_does_not_stop_owner() {
    const CHILD_PATH: &str = "HACK_FOREGROUND_TEST_ABANDONED";
    if let Some(path) = std::env::var_os(CHILD_PATH) {
        let _socket = UnixStream::connect(path).unwrap();
        return;
    }
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    let mut published = Publication::bind(&candidate, &run).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "provider::graph::foreground::tests::abandoned_client_does_not_stop_owner",
        ])
        .env(CHILD_PATH, path.join("control.sock"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned test child timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(published.accept().unwrap().is_none());
    published.verify().unwrap();
    published.finish().unwrap();
    drop(published);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn cross_process_status_waits_for_request_after_accept() {
    use std::{
        io::Read,
        os::fd::AsRawFd,
        process::{Child, Command, Stdio},
    };
    const CHILD_ROOT: &str = "HACK_FOREGROUND_STATUS_TEST_ROOT";
    const CHILD_RUN: &str = "HACK_FOREGROUND_STATUS_TEST_RUN";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let candidate = Candidate::discover(std::path::Path::new(&root)).unwrap();
        let run = std::env::var(CHILD_RUN).unwrap();
        let mut stream = Pin::load(&candidate, &run).unwrap().connect().unwrap();
        std::io::stdout().write_all(b"R").unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_exact(&mut [0]).unwrap();
        transport::write(
            &mut stream,
            &transport::WireRequest {
                version: 1,
                run: run.clone(),
                remove_data: None,
                restore: None,
            },
            Duration::from_secs(2),
        )
        .unwrap();
        let reply: Value = transport::read(&mut stream, Duration::from_secs(2), 1024).unwrap();
        assert_eq!(reply, json!({"ok":true,"run":run,"phase":"ready"}));
        return;
    }
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    struct OwnedDirectory(std::path::PathBuf);
    impl Drop for OwnedDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    // This fixture never replaces/adopts a publication; remove its private test
    // directory even when the pre-fix descriptor assertion fails.
    let _directory = OwnedDirectory(path.clone());
    let mut published = Publication::bind(&candidate, &run).unwrap();
    let mut child = OwnedChild(Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "provider::graph::foreground::tests::cross_process_status_waits_for_request_after_accept", "--nocapture", "--quiet"])
        .env(CHILD_ROOT, &candidate.checkout).env(CHILD_RUN, &run)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap());
    let mut output = child.0.stdout.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    // The test harness can write its own prefix; the child marker proves connect
    // completed, while its stdin barrier prevents a request from being prewritten.
    loop {
        let mut poll = libc::pollfd {
            fd: output.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let remaining = deadline.checked_duration_since(Instant::now()).unwrap();
        // SAFETY: poll receives one initialized entry backed by a live owned pipe.
        assert!(unsafe { libc::poll(&mut poll, 1, remaining.as_millis().min(5000) as i32) } > 0);
        let mut byte = [0];
        output.read_exact(&mut byte).unwrap();
        if byte[0] == b'R' {
            break;
        }
    }
    let mut server = published.accept().unwrap().unwrap();
    // SAFETY: F_GETFL only observes the live accepted stream descriptor.
    let flags = unsafe { libc::fcntl(server.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0);
    assert_eq!(
        flags & libc::O_NONBLOCK,
        0,
        "accepted request stream must honor bounded blocking reads"
    );
    child.0.stdin.take().unwrap().write_all(b"G").unwrap();
    let request: transport::WireRequest =
        transport::read(&mut server, Duration::from_secs(2), 1024).unwrap();
    assert_eq!(request.version, 1);
    assert_eq!(request.run, run);
    assert_eq!(request.remove_data, None);
    transport::write(
        &mut server,
        &json!({"ok":true,"run":run,"phase":"ready"}),
        Duration::from_secs(2),
    )
    .unwrap();
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "owned status client exceeded deadline"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    published.finish().unwrap();
    drop(published);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn buffered_reply_survives_both_write_halves_closed() {
    let (mut client, mut server) = UnixStream::pair().unwrap();
    transport::write(&mut client, &json!({"status":true}), Duration::from_secs(1)).unwrap();
    let request: Value = transport::read(&mut server, Duration::from_secs(1), 1024).unwrap();
    assert_eq!(request, json!({"status":true}));
    transport::write(&mut server, &json!({"ok":true}), Duration::from_secs(1)).unwrap();
    // Both SHUT_WR calls have completed before reading the buffered reply. On
    // macOS SO_RCVTIMEO can no longer be changed here, but the data remains valid.
    let response: Value = transport::read(&mut client, Duration::from_secs(1), 1024).unwrap();
    assert_eq!(response, json!({"ok":true}));
}

#[test]
fn never_admitted_publication_finishes_only_without_graph_state() {
    for (admitted, graph_exists) in [(false, false), (true, false), (false, true)] {
        let (_fixture, candidate, run) = fixture();
        let mut publication = Publication::bind(&candidate, &run).unwrap();
        let control = root(&candidate, &run);
        if graph_exists {
            fs::create_dir_all(super::super::directory(&candidate, &run).unwrap()).unwrap();
        }
        let finished =
            finish_before_admission(&mut publication, &candidate, &run, admitted).unwrap();
        assert_eq!(finished, !admitted && !graph_exists);
        assert_eq!(control.join("owner.json").exists(), !finished);
        assert_eq!(control.join("control.sock").exists(), !finished);
        if !finished {
            publication.finish().unwrap();
        }
        drop(publication);
        fs::remove_dir_all(control).unwrap();
    }
}

#[test]
fn retained_publisher_exit_wakes_owner_and_retired_watch_does_not() {
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    let mut publication = Publication::bind(&candidate, &run).unwrap();
    let events = signals::Events::new(&publication).unwrap();
    let spawn = || {
        std::process::Command::new("/bin/cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut first = spawn();
    events.watch_child(&first).unwrap();
    first.kill().unwrap();
    assert!(events.wait().is_err());
    events.unwatch_child(&first).unwrap();
    first.wait().unwrap();
    let mut retired = spawn();
    events.watch_child(&retired).unwrap();
    events.unwatch_child(&retired).unwrap();
    retired.kill().unwrap();
    retired.wait().unwrap();
    let _client = Pin::load(&candidate, &run).unwrap().connect().unwrap();
    assert!(!events.wait().unwrap());
    drop(events);
    publication.finish().unwrap();
    drop(publication);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn retired_cleanup_guard_excludes_active_and_stale_publication() {
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    let mut publication = Publication::bind(&candidate, &run).unwrap();
    assert!(
        transport::Retired::acquire(&candidate, &run)
            .unwrap()
            .is_none()
    );
    publication.finish().unwrap();
    // File absence while the real owner still holds its lock is not retirement.
    assert!(transport::Retired::acquire(&candidate, &run).is_err());
    drop(publication);
    let retired = transport::Retired::acquire(&candidate, &run)
        .unwrap()
        .unwrap();
    assert!(Publication::bind(&candidate, &run).is_err());
    retired.verify().unwrap();
    drop(retired);
    fs::write(path.join("owner.json"), b"stale").unwrap();
    assert!(
        transport::Retired::acquire(&candidate, &run)
            .unwrap()
            .is_none()
    );
    fs::remove_file(path.join("owner.json")).unwrap();
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn dead_owner_selection_holds_lock_and_rejects_live_or_changed_records() {
    let (_fixture, candidate, run) = fixture();
    let path = root(&candidate, &run);
    let published = Publication::bind(&candidate, &run).unwrap();
    assert!(super::DeadOwner::acquire(&candidate, &run).is_err());
    drop(published);
    assert!(super::DeadOwner::acquire(&candidate, &run).is_err());
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("0.1")
        .spawn()
        .unwrap();
    let identity = crate::provider::identity::observe(child.id() as i32).unwrap();
    child.wait().unwrap();
    let mut record: Value = crate::provider::state::read(&path.join("owner.json")).unwrap();
    record["process"] = serde_json::to_value(identity).unwrap();
    crate::provider::state::write(&path.join("owner.json"), &record).unwrap();
    let guard = super::DeadOwner::acquire(&candidate, &run).unwrap();
    assert!(super::DeadOwner::acquire(&candidate, &run).is_err());
    assert_eq!(guard.fingerprint().len(), 64);
    record["run"] = json!("f".repeat(32));
    crate::provider::state::write(&path.join("owner.json"), &record).unwrap();
    assert!(guard.verify().is_err());
    drop(guard);
    fs::remove_dir_all(path).unwrap();
}
