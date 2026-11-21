//! HACK-2460: one runtime service per native home, started on demand by its
//! clients. The design model is `tests/models/tla/runtime-service`; this module
//! implements its `TakeLock`, `LoseRace`, `Bind`, `IdleExit`, `Retire` and
//! `ExitDrained` actions. Only `hello`, `service.status` and `service.retire` are
//! served, and nothing in the CLI calls the service yet.
//!
//! Ownership: the process holding the exclusive `flock` on `service.lock` is the
//! only one that may remove a stale socket path and bind it (`OneOwner`). The lock
//! is held until `serve` returns, which happens only after every session thread
//! has ended, and the kernel frees it on a crash. The socket path is unlinked only
//! while it still names this process's own socket.
//!
//! Shutdown, for idle exit and retire alike: stop accepting new requests, unlink
//! the socket, accept what is already queued only to refuse it before admission,
//! wait for requests already admitted, then shut every session socket down and
//! wait for its thread.
//!
//! Memory is never authority: a kill at any moment loses only open sessions. The
//! advisory `service.json` is for diagnostics and is never read for decisions.
mod client;
pub mod frame;

use crate::CandidateError;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub use client::call;
pub use frame::CONTROL_FRAME_LIMIT;

pub const FRAME_VERSION: u32 = 1;
pub const MAX_SESSIONS: usize = 32;
/// macOS `sun_path` holds 104 bytes including the terminating NUL; one rule everywhere.
pub const SOCKET_PATH_LIMIT: usize = 103;
const SESSION_IDLE: Duration = Duration::from_secs(30);
/// Pause before accepting again after the process ran out of descriptors or memory.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);
/// How long one connection queued at shutdown may take to deliver its whole
/// first request and receive the refusal.
const QUEUED_WAIT: Duration = Duration::from_millis(50);
/// The whole time shutdown spends refusing queued connections.
const QUEUED_BUDGET: Duration = Duration::from_millis(500);
const OPS: [&str; 3] = ["hello", "service.status", "service.retire"];

/// Files of the service under a home's state root, all inside one 0700 directory.
pub struct Paths {
    pub dir: PathBuf,
    pub lock: PathBuf,
    pub socket: PathBuf,
    pub record: PathBuf,
}

pub fn paths(state_root: &Path) -> Paths {
    let dir = state_root.join("run").join("service");
    Paths {
        lock: dir.join("service.lock"),
        socket: dir.join("hack-runtime.sock"),
        record: dir.join("service.json"),
        dir,
    }
}

pub struct Options {
    /// Exit after this long with no session and no request in progress.
    pub idle: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Another process holds `service.lock`; this one never bound the socket.
    Lost,
    /// Idle bound reached: stopped listening, refused what was queued, exited.
    Idle,
    /// Asked to retire: unlinked the socket, refused new requests, exited.
    Retired,
}

fn failure(code: &'static str, message: impl ToString) -> CandidateError {
    CandidateError::new(code, message.to_string())
}

fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

/// Serve until idle or retired. `ready` (the starter's descriptor) receives
/// exactly one JSON line: `{"listening":{…}}` once the socket is bound and every
/// startup step worked, `{"lost":true}`, or `{"refused":{"code":…}}` for any
/// failure before that. "Listening" is not "ready": a client treats the service
/// as ready only when a `hello` over the socket has succeeded (an end-to-end
/// request on the path it will use), never because the socket exists or the
/// process is up.
pub fn serve(
    state_root: &Path,
    options: Options,
    mut ready: Option<File>,
) -> Result<Outcome, CandidateError> {
    let mut announce = |line: Value| {
        if let Some(mut file) = ready.take() {
            // The starter may already have given up; that never stops the service.
            let _ = writeln!(file, "{line}");
        }
    };
    let paths = paths(state_root);
    let (listener, lock, socket_id) = match start(&paths) {
        Ok(Some(started)) => started,
        Ok(None) => {
            announce(json!({"lost": true}));
            return Ok(Outcome::Lost);
        }
        Err(error) => {
            announce(json!({"refused": {"code": error.code}}));
            return Err(error);
        }
    };
    let (shared, wake) = match prepare(&paths, options, socket_id) {
        Ok(prepared) => prepared,
        Err(error) => {
            // Still holding the lock: remove what this process created, then refuse.
            drop(listener);
            unlink_if(&paths.socket, socket_id);
            announce(json!({"refused": {"code": error.code}}));
            return Err(error);
        }
    };
    announce(json!({"listening": shared.identity.public()}));
    let outcome = run(&shared, listener, &wake);
    remove_own_record(&paths.record, &shared.identity.epoch);
    drop(lock);
    Ok(outcome)
}

