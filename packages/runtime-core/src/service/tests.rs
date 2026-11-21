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

/// Only a hang can break this bound; the tests prove their properties from
/// results, never from how long a loaded machine took.
const HANG_GUARD: Duration = Duration::from_secs(30);

/// Run `f` on its own thread and fail if it has not returned within `HANG_GUARD`.
fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(f());
    });
    received
        .recv_timeout(HANG_GUARD)
        .expect("the call did not return: it hung")
}

/// Whether `service.lock` becomes free within ten seconds. Another test thread
/// that forks (one test re-runs this binary) briefly shares every open file
/// description, the lock's included, until its child execs and O_CLOEXEC closes
/// it, so a free lock can look held for that moment.
fn lock_frees(path: &Path) -> bool {
    let started = Instant::now();
    loop {
        if try_lock(path).unwrap().is_some() {
            return true;
        }
        // A bound for the retry only, generous for a loaded machine.
        if started.elapsed() > Duration::from_secs(10) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn hello_and_status_name_this_build_and_process() {
    let root = Root::new();
    let (handle, ready) = spawn(&root.0, Duration::from_secs(30));
    let service = &ready["listening"];
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
    assert_eq!(status["service"]["epoch"], ready["listening"]["epoch"]);
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
    assert!(ready["listening"].is_object(), "{ready}");
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
    assert!(
        lock_frees(&paths(&root.0).lock),
        "the lock is free after exit"
    );
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
    assert!(lock_frees(&paths(&root.0).lock));
    // The next start takes the freed lock and binds a fresh socket.
    let (handle, ready) = spawn(&root.0, Duration::from_secs(30));
    assert!(ready["listening"].is_object());
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
    let stopping = Arc::clone(&shared);
    assert_eq!(
        within(move || shut_down(&stopping, listener)),
        Outcome::Idle
    );
    for stream in &mut queued {
        let body = frame::read(stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT).unwrap();
        assert_eq!(
            code(&serde_json::from_slice(&body).unwrap()),
            "E_SERVICE_DRAINING"
        );
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
    assert!(lock_frees(&paths.lock));
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
    assert_eq!(status["service"]["epoch"], ready["listening"]["epoch"]);
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
    // A connect without its own deadline would block forever on the full
    // backlog: the hang guard is the proof.
    let home = root.0.clone();
    let refused = within(move || {
        super::client::call_within(
            &home,
            "service.status",
            json!({}),
            Duration::from_millis(300),
        )
    });
    assert_eq!(refused.unwrap_err().code, "service_busy");
    drop(listener);
}

#[test]
fn a_duplicate_field_is_refused_and_never_acted_on() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_secs(30));
    let mut stream = connect(&root.0);
    hello(&mut stream);
    let raw = br#"{"v":1,"id":"1","op":"service.status","op":"service.retire"}"#;
    frame::write(&mut stream, raw, CONTROL_FRAME_LIMIT).unwrap();
    let body = frame::read(&mut stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT).unwrap();
    assert_eq!(code(&serde_json::from_slice(&body).unwrap()), "E_BAD_FRAME");
    // Still serving: nothing retired it.
    assert!(call(&root.0, "service.status", json!({})).is_ok());
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[test]
fn the_session_limit_reaches_the_client_as_a_refusal() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_secs(30));
    let open: Vec<_> = (0..MAX_SESSIONS)
        .map(|_| {
            let mut stream = connect(&root.0);
            hello(&mut stream);
            stream
        })
        .collect();
    let refused = call(&root.0, "service.status", json!({})).unwrap_err();
    assert_eq!(refused.code, "service_refused");
    assert!(
        refused.message.contains("E_SESSION_LIMIT"),
        "{}",
        refused.message
    );
    drop(open);
    // Sessions end asynchronously; the slots free up shortly.
    let started = Instant::now();
    while call(&root.0, "service.status", json!({})).is_err() {
        assert!(
            started.elapsed() < HANG_GUARD,
            "the session slots never freed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[test]
fn a_request_queued_before_idle_expiry_gets_a_refusal_not_silence() {
    let root = Root::new();
    let paths = paths(&root.0);
    let (listener, lock, id) = start(&paths).unwrap().unwrap();
    let options = Options {
        idle: Duration::from_secs(30),
    };
    let (shared, _wake) = prepare(&paths, options, id).unwrap();
    let mut queued = connect(&root.0);
    let hello = json!({"v": 1, "id": "h", "op": "hello", "args": {"client": {"kind": "cli"}}});
    let bytes = serde_json::to_vec(&hello).unwrap();
    frame::write(&mut queued, &bytes, CONTROL_FRAME_LIMIT).unwrap();
    shared.stop(Outcome::Idle);
    assert_eq!(shut_down(&shared, listener), Outcome::Idle);
    let body = frame::read(&mut queued, Duration::from_secs(2), CONTROL_FRAME_LIMIT).unwrap();
    let reply: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["id"], "h");
    assert_eq!(code(&reply), "E_SERVICE_DRAINING");
    drop(lock);
}

#[test]
fn a_positional_array_or_a_null_session_is_refused_and_never_acted_on() {
    let root = Root::new();
    let (handle, _) = spawn(&root.0, Duration::from_secs(30));
    for raw in [
        &br#"[1,"r","service.retire"]"#[..],
        br#"{"v":1,"id":"1","op":"service.retire","session":null}"#,
        br#"{"v":1,"id":"1","op":"service.retire","session":7}"#,
    ] {
        let mut stream = connect(&root.0);
        hello(&mut stream);
        frame::write(&mut stream, raw, CONTROL_FRAME_LIMIT).unwrap();
        let body = frame::read(&mut stream, Duration::from_secs(2), CONTROL_FRAME_LIMIT).unwrap();
        assert_eq!(code(&serde_json::from_slice(&body).unwrap()), "E_BAD_FRAME");
        assert!(call(&root.0, "service.status", json!({})).is_ok());
    }
    call(&root.0, "service.retire", json!({})).unwrap();
    handle.join().unwrap().unwrap();
}

#[test]
fn partial_requests_queued_at_shutdown_cannot_hold_the_lock() {
    let root = Root::new();
    let paths = paths(&root.0);
    let (listener, lock, id) = start(&paths).unwrap().unwrap();
    let options = Options {
        idle: Duration::from_secs(30),
    };
    let (shared, _wake) = prepare(&paths, options, id).unwrap();
    // Each queued peer sends one header byte and then nothing, keeping its end open.
    let stalled: Vec<_> = (0..24)
        .map(|_| {
            let mut stream = connect(&root.0);
            stream.write_all(&[0]).unwrap();
            stream
        })
        .collect();
    shared.stop(Outcome::Idle);
    // Both paths that refuse queued connections draw on the same budget, so at
    // most QUEUED_BUDGET / QUEUED_WAIT of the 24 stalled peers are waited on
    // (fewer when the machine is slow); without the shared cap all 24 are.
    accept_queued(&shared, &listener).unwrap();
    let stopping = Arc::clone(&shared);
    assert_eq!(
        within(move || shut_down(&stopping, listener)),
        Outcome::Idle
    );
    let waited = shared.state().refused;
    let cap = (QUEUED_BUDGET.as_millis() / QUEUED_WAIT.as_millis()) as usize + 1;
    assert!(
        waited <= cap,
        "{waited} queued peers were waited on, cap {cap}"
    );
    drop(stalled);
    drop(lock);
}

#[test]
fn a_connection_accepted_after_stop_is_refused_not_handed_to_a_worker() {
    // The interleaving where a retire wakes the accept loop while a client is
    // queued: stopping is already set when accept_queued takes the connection.
    let root = Root::new();
    let paths = paths(&root.0);
    let (listener, lock, id) = start(&paths).unwrap().unwrap();
    let options = Options {
        idle: Duration::from_secs(30),
    };
    let (shared, _wake) = prepare(&paths, options, id).unwrap();
    let mut queued = connect(&root.0);
    let hello = json!({"v": 1, "id": "q", "op": "hello", "args": {"client": {"kind": "cli"}}});
    let bytes = serde_json::to_vec(&hello).unwrap();
    frame::write(&mut queued, &bytes, CONTROL_FRAME_LIMIT).unwrap();
    shared.stop(Outcome::Retired);
    accept_queued(&shared, &listener).unwrap();
    assert_eq!(shared.state().sessions, 0, "no worker was started");
    let body = frame::read(&mut queued, Duration::from_secs(2), CONTROL_FRAME_LIMIT).unwrap();
    let reply: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(reply["id"], "q");
    assert_eq!(code(&reply), "E_SERVICE_DRAINING");
    assert_eq!(shut_down(&shared, listener), Outcome::Retired);
    drop(lock);
}
