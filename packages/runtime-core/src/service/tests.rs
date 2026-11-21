use super::*;
use std::io::BufRead;
use std::os::fd::FromRawFd;
use std::sync::Barrier;

/// A fresh private state root short enough for a socket path on every platform.
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let mut parent = std::env::temp_dir().canonicalize().unwrap();
        if parent.as_os_str().len() > 40 {
            parent = Path::new("/tmp").canonicalize().unwrap();
        }
        Self(crate::private_test_root(&parent, "hrs"))
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn pipe() -> (File, File) {
    let mut fds = [0; 2];
    // SAFETY: a writable two-element array; both descriptors are owned below.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: fresh descriptors from pipe(2), each wrapped exactly once.
    unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) }
}

/// Start `serve` on a thread and wait for its ready line.
fn spawn(
    root: &Path,
    idle: Duration,
) -> (
    std::thread::JoinHandle<Result<Outcome, CandidateError>>,
    Value,
) {
    let (reader, writer) = pipe();
    let root = root.to_path_buf();
    let handle = std::thread::spawn(move || serve(&root, Options { idle }, Some(writer)));
    let mut line = String::new();
    std::io::BufReader::new(reader)
        .read_line(&mut line)
        .unwrap();
    (handle, serde_json::from_str(&line).unwrap())
}

fn connect(root: &Path) -> UnixStream {
    UnixStream::connect(paths(root).socket).unwrap()
}

fn ask(stream: &mut UnixStream, request: Value) -> Value {
    frame::write(
        stream,
        &serde_json::to_vec(&request).unwrap(),
        CONTROL_FRAME_LIMIT,
    )
    .unwrap();
    let body = frame::read(stream, Duration::from_secs(5), CONTROL_FRAME_LIMIT).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn hello(stream: &mut UnixStream) -> Value {
    ask(
        stream,
        json!({"v": 1, "id": "h", "op": "hello", "args": {"client": {"kind": "cli"}}}),
    )
}

fn code(reply: &Value) -> &str {
    assert_eq!(reply["ok"], false, "{reply}");
    assert_eq!(reply["error"]["admitted"], false, "{reply}");
    reply["error"]["code"].as_str().unwrap()
}

#[test]
fn hello_and_status_name_this_build_and_process() {
    let root = Root::new();
    let (handle, ready) = spawn(&root.0, Duration::from_secs(30));
    let service = &ready["ready"];
    assert_eq!(service["build_id"], env!("HACK_RUNTIME_BUILD_ID"));
    assert_eq!(service["pid"], std::process::id());
    assert_eq!(service["epoch"].as_str().unwrap().len(), 32);
    let mut stream = connect(&root.0);
    let greeting = hello(&mut stream);
    assert_eq!(greeting["result"]["service"], *service);
    assert_eq!(greeting["result"]["ops"][1]["name"], "service.status");
    let status = call(&root.0, "service.status", json!({})).unwrap();
    assert_eq!(status["service"]["epoch"], service["epoch"]);
    assert_eq!(status["sessions"], 2);
    let record: Value =
        serde_json::from_slice(&std::fs::read(paths(&root.0).record).unwrap()).unwrap();
    assert_eq!(record["epoch"], service["epoch"]);
    let mode = paths(&root.0).socket.symlink_metadata().unwrap().mode();
    assert_eq!(mode & 0o777, 0o600);
    call(&root.0, "service.retire", json!({})).unwrap();
    assert_eq!(handle.join().unwrap().unwrap(), Outcome::Retired);
    assert!(!paths(&root.0).socket.exists());
    assert!(!paths(&root.0).record.exists());
}

#[test]
fn requests_are_refused_before_admission_for_every_protocol_error() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_secs(30));
    let mut stream = connect(&root.0);
    let status = json!({"v": 1, "id": "1", "op": "service.status"});
    assert_eq!(code(&ask(&mut stream, status.clone())), "E_HELLO_REQUIRED");
    assert_eq!(
        code(&ask(&mut stream, json!({"v": 1, "id": "1", "op": "hello"}))),
        "E_BAD_REQUEST"
    );
    hello(&mut stream);
    for (request, expected) in [
        (
            json!({"v": 2, "id": "1", "op": "service.status"}),
            "E_FRAME_VERSION",
        ),
        (
            json!({"v": 1, "id": "1", "op": "graph.status"}),
            "E_UNKNOWN_OP",
        ),
        (
            json!({"v": 1, "id": "1", "op": "service.status@2"}),
            "E_OP_VERSION",
        ),
        (
            json!({"v": 1, "id": "1", "op": "service.status", "private": {"values": {}}}),
            "E_PRIVATE_REFUSED",
        ),
        (
            json!({"v": 1, "id": "1", "op": "service.status", "intent": "ab"}),
            "E_BAD_FRAME",
        ),
        (
            json!({"v": 1, "id": "", "op": "service.status"}),
            "E_BAD_FRAME",
        ),
        // Presence is what counts: an explicit null is refused too.
        (
            json!({"v": 1, "id": "1", "op": "service.status", "private": null}),
            "E_PRIVATE_REFUSED",
        ),
        (
            json!({"v": 1, "id": "1", "op": "service.status", "intent": null}),
            "E_BAD_FRAME",
        ),
    ] {
        assert_eq!(code(&ask(&mut stream, request)), expected);
    }
    assert_eq!(ask(&mut stream, status)["ok"], true);
    // An unknown field closes the session after one refusal.
    let refused = ask(
        &mut stream,
        json!({"v": 1, "id": "1", "op": "hello", "extra": 1}),
    );
    assert_eq!(code(&refused), "E_BAD_FRAME");
    assert_eq!(
        frame::read(&mut stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT),
        Err(frame::FrameError::Closed)
    );
    // An oversized length is refused without reading the body.
    let mut stream = connect(&root.0);
    stream
        .write_all(&((CONTROL_FRAME_LIMIT + 1) as u32).to_be_bytes())
        .unwrap();
    let body = frame::read(&mut stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT).unwrap();
    assert_eq!(
        code(&serde_json::from_slice(&body).unwrap()),
        "E_FRAME_TOO_LARGE"
    );
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[test]
fn concurrent_starts_leave_exactly_one_serving_process() {
    let root = Root::new();
    let barrier = Arc::new(Barrier::new(6));
    let starts: Vec<_> = (0..6)
        .map(|_| {
            let (root, barrier) = (root.0.clone(), Arc::clone(&barrier));
            std::thread::spawn(move || {
                barrier.wait();
                serve(
                    &root,
                    Options {
                        idle: Duration::from_millis(400),
                    },
                    None,
                )
            })
        })
        .collect();
    let outcomes: Vec<_> = starts
        .into_iter()
        .map(|t| t.join().unwrap().unwrap())
        .collect();
    assert_eq!(
        outcomes.iter().filter(|o| **o != Outcome::Lost).count(),
        1,
        "{outcomes:?}"
    );
    assert!(outcomes.contains(&Outcome::Idle));
}