/// `TakeLock` then `Bind`, or `LoseRace`. Returns `None` when the lock is held.
/// The bound listener, the held lock, and the `(dev, ino)` of the socket it bound.
type Bound = (UnixListener, File, (u64, u64));

fn start(paths: &Paths) -> Result<Option<Bound>, CandidateError> {
    private_directory(&paths.dir)?;
    if paths.socket.as_os_str().len() > SOCKET_PATH_LIMIT {
        return Err(failure(
            "service_socket_path_too_long",
            format!("The service socket path is longer than {SOCKET_PATH_LIMIT} bytes."),
        ));
    }
    let Some(lock) = try_lock(&paths.lock)? else {
        return Ok(None);
    };
    match paths.socket.symlink_metadata() {
        Ok(m) if m.file_type().is_socket() && m.uid() == euid() => {
            std::fs::remove_file(&paths.socket).map_err(|e| failure("service_io", e))?
        }
        Ok(_) => {
            return Err(failure(
                "service_socket_path_refused",
                "The service socket path is not a socket owned by this user.",
            ));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(failure("service_io", e)),
    }
    let listener = UnixListener::bind(&paths.socket).map_err(|e| failure("service_bind", e))?;
    let m = paths
        .socket
        .symlink_metadata()
        .map_err(|e| failure("service_io", e))?;
    let id = (m.dev(), m.ino());
    let finish = || -> std::io::Result<()> {
        std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)
    };
    if let Err(e) = finish() {
        unlink_if(&paths.socket, id);
        return Err(failure("service_io", e));
    }
    Ok(Some((listener, lock, id)))
}

/// Everything fallible after bind, so "listening" is announced only once it all worked.
fn prepare(
    paths: &Paths,
    options: Options,
    socket_id: (u64, u64),
) -> Result<(Arc<Shared>, UnixStream), CandidateError> {
    let identity = Identity::new()?;
    let (wake_tx, wake_rx) = UnixStream::pair().map_err(|e| failure("service_io", e))?;
    // Both ends non-blocking: a full wake buffer must never stall a session
    // thread, and one pending byte is enough to wake the accept loop.
    for end in [&wake_tx, &wake_rx] {
        end.set_nonblocking(true)
            .map_err(|e| failure("service_io", e))?;
    }
    write_record(&paths.record, &identity)?;
    let shared = Arc::new(Shared {
        identity,
        idle: options.idle,
        socket: paths.socket.clone(),
        socket_id,
        state: Mutex::new(State {
            sessions: 0,
            busy: 0,
            stopping: None,
            refuse_until: None,
            refused: 0,
            queued_wait: QUEUED_WAIT,
            last_activity: Instant::now(),
            streams: HashMap::new(),
            next_session: 0,
        }),
        changed: Condvar::new(),
        wake: wake_tx,
    });
    Ok((shared, wake_rx))
}

fn private_directory(dir: &Path) -> Result<(), CandidateError> {
    crate::reject_aliased_state(dir)?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| failure("service_io", e))?;
    check_private_directory(dir)
}

fn check_private_directory(dir: &Path) -> Result<(), CandidateError> {
    let m = dir
        .symlink_metadata()
        .map_err(|e| failure("service_io", e))?;
    if !m.is_dir() || m.uid() != euid() || m.mode() & 0o077 != 0 {
        return Err(failure(
            "service_directory_refused",
            "The service directory must be owned by this user with mode 0700.",
        ));
    }
    Ok(())
}

