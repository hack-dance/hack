//! HACK-2460: one runtime service per native home, started on demand by its
//! clients. The design model is `tests/models/tla/runtime-service`; this module
//! implements its `TakeLock`, `LoseRace`, `Bind`, `IdleExit`, `Retire` and
//! `ExitDrained` actions. Only `hello`, `service.status` and `service.retire` are
//! served, and nothing in the CLI calls the service yet.
//!
//! Ownership: the process holding the exclusive `flock` on `service.lock` is the
//! only one that may remove a stale socket path and bind it (`OneOwner`). The lock
//! is held until the process exits, also while it drains, and the kernel frees it
//! on a crash. The socket path is unlinked only while it still names this
//! process's own socket.
//!
//! Memory is never authority: a kill at any moment loses only open sessions. The
//! advisory `service.json` is for diagnostics and is never read for decisions.
pub mod frame;

use crate::CandidateError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub use frame::CONTROL_FRAME_LIMIT;

pub const FRAME_VERSION: u32 = 1;
pub const MAX_SESSIONS: usize = 32;
/// macOS `sun_path` holds 104 bytes including the terminating NUL; one rule everywhere.
pub const SOCKET_PATH_LIMIT: usize = 103;
const SESSION_IDLE: Duration = Duration::from_secs(30);
const CLIENT_DEADLINE: Duration = Duration::from_secs(5);
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

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Another process holds `service.lock`; this one never bound the socket.
    Lost,
    /// Idle bound reached: stopped listening, served what was queued, exited.
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

/// Serve until idle or retired. `ready` receives exactly one JSON line:
/// `{"ready":{…}}`, `{"lost":true}` or `{"refused":{"code":…}}`.
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
    let started = start(state_root);
    let (listener, lock, socket_id) = match started {
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
    let paths = paths(state_root);
    let identity = Identity::new()?;
    write_record(&paths.record, &identity)?;
    announce(json!({"ready": identity.public()}));
    let (wake_tx, wake_rx) = UnixStream::pair().map_err(|e| failure("service_io", e))?;
    // Both ends non-blocking: a full wake buffer must never stall a session
    // thread, and one pending byte is enough to wake the accept loop.
    for end in [&wake_tx, &wake_rx] {
        end.set_nonblocking(true)
            .map_err(|e| failure("service_io", e))?;
    }
    let shared = Arc::new(Shared {
        identity,
        idle: options.idle,
        socket: paths.socket.clone(),
        socket_id,
        state: Mutex::new(State {
            sessions: 0,
            busy: 0,
            draining: false,
            last_activity: Instant::now(),
        }),
        changed: Condvar::new(),
        wake: wake_tx,
    });
    let outcome = run(&shared, listener, &wake_rx);
    remove_own_record(&paths.record, &shared.identity.epoch);
    drop(lock);
    outcome
}

/// `TakeLock` then `Bind`, or `LoseRace`. Returns `None` when the lock is held.
/// The bound listener, the held lock, and the `(dev, ino)` of the socket it bound.
type Bound = (UnixListener, File, (u64, u64));

fn start(state_root: &Path) -> Result<Option<Bound>, CandidateError> {
    let paths = paths(state_root);
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
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| failure("service_io", e))?;
    let m = paths
        .socket
        .symlink_metadata()
        .map_err(|e| failure("service_io", e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| failure("service_io", e))?;
    Ok(Some((listener, lock, (m.dev(), m.ino()))))
}

fn private_directory(dir: &Path) -> Result<(), CandidateError> {
    crate::reject_aliased_state(dir)?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| failure("service_io", e))?;
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
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| failure("service_io", e))?;
    // SAFETY: a valid owned descriptor; the lock is released when `file` closes.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    match std::io::Error::last_os_error() {
        e if e.kind() == ErrorKind::WouldBlock => Ok(None),
        e => Err(failure("service_io", e)),
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
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|e| failure("service_io", e))?;
    let mut value = identity.public();
    value["started_at_ms"] = json!(identity.started_at_ms as u64);
    writeln!(file, "{value}").map_err(|e| failure("service_io", e))?;
    std::fs::rename(&temporary, record).map_err(|e| failure("service_io", e))
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
    draining: bool,
    last_activity: Instant,
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
        let _ = (&self.wake).write(&[1]);
    }
    /// Unlink the socket path only while it still names this process's socket.
    fn unlink_own_socket(&self) {
        if let Ok(m) = self.socket.symlink_metadata() {
            if (m.dev(), m.ino()) == self.socket_id {
                let _ = std::fs::remove_file(&self.socket);
            }
        }
    }
}

fn run(
    shared: &Arc<Shared>,
    listener: UnixListener,
    wake: &UnixStream,
) -> Result<Outcome, CandidateError> {
    loop {
        let timeout = {
            let state = shared.state();
            if state.draining {
                break;
            }
            (state.sessions == 0 && state.busy == 0)
                .then(|| shared.idle.saturating_sub(state.last_activity.elapsed()))
        };
        if timeout == Some(Duration::ZERO) {
            // `IdleExit`: stop listening first, serve whatever was already queued,
            // then exit once those sessions are done.
            shared.unlink_own_socket();
            accept_all(shared, &listener);
            drop(listener);
            wait_until(shared, |s| s.sessions == 0 && s.busy == 0);
            return Ok(Outcome::Idle);
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
        // SAFETY: two initialized pollfd entries that outlive the call.
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, millis) } < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() != ErrorKind::Interrupted {
                return Err(failure("service_io", e));
            }
        }
        let mut sink = [0u8; 64];
        while matches!((&*wake).read(&mut sink), Ok(n) if n > 0) {}
        accept_all(shared, &listener);
    }
    // `ExitDrained`: the socket path is already gone; finish requests in progress.
    drop(listener);
    wait_until(shared, |s| s.busy == 0);
    Ok(Outcome::Retired)
}