#[test]
fn a_loser_announces_lost_and_never_touches_the_winners_socket() {
    let root = Root::new();
    let (handle, ready) = spawn(&root.0, Duration::from_secs(30));
    let (_second, lost) = spawn(&root.0, Duration::from_secs(30));
    assert_eq!(lost, json!({"lost": true}));
    let status = call(&root.0, "service.status", json!({})).unwrap();
    assert_eq!(status["service"]["epoch"], ready["ready"]["epoch"]);
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[test]
fn a_stale_socket_is_replaced_and_a_planted_file_is_refused() {
    let root = Root::new();
    let socket = paths(&root.0).socket;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(paths(&root.0).dir)
        .unwrap();
    drop(UnixListener::bind(&socket).unwrap());
    assert!(socket.symlink_metadata().unwrap().file_type().is_socket());
    let (handle, ready) = spawn(&root.0, Duration::from_secs(30));
    assert!(ready["ready"].is_object(), "{ready}");
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();

    std::fs::write(&socket, b"not a socket").unwrap();
    let (handle, refused) = spawn(&root.0, Duration::from_secs(30));
    assert_eq!(
        refused,
        json!({"refused": {"code": "service_socket_path_refused"}})
    );
    assert_eq!(
        handle.join().unwrap().unwrap_err().code,
        "service_socket_path_refused"
    );
    assert_eq!(std::fs::read(&socket).unwrap(), b"not a socket");
}

#[test]
fn a_socket_path_over_the_limit_is_refused_before_the_lock() {
    let root = Root::new();
    let deep = root.0.join("x".repeat(SOCKET_PATH_LIMIT));
    let (handle, refused) = spawn(&deep, Duration::from_secs(30));
    assert_eq!(
        refused,
        json!({"refused": {"code": "service_socket_path_too_long"}})
    );
    assert!(handle.join().unwrap().is_err());
    assert!(!paths(&deep).lock.exists());
}

#[test]
fn idle_exit_stops_listening_and_frees_the_lock() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_millis(200));
    assert_eq!(handle.join().unwrap().unwrap(), Outcome::Idle);
    assert!(!paths(&root.0).socket.exists());
    assert_eq!(
        call(&root.0, "service.status", json!({})).unwrap_err().code,
        "service_absent"
    );
    let lock = try_lock(&paths(&root.0).lock).unwrap();
    assert!(lock.is_some(), "the lock is free after exit");
}