fn try_lock(path: &Path) -> Result<Option<File>, CandidateError> {
    let refused = || {
        failure(
            "service_lock_refused",
            "service.lock must be a regular file owned by this user with mode 0600.",
        )
    };
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) => refused(),
            _ => failure("service_io", e),
        })?;
    // Check what was opened, not the path: an existing file keeps its own mode.
    let m = file.metadata().map_err(|e| failure("service_io", e))?;
    if !m.is_file() || m.uid() != euid() || m.mode() & 0o077 != 0 {
        return Err(refused());
    }
    // SAFETY: a valid owned descriptor; the lock is released when `file` closes.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    match std::io::Error::last_os_error() {
        e if e.kind() == ErrorKind::WouldBlock => Ok(None),
        e => Err(failure("service_io", e)),
    }
}

fn unlink_if(path: &Path, id: (u64, u64)) {
    if let Ok(m) = path.symlink_metadata() {
        if (m.dev(), m.ino()) == id {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct Identity {
    pid: u32,
    epoch: String,
    started_at_ms: u128,
}

impl Identity {
    fn new() -> Result<Self, CandidateError> {
        let mut bytes = [0u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut bytes))
            .map_err(|e| failure("service_io", e))?;
        Ok(Self {
            pid: std::process::id(),
            epoch: bytes.iter().map(|b| format!("{b:02x}")).collect(),
            started_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        })
    }
    fn public(&self) -> Value {
        json!({
            "pid": self.pid,
            "epoch": self.epoch,
            "build_id": env!("HACK_RUNTIME_BUILD_ID"),
            "version": crate::CANDIDATE_VERSION,
        })
    }
}

/// Advisory only: `hack doctor` may show it; nothing decides from it.
fn write_record(record: &Path, identity: &Identity) -> Result<(), CandidateError> {
    let temporary = record.with_extension(format!("json.{}", identity.pid));
    let _ = std::fs::remove_file(&temporary);
    let written = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        let mut value = identity.public();
        value["started_at_ms"] = json!(identity.started_at_ms as u64);
        writeln!(file, "{value}")?;
        std::fs::rename(&temporary, record)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(failure("service_io", e));
    }
    Ok(())
}

fn remove_own_record(record: &Path, epoch: &str) {
    let ours = std::fs::read(record)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|value| value["epoch"] == epoch);
    if ours {
        let _ = std::fs::remove_file(record);
    }
}

struct State {
    sessions: usize,
    busy: usize,
    /// Set once, by idle expiry or retire; every later request is refused.
    stopping: Option<Outcome>,
    /// When stopping began plus `QUEUED_BUDGET`: queued connections are refused
    /// only until then, on every path, and closed after.
    refuse_until: Option<Instant>,
    /// Queued connections given a chance to be refused since stopping began.
    refused: usize,
    /// How long one queued connection may take to deliver its first request
    /// (`QUEUED_WAIT`; tests set it).
    queued_wait: Duration,
    last_activity: Instant,
    /// A handle to every live session's socket, to shut it down at exit.
    streams: HashMap<u64, UnixStream>,
    next_session: u64,
}

struct Shared {
    identity: Identity,
    idle: Duration,
    socket: PathBuf,
    socket_id: (u64, u64),
    state: Mutex<State>,
    changed: Condvar,
    wake: UnixStream,
}