fn wait_until(shared: &Shared, done: impl Fn(&State) -> bool) {
    let mut state = shared.state();
    while !done(&state) {
        state = shared
            .changed
            .wait(state)
            .unwrap_or_else(|p| p.into_inner());
    }
}

fn accept_all(shared: &Arc<Shared>, listener: &UnixListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let admitted = {
            let mut state = shared.state();
            let admitted = state.sessions < MAX_SESSIONS;
            if admitted {
                state.sessions += 1;
                state.last_activity = Instant::now();
            }
            admitted
        };
        if !admitted {
            let _ = stream.set_nonblocking(false);
            let _ = reply(
                &mut stream,
                &Value::Null,
                Err(("E_SESSION_LIMIT", "Too many sessions.")),
            );
            continue;
        }
        let shared = Arc::clone(shared);
        std::thread::spawn(move || {
            session(&shared, stream);
            let mut state = shared.state();
            state.sessions -= 1;
            state.last_activity = Instant::now();
            drop(state);
            shared.changed.notify_all();
            shared.wake();
        });
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u32,
    id: String,
    op: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    intent: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    private: Option<serde::de::IgnoredAny>,
}

type Refusal = (&'static str, &'static str);

fn session(shared: &Shared, mut stream: UnixStream) {
    if stream.set_nonblocking(false).is_err() || crate::node::peer_uid(&stream).ok() != Some(euid())
    {
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
        let Ok(request) = serde_json::from_slice::<Request>(&body) else {
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
            if state.draining {
                drop(state);
                let refused = Err(("E_SERVICE_DRAINING", "The service is retiring."));
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
    if request.v != FRAME_VERSION {
        return Err(("E_FRAME_VERSION", "Unsupported frame version."));
    }
    if request.id.is_empty()
        || request.id.len() > 64
        || request.session.as_ref().is_some_and(|s| s.len() > 64)
    {
        return Err(("E_BAD_FRAME", "Request id or session out of bounds."));
    }
    if request.private.is_some() {
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
    if request.intent.is_some() {
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
            // `Retire`: unlink at once so the next client starts a fresh process,
            // which waits for this one's lock; refuse everything after this reply.
            shared.state().draining = true;
            shared.unlink_own_socket();
            shared.wake();
            Ok(json!({"schema": "hack.runtime.service.retire.v1", "draining": true}))
        }
    }
}

/// TIMINGS HOOK (hack.timings/1, HACK-2458): finished span lines for the request
/// go back with its reply once the record types land; never on stdout or stderr.
fn reply(stream: &mut UnixStream, id: &Value, result: Result<Value, Refusal>) -> Result<(), ()> {
    let value = match result {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        // Nothing in this slice has effects, so no refusal is ever admitted.
        Err((code, message)) => json!({
            "id": id, "ok": false,
            "error": {"code": code, "message": message, "admitted": false},
        }),
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
    frame::write(stream, &bytes, CONTROL_FRAME_LIMIT).map_err(|_| ())
}

/// One request on a fresh session: `hello`, then `op`. Checks the server's uid.
pub fn call(state_root: &Path, op: &str, args: Value) -> Result<Value, CandidateError> {
    let socket = paths(state_root).socket;
    let mut stream = UnixStream::connect(&socket).map_err(|e| match e.kind() {
        ErrorKind::NotFound | ErrorKind::ConnectionRefused => {
            failure("service_absent", "No runtime service is serving this home.")
        }
        _ => failure("service_io", e),
    })?;
    if crate::node::peer_uid(&stream)? != euid() {
        return Err(failure(
            "service_foreign",
            "The service runs as another user.",
        ));
    }
    let mut ask = |id: &str, op: &str, args: Value| -> Result<Value, CandidateError> {
        let request = json!({"v": FRAME_VERSION, "id": id, "op": op, "args": args});
        let bytes = serde_json::to_vec(&request).map_err(|e| failure("service_io", e))?;
        frame::write(&mut stream, &bytes, CONTROL_FRAME_LIMIT)
            .map_err(|e| failure("service_io", format!("{e:?}")))?;
        let body = frame::read(&mut stream, CLIENT_DEADLINE, CONTROL_FRAME_LIMIT)
            .map_err(|e| failure("service_io", format!("{e:?}")))?;
        let mut value: Value =
            serde_json::from_slice(&body).map_err(|e| failure("service_io", e))?;
        if value["ok"] == true {
            return Ok(value["result"].take());
        }
        Err(failure(
            "service_refused",
            format!("{} {}", value["error"]["code"], value["error"]["message"]),
        ))
    };
    ask("1", "hello", json!({"client": {"kind": "cli"}}))?;
    ask("2", op, args)
}

#[cfg(test)]
mod tests;