#[test]
fn an_open_session_keeps_the_service_until_it_closes() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_millis(150));
    let mut stream = connect(&root.0);
    hello(&mut stream);
    std::thread::sleep(Duration::from_millis(400));
    assert!(!handle.is_finished());
    drop(stream);
    assert_eq!(handle.join().unwrap().unwrap(), Outcome::Idle);
}

#[test]
fn retire_ends_every_session_before_the_lock_is_released() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_secs(30));
    // One session keeps sending requests as fast as it can.
    let mut busy = connect(&root.0);
    hello(&mut busy);
    let hammer = std::thread::spawn(move || {
        let mut refused = 0;
        loop {
            let request = json!({"v": 1, "id": "9", "op": "service.status"});
            let bytes = serde_json::to_vec(&request).unwrap();
            if frame::write(&mut busy, &bytes, CONTROL_FRAME_LIMIT).is_err() {
                return refused;
            }
            match frame::read(&mut busy, Duration::from_secs(5), CONTROL_FRAME_LIMIT) {
                Ok(body) => {
                    let reply: Value = serde_json::from_slice(&body).unwrap();
                    if reply["ok"] == false {
                        assert_eq!(code(&reply), "E_SERVICE_DRAINING");
                        refused += 1;
                    }
                }
                Err(_) => return refused,
            }
        }
    });
    // Another holds its session open without sending anything.
    let mut quiet = connect(&root.0);
    hello(&mut quiet);
    call(&root.0, "service.retire", json!({})).unwrap();
    assert_eq!(handle.join().unwrap().unwrap(), Outcome::Retired);
    // serve has returned: no session thread is left to answer anyone.
    hammer.join().unwrap();
    assert_eq!(
        frame::read(&mut quiet, Duration::from_secs(2), CONTROL_FRAME_LIMIT),
        Err(frame::FrameError::Closed)
    );
    assert!(try_lock(&paths(&root.0).lock).unwrap().is_some());
    // The next start takes the freed lock and binds a fresh socket.
    let (handle, ready) = spawn(&root.0, Duration::from_secs(30));
    assert!(ready["ready"].is_object());
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[test]
fn connections_queued_at_shutdown_are_refused_and_cannot_hold_it_open() {
    let root = Root::new();
    let paths = paths(&root.0);
    let (listener, lock, id) = start(&paths).unwrap().unwrap();
    let (shared, _wake) = prepare(
        &paths,
        Options {
            idle: Duration::from_secs(30),
        },
        id,
    )
    .unwrap();
    // Two clients connect, the service decides to stop before accepting them,
    // and one of them asks it to retire.
    let mut queued: Vec<_> = (0..2).map(|_| connect(&root.0)).collect();
    shared.stop(Outcome::Idle);
    let retire = json!({"v": 1, "id": "r", "op": "service.retire"});
    for stream in &mut queued {
        let bytes = serde_json::to_vec(&retire).unwrap();
        frame::write(stream, &bytes, CONTROL_FRAME_LIMIT).unwrap();
    }
    let started = Instant::now();
    assert_eq!(shut_down(&shared, listener), Outcome::Idle);
    assert!(started.elapsed() < Duration::from_secs(3));
    for stream in &mut queued {
        // Either the refusal before admission, or the close that follows it.
        if let Ok(body) = frame::read(stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT) {
            assert_eq!(
                code(&serde_json::from_slice(&body).unwrap()),
                "E_SERVICE_DRAINING"
            );
        }
        assert_eq!(
            frame::read(stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT),
            Err(frame::FrameError::Closed)
        );
    }
    assert!(!paths.socket.exists());
    drop(lock);
}