impl Shared {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn wake(&self) {
        // WouldBlock is fine: unread bytes already wake the loop. EINTR is not.
        while let Err(e) = (&self.wake).write(&[1]) {
            if e.kind() != ErrorKind::Interrupted {
                return;
            }
        }
    }
    fn stop(&self, outcome: Outcome) {
        self.stop_until(outcome, Instant::now() + QUEUED_BUDGET);
    }
    /// `stop`, with the instant until which queued connections are refused
    /// given explicitly (tests set it; the first stop decides it).
    fn stop_until(&self, outcome: Outcome, refuse_until: Instant) {
        let mut state = self.state();
        state.stopping.get_or_insert(outcome);
        state.refuse_until.get_or_insert(refuse_until);
        drop(state);
        // Unlink at once so the next client starts a fresh process, which waits
        // for this one's lock.
        unlink_if(&self.socket, self.socket_id);
        self.wake();
    }
    fn wait_until(&self, done: impl Fn(&State) -> bool) {
        let mut state = self.state();
        while !done(&state) {
            state = self.changed.wait(state).unwrap_or_else(|p| p.into_inner());
        }
    }
}

fn run(shared: &Arc<Shared>, listener: UnixListener, wake: &UnixStream) -> Outcome {
    loop {
        let timeout = {
            let state = shared.state();
            if state.stopping.is_some() {
                break;
            }
            (state.sessions == 0 && state.busy == 0)
                .then(|| shared.idle.saturating_sub(state.last_activity.elapsed()))
        };
        if timeout == Some(Duration::ZERO) {
            shared.stop(Outcome::Idle);
            break;
        }
        let mut fds = [
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: wake.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let millis = timeout.map_or(-1, |t| t.as_millis().clamp(1, i32::MAX as u128) as i32);
        // SAFETY: two initialized pollfd entries that outlive the call. An error
        // (EINTR) simply re-runs the loop.
        unsafe { libc::poll(fds.as_mut_ptr(), 2, millis) };
        let mut sink = [0u8; 64];
        while matches!((&*wake).read(&mut sink), Ok(n) if n > 0) {}
        if accept_queued(shared, &listener).is_err() {
            std::thread::sleep(ACCEPT_BACKOFF);
        }
    }
    shut_down(shared, listener)
}

/// `IdleExit` and `ExitDrained`, one path for both.
fn shut_down(shared: &Arc<Shared>, listener: UnixListener) -> Outcome {
    let budget = shared.state().refuse_until.unwrap_or_else(Instant::now);
    refuse_queued(shared, &listener, budget);
    drop(listener);
    shared.wait_until(|s| s.busy == 0);
    // A session whose next request was not read yet sees a close; nothing it
    // sent was admitted.
    for stream in shared.state().streams.values() {
        let _ = stream.shutdown(Shutdown::Both);
    }
    shared.wait_until(|s| s.sessions == 0);
    shared.state().stopping.unwrap_or(Outcome::Idle)
}

/// Connections queued when the service stops are never served. One whose whole
/// first request arrives in time gets `E_SERVICE_DRAINING` before admission. Each
/// gets at most `QUEUED_WAIT`, and all of them together end at `budget`; after
/// it, closing the listener resets whatever is still queued.
fn refuse_queued(shared: &Shared, listener: &UnixListener, budget: Instant) {
    while Instant::now() < budget {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == ErrorKind::ConnectionAborted => continue,
            Err(_) => return,
        };
        let wait = shared.state().queued_wait;
        refuse(shared, stream, (Instant::now() + wait).min(budget));
    }
}

/// Answer one connection's first request, if it arrives by `by`, with
/// `E_SERVICE_DRAINING`, then close it. Nothing is admitted.
fn refuse(shared: &Shared, mut stream: UnixStream, by: Instant) {
    shared.state().refused += 1;
    if stream.set_nonblocking(false).is_err() || crate::node::peer_uid(&stream).ok() != Some(euid())
    {
        return;
    }
    let Ok(body) = frame::read_by(&mut stream, by, CONTROL_FRAME_LIMIT) else {
        return;
    };
    let id = parse(&body).map_or(Value::Null, |request| json!(request.id));
    let refused = refusal(&id, ("E_SERVICE_DRAINING", "The service is stopping."));
    let _ = frame::write_by(&mut stream, &refused, CONTROL_FRAME_LIMIT, by);
}

/// Accept every queued connection. `Err` only when the process is out of
/// resources; the queue is left for a later attempt.
fn accept_queued(shared: &Arc<Shared>, listener: &UnixListener) -> Result<(), ()> {
    loop {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock => return Ok(()),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == ErrorKind::ConnectionAborted => continue,
            Err(_) => return Err(()),
        };
        // macOS hands out accepted sockets with the listener's O_NONBLOCK.
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        let Ok(handle) = stream.try_clone() else {
            continue;
        };
        let id = {
            let mut state = shared.state();
            if let Some(budget) = state.refuse_until {
                // Stopped while this connection waited: never hand it to a worker.
                drop(state);
                if Instant::now() >= budget {
                    // Out of budget: close it and leave the rest to shut_down.
                    return Ok(());
                }
                let wait = shared.state().queued_wait;
                refuse(shared, stream, (Instant::now() + wait).min(budget));
                continue;
            }
            if state.sessions >= MAX_SESSIONS {
                None
            } else {
                let id = state.next_session;
                state.next_session += 1;
                state.sessions += 1;
                state.streams.insert(id, handle);
                state.last_activity = Instant::now();
                Some(id)
            }
        };
        let Some(id) = id else {
            let _ = reply(
                &mut stream,
                &Value::Null,
                Err(("E_SESSION_LIMIT", "Too many sessions.")),
            );
            continue;
        };
        let worker = Arc::clone(shared);
        let spawned = std::thread::Builder::new()
            .name("hack-service-session".into())
            .spawn(move || {
                session(&worker, stream);
                end_session(&worker, id);
            });
        if spawned.is_err() {
            // The stream moved into the failed closure and is closed with it.
            end_session(shared, id);
            return Err(());
        }
    }
}

fn end_session(shared: &Shared, id: u64) {
    let mut state = shared.state();
    state.sessions -= 1;
    state.streams.remove(&id);
    state.last_activity = Instant::now();
    drop(state);
    shared.changed.notify_all();
    shared.wake();
}

/// Unknown and duplicate fields are refused by the derive.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u64,
    id: String,
    op: String,
    #[serde(default)]
    args: Value,
    #[serde(default, deserialize_with = "text")]
    session: Option<String>,
    /// Field presence, whatever the value, including `null`.
    #[serde(default, rename = "intent", deserialize_with = "present")]
    has_intent: bool,
    #[serde(default, rename = "private", deserialize_with = "present")]
    has_private: bool,
}

/// A string when present; `null` and other types are refused.
fn text<'de, D: Deserializer<'de>>(value: D) -> Result<Option<String>, D::Error> {
    String::deserialize(value).map(Some)
}

fn present<'de, D: Deserializer<'de>>(value: D) -> Result<bool, D::Error> {
    serde::de::IgnoredAny::deserialize(value)?;
    Ok(true)
}

/// A request is a JSON object; the derive would also accept a positional array.
fn parse(body: &[u8]) -> Option<Request> {
    let first = body.iter().find(|byte| !byte.is_ascii_whitespace())?;
    if *first != b'{' {
        return None;
    }
    serde_json::from_slice(body).ok()
}

type Refusal = (&'static str, &'static str);

fn session(shared: &Shared, mut stream: UnixStream) {
    if crate::node::peer_uid(&stream).ok() != Some(euid()) {
        return;
    }
    let mut greeted = false;
    loop {
        let body = match frame::read(&mut stream, SESSION_IDLE, CONTROL_FRAME_LIMIT) {
            Ok(body) => body,
            Err(frame::FrameError::TooLarge(_)) => {
                let _ = reply(
                    &mut stream,
                    &Value::Null,
                    Err(("E_FRAME_TOO_LARGE", "Frame too large.")),
                );
                return;
            }
            Err(_) => return,
        };
        let Some(request) = parse(&body) else {
            let _ = reply(
                &mut stream,
                &Value::Null,
                Err(("E_BAD_FRAME", "Unreadable request.")),
            );
            return;
        };
        let id = json!(request.id);
        {
            let mut state = shared.state();
            if state.stopping.is_some() {
                drop(state);
                let refused = Err(("E_SERVICE_DRAINING", "The service is stopping."));
                if reply(&mut stream, &id, refused).is_err() {
                    return;
                }
                continue;
            }
            state.busy += 1;
            state.last_activity = Instant::now();
        }
        // TIMINGS HOOK (hack.timings/1, HACK-2458): one span per request, step
        // `service.request`, parented on the trace and span ids the client sends.
        // Emits nothing until the HACK-2458 record types land; no local type.
        let result = answer(shared, &mut greeted, &request);
        let written = reply(&mut stream, &id, result);
        let mut state = shared.state();
        state.busy -= 1;
        state.last_activity = Instant::now();
        drop(state);
        shared.changed.notify_all();
        if written.is_err() {
            return;
        }
    }
}