#[test]
fn a_failure_after_bind_is_refused_and_leaves_no_socket() {
    let root = Root::new();
    let paths = paths(&root.0);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&paths.record)
        .unwrap();
    let (handle, refused) = spawn(&root.0, Duration::from_secs(30));
    assert_eq!(refused, json!({"refused": {"code": "service_io"}}));
    assert!(handle.join().unwrap().is_err());
    assert!(paths.socket.symlink_metadata().is_err());
    assert!(try_lock(&paths.lock).unwrap().is_some());
}

#[test]
fn a_lock_file_that_is_not_private_or_is_a_symlink_is_refused() {
    let root = Root::new();
    let paths = paths(&root.0);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&paths.dir)
        .unwrap();
    std::fs::write(&paths.lock, b"").unwrap();
    std::fs::set_permissions(&paths.lock, std::fs::Permissions::from_mode(0o644)).unwrap();
    let (handle, refused) = spawn(&root.0, Duration::from_secs(30));
    assert_eq!(
        refused,
        json!({"refused": {"code": "service_lock_refused"}})
    );
    assert!(handle.join().unwrap().is_err());
    std::fs::remove_file(&paths.lock).unwrap();
    let target = root.0.join("elsewhere.lock");
    std::fs::write(&target, b"").unwrap();
    std::os::unix::fs::symlink(&target, &paths.lock).unwrap();
    let (handle, refused) = spawn(&root.0, Duration::from_secs(30));
    assert_eq!(
        refused,
        json!({"refused": {"code": "service_lock_refused"}})
    );
    assert!(handle.join().unwrap().is_err());
    assert!(!paths.socket.exists());
}

#[test]
fn a_client_never_reaches_another_homes_service_through_a_symlink() {
    let (a, b) = (Root::new(), Root::new());
    let (handle, ready) = spawn(&b.0, Duration::from_secs(30));
    // Home A's service directory is a symlink to home B's.
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(a.0.join("run"))
        .unwrap();
    std::os::unix::fs::symlink(paths(&b.0).dir, paths(&a.0).dir).unwrap();
    assert_eq!(
        call(&a.0, "service.retire", json!({})).unwrap_err().code,
        "aliased_state"
    );
    let status = call(&b.0, "service.status", json!({})).unwrap();
    assert_eq!(status["service"]["epoch"], ready["ready"]["epoch"]);
    call(&b.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn a_client_gives_up_on_a_full_backlog_within_its_deadline() {
    use std::os::fd::FromRawFd;
    let root = Root::new();
    let paths = paths(&root.0);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&paths.dir)
        .unwrap();
    let listener = UnixListener::bind(&paths.socket).unwrap();
    // A backlog of one (Linux lets listen shrink it), then fill it with
    // non-blocking connections nobody accepts.
    // SAFETY: re-listening on our own bound socket.
    assert_eq!(
        unsafe { libc::listen(std::os::fd::AsRawFd::as_raw_fd(&listener), 1) },
        0
    );
    let mut pending = Vec::new();
    for _ in 0..64 {
        // SAFETY: plain socket creation, owned below.
        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_NONBLOCK, 0) };
        assert!(fd >= 0);
        // SAFETY: a fresh descriptor, wrapped once.
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        // SAFETY: an all-zero sockaddr_un is valid; the path fits (checked above).
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (slot, byte) in address
            .sun_path
            .iter_mut()
            .zip(paths.socket.as_os_str().as_encoded_bytes())
        {
            *slot = *byte as libc::c_char;
        }
        let length = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        // SAFETY: a valid address and length.
        if unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), length) } != 0
        {
            break;
        }
        pending.push(stream);
    }
    let started = Instant::now();
    let refused = super::client::call_within(
        &root.0,
        "service.status",
        json!({}),
        Duration::from_millis(300),
    );
    assert_eq!(refused.unwrap_err().code, "service_busy");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    drop(listener);
}