fn answer(shared: &Shared, greeted: &mut bool, request: &Request) -> Result<Value, Refusal> {
    if request.v != u64::from(FRAME_VERSION) {
        return Err(("E_FRAME_VERSION", "Unsupported frame version."));
    }
    if request.id.is_empty()
        || request.id.len() > 64
        || request.session.as_ref().is_some_and(|s| s.len() > 64)
    {
        return Err(("E_BAD_FRAME", "Request id or session out of bounds."));
    }
    if request.has_private {
        return Err((
            "E_PRIVATE_REFUSED",
            "This operation takes no private input.",
        ));
    }
    let (name, version) = request.op.split_once('@').unwrap_or((&request.op, "1"));
    if !OPS.contains(&name) {
        return Err(("E_UNKNOWN_OP", "Unknown operation."));
    }
    if version != "1" {
        return Err(("E_OP_VERSION", "Unsupported operation version."));
    }
    if request.has_intent {
        return Err(("E_BAD_FRAME", "A read operation takes no intent."));
    }
    if name != "hello" && !*greeted {
        return Err(("E_HELLO_REQUIRED", "Send hello first."));
    }
    let identity = shared.identity.public();
    match name {
        "hello" => {
            let kind = request.args.pointer("/client/kind").and_then(Value::as_str);
            if !matches!(kind, Some("cli" | "desktop" | "dashboard")) {
                return Err(("E_BAD_REQUEST", "hello needs client.kind."));
            }
            *greeted = true;
            Ok(json!({
                "schema": "hack.runtime.service.hello.v1",
                "frame": FRAME_VERSION,
                "service": identity,
                "ops": OPS.map(|op| json!({"name": op, "versions": [1]})),
                "limits": {"sessions": MAX_SESSIONS, "control_frame_bytes": CONTROL_FRAME_LIMIT},
            }))
        }
        "service.status" => Ok(json!({
            "schema": "hack.runtime.service.status.v1",
            "service": identity,
            "started_at_ms": shared.identity.started_at_ms as u64,
            "sessions": shared.state().sessions,
            "idle_seconds": shared.idle.as_secs(),
        })),
        _ => {
            // `Retire`: everything after this reply is refused.
            shared.stop(Outcome::Retired);
            Ok(json!({"schema": "hack.runtime.service.retire.v1", "draining": true}))
        }
    }
}

/// TIMINGS HOOK (hack.timings/1, HACK-2458): finished span lines for the request
/// go back with its reply once the record types land; never on stdout or stderr.
fn reply(stream: &mut UnixStream, id: &Value, result: Result<Value, Refusal>) -> Result<(), ()> {
    let bytes = match result {
        Ok(result) => {
            serde_json::to_vec(&json!({"id": id, "ok": true, "result": result})).map_err(|_| ())?
        }
        Err(refused) => refusal(id, refused),
    };
    frame::write(stream, &bytes, CONTROL_FRAME_LIMIT).map_err(|_| ())
}

/// A refusal reply. Nothing in this slice has effects, so none is ever admitted.
fn refusal(id: &Value, (code, message): Refusal) -> Vec<u8> {
    let value = json!({
        "id": id, "ok": false,
        "error": {"code": code, "message": message, "admitted": false},
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

#[cfg(test)]
mod tests;
