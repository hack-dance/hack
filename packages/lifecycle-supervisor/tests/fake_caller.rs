//! Real-process qualification through the framed public protocol. No shell,
//! network, daemon, user HOME or registry is involved.
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs,
    io::{Read, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Once,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const TOKEN: &str = "synthetic-owner-token";
const TIMEOUT: Duration = Duration::from_secs(15);

struct Fixture {
    root: PathBuf,
    owned: RefCell<Vec<Identity>>,
}

/// Name prefix of every fixture root: `supervisor-test-<test pid>-<nonce>-<n>`.
const ROOT_PREFIX: &str = "supervisor-test-";
static STALE_SWEEP: Once = Once::new();

fn fixture_parent() -> PathBuf {
    std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

impl Fixture {
    fn new() -> Self {
        let parent = fixture_parent();
        // A run killed before its fixtures dropped (timeout, Ctrl-C, SIGKILL)
        // leaves their processes behind; the next run reaps them once.
        STALE_SWEEP.call_once(|| reap_stale_fixture_roots(&parent));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = parent.join(format!(
            "{ROOT_PREFIX}{}-{nonce}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self {
            root,
            owned: RefCell::new(Vec::new()),
        }
    }

    fn process(&self, name: &str, mode: &str) -> Value {
        json!({"name":name,"argv":[std::env::current_exe().unwrap(),"--exact","fixture_process","--nocapture"],"cwd":self.root,"env":{"HOME":self.root,"PATH":"/usr/bin:/bin","HACK_DAEMON_AUTOSTART_DISABLE":"1","SUPERVISOR_FIXTURE":mode}})
    }

    fn launch(&self, processes: Vec<Value>) -> Value {
        json!({"version":1,"root":self.root,"ownerToken":TOKEN,"processes":processes})
    }

    fn control(&self, token: &str) -> Value {
        json!({"version":1,"root":self.root,"ownerToken":token})
    }

    #[track_caller]
    fn request(&self, action: &str, request: &Value) -> (Child, Value) {
        let mut child = command(&self.root, action).spawn().unwrap();
        send(child.stdin.as_mut().unwrap(), request);
        // Deliberately retain stdin: frame receipt must not depend on EOF.
        let reply = receive(child.stdout.as_mut().unwrap());
        self.remember(&reply);
        (child, reply)
    }

    fn remember(&self, reply: &Value) {
        for state in reply["processes"].as_array().into_iter().flatten() {
            for field in ["guardPid", "commandPid"] {
                if let Some(id) = state[field].as_i64().and_then(|id| identity(id as i32)) {
                    self.owned.borrow_mut().push(id);
                }
            }
        }
    }

    fn start(&self, processes: Vec<Value>) -> (Child, Value) {
        self.request("run", &self.launch(processes))
    }

    fn start_generation(&self, processes: Vec<Value>, token: &str) -> (Child, Value) {
        let mut plan = self.launch(processes);
        plan["ownerToken"] = json!(token);
        self.request("run", &plan)
    }

    fn stop_generation(&self, token: &str) {
        let (mut stop, _) = self.request("stop", &self.control(token));
        assert!(wait(&mut stop, TIMEOUT).success());
    }

    fn stop(&self) {
        let mut child = command(&self.root, "stop").spawn().unwrap();
        send(child.stdin.as_mut().unwrap(), &self.control(TOKEN));
        drop(child.stdin.take());
        let status = wait(&mut child, TIMEOUT);
        if !status.success() {
            // Receipts contain only identity/phase metadata, never argv/env.
            // Read after the same exit deadline so diagnostic collection cannot
            // change stop admission or hide a resumed-guard timing failure.
            let receipt = receive(child.stdout.as_mut().unwrap());
            panic!("owned stop failed: {receipt}");
        }
    }

    /// Take the fixture's stop lock once its current holder releases it. A
    /// launch writes its ready receipt just before it drops this lock, and a
    /// guard keeps its startup lease until publication, so the lock can still
    /// be held briefly after `start` returns.
    #[track_caller]
    fn take_stop_lock(&self) -> fs::File {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(".stop.lock"))
            .unwrap();
        eventually(|| {
            // SAFETY: flock only borrows this live descriptor.
            (unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0)
                .then_some(())
        });
        lock
    }

    #[track_caller]
    fn state(&self, name: &str) -> Value {
        eventually(|| {
            fs::read(self.root.join(format!("{name}.json")))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
        })
    }

    fn log(&self) -> String {
        fs::read_to_string(self.root.join("lifecycle.log")).unwrap_or_default()
    }

    #[track_caller]
    fn await_log(&self, needle: &str) {
        eventually(|| self.log().contains(needle).then_some(()));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Ask the normal owner first, including after an assertion panic. Stop
        // has a bounded wait and all inputs refer only to this fixture root.
        if let Ok(mut stop) = command(&self.root, "stop").spawn() {
            if let Some(mut stdin) = stop.stdin.take() {
                let bytes = serde_json::to_vec(&self.control(TOKEN)).unwrap_or_default();
                let _ = stdin.write_all(&(bytes.len() as u32).to_be_bytes());
                let _ = stdin.write_all(&bytes);
            }
            let deadline = Instant::now() + Duration::from_secs(8);
            while stop.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = stop.kill();
            let _ = stop.wait();
        }
        // Receipt copies are captured before tests deliberately corrupt state.
        // A still-matching guard or command birth proves the original session
        // still exists. Recheck each enumerated PID's birth before its signal.
        for anchor in self.owned.borrow().iter() {
            if identity(anchor.pid).as_ref() != Some(anchor) {
                continue;
            }
            let mut members: Vec<_> = census()
                .into_iter()
                .filter(|p| p.session == anchor.session)
                .collect();
            members.sort_by_key(|p| p.pid == anchor.session);
            for member in members {
                if identity(member.pid).as_ref() == Some(&member) {
                    // SAFETY: matched kernel birth and session from a live
                    // captured launch identity; no user-owned state is used.
                    unsafe {
                        libc::kill(member.pid, libc::SIGKILL);
                    }
                }
            }
        }
        // Anchors miss processes whose guard and command both exited (forked
        // or TERM-ignoring descendants) and launches whose reply was never
        // recorded (a panic or killed supervisor before `remember`). Every
        // fixture process runs in this root, so reap by working directory.
        let survivors = reap_fixture_processes(&self.root);
        // Keep the root while anything still works in it, so a survivor's
        // recovery state is not lost.
        if survivors.is_empty() && occupants(&self.root).is_empty() {
            let _ = fs::remove_dir_all(&self.root);
        }
        if !survivors.is_empty() && !thread::panicking() {
            panic!(
                "{} fixture process(es) survived teardown: {survivors:?}",
                survivors.len()
            );
        }
    }
}

/// A process seen working in a fixture root, keyed by PID and kernel birth.
/// Unlike [`Identity`] it carries no session: a process that never called
/// `setsid` can share session 1 (launchd on macOS runners), which `identity`
/// rejects so session-wide kills can never reach it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Occupant {
    pid: i32,
    birth: u64,
}

/// Live processes (other than this one) whose working directory is `root`,
/// whatever their executable or session.
fn occupants(root: &Path) -> Vec<Occupant> {
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    all_pids()
        .into_iter()
        .filter(|pid| *pid != std::process::id() as i32)
        .filter(|pid| cwd_of(*pid).as_deref() == Some(root.as_path()))
        .filter_map(|pid| {
            Some(Occupant {
                pid,
                birth: birth_of(pid)?,
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn all_pids() -> Vec<i32> {
    fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<i32> {
    let mut pids = vec![0i32; 65536];
    // SAFETY: initialized vector provides the supplied writable byte count.
    let count =
        unsafe { libc::proc_listpids(1, 0, pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
    if count <= 0 {
        return Vec::new();
    }
    pids.into_iter()
        .take(count as usize / 4)
        .filter(|p| *p > 1)
        .collect()
}

#[cfg(target_os = "linux")]
fn birth_of(pid: i32) -> Option<u64> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    text.rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
fn birth_of(pid: i32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: kernel writes at most the supplied live buffer size.
    let size = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if size as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
        return None;
    }
    // SAFETY: fully written above.
    let info = unsafe { info.assume_init() };
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// SIGKILLs every live process whose working directory is `root` and whose
/// executable is a fixture test binary or the supervisor, until a census finds
/// none or the deadline passes. Each identity is rechecked right before its
/// signal so a reused PID is never hit. Returns the PIDs still present.
fn reap_fixture_processes(root: &Path) -> Vec<i32> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let matched: Vec<_> = occupants(root)
            .into_iter()
            .filter(|p| exe_of(p.pid).is_some_and(|exe| is_fixture_executable(&exe)))
            .collect();
        if matched.is_empty() {
            return Vec::new();
        }
        if Instant::now() >= deadline {
            return matched.into_iter().map(|p| p.pid).collect();
        }
        let canonical = root.canonicalize().ok();
        for member in matched {
            // Recheck birth and root right before the signal: a reused PID
            // has a different birth, a moved process a different cwd.
            if birth_of(member.pid) == Some(member.birth)
                && cwd_of(member.pid).as_deref() == canonical.as_deref()
            {
                // SAFETY: a live fixture or supervisor process working in this
                // fixture's private root, rechecked by birth and cwd.
                unsafe {
                    libc::kill(member.pid, libc::SIGKILL);
                }
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// Reaps and removes fixture roots under `parent` whose owning test process
/// (the PID in the root name) no longer exists.
fn reap_stale_fixture_roots(parent: &Path) {
    for entry in fs::read_dir(parent).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let Some(owner) = name
            .to_str()
            .and_then(|n| n.strip_prefix(ROOT_PREFIX))
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<i32>().ok())
        else {
            continue;
        };
        // SAFETY: signal 0 only probes for existence.
        let owner_alive = owner == std::process::id() as i32
            || unsafe { libc::kill(owner, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if owner_alive {
            continue;
        }
        let root = entry.path();
        // Remove the root only once nothing at all works in it: a process
        // this sweep does not recognize keeps the root and its state.
        if reap_fixture_processes(&root).is_empty() && occupants(&root).is_empty() {
            let _ = fs::remove_dir_all(&root);
        }
    }
}

/// A build of this test binary (`fake_caller-<hex>`, from any worktree or
/// profile) or the supervisor. Callers also require the process to work in a
/// fixture root, which only this suite creates.
fn is_fixture_executable(exe: &Path) -> bool {
    exe.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| {
            name == "hack-lifecycle-supervisor"
                || name.strip_prefix("fake_caller-").is_some_and(|hash| {
                    !hash.is_empty() && hash.bytes().all(|b| b.is_ascii_hexdigit())
                })
        })
}

/// `/proc/<pid>/<link>`, or the same link of any live task when the main
/// thread has exited (its own links are then unreadable).
#[cfg(target_os = "linux")]
fn task_link(pid: i32, link: &str) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/{link}"))
        .ok()
        .or_else(|| {
            fs::read_dir(format!("/proc/{pid}/task"))
                .ok()?
                .flatten()
                .find_map(|task| fs::read_link(task.path().join(link)).ok())
        })
}

#[cfg(target_os = "linux")]
fn cwd_of(pid: i32) -> Option<PathBuf> {
    task_link(pid, "cwd")
}

#[cfg(target_os = "linux")]
fn exe_of(pid: i32) -> Option<PathBuf> {
    let link = task_link(pid, "exe")?;
    // A binary rebuilt since the process started reads as "<path> (deleted)".
    let text = link.to_str()?;
    Some(PathBuf::from(
        text.strip_suffix(" (deleted)").unwrap_or(text),
    ))
}

#[cfg(target_os = "macos")]
fn cwd_of(pid: i32) -> Option<PathBuf> {
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
    // SAFETY: kernel writes at most the supplied live buffer size.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: fully written above; the path is a NUL-terminated C string.
    let info = unsafe { info.assume_init() };
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes())))
}

#[cfg(target_os = "macos")]
fn exe_of(pid: i32) -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: kernel writes at most the supplied live buffer size.
    let written =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if written <= 0 {
        return None;
    }
    buffer.truncate(written as usize);
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer)))
}

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    pid: i32,
    session: i32,
    birth: u64,
}

#[cfg(target_os = "linux")]
fn identity(pid: i32) -> Option<Identity> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = text.rsplit_once(") ")?.1.split_whitespace().collect();
    Some(Identity {
        pid,
        session: fields.get(3)?.parse().ok()?,
        birth: fields.get(19)?.parse().ok()?,
    })
}

#[cfg(target_os = "macos")]
fn identity(pid: i32) -> Option<Identity> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    // SAFETY: kernel writes at most the supplied live buffer size.
    let size = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if size as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let session = unsafe { libc::getsid(pid) };
    (session > 1).then_some(Identity {
        pid,
        session,
        birth: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
    })
}

#[cfg(target_os = "linux")]
fn census() -> Vec<Identity> {
    fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .filter_map(identity)
        .collect()
}

#[cfg(target_os = "macos")]
fn census() -> Vec<Identity> {
    let mut pids = vec![0i32; 65536];
    // SAFETY: initialized vector provides the supplied writable byte count.
    let count =
        unsafe { libc::proc_listpids(1, 0, pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
    if count <= 0 {
        return Vec::new();
    }
    pids.into_iter()
        .take(count as usize / 4)
        .filter(|p| *p > 1)
        .filter_map(identity)
        .collect()
}

fn parent_pid(pid: i32) -> Option<i32> {
    #[cfg(target_os = "linux")]
    {
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        text.rsplit_once(") ")?
            .1
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: live writable buffer with the exact native struct size.
        let size = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        (size as usize == std::mem::size_of::<libc::proc_bsdinfo>())
            .then(|| unsafe { info.assume_init() }.pbi_ppid as i32)
    }
}

#[cfg(target_os = "linux")]
fn process_has_open_file(pid: i32, file: &fs::Metadata) -> bool {
    fs::read_dir(format!("/proc/{pid}/fd"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|fd| fs::metadata(fd.path()).ok())
        .any(|metadata| metadata.dev() == file.dev() && metadata.ino() == file.ino())
}

#[cfg(target_os = "macos")]
fn process_has_open_file(pid: i32, file: &fs::Metadata) -> bool {
    use std::mem::{MaybeUninit, size_of};

    // Darwin sys/proc_info.h ABI for PROC_PIDFDVNODEINFO, which libc does not
    // expose. Only the vnode stat is used below.
    const PROC_PIDFDVNODEINFO: i32 = 1;
    #[repr(C)]
    struct ProcFileInfo {
        open_flags: u32,
        status: u32,
        offset: libc::off_t,
        file_type: i32,
        guard_flags: u32,
    }
    #[repr(C)]
    struct VnodeFdInfo {
        file: ProcFileInfo,
        vnode: libc::vnode_info,
    }

    // SAFETY: a null buffer with size zero asks libproc for the list size.
    let bytes =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if bytes <= 0 {
        return false;
    }
    let mut fds = vec![
        MaybeUninit::<libc::proc_fdinfo>::uninit();
        bytes as usize / size_of::<libc::proc_fdinfo>()
    ];
    // SAFETY: the buffer is writable for its supplied byte length.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            size_of_val(fds.as_slice()) as i32,
        )
    };
    if written <= 0 {
        return false;
    }
    fds.into_iter()
        .take(written as usize / size_of::<libc::proc_fdinfo>())
        // SAFETY: we only consume complete records written by libproc.
        .map(|fd| unsafe { fd.assume_init() })
        .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
        .any(|fd| {
            let mut info = MaybeUninit::<VnodeFdInfo>::zeroed();
            let size = size_of::<VnodeFdInfo>() as i32;
            // SAFETY: the output buffer has the size and layout for this flavor.
            let written = unsafe {
                libc::proc_pidfdinfo(
                    pid,
                    fd.proc_fd,
                    PROC_PIDFDVNODEINFO,
                    info.as_mut_ptr().cast(),
                    size,
                )
            };
            if written != size {
                return false;
            }
            // SAFETY: libproc wrote a complete vnode record.
            let stat = unsafe { info.assume_init() }.vnode.vi_stat;
            stat.vst_dev == file.dev() as u32 && stat.vst_ino == file.ino()
        })
}

fn command(root: &Path, action: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-lifecycle-supervisor"));
    command
        .arg(action)
        // Supervisors and the guards they start inherit this, so teardown and
        // the stale-root sweep find them by working directory too (HACK-2322).
        .current_dir(root)
        .env_clear()
        .env("HOME", root)
        .env("PATH", "/usr/bin:/bin")
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env("SUPERVISOR_PARENT_ONLY", "synthetic-parent-only")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

fn send(writer: &mut impl Write, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    writer.write_all(&bytes).unwrap();
    writer.flush().unwrap();
}

#[track_caller]
fn exact(reader: &mut (impl Read + AsRawFd), bytes: &mut [u8]) {
    let end = Instant::now() + TIMEOUT;
    let mut offset = 0;
    while offset < bytes.len() {
        assert!(Instant::now() < end, "framed response timed out");
        let mut poll = libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one initialized pollfd is writable and alive for this call.
        let n = unsafe { libc::poll(&mut poll, 1, 100) };
        if n == 0 {
            continue;
        }
        assert!(n > 0, "poll failed");
        let n = reader.read(&mut bytes[offset..]).unwrap();
        assert!(n > 0, "response closed before a complete frame");
        offset += n;
    }
}

#[track_caller]
fn receive(reader: &mut (impl Read + AsRawFd)) -> Value {
    let mut header = [0; 4];
    exact(reader, &mut header);
    let length = u32::from_be_bytes(header) as usize;
    assert!((1..=1024 * 1024).contains(&length));
    let mut bytes = vec![0; length];
    exact(reader, &mut bytes);
    serde_json::from_slice(&bytes).unwrap()
}

#[track_caller]
fn wait(child: &mut Child, timeout: Duration) -> std::process::ExitStatus {
    let end = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= end {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned subprocess exceeded deadline");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[track_caller]
fn eventually<T>(mut predicate: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + TIMEOUT;
    loop {
        if let Some(value) = predicate() {
            return value;
        }
        assert!(
            Instant::now() < end,
            "expected fixture observation did not arrive"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn pid(state: &Value, field: &str) -> i32 {
    state[field].as_i64().unwrap() as i32
}

struct ForeignChild(Child);
impl ForeignChild {
    fn spawn() -> Self {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "fixture_process", "--nocapture"])
            .env_clear()
            .env("SUPERVISOR_FIXTURE", "hold")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: changes only the new child, with no allocated state.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Self(command.spawn().unwrap())
    }
}
impl Drop for ForeignChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A refused `stop` or `status`: exits nonzero and still answers with one
/// framed receipt carrying the expected outcome and reason.
#[track_caller]
fn refused_framed(fixture: &Fixture, action: &str, request: Value, reason: &str) -> Value {
    let (mut child, receipt) = fixture.request(action, &request);
    assert!(!wait(&mut child, TIMEOUT).success(), "{receipt}");
    assert_eq!(receipt["outcome"], "unknown", "{receipt}");
    assert_eq!(receipt["reason"], reason, "{receipt}");
    receipt
}

#[track_caller]
fn refused(fixture: &Fixture, action: &str, request: Value) {
    let mut child = command(&fixture.root, action).spawn().unwrap();
    send(child.stdin.as_mut().unwrap(), &request);
    drop(child.stdin.take());
    assert!(
        !wait(&mut child, TIMEOUT).success(),
        "unsafe operation was accepted"
    );
}

/// A fixture process started outside the supervisor, so no receipt records it.
fn stray_fixture_process(cwd: &Path) -> Child {
    stray_process(&std::env::current_exe().unwrap(), cwd, "hold")
}

fn stray_process(exe: &Path, cwd: &Path, mode: &str) -> Child {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(exe);
    command
        .args(["--exact", "fixture_process", "--nocapture"])
        .current_dir(cwd)
        .env_clear()
        .env("SUPERVISOR_FIXTURE", mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: changes only the new child, with no allocated state.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    let root = cwd.canonicalize().unwrap();
    eventually(|| {
        cwd_of(child.id() as i32)
            .filter(|dir| *dir == root)
            .map(|_| ())
    });
    child
}

#[test]
fn teardown_reaps_fixture_processes_no_receipt_recorded() {
    use std::os::unix::process::ExitStatusExt;
    let f = Fixture::new();
    let mut stray = stray_fixture_process(&f.root);
    drop(f);
    let status = wait(&mut stray, TIMEOUT);
    assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");
}

/// Threads of `pid` that are neither zombie nor dead.
#[cfg(target_os = "linux")]
fn live_tasks(pid: u32) -> usize {
    fs::read_dir(format!("/proc/{pid}/task"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|task| {
            fs::read_to_string(task.path().join("stat"))
                .ok()
                .and_then(|stat| {
                    let state = stat.rsplit_once(") ")?.1.chars().next()?;
                    Some(state != 'Z' && state != 'X')
                })
                .unwrap_or(false)
        })
        .count()
}

#[cfg(target_os = "linux")]
#[test]
fn teardown_reaps_a_fixture_whose_main_thread_exited() {
    use std::os::unix::process::ExitStatusExt;
    let f = Fixture::new();
    let mut stray = stray_process(
        &std::env::current_exe().unwrap(),
        &f.root,
        "pthread-main-exit",
    );
    // The mode forks a child that ends its main thread and keeps a worker;
    // that leader's own /proc links are then unreadable.
    let parent = stray.id();
    let root = f.root.canonicalize().unwrap();
    let leader = eventually(|| {
        census()
            .into_iter()
            .map(|p| p.pid as u32)
            .filter(|pid| *pid != parent && parent_pid(*pid as i32) == Some(parent as i32))
            .find(|pid| {
                fs::read_link(format!("/proc/{pid}/cwd")).is_err()
                    && cwd_of(*pid as i32).as_deref() == Some(root.as_path())
                    && live_tasks(*pid) > 0
            })
    });
    drop(f);
    let status = wait(&mut stray, TIMEOUT);
    assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");
    eventually(|| (live_tasks(leader) == 0).then_some(()));
}

/// A parent directory private to one stale-sweep test. Its dead-owner roots
/// sit below it, out of reach of the shared parent's one-time sweep and of the
/// other stale-sweep test, so concurrent tests cannot reap each other's roots.
struct PrivateParent(PathBuf);
impl PrivateParent {
    fn new() -> Self {
        let path = fixture_parent().join(format!(
            "fake-caller-sweep-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
}
impl Drop for PrivateParent {
    fn drop(&mut self) {
        reap_stale_fixture_roots(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn stale_sweep_reaps_other_builds_and_keeps_an_occupied_root() {
    use std::os::unix::process::ExitStatusExt;
    let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
    let dead = gone.id();
    gone.wait().unwrap();
    let private = PrivateParent::new();
    let parent = private.0.as_path();
    let root = parent.join(format!("{ROOT_PREFIX}{dead}-1-0"));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    // Another worktree's build of this test binary: same name pattern,
    // different directory.
    let other = parent.join(format!("fake-caller-other-build-{}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&other).unwrap();
    let copy = other.join("fake_caller-0123456789abcdef");
    fs::copy(std::env::current_exe().unwrap(), &copy).unwrap();
    let mut foreign_build = stray_process(&copy, &root, "hold");
    // A process the sweep does not recognize keeps the root.
    let mut bystander = Command::new("/bin/sleep")
        .arg("30")
        .current_dir(&root)
        .spawn()
        .unwrap();
    let bystander_pid = bystander.id() as i32;
    let deadline = Instant::now() + TIMEOUT;
    while !occupants(&root).iter().any(|p| p.pid == bystander_pid) {
        assert!(
            Instant::now() < deadline,
            "bystander not visible as an occupant: cwd={:?} exe={:?} birth={:?}",
            cwd_of(bystander_pid),
            exe_of(bystander_pid),
            birth_of(bystander_pid),
        );
        thread::sleep(Duration::from_millis(20));
    }
    reap_stale_fixture_roots(parent);
    let status = wait(&mut foreign_build, TIMEOUT);
    assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");
    assert!(bystander.try_wait().unwrap().is_none());
    assert!(root.exists());
    bystander.kill().unwrap();
    bystander.wait().unwrap();
    reap_stale_fixture_roots(parent);
    assert!(!root.exists());
    let _ = fs::remove_dir_all(&other);
}

#[test]
fn stale_roots_of_a_dead_test_process_are_reaped_and_removed() {
    use std::os::unix::process::ExitStatusExt;
    // A PID that just exited stands in for a test process killed mid-run.
    let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
    let dead = gone.id();
    gone.wait().unwrap();
    let private = PrivateParent::new();
    let parent = private.0.as_path();
    let root = parent.join(format!("{ROOT_PREFIX}{dead}-0-0"));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let mut stray = stray_fixture_process(&root);
    // A supervisor left stopped mid-request, as a run killed while a test holds
    // a guard SIGSTOPed would leave it.
    let mut supervisor = command(&root, "run").spawn().unwrap();
    let canonical_root = root.canonicalize().unwrap();
    eventually(|| {
        cwd_of(supervisor.id() as i32)
            .filter(|dir| *dir == canonical_root)
            .map(|_| ())
    });
    // SAFETY: stops only the supervisor this test just spawned.
    assert_eq!(
        unsafe { libc::kill(supervisor.id() as i32, libc::SIGSTOP) },
        0
    );
    let supervisor_pid = supervisor.id() as i32;
    let seen = occupants(&root).iter().any(|p| p.pid == supervisor_pid);
    assert!(
        seen && exe_of(supervisor_pid).is_some_and(|exe| is_fixture_executable(&exe)),
        "stopped supervisor not visible to the sweep: occupant={seen} cwd={:?} exe={:?} birth={:?}",
        cwd_of(supervisor_pid),
        exe_of(supervisor_pid),
        birth_of(supervisor_pid),
    );
    reap_stale_fixture_roots(parent);
    for child in [&mut stray, &mut supervisor] {
        let status = wait(child, TIMEOUT);
        assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");
    }
    assert!(!root.exists());
}

#[test]
fn starts_and_records_identity() {
    let f = Fixture::new();
    let (mut caller, receipt) = f.start(vec![f.process("worker", "hold")]);
    assert_eq!(receipt["version"], 1);
    f.await_log("fixture-ready");
    let state = f.state("worker");
    assert_eq!(state["ownerToken"], TOKEN);
    assert_eq!(state["guardPid"], state["processGroupId"]);
    assert!(state["guardStartTime"].as_u64().unwrap() > 0);
    assert!(state["bootId"].as_str().is_some_and(|v| !v.is_empty()));
    assert!(pid(&state, "commandPid") > 1);
    assert_eq!(
        fs::metadata(f.root.join("worker.json")).unwrap().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(f.root.join("lifecycle.log")).unwrap().mode() & 0o777,
        0o600
    );
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn stop_after_caller_closed() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    drop(caller.stdin.take());
    drop(caller.stdout.take());
    f.await_log("fixture-ready");
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn supervisor_kill_then_recover_stop() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    caller.kill().unwrap();
    caller.wait().unwrap();
    refused(&f, "run", f.launch(vec![f.process("worker", "hold")]));
    f.stop();
}

#[test]
fn term_ignoring_command_is_killed_after_grace() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "ignore-term")]);
    f.await_log("fixture-ready");
    let start = Instant::now();
    f.stop();
    assert!(
        start.elapsed() >= Duration::from_secs(5),
        "TERM grace was shortened"
    );
    assert!(wait(&mut caller, TIMEOUT).success());
    let state = f.state("worker");
    assert_eq!(state["phase"], "killed", "{state}");
    assert_eq!(state["signal"], libc::SIGKILL, "{state}");
}

#[test]
fn stop_confirms_kill_after_guard_is_delayed_past_old_budget() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "wrapper-term-child")]);
    f.await_log("fixture-ready");
    eventually(|| f.root.join("wrapper-child-ready").exists().then_some(()));
    let state = f.state("worker");
    let guard = identity(pid(&state, "guardPid")).expect("guard identity");
    let command_pid = pid(&state, "commandPid");
    let command_birth = process_birth(command_pid).expect("wrapper birth");
    let descendant = f
        .log()
        .lines()
        .find_map(|line| {
            line.split("wrapper-child ")
                .nth(1)
                .and_then(|pid| pid.parse::<i32>().ok())
                .and_then(identity)
        })
        .expect("TERM-ignoring descendant identity");
    f.owned.borrow_mut().push(descendant.clone());

    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    // The wrapper's exit proves the guard started its grace and sent TERM.
    eventually(|| {
        (process_birth(command_pid) != Some(command_birth) || process_is_zombie(command_pid))
            .then_some(())
    });
    // SAFETY: the fixture owns this guard, which is still supervising its
    // TERM-ignoring descendant. Fixture teardown also handles a frozen guard.
    assert!(identity(guard.pid).as_ref() == Some(&guard));
    assert_eq!(unsafe { libc::kill(guard.pid, libc::SIGSTOP) }, 0);
    eventually(|| process_is_stopped(guard.pid).then_some(()));
    assert_eq!(f.state("worker")["phase"], "stopping");
    // Keep the guard unscheduled past the old request budget, then give it
    // time to escalate and publish confirmed absence within the new budget.
    thread::sleep(Duration::from_millis(7_250));
    assert!(identity(guard.pid).as_ref() == Some(&guard));
    assert_eq!(unsafe { libc::kill(guard.pid, libc::SIGCONT) }, 0);

    let receipt = receive(stop.stdout.as_mut().unwrap());
    assert!(wait(&mut stop, TIMEOUT).success(), "{receipt}");
    assert_eq!(receipt["outcome"], "stopped", "{receipt}");
    assert_eq!(receipt["liveProcessNames"], json!([]), "{receipt}");
    assert_eq!(receipt["unknownProcessNames"], json!([]), "{receipt}");
    assert!(wait(&mut caller, TIMEOUT).success());
    assert_eq!(f.state("worker")["phase"], "killed");
    assert!(
        identity(descendant.pid).as_ref() != Some(&descendant) || process_is_zombie(descendant.pid),
        "TERM-ignoring descendant survived"
    );
}

#[test]
fn foreign_owner_cannot_stop() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    refused_framed(
        &f,
        "stop",
        f.control("different-owner"),
        "foreign-live-process",
    );
    let state = f.state("worker");
    // SAFETY: signal zero observes this fixture's process without delivering a signal.
    assert_eq!(unsafe { libc::kill(pid(&state, "commandPid"), 0) }, 0);
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn failed_start_runs_no_later_command() {
    let f = Fixture::new();
    let broken =
        json!({"name":"broken","argv":["/nonexistent/synthetic-program"],"cwd":f.root,"env":{}});
    refused(
        &f,
        "run",
        f.launch(vec![broken, f.process("later", "hold")]),
    );
    assert!(
        !f.root.join("later.json").exists(),
        "later command started after failure"
    );
    assert!(!f.log().contains("fixture-ready"));
}

#[test]
fn output_bursts_and_long_lines_include_partial_tail() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "burst")]);
    assert!(wait(&mut caller, TIMEOUT).success());
    let text = f.log();
    assert!(text.contains("\tstderr\tfixture-error"));
    assert!(text.contains("partial-tail"));
    assert_eq!(text.matches("burst-record-").count(), 2000);
    assert_eq!(text.bytes().filter(|v| *v == b'X').count(), 300_000);
    for line in text.lines() {
        let fields: Vec<_> = line.splitn(4, '\t').collect();
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[1], "worker");
        assert!(fields[0].ends_with('Z'));
    }
}

/// Without a log lock, each record is one O_APPEND write. Two guards burst
/// with a barrier in the middle (each waits until both halves are in the log),
/// so their appends overlap in both directions by construction, including
/// 64 KiB records far above PIPE_BUF. Every line must be one whole record of
/// one guard: a split anywhere, also inside the timestamp, fails a field check.
#[test]
fn concurrent_guards_append_whole_records_without_a_lock() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![
        f.process("alpha", "burst-pair-alpha"),
        f.process("beta", "burst-pair-beta"),
    ]);
    assert!(wait(&mut caller, TIMEOUT).success());
    let text = f.log();
    let lines: Vec<_> = text.lines().collect();
    for line in &lines {
        let fields: Vec<_> = line.splitn(4, '\t').collect();
        assert_eq!(fields.len(), 4, "split record: {line:.80}");
        assert_eq!(fields[0].len(), 20, "split timestamp: {line:.80}");
        assert!(fields[0].ends_with('Z'), "{line:.80}");
        assert!(matches!(fields[1], "alpha" | "beta"), "{line:.80}");
        assert!(matches!(fields[2], "stdout" | "stderr"), "{line:.80}");
    }
    for (first, later) in [("alpha", "beta"), ("beta", "alpha")] {
        let start = lines
            .iter()
            .position(|line| line.split('\t').nth(1) == Some(first))
            .expect("a guard logged nothing");
        assert!(
            lines[start..]
                .iter()
                .any(|line| line.split('\t').nth(1) == Some(later)),
            "no {later} record after the first {first} record"
        );
    }
    for name in ["alpha", "beta"] {
        let own: Vec<_> = lines
            .iter()
            .filter(|line| line.split('\t').nth(1) == Some(name))
            .collect();
        assert_eq!(
            own.iter().filter(|l| l.contains("\tburst-record-")).count(),
            2000
        );
        let xs: usize = own
            .iter()
            .filter_map(|line| line.splitn(4, '\t').nth(3))
            .filter(|message| message.starts_with('X'))
            .map(|message| {
                assert!(message.bytes().all(|b| b == b'X'), "mixed record");
                message.len()
            })
            .sum();
        assert_eq!(xs, 300_000);
    }
}

#[test]
fn zombies_do_not_hold_liveness() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "zombie")]);
    assert!(
        wait(&mut caller, TIMEOUT).success(),
        "zombie-only session remained alive"
    );
    assert!(f.log().contains("unreaped-zombie-confirmed"));
}

#[test]
fn sentinel_environment_never_enters_argv_or_state() {
    let f = Fixture::new();
    let mut process = f.process("worker", "sentinel");
    let sentinel = format!(
        "synthetic-credential-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    process["env"]["SYNTHETIC_PRIVATE_VALUE"] = json!(sentinel);
    let (mut caller, _) = f.start(vec![process]);
    f.await_log("sentinel-received");
    for entry in fs::read_dir(&f.root).unwrap().flatten() {
        if entry.file_type().unwrap().is_file() {
            let bytes = fs::read(entry.path()).unwrap();
            assert!(
                !bytes
                    .windows(sentinel.len())
                    .any(|v| v == sentinel.as_bytes()),
                "private value persisted"
            );
        }
    }
    let state = f.state("worker");
    #[cfg(target_os = "linux")]
    for process_id in [
        caller.id() as i32,
        pid(&state, "guardPid"),
        pid(&state, "commandPid"),
    ] {
        let bytes = fs::read(format!("/proc/{process_id}/cmdline")).unwrap();
        assert!(
            !bytes
                .windows(sentinel.len())
                .any(|v| v == sentinel.as_bytes()),
            "private value in argv"
        );
    }
    #[cfg(target_os = "linux")]
    {
        let bytes = fs::read(format!("/proc/{}/environ", pid(&state, "guardPid"))).unwrap();
        assert!(bytes.is_empty(), "guard inherited caller environment");
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/bin/ps")
            .args([
                "-o",
                "command=",
                "-p",
                &format!(
                    "{},{},{}",
                    caller.id(),
                    pid(&state, "guardPid"),
                    pid(&state, "commandPid")
                ),
            ])
            .output()
            .unwrap();
        assert!(
            !output
                .stdout
                .windows(sentinel.len())
                .any(|v| v == sentinel.as_bytes()),
            "private value in argv"
        );
    }
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn child_descriptor_allowlist() {
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::fs::OpenOptionsExt;
    let f = Fixture::new();
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(f.root.join("unexpected-inheritance"))
        .unwrap();
    // Deliberately emulate a caller's inheritable descriptor. The launcher's
    // startup descriptor sweep and each exec boundary must exclude it.
    let raw = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 200) };
    assert!(raw >= 200);
    let _inheritable = unsafe { OwnedFd::from_raw_fd(raw) };
    let (mut caller, _) = f.start(vec![f.process("worker", "descriptors")]);
    assert!(wait(&mut caller, TIMEOUT).success());
    assert!(f.log().contains("descriptor-allowlist-ok"));
    assert!(!f.log().contains("descriptor-leak"));
}

#[test]
fn repeated_immediate_restart_waits_for_instance_lock_release() {
    let f = Fixture::new();
    let mut previous = None;
    for generation in 0..8 {
        let token = format!("synthetic-generation-{generation}");
        let (caller, _) = f.start_generation(vec![f.process("worker", "hold")], &token);
        if let Some(mut old) = previous.take() {
            assert!(wait(&mut old, TIMEOUT).success());
        }
        f.stop_generation(&token);
        previous = Some(caller);
    }
    assert!(wait(previous.as_mut().unwrap(), TIMEOUT).success());
}

#[test]
fn raised_descriptor_limit_does_not_delay_startup() {
    // Exercise the largest supported soft limit without changing this host's
    // hard limit. The exact million-fd qualification remains separate below.
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
        0
    );
    descriptor_limit_startup(limit.rlim_max.min(1_048_576));
}

#[test]
#[ignore = "qualification requires a hard RLIMIT_NOFILE of at least 1048576"]
fn million_descriptor_limit_qualification() {
    descriptor_limit_startup(1_048_576);
}

fn descriptor_limit_startup(descriptors: libc::rlim_t) {
    use std::os::unix::process::CommandExt;
    let f = Fixture::new();
    let mut cmd = command(&f.root, "run");
    // SAFETY: adjusts only this freshly forked fixture child's descriptor limit.
    unsafe {
        cmd.pre_exec(move || {
            let limit = libc::rlimit {
                rlim_cur: descriptors,
                rlim_max: descriptors,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut caller = cmd.spawn().unwrap();
    let start = Instant::now();
    send(
        caller.stdin.as_mut().unwrap(),
        &f.launch(vec![f.process("worker", "descriptors")]),
    );
    let receipt = receive(caller.stdout.as_mut().unwrap());
    f.remember(&receipt);
    assert_eq!(receipt["outcome"], "ready");
    assert!(wait(&mut caller, TIMEOUT).success());
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(f.log().contains("descriptor-allowlist-ok"));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "bounded idle CPU/context-switch measurement; run alone with --nocapture"]
fn idle_guard_cpu_and_wakeup_measurement() {
    fn sample(pid: i32) -> (u64, u64) {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let fields: Vec<_> = stat
            .rsplit_once(") ")
            .unwrap()
            .1
            .split_whitespace()
            .collect();
        let ticks = fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap();
        let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        let switches = status
            .lines()
            .find_map(|line| {
                line.strip_prefix("voluntary_ctxt_switches:")
                    .map(|v| v.trim().parse::<u64>().unwrap())
            })
            .unwrap();
        (ticks, switches)
    }
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let guard = pid(&f.state("worker"), "guardPid");
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    for trial in 1..=3 {
        let before = sample(guard);
        let before_parent = sample(caller.id() as i32);
        let start = Instant::now();
        thread::sleep(Duration::from_secs(5));
        let wall = start.elapsed().as_secs_f64();
        let after = sample(guard);
        let after_parent = sample(caller.id() as i32);
        let cpu = (after.0 - before.0) as f64 / hz;
        let switches = after.1 - before.1;
        eprintln!(
            "trial={trial} wall_seconds={wall:.3} guard_cpu_seconds={cpu:.3} guard_voluntary_switches={switches} supervisor_cpu_seconds={:.3} supervisor_voluntary_switches={}",
            (after_parent.0 - before_parent.0) as f64 / hz,
            after_parent.1 - before_parent.1
        );
        assert!(cpu / wall < 0.01, "idle guard exceeded 1% of one CPU");
        assert!(
            (switches as f64) / wall < 5.0,
            "idle guard exceeded 5 voluntary switches/s"
        );
    }
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn natural_exit_during_stop_admission_is_successful_absence() {
    let f = Fixture::new();
    for generation in 0..8 {
        let token = format!("synthetic-generation-{generation}");
        let (mut caller, _) = f.start_generation(vec![f.process("worker", "unicode")], &token);
        let (mut stop, receipt) = f.request("stop", &f.control(&token));
        assert!(wait(&mut stop, TIMEOUT).success());
        assert_eq!(receipt["outcome"], "stopped");
        assert!(wait(&mut caller, TIMEOUT).success());
    }
}

#[test]
fn status_reports_kernel_liveness_separately_from_persisted_phase() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    let (mut status, receipt) = f.request("status", &f.control(TOKEN));
    assert!(wait(&mut status, TIMEOUT).success());
    assert_eq!(receipt["liveProcessNames"], json!(["worker"]));
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
    let mut state = f.state("worker");
    state["phase"] = json!("running");
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let (mut status, receipt) = f.request("status", &f.control(TOKEN));
    assert!(wait(&mut status, TIMEOUT).success());
    assert_eq!(receipt["processes"][0]["phase"], "running");
    assert_eq!(receipt["liveProcessNames"], json!([]));
    assert_eq!(receipt["unknownProcessNames"], json!([]));
}

#[test]
fn concurrent_stop_requests_settle() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let mut first = command(&f.root, "stop").spawn().unwrap();
    let mut second = command(&f.root, "stop").spawn().unwrap();
    send(first.stdin.as_mut().unwrap(), &f.control(TOKEN));
    send(second.stdin.as_mut().unwrap(), &f.control(TOKEN));
    drop(first.stdin.take());
    drop(second.stdin.take());
    let first_ok = wait(&mut first, TIMEOUT).success();
    let second_ok = wait(&mut second, TIMEOUT).success();
    assert!(first_ok || second_ok, "neither stop request settled");
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn changed_process_group_remains_in_owned_session() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "change-group")]);
    f.await_log("changed-group-ready");
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "60-second native idle CPU and kernel wakeup measurement; run alone"]
fn idle_guard_cpu_and_wakeup_measurement() {
    fn sample(pid: i32) -> libc::rusage_info_v2 {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: proc_pid_rusage's opaque output points at the complete V2
        // struct for the requested flavor, live and writable for this call.
        assert_eq!(
            unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, info.as_mut_ptr().cast()) },
            0
        );
        unsafe { info.assume_init() }
    }
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let guard = pid(&f.state("worker"), "guardPid");
    let before = sample(guard);
    let parent_before = sample(caller.id() as i32);
    let start = Instant::now();
    thread::sleep(Duration::from_secs(60));
    let after = sample(guard);
    let parent_after = sample(caller.id() as i32);
    for (label, before, after) in [
        ("guard", before, after),
        ("owner", parent_before, parent_after),
    ] {
        println!(
            "{label}: wall_s={:.3} cpu_ns={} idle_wakeups={} interrupt_wakeups={}",
            start.elapsed().as_secs_f64(),
            (after.ri_user_time - before.ri_user_time)
                + (after.ri_system_time - before.ri_system_time),
            after.ri_pkg_idle_wkups - before.ri_pkg_idle_wkups,
            after.ri_interrupt_wkups - before.ri_interrupt_wkups
        );
    }
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn inherited_ignored_signal_is_reset() {
    use std::os::unix::process::CommandExt;
    let f = Fixture::new();
    let mut command = command(&f.root, "run");
    // SAFETY: signal changes only the freshly forked test child; it is an
    // async-signal-safe operation and captures no allocated state.
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
            Ok(())
        });
    }
    let mut caller = command.spawn().unwrap();
    send(
        caller.stdin.as_mut().unwrap(),
        &f.launch(vec![f.process("worker", "signal-default")]),
    );
    let receipt = receive(caller.stdout.as_mut().unwrap());
    f.remember(&receipt);
    f.await_log("signal-default-ok");
    let start = Instant::now();
    f.stop();
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "command retained ignored TERM disposition"
    );
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn supervisor_and_guard_prepublication_crashes_keep_stop_admission_leased() {
    use std::os::unix::fs::OpenOptionsExt;
    let f = Fixture::new();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(f.root.join("worker.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let mut caller = command(&f.root, "run").spawn().unwrap();
    send(
        caller.stdin.as_mut().unwrap(),
        &f.launch(vec![
            f.process("first", "hold"),
            f.process("worker", "hold"),
        ]),
    );
    f.await_log("fixture-ready");
    let first = f.state("first");
    f.remember(&json!({"processes":[first.clone()]}));
    let first_guard_pid = pid(&first, "guardPid");
    let worker_lock = lock.metadata().unwrap();
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.root.join(".stop.lock"))
        .unwrap();
    let lease_file = lease.metadata().unwrap();
    // A session leader can exist before the caller sends the launch frame.
    // Wait for the second guard to open its command lock while still holding
    // the inherited stop lease. Our command lock keeps it before publication.
    let guard = eventually(|| {
        census().into_iter().find(|p| {
            p.pid != first_guard_pid
                && p.session == p.pid
                && parent_pid(p.pid) == Some(caller.id() as i32)
                && process_has_open_file(p.pid, &worker_lock)
                && process_has_open_file(p.pid, &lease_file)
        })
    });
    f.owned.borrow_mut().push(guard.clone());
    caller.kill().unwrap();
    caller.wait().unwrap();
    // A fresh open file description must still contend after the caller dies.
    // SAFETY: flock only borrows this live descriptor.
    let acquired = unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    let lock_error = std::io::Error::last_os_error();
    assert_eq!(acquired, -1, "stop lease released on caller death");
    assert_eq!(lock_error.kind(), std::io::ErrorKind::WouldBlock);
    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    eventually(|| {
        assert!(
            stop.try_wait().unwrap().is_none(),
            "stop passed an unpublished guard"
        );
        process_has_open_file(stop.id() as i32, &lease_file).then_some(())
    });
    // Stop has reached admission. Its receipt pipe must stay silent while the
    // guard holds the lease, including if stop exits without sending a frame.
    let mut reply = libc::pollfd {
        fd: stop.stdout.as_ref().unwrap().as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll borrows one live, writable descriptor record.
    assert_eq!(
        unsafe { libc::poll(&mut reply, 1, 150) },
        0,
        "stop passed an unpublished guard"
    );
    assert!(!f.root.join("worker.json").exists());
    // SAFETY: captured direct guard is still blocked on our fixture lock.
    assert!(identity(guard.pid).as_ref() == Some(&guard));
    assert_eq!(unsafe { libc::kill(guard.pid, libc::SIGKILL) }, 0);
    assert!(wait(&mut stop, TIMEOUT).success());
    drop(lock);
    let (mut next, _) = f.start_generation(
        vec![f.process("worker", "hold")],
        "synthetic-next-generation",
    );
    f.stop_generation("synthetic-next-generation");
    assert!(wait(&mut next, TIMEOUT).success());
}

#[test]
fn supervisor_killed_while_ready_receipt_is_blocked_recovers() {
    use std::os::fd::{FromRawFd, IntoRawFd, OwnedFd};
    let f = Fixture::new();
    let (_reader, mut writer) = std::os::unix::net::UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    // Saturate the very descriptor used for the caller's receipt. Authored
    // launch can finish, but the supervisor cannot commit a ready frame.
    let buffer = [0u8; 8192];
    loop {
        match writer.write(&buffer) {
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("fixture receipt saturation: {e}"),
        }
    }
    // SAFETY: ownership moves from UnixStream into OwnedFd exactly once.
    let fd = unsafe { OwnedFd::from_raw_fd(writer.into_raw_fd()) };
    let mut caller = command(&f.root, "run")
        .stdout(Stdio::from(fd))
        .spawn()
        .unwrap();
    send(
        caller.stdin.as_mut().unwrap(),
        &f.launch(vec![f.process("worker", "hold")]),
    );
    f.await_log("fixture-ready");
    let state = f.state("worker");
    f.remember(&json!({"processes":[state]}));
    assert!(caller.try_wait().unwrap().is_none());
    caller.kill().unwrap();
    caller.wait().unwrap();
    f.stop();
}

#[test]
fn guard_crash_before_complete_launch_frame_starts_nothing() {
    use std::os::unix::process::CommandExt;
    let f = Fixture::new();
    let mut cmd = command(&f.root, "guard");
    // SAFETY: changes only the fresh child into its own session.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut guard = cmd.spawn().unwrap();
    // The frame header authorizes no launch; kill at the deterministic input
    // admission boundary rather than relying on scheduler timing.
    guard
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&100u32.to_be_bytes())
        .unwrap();
    guard.kill().unwrap();
    guard.wait().unwrap();
    assert!(!f.root.join("worker.json").exists());
    assert!(!f.root.join("lifecycle.log").exists());
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn supervisor_killed_during_output_burst_is_recoverable() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "continuous-output")]);
    f.await_log("continuous-output");
    caller.kill().unwrap();
    caller.wait().unwrap();
    f.stop();
}

#[test]
fn dead_guard_with_live_session_recovers_term_then_kill() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "ignore-term")]);
    f.await_log("fixture-ready");
    let state = f.state("worker");
    // SAFETY: this fixture owns the captured live guard incarnation.
    unsafe {
        libc::kill(pid(&state, "guardPid"), libc::SIGKILL);
    }
    assert!(wait(&mut caller, TIMEOUT).success());
    refused(&f, "run", f.launch(vec![f.process("worker", "hold")]));
    let (mut status, observed) = f.request("status", &f.control(TOKEN));
    assert!(wait(&mut status, TIMEOUT).success());
    assert_eq!(observed["liveProcessNames"], json!([]));
    assert_eq!(observed["unknownProcessNames"], json!(["worker"]));
    let start = Instant::now();
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    assert!(wait(&mut stop, TIMEOUT).success());
    assert_eq!(receipt["outcome"], "stopped");
    assert!(start.elapsed() >= Duration::from_secs(5));
    assert_eq!(receipt["liveProcessNames"], json!([]));
}

#[test]
fn guard_lost_mid_stop_keeps_admission_snapshot() {
    guard_lost_during_stop(Duration::ZERO, false);
}

#[test]
fn guard_lost_late_in_stop_gets_full_recovery_deadline() {
    guard_lost_during_stop(Duration::from_secs(3), false);
}

#[test]
fn expired_target_does_not_abandon_other_recovery() {
    guard_lost_during_stop(Duration::from_secs(3), true);
}

fn guard_lost_during_stop(delay: Duration, blocked: bool) {
    let f = Fixture::new();
    let mut processes = vec![f.process("worker", "wrapper-term-child")];
    if blocked {
        processes.push(f.process("blocked", "hold"));
    }
    let (mut caller, _) = f.start(processes);
    let blocked_guard = blocked.then(|| pid(&f.state("blocked"), "guardPid"));
    // Freeze only after launch and guard startup leases released the stop lock.
    drop(f.take_stop_lock());
    if let Some(guard) = blocked_guard {
        assert_eq!(unsafe { libc::kill(guard, libc::SIGSTOP) }, 0);
    }
    eventually(|| f.root.join("wrapper-child-ready").exists().then_some(()));
    let state = f.state("worker");
    let child = eventually(|| {
        f.log().lines().find_map(|line| {
            line.split("wrapper-child ")
                .nth(1)
                .and_then(|pid| pid.parse::<i32>().ok())
                .and_then(identity)
        })
    });
    f.owned.borrow_mut().push(child.clone());
    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    // The guard has acted on this stop once its wrapper is dead. Its five-second
    // grace leaves time to remove the guard before it can KILL the child.
    eventually(|| {
        identity(pid(&state, "commandPid"))
            .is_none_or(|_| process_is_zombie(pid(&state, "commandPid")))
            .then_some(())
    });
    thread::sleep(delay);
    // Freeze the guard before removing it, then prove it has not begun its own
    // escalation: it persists kill-pending before its first KILL. The child must
    // still be live, so only the stop's admission snapshot can KILL it.
    let guard = pid(&state, "guardPid");
    let guard_birth = identity(guard).expect("guard identity").birth;
    assert_eq!(unsafe { libc::kill(guard, libc::SIGSTOP) }, 0);
    // SIGSTOP delivery is asynchronous: wait until the kernel reports this
    // guard incarnation stopped before trusting the observations below.
    eventually(|| {
        (identity(guard).is_some_and(|current| current.birth == guard_birth)
            && process_is_stopped(guard))
        .then_some(())
    });
    let frozen = f.state("worker");
    assert_eq!(
        frozen["phase"], "stopping",
        "guard escalated first: {frozen}"
    );
    assert!(
        identity(child.pid).is_some_and(|current| current.birth == child.birth)
            && !process_is_zombie(child.pid),
        "TERM-ignoring child exited before guard loss"
    );
    let recovery_started = Instant::now();
    // Freeze stop too, so it cannot observe the guard as an unreaped zombie:
    // a zombie guard is still a witness, and a fresh capture would then succeed
    // without the admission snapshot this test is about.
    let stop_pid = stop.id() as i32;
    // SAFETY: the stop request is this test's own child.
    assert_eq!(unsafe { libc::kill(stop_pid, libc::SIGSTOP) }, 0);
    // Resume the stop request even if any assertion below fails first.
    let resume = ResumeOnDrop(stop_pid);
    eventually(|| process_is_stopped(stop_pid).then_some(()));
    // SAFETY: the frozen guard belongs to this fixture.
    assert_eq!(unsafe { libc::kill(guard, libc::SIGKILL) }, 0);
    if !blocked {
        assert!(wait(&mut caller, TIMEOUT).success());
    }
    // Resume stop only after the guard incarnation has no process record left,
    // zombie included, so no guard can witness a fresh capture.
    eventually(|| (process_birth(guard) != Some(guard_birth)).then_some(()));
    drop(resume);
    let receipt = receive(stop.stdout.as_mut().unwrap());
    let stopped = wait(&mut stop, TIMEOUT).success();
    assert_eq!(stopped, !blocked, "{receipt}");
    assert_eq!(
        receipt["outcome"],
        if blocked { "unknown" } else { "stopped" }
    );
    // Recovery starts its own TERM grace after detecting guard loss, so KILL of
    // the captured child cannot precede a fresh five-second interval, even when
    // the original guard deadline had almost expired.
    let recovered_after = recovery_started.elapsed();
    assert!(
        recovered_after >= Duration::from_secs(5),
        "recovery skipped its fresh grace: {recovered_after:?}"
    );
    assert!(recovered_after < TIMEOUT);
    assert!(identity(child.pid).is_none() || process_is_zombie(child.pid));
    if let Some(guard) = blocked_guard {
        assert_eq!(unsafe { libc::kill(guard, libc::SIGCONT) }, 0);
        f.stop();
        assert!(wait(&mut caller, TIMEOUT).success());
    }
}

#[test]
fn orphan_recovery_keeps_observed_child_after_term_ends_witness() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "wrapper-term-child")]);
    f.await_log("fixture-ready");
    eventually(|| f.root.join("wrapper-child-ready").exists().then_some(()));
    let state = f.state("worker");
    let child = eventually(|| {
        f.log().lines().find_map(|line| {
            line.split("wrapper-child ")
                .nth(1)
                .and_then(|pid| pid.parse::<i32>().ok())
                .and_then(identity)
        })
    });
    f.owned.borrow_mut().push(child.clone());
    assert!(child.birth > state["commandStartTime"].as_u64().unwrap());
    // SAFETY: captured guard belongs to this fixture; command/wrapper survives.
    assert_eq!(
        unsafe { libc::kill(pid(&state, "guardPid"), libc::SIGKILL) },
        0
    );
    assert!(wait(&mut caller, TIMEOUT).success());
    let start = Instant::now();
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    assert!(wait(&mut stop, TIMEOUT).success());
    assert_eq!(receipt["outcome"], "stopped");
    assert!(
        start.elapsed() >= Duration::from_secs(5),
        "child did not get a full TERM grace"
    );
    assert!(start.elapsed() < Duration::from_secs(7));
    // A zombie is harmless and may await the host's subreaper; no live member remains.
    assert!(
        census()
            .into_iter()
            .all(|p| p.session != pid(&state, "guardPid")
                || identity(p.pid).is_none()
                || process_is_zombie(p.pid))
    );
}

/// Recovery captures the session before its TERM. A descendant forked after
/// that capture is never signalled; stop waits until its own deadline for it.
fn late_descendant_case(forever: bool) {
    let f = Fixture::new();
    let mode = if forever {
        "fork-on-term-forever"
    } else {
        "fork-on-term"
    };
    let (mut caller, _) = f.start(vec![f.process("worker", mode)]);
    f.await_log("fixture-ready");
    let state = f.state("worker");
    // SAFETY: the captured guard belongs to this fixture; its command survives.
    assert_eq!(
        unsafe { libc::kill(pid(&state, "guardPid"), libc::SIGKILL) },
        0
    );
    assert!(wait(&mut caller, TIMEOUT).success());
    let start = Instant::now();
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    let stopped = wait(&mut stop, TIMEOUT).success();
    let elapsed = start.elapsed();
    let late = std::fs::read_to_string(f.root.join("late-descendant"))
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .expect("command did not fork after recovery TERM");
    let late_identity = identity(late);
    if let Some(late) = &late_identity {
        f.owned.borrow_mut().push(late.clone());
    }
    assert!(
        identity(pid(&state, "commandPid")).is_none()
            || process_is_zombie(pid(&state, "commandPid")),
        "captured command survived recovery KILL"
    );
    if forever {
        assert!(!stopped, "{receipt}");
        assert_eq!(receipt["outcome"], "unknown");
        assert!(
            elapsed >= Duration::from_secs(7),
            "stop gave up before its deadline: {elapsed:?}"
        );
        let late = late_identity.expect("unobserved descendant was signalled");
        assert!(
            !process_is_zombie(late.pid),
            "unobserved descendant was signalled"
        );
    } else {
        assert!(stopped, "{receipt}");
        assert_eq!(receipt["outcome"], "stopped");
        assert!(elapsed >= Duration::from_secs(5));
        assert!(elapsed < TIMEOUT);
    }
}

#[test]
fn orphan_recovery_waits_for_unobserved_descendant_to_exit() {
    late_descendant_case(false);
}

#[test]
fn orphan_recovery_never_signals_unobserved_descendant() {
    late_descendant_case(true);
}

/// Sends SIGCONT to a stopped child of this test when dropped, so a failed
/// assertion cannot leave the stop request suspended.
struct ResumeOnDrop(i32);

impl Drop for ResumeOnDrop {
    fn drop(&mut self) {
        // SAFETY: the PID is this test's own unreaped child.
        unsafe {
            libc::kill(self.0, libc::SIGCONT);
        }
    }
}

/// Birth of any process record at `pid`, zombies included, matching the
/// production inspection (Darwin `proc_pidinfo` argument 1, no `getsid`).
fn process_birth(pid: i32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        text.rsplit_once(") ")?
            .1
            .split_whitespace()
            .nth(19)?
            .parse()
            .ok()
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: native output buffer is writable and exactly sized.
        let size = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                1,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        if size as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
            return None;
        }
        let info = unsafe { info.assume_init() };
        Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }
}

#[test]
fn stop_waiting_past_lock_bound_reports_unknown_without_acting() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let state = f.state("worker");
    let worker = identity(pid(&state, "commandPid")).expect("command identity");
    // Hold the fixture's stop lock as a stuck stop would.
    let lock = f.take_stop_lock();
    let start = Instant::now();
    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    // The frame arrives only after the nineteen-second wait. The reader's own
    // timeout is shorter, so start reading part of the way through.
    thread::sleep(Duration::from_secs(10));
    let receipt = receive(stop.stdout.as_mut().unwrap());
    assert!(!wait(&mut stop, TIMEOUT).success(), "{receipt}");
    assert_eq!(receipt["outcome"], "unknown");
    assert_eq!(receipt["reason"], "stop-lock-wait-expired");
    assert!(start.elapsed() >= Duration::from_secs(19));
    assert!(
        identity(worker.pid).as_ref() == Some(&worker),
        "stop acted while waiting"
    );
    assert_eq!(f.state("worker")["phase"], "running");
    drop(lock);
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn invalid_control_requests_still_get_a_framed_refusal() {
    let f = Fixture::new();
    for action in ["stop", "status"] {
        let (mut child, receipt) = f.request(
            action,
            &json!({"version": 99, "root": f.root, "ownerToken": TOKEN}),
        );
        assert!(!wait(&mut child, TIMEOUT).success(), "{receipt}");
        assert_eq!(receipt["outcome"], "refused");
        assert_eq!(receipt["reason"], "invalid-request");
        assert_eq!(receipt["processes"], json!([]));
    }
}

/// Linux shows a leader whose main thread called `pthread_exit` as `Z` while
/// its worker threads run. It must count as live. After guard loss, recovery
/// signals captured members one by one, so a member misread as a zombie is
/// never captured: stop then reported absence while its worker survived.
#[cfg(target_os = "linux")]
#[test]
fn main_thread_exit_with_live_worker_is_still_stopped() {
    // `pthread-churn` keeps replacing its only worker thread, so a scan of the
    // task list can miss the live replacement; the kernel's thread count cannot.
    for (mode, lose_guard) in [
        ("pthread-main-exit", false),
        ("pthread-main-exit", true),
        ("pthread-churn", false),
        ("pthread-churn", true),
    ] {
        let f = Fixture::new();
        let (mut caller, _) = f.start(vec![f.process("worker", mode)]);
        f.await_log("fixture-ready");
        let state = f.state("worker");
        let child = eventually(|| {
            f.log().lines().find_map(|line| {
                line.split("pthread-child ")
                    .nth(1)
                    .and_then(|pid| pid.parse::<i32>().ok())
            })
        });
        f.owned
            .borrow_mut()
            .push(identity(child).expect("pthread child identity"));
        eventually(|| (process_state(child) == Some(b'Z') && live_task(child)).then_some(()));
        if lose_guard {
            drop(f.take_stop_lock());
            // SAFETY: the captured guard belongs to this fixture.
            assert_eq!(
                unsafe { libc::kill(pid(&state, "guardPid"), libc::SIGKILL) },
                0
            );
            assert!(wait(&mut caller, TIMEOUT).success());
        }
        let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
        assert!(wait(&mut stop, TIMEOUT).success(), "{receipt}");
        assert_eq!(receipt["outcome"], "stopped");
        eventually(|| (!live_task(child)).then_some(()));
        if !lose_guard {
            assert!(wait(&mut caller, TIMEOUT).success());
        }
    }
}

#[cfg(target_os = "linux")]
fn live_task(pid: i32) -> bool {
    fs::read_dir(format!("/proc/{pid}/task"))
        .into_iter()
        .flatten()
        .flatten()
        .any(|task| {
            fs::read_to_string(task.path().join("stat"))
                .ok()
                .and_then(|stat| stat.rsplit_once(") ").map(|(_, rest)| rest.bytes().next()))
                .flatten()
                .is_some_and(|state| state != b'Z' && state != b'X')
        })
}

/// A guard stopped while it held a lock on the shared log (SIGSTOP between
/// lock and unlock) must not stall sibling guards. The test holds an exclusive
/// flock on the log from outside for the whole run, as such a frozen guard
/// would: a guard's output must still reach the log and its project must
/// still stop with a framed `stopped` receipt within the normal bounds.
#[test]
fn held_log_lock_never_stalls_a_guard() {
    use std::os::unix::fs::OpenOptionsExt;
    let f = Fixture::new();
    let log = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(f.root.join("lifecycle.log"))
        .unwrap();
    // SAFETY: flock only borrows this live descriptor.
    assert_eq!(unsafe { libc::flock(log.as_raw_fd(), libc::LOCK_EX) }, 0);
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let start = Instant::now();
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    assert!(wait(&mut stop, TIMEOUT).success(), "{receipt}");
    assert_eq!(receipt["outcome"], "stopped");
    assert!(start.elapsed() < Duration::from_secs(7));
    assert!(wait(&mut caller, TIMEOUT).success());
    drop(log);
}

/// One receipt that cannot be verified (guard gone, recorded command birth
/// wrong, so no witness proves the session) must not keep stop from stopping
/// the healthy commands of the same owner. The unverifiable command is never
/// signalled, and the request answers `unknown` with `stop-incomplete`.
#[test]
fn unverifiable_receipt_does_not_block_healthy_targets() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![
        f.process("healthy", "hold"),
        f.process("unverifiable", "hold"),
    ]);
    eventually(|| (f.log().matches("fixture-ready").count() == 2).then_some(()));
    let healthy = identity(pid(&f.state("healthy"), "commandPid")).expect("healthy command");
    let mut bad = f.state("unverifiable");
    let bad_command = identity(pid(&bad, "commandPid")).expect("unverifiable command");
    let bad_guard = pid(&bad, "guardPid");
    let bad_guard_birth = process_birth(bad_guard).expect("guard birth");
    // SAFETY: the guard belongs to this fixture; its command survives it.
    assert_eq!(unsafe { libc::kill(bad_guard, libc::SIGKILL) }, 0);
    // Wait until no record of that guard is left, zombie included: on Darwin
    // `identity` already rejects a zombie, and a zombie guard is still a witness.
    eventually(|| (process_birth(bad_guard) != Some(bad_guard_birth)).then_some(()));
    bad["commandStartTime"] = json!(bad["commandStartTime"].as_u64().unwrap() + 1);
    fs::write(
        f.root.join("unverifiable.json"),
        serde_json::to_vec(&bad).unwrap(),
    )
    .unwrap();
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    assert!(!wait(&mut stop, TIMEOUT).success(), "{receipt}");
    assert_eq!(receipt["outcome"], "unknown");
    assert_eq!(receipt["reason"], "stop-incomplete");
    eventually(|| {
        (identity(healthy.pid).as_ref() != Some(&healthy) || process_is_zombie(healthy.pid))
            .then_some(())
    });
    assert!(
        identity(bad_command.pid).as_ref() == Some(&bad_command)
            && !process_is_zombie(bad_command.pid),
        "unverifiable command was signalled"
    );
    // SAFETY: this fixture's own command, identity checked just above.
    unsafe {
        libc::kill(bad_command.pid, libc::SIGKILL);
    }
    let _ = wait(&mut caller, TIMEOUT);
}

/// Another owner's receipt whose live members no witness ties to it (guard
/// gone, recorded command birth wrong) refuses with `foreign-unknown-process`
/// and signals nothing.
#[test]
fn unverifiable_foreign_receipt_refuses_with_its_own_reason() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let mut state = f.state("worker");
    let command = identity(pid(&state, "commandPid")).expect("command identity");
    let guard = pid(&state, "guardPid");
    let guard_birth = process_birth(guard).expect("guard birth");
    // SAFETY: the guard belongs to this fixture; its command survives it.
    assert_eq!(unsafe { libc::kill(guard, libc::SIGKILL) }, 0);
    // No record left, zombie included (see the test above).
    eventually(|| (process_birth(guard) != Some(guard_birth)).then_some(()));
    state["commandStartTime"] = json!(state["commandStartTime"].as_u64().unwrap() + 1);
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    refused_framed(
        &f,
        "stop",
        f.control("different-owner"),
        "foreign-unknown-process",
    );
    assert!(
        identity(command.pid).as_ref() == Some(&command),
        "command was signalled"
    );
    // SAFETY: this fixture's own command, identity checked just above.
    unsafe {
        libc::kill(command.pid, libc::SIGKILL);
    }
    let _ = wait(&mut caller, TIMEOUT);
}

fn process_is_zombie(pid: i32) -> bool {
    process_state(pid) == Some(b'Z')
}

/// Job-control stop observed by the kernel, not merely a submitted SIGSTOP.
fn process_is_stopped(pid: i32) -> bool {
    matches!(process_state(pid), Some(b'T' | b't'))
}

/// Linux /proc state letter; Darwin maps SZOMB to Z and SSTOP to T.
fn process_state(pid: i32) -> Option<u8> {
    #[cfg(target_os = "linux")]
    {
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|s| {
                s.rsplit_once(") ")
                    .and_then(|(_, rest)| rest.bytes().next())
            })
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: native output buffer is writable and exactly sized.
        let size = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                1,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        if size as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
            return None;
        }
        Some(match unsafe { info.assume_init() }.pbi_status {
            libc::SZOMB => b'Z',
            libc::SSTOP => b'T',
            _ => b'R',
        })
    }
}

#[test]
fn unreaped_matching_guard_proves_legacy_session_ownership() {
    let f = Fixture::new();
    let (caller, _) = f.start(vec![f.process("worker", "hold")]);
    let mut caller = ForeignChild(caller);
    f.await_log("fixture-ready");
    let mut state = f.state("worker");
    // Freeze the parent only after launch has released the stop lock;
    // otherwise the frozen parent would hold it and stop could never run.
    drop(f.take_stop_lock());
    // Keep the parent from reaping its guard, then exercise legacy birth absence.
    assert_eq!(
        unsafe { libc::kill(caller.0.id() as i32, libc::SIGSTOP) },
        0
    );
    // SIGSTOP delivery is asynchronous. Observe our own child's stopped
    // wait status before killing its guard, so it cannot win the reap race.
    eventually(|| {
        let mut status = 0;
        // SAFETY: this is our unreaped child; status is writable for waitpid.
        let observed = unsafe {
            libc::waitpid(
                caller.0.id() as i32,
                &mut status,
                libc::WNOHANG | libc::WUNTRACED,
            )
        };
        (observed == caller.0.id() as i32 && libc::WIFSTOPPED(status)).then_some(())
    });
    assert_eq!(
        unsafe { libc::kill(pid(&state, "guardPid"), libc::SIGKILL) },
        0
    );
    eventually(|| process_is_zombie(pid(&state, "guardPid")).then_some(()));
    state["commandStartTime"] = Value::Null;
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    f.stop();
    assert_eq!(
        unsafe { libc::kill(caller.0.id() as i32, libc::SIGCONT) },
        0
    );
    assert!(wait(&mut caller.0, TIMEOUT).success());
}

#[test]
fn guard_dying_during_stop_gets_a_fresh_authored_term_grace() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "ignore-term")]);
    f.await_log("fixture-ready");
    let guard = pid(&f.state("worker"), "guardPid");
    let birth = identity(guard).unwrap();
    // Freeze only after launch and guard startup leases released the stop lock.
    drop(f.take_stop_lock());
    // Suspend this owned guard so its pending TERM cannot reach the command.
    assert_eq!(unsafe { libc::kill(guard, libc::SIGSTOP) }, 0);
    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    thread::sleep(Duration::from_millis(150));
    assert!(identity(guard).as_ref() == Some(&birth));
    let killed_at = Instant::now();
    assert_eq!(unsafe { libc::kill(guard, libc::SIGKILL) }, 0);
    let receipt = receive(stop.stdout.as_mut().unwrap());
    assert!(wait(&mut stop, TIMEOUT).success());
    assert_eq!(receipt["outcome"], "stopped");
    assert!(killed_at.elapsed() >= Duration::from_secs(5));
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn stale_receipt_cannot_signal_another_process() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let mut state = f.state("worker");
    let original = state.clone();
    // A valid-looking receipt with an incorrect birth time must never become
    // authority just because its PID currently exists.
    state["guardStartTime"] = json!(state["guardStartTime"].as_u64().unwrap() + 1);
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let (mut stop, _) = f.request("stop", &f.control(TOKEN));
    wait(&mut stop, TIMEOUT);
    assert_eq!(unsafe { libc::kill(pid(&original, "commandPid"), 0) }, 0);
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn receipt_naming_a_foreign_pid_cannot_stop_it() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let mut foreign = ForeignChild::spawn();
    let original = f.state("worker");
    let mut state = original.clone();
    state["guardPid"] = json!(foreign.0.id());
    state["processGroupId"] = json!(foreign.0.id());
    // Linux births have clock-tick precision: two distinct live PIDs can have
    // equal births. Make this stale identity differ deterministically.
    let foreign_identity = eventually(|| identity(foreign.0.id() as i32));
    state["guardStartTime"] = json!(foreign_identity.birth + 1);
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let (mut stop, _) = f.request("stop", &f.control(TOKEN));
    wait(&mut stop, TIMEOUT);
    let foreign_running = foreign.0.try_wait().unwrap().is_none();
    drop(foreign);
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
    assert!(foreign_running, "stale receipt signalled another process");
}

#[test]
fn stale_reused_session_leader_does_not_block_fresh_launch() {
    let f = Fixture::new();
    let (mut first, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    f.stop();
    assert!(wait(&mut first, TIMEOUT).success());
    let mut foreign = ForeignChild::spawn();
    let foreign_identity = eventually(|| identity(foreign.0.id() as i32));
    let mut state = f.state("worker");
    state["guardPid"] = json!(foreign.0.id());
    state["processGroupId"] = json!(foreign.0.id());
    state["guardStartTime"] = json!(foreign_identity.birth + 1);
    fs::write(
        f.root.join("worker.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let (mut next, _) = f.start_generation(
        vec![f.process("worker", "hold")],
        "synthetic-next-generation",
    );
    f.stop_generation("synthetic-next-generation");
    assert!(wait(&mut next, TIMEOUT).success());
    assert!(
        foreign.0.try_wait().unwrap().is_none(),
        "foreign reused session was signalled"
    );
}

#[test]
fn dead_reused_session_cannot_authorize_signals_from_old_receipt() {
    use std::os::unix::process::CommandExt;
    let f = Fixture::new();
    let (mut old, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    f.stop();
    assert!(wait(&mut old, TIMEOUT).success());
    let terminal = f.state("worker");
    // Use a real dead session leader and real surviving child. Relocate the
    // old receipt's SID to that session rather than waiting for host PID wrap.
    thread::sleep(Duration::from_millis(30));
    let mut launch = Command::new(std::env::current_exe().unwrap());
    launch
        .args(["--exact", "fixture_process", "--nocapture"])
        .env_clear()
        .env("SUPERVISOR_FIXTURE", "leave-session-child")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    unsafe {
        launch.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut leader = launch.spawn().unwrap();
    let sid = leader.id() as i32;
    let mut output = String::new();
    leader
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(wait(&mut leader, TIMEOUT).success());
    let child_pid: i32 = output
        .lines()
        .find_map(|line| {
            line.strip_prefix("session-child ")
                .and_then(|pid| pid.parse().ok())
        })
        .unwrap();
    let child = identity(child_pid).unwrap();
    f.owned.borrow_mut().push(child.clone());
    assert_eq!(child.session, sid);
    assert!(identity(sid).is_none(), "replacement leader must be gone");
    let mut relocated = terminal.clone();
    relocated["guardPid"] = json!(sid);
    relocated["processGroupId"] = json!(sid);
    for phase in ["running", "starting", "exited", "killed", "failed-start"] {
        relocated["phase"] = json!(phase);
        fs::write(
            f.root.join("worker.json"),
            serde_json::to_vec(&relocated).unwrap(),
        )
        .unwrap();
        let (mut status, observed) = f.request("status", &f.control(TOKEN));
        let uncertain = matches!(phase, "running" | "starting");
        assert_eq!(wait(&mut status, TIMEOUT).success(), !uncertain);
        assert_eq!(
            observed["unknownProcessNames"].as_array().unwrap().len(),
            usize::from(uncertain)
        );
        let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
        assert_eq!(
            receipt["outcome"],
            if uncertain { "unknown" } else { "stopped" }
        );
        assert_eq!(wait(&mut stop, TIMEOUT).success(), !uncertain);
        assert!(
            identity(child_pid).as_ref() == Some(&child),
            "unrelated session was signalled"
        );
    }
    // A terminal old generation must not fence an unrelated generation.
    let (mut next, _) =
        f.start_generation(vec![f.process("worker", "hold")], "synthetic-new-owner");
    f.stop_generation("synthetic-new-owner");
    assert!(wait(&mut next, TIMEOUT).success());
    assert!(identity(child_pid).as_ref() == Some(&child));
}

#[test]
fn preexisting_broad_log_is_refused_before_launch() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    fs::write(f.root.join("lifecycle.log"), b"sentinel").unwrap();
    fs::set_permissions(
        f.root.join("lifecycle.log"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    refused(&f, "run", f.launch(vec![f.process("worker", "hold")]));
    assert!(!f.root.join("worker.json").exists());
    assert_eq!(fs::read(f.root.join("lifecycle.log")).unwrap(), b"sentinel");
}

#[cfg(feature = "test-hooks")]
fn stopped(pid: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|s| s.rsplit_once(") ").map(|(_, rest)| rest.starts_with('T')))
            .unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: writable native buffer lives through this synchronous call.
        let size = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        size as usize == std::mem::size_of::<libc::proc_bsdinfo>()
            && unsafe { info.assume_init() }.pbi_status == libc::SSTOP
    }
}

#[cfg(feature = "test-hooks")]
fn kill_guard_at_launch_checkpoint(checkpoint: &str) {
    let f = Fixture::new();
    let mut process = f.process("worker", "hold-checkpoint");
    process["env"]["SUPERVISOR_TEST_CHECKPOINT"] = json!(checkpoint);
    let mut caller = command(&f.root, "run").spawn().unwrap();
    send(caller.stdin.as_mut().unwrap(), &f.launch(vec![process]));
    let state = f.state("worker");
    let guard = pid(&state, "guardPid");
    eventually(|| stopped(guard).then_some(()));
    f.remember(&json!({"processes":[state.clone()]}));
    assert_eq!(f.state("worker")["phase"], "starting");
    let children: Vec<_> = census()
        .into_iter()
        .filter(|p| parent_pid(p.pid) == Some(guard))
        .collect();
    assert_eq!(children.len(), usize::from(checkpoint == "after-spawn"));
    for child in &children {
        f.owned.borrow_mut().push(child.clone());
    }
    if checkpoint == "after-spawn" {
        // The paused guard cannot drain output. Wait until the command has
        // finished its initial writes so killing the reader cannot race SIGPIPE.
        eventually(|| {
            f.root
                .join("checkpoint-command-ready")
                .exists()
                .then_some(())
        });
        assert!(identity(children[0].pid).as_ref() == Some(&children[0]));
    }
    // SAFETY: exact stopped guard and session belong to this fixture.
    assert_eq!(unsafe { libc::kill(guard, libc::SIGKILL) }, 0);
    let _ = wait(&mut caller, TIMEOUT);
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    if checkpoint == "before-spawn" {
        assert_eq!(receipt["outcome"], "stopped");
        assert!(wait(&mut stop, TIMEOUT).success());
    } else {
        // No running receipt/birth witness was published. Safety requires
        // uncertainty without signals, rather than guessing session ownership.
        assert_eq!(receipt["outcome"], "unknown");
        assert!(!wait(&mut stop, TIMEOUT).success());
        assert!(identity(children[0].pid).as_ref() == Some(&children[0]));
        let (mut status, observed) = f.request("status", &f.control(TOKEN));
        assert!(!wait(&mut status, TIMEOUT).success());
        assert_eq!(observed["unknownProcessNames"], json!(["worker"]));
        refused(&f, "run", f.launch(vec![f.process("worker", "hold")]));
    }
}

#[cfg(feature = "test-hooks")]
#[test]
fn guard_killed_after_starting_save_before_spawn_starts_nothing() {
    kill_guard_at_launch_checkpoint("before-spawn");
}

#[cfg(feature = "test-hooks")]
#[test]
fn guard_killed_after_spawn_before_running_save_retains_unknown() {
    kill_guard_at_launch_checkpoint("after-spawn");
}

#[test]
fn incomplete_frame_has_one_whole_handoff_deadline() {
    let f = Fixture::new();
    let mut caller = command(&f.root, "run").spawn().unwrap();
    let start = Instant::now();
    caller.stdin.as_mut().unwrap().write_all(&[0]).unwrap();
    thread::sleep(Duration::from_secs(6));
    // Complete the header late, leaving the announced body absent. A reset
    // deadline per read would let this request survive sixteen seconds.
    caller
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&[0, 0, 16])
        .unwrap();
    assert!(!wait(&mut caller, Duration::from_secs(6)).success());
    assert!(start.elapsed() < Duration::from_secs(12));
    assert!(!f.root.join("lifecycle.log").exists());
}

#[test]
fn failure_teardown_stops_separate_command_group() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let state = f.state("worker");
    let command_pid = pid(&state, "commandPid");
    let guard_pid = pid(&state, "guardPid");
    assert_ne!(command_pid, guard_pid);
    drop(f);
    assert!(wait(&mut caller, TIMEOUT).success());
    assert!(identity(command_pid).is_none(), "fixture command leaked");
    assert!(identity(guard_pid).is_none(), "fixture guard leaked");
}

#[test]
fn unresponsive_guard_stop_remains_unknown() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    let state = f.state("worker");
    let guard = pid(&state, "guardPid");
    // Freeze only after launch and guard startup leases released the stop lock.
    drop(f.take_stop_lock());
    // SAFETY: the guard belongs to this fixture and its receipt is immutable.
    assert_eq!(unsafe { libc::kill(guard, libc::SIGSTOP) }, 0);
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    assert_eq!(receipt["outcome"], "unknown");
    assert_eq!(receipt["reason"], "stop-incomplete");
    assert!(!wait(&mut stop, TIMEOUT).success());
    assert_eq!(unsafe { libc::kill(pid(&state, "commandPid"), 0) }, 0);
    // The owner is retired but its member is not proven absent.
    refused_framed(&f, "status", f.control(TOKEN), "retired-owner-live");
    refused(&f, "run", f.launch(vec![f.process("worker", "hold")]));
    assert_eq!(unsafe { libc::kill(guard, libc::SIGCONT) }, 0);
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn new_generation_ignores_retained_terminal_receipts() {
    let f = Fixture::new();
    let (mut first, _) = f.start(vec![f.process("old-name", "hold")]);
    f.await_log("fixture-ready");
    f.stop();
    assert!(wait(&mut first, TIMEOUT).success());
    let mut launch = f.launch(vec![f.process("renamed", "hold")]);
    launch["ownerToken"] = json!("synthetic-next-generation");
    let (mut next, _) = f.request("run", &launch);
    let (mut stop, receipt) = f.request("stop", &f.control("synthetic-next-generation"));
    assert!(wait(&mut stop, TIMEOUT).success());
    assert!(wait(&mut next, TIMEOUT).success());
    assert_eq!(receipt["processes"].as_array().unwrap().len(), 1);
    assert!(
        f.root.join("old-name.json").exists(),
        "terminal receipt was discarded"
    );
}

#[test]
fn case_only_rename_accepts_terminal_receipt_with_previous_spelling() {
    let f = Fixture::new();
    let (mut first, _) = f.start(vec![f.process("Worker", "hold")]);
    f.await_log("fixture-ready");
    f.stop();
    assert!(wait(&mut first, TIMEOUT).success());
    // Also emulate the case-insensitive lookup on Linux: the payload retains
    // its original spelling while the lookup uses the new command name.
    fs::rename(f.root.join("Worker.json"), f.root.join("worker.json")).unwrap();
    let (mut next, _) = f.start_generation(
        vec![f.process("worker", "hold")],
        "synthetic-next-generation",
    );
    f.stop_generation("synthetic-next-generation");
    assert!(wait(&mut next, TIMEOUT).success());
}

#[test]
fn command_joining_guard_group_still_receives_kill() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "join-guard-group")]);
    f.await_log("joined-guard-group");
    let start = Instant::now();
    f.stop();
    assert!(start.elapsed() >= Duration::from_secs(5));
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn process_group_leader_caller_refuses_without_launch() {
    use std::os::unix::process::CommandExt;
    let f = Fixture::new();
    let mut command = command(&f.root, "run");
    // SAFETY: changes only the newly forked child, using no allocated state.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut caller = command.spawn().unwrap();
    send(
        caller.stdin.as_mut().unwrap(),
        &f.launch(vec![f.process("worker", "hold")]),
    );
    drop(caller.stdin.take());
    assert!(!wait(&mut caller, TIMEOUT).success());
    assert!(!f.root.join("worker.json").exists());
    assert!(!f.root.join("lifecycle.log").exists());
}

#[test]
fn stop_serializes_with_multiple_process_launches() {
    let f = Fixture::new();
    let processes: Vec<_> = (0..16)
        .map(|i| f.process(&format!("worker-{i}"), "hold"))
        .collect();
    let mut caller = command(&f.root, "run").spawn().unwrap();
    send(caller.stdin.as_mut().unwrap(), &f.launch(processes));
    f.state("worker-0");
    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    let ready = receive(caller.stdout.as_mut().unwrap());
    f.remember(&ready);
    let receipt = receive(stop.stdout.as_mut().unwrap());
    assert_eq!(receipt["outcome"], "stopped");
    assert!(wait(&mut stop, TIMEOUT).success());
    assert!(wait(&mut caller, TIMEOUT).success());
    for state in ready["processes"].as_array().unwrap() {
        assert!(
            identity(pid(state, "commandPid")).is_none(),
            "a launch escaped concurrent stop"
        );
    }
}

#[test]
fn unicode_codepoint_crossing_chunk_boundary_is_preserved() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "unicode")]);
    assert!(wait(&mut caller, TIMEOUT).success());
    let log = f.log();
    assert_eq!(log.matches('🦀').count(), 1);
    assert!(
        !log.contains('\u{fffd}'),
        "UTF-8 chunk boundary corrupted a codepoint"
    );
}

#[test]
fn case_insensitive_process_name_collision_refuses_all_launches() {
    let f = Fixture::new();
    refused(
        &f,
        "run",
        f.launch(vec![
            f.process("Worker", "hold"),
            f.process("worker", "hold"),
        ]),
    );
    assert!(!f.root.join("Worker.json").exists());
    assert!(!f.root.join("worker.json").exists());
    assert!(!f.root.join("lifecycle.log").exists());
}

#[test]
fn status_observes_without_creating_files() {
    let f = Fixture::new();
    let (mut status, receipt) = f.request("status", &f.control(TOKEN));
    assert!(wait(&mut status, TIMEOUT).success());
    assert_eq!(receipt["outcome"], "observed");
    assert!(receipt["processes"].as_array().unwrap().is_empty());
    assert_eq!(fs::read_dir(&f.root).unwrap().count(), 0);
}

#[cfg(target_os = "linux")]
#[test]
fn adopted_orphan_is_reaped_while_direct_command_lives() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "orphan-exits")]);
    f.await_log("orphan-ready");
    let orphan = eventually(|| {
        f.log().lines().find_map(|line| {
            line.split("orphan-ready ")
                .nth(1)
                .and_then(|value| value.parse::<i32>().ok())
        })
    });
    eventually(|| identity(orphan).is_none().then_some(()));
    let state = f.state("worker");
    assert!(identity(pid(&state, "commandPid")).is_some());
    f.stop();
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn fixture_process() {
    let Ok(mode) = std::env::var("SUPERVISOR_FIXTURE") else {
        return;
    };
    assert!(
        std::env::var_os("SUPERVISOR_PARENT_ONLY").is_none(),
        "command inherited caller environment"
    );
    match mode.as_str() {
        "burst-pair-alpha" | "burst-pair-beta" => {
            // Two guards' appends overlap by construction: each writes half its
            // records, then waits until both halves are in the shared log
            // before writing the rest.
            let (own, other) = if mode == "burst-pair-alpha" {
                ("alpha", "beta")
            } else {
                ("beta", "alpha")
            };
            let mut out = std::io::stdout().lock();
            for i in 0..1000 {
                writeln!(out, "burst-record-{i}").unwrap();
            }
            out.flush().unwrap();
            let half = |name: &str| format!("\t{name}\tstdout\tburst-record-999\n");
            loop {
                let log = fs::read_to_string("lifecycle.log").unwrap_or_default();
                if log.contains(&half(own)) && log.contains(&half(other)) {
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
            for i in 1000..2000 {
                writeln!(out, "burst-record-{i}").unwrap();
            }
            out.write_all(&vec![b'X'; 300_000]).unwrap();
            out.write_all(b"\npartial-tail").unwrap();
            out.flush().unwrap();
            eprintln!("fixture-error");
            std::process::exit(0);
        }
        "burst" => {
            let mut out = std::io::stdout().lock();
            for i in 0..2000 {
                writeln!(out, "burst-record-{i}").unwrap();
            }
            out.write_all(&vec![b'X'; 300_000]).unwrap();
            out.write_all(b"\npartial-tail").unwrap();
            out.flush().unwrap();
            eprintln!("fixture-error");
            std::process::exit(0);
        }
        "descriptors" => {
            assert_eq!(unsafe { libc::isatty(0) }, 0);
            let mut byte = [0u8];
            assert_eq!(
                std::io::stdin().read(&mut byte).unwrap(),
                0,
                "command inherited private protocol input"
            );
            let mut leaked = false;
            for fd in 3..1024 {
                // SAFETY: F_GETFD observes descriptor state without mutation.
                if unsafe { libc::fcntl(fd, libc::F_GETFD) } >= 0 {
                    leaked = true;
                }
            }
            println!(
                "{}",
                if leaked {
                    "descriptor-leak"
                } else {
                    "descriptor-allowlist-ok"
                }
            );
            std::process::exit(if leaked { 1 } else { 0 });
        }
        "zombie" => {
            // SAFETY: fixture immediately exits in the fork child; it invokes
            // no allocator or Rust destructors after fork in that branch.
            let child = unsafe { libc::fork() };
            assert!(child >= 0);
            if child == 0 {
                unsafe {
                    libc::_exit(0);
                }
            }
            let mut event = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: observe only this fixture's direct child into a writable
            // buffer. WNOWAIT confirms exit while deliberately retaining it.
            assert_eq!(
                unsafe {
                    libc::waitid(
                        libc::P_PID,
                        child as libc::id_t,
                        event.as_mut_ptr(),
                        libc::WEXITED | libc::WNOWAIT,
                    )
                },
                0
            );
            println!("unreaped-zombie-confirmed {child}");
            std::io::stdout().flush().unwrap();
            std::process::exit(0);
        }
        #[cfg(target_os = "linux")]
        "orphan-exits" => {
            let (mut input, output) = std::os::unix::net::UnixStream::pair().unwrap();
            // SAFETY: both fork descendants use only async-signal-safe libc
            // calls and immediately exit; no Rust allocator state is reused.
            let intermediary = unsafe { libc::fork() };
            assert!(intermediary >= 0);
            if intermediary == 0 {
                unsafe {
                    let orphan = libc::fork();
                    if orphan == 0 {
                        libc::usleep(300_000);
                        libc::_exit(0);
                    }
                    let bytes = orphan.to_be_bytes();
                    libc::write(output.as_raw_fd(), bytes.as_ptr().cast(), bytes.len());
                    libc::_exit(if orphan < 0 { 98 } else { 0 });
                }
            }
            let mut status = 0;
            assert_eq!(
                unsafe { libc::waitpid(intermediary, &mut status, 0) },
                intermediary
            );
            let mut bytes = [0; 4];
            input.read_exact(&mut bytes).unwrap();
            let orphan = i32::from_be_bytes(bytes);
            assert!(orphan > 1);
            println!("orphan-ready {orphan}");
        }
        "change-group" => {
            // SAFETY: fork child uses only async-signal-safe calls and never
            // returns to Rust, so the libtest thread state is not reused.
            let child = unsafe { libc::fork() };
            assert!(child >= 0);
            if child == 0 {
                unsafe {
                    if libc::setpgid(0, 0) != 0 {
                        libc::_exit(98);
                    }
                    libc::write(1, c"changed-group-ready\n".as_ptr().cast(), 20);
                    loop {
                        libc::pause();
                    }
                }
            }
        }
        "join-guard-group" => {
            // SAFETY: fixture joins its existing session leader's group; only
            // this authored test process's group/disposition are changed.
            unsafe {
                let session = libc::getsid(0);
                assert!(session > 1);
                assert_eq!(libc::setpgid(0, session), 0);
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
            println!("joined-guard-group");
        }
        "unicode" => {
            let mut out = std::io::stdout().lock();
            out.write_all(&vec![b'a'; 65535]).unwrap();
            out.write_all("🦀\n".as_bytes()).unwrap();
            out.flush().unwrap();
            std::process::exit(0);
        }
        #[cfg(target_os = "linux")]
        "non-dumpable" => {
            // SAFETY: affects only this owned fixture's dumpability, not its UID.
            assert_eq!(unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) }, 0);
            println!("non-dumpable-ready");
        }
        "signal-default" => {
            let mut disposition: libc::sigaction = unsafe { std::mem::zeroed() };
            assert_eq!(
                unsafe { libc::sigaction(libc::SIGTERM, std::ptr::null(), &mut disposition) },
                0
            );
            assert_eq!(disposition.sa_sigaction, libc::SIG_DFL);
            println!("signal-default-ok");
        }
        "continuous-output" => loop {
            println!("continuous-output {}", "x".repeat(4096));
            thread::sleep(Duration::from_millis(1));
        },
        "sentinel" => {
            assert!(std::env::var_os("SYNTHETIC_PRIVATE_VALUE").is_some());
            println!("sentinel-received");
        }
        "ignore-term" => {
            // SAFETY: SIG_IGN is a valid process-local disposition.
            unsafe {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
        }
        "leave-session-child" => {
            // SAFETY: fork child uses only async-signal-safe operations and
            // never returns into libtest's multithreaded runtime.
            let child = unsafe { libc::fork() };
            assert!(child >= 0);
            if child == 0 {
                unsafe {
                    libc::close(1);
                    loop {
                        libc::pause();
                    }
                }
            }
            println!("session-child {child}");
            std::io::stdout().flush().unwrap();
            std::process::exit(0);
        }
        "wrapper-term-child" => {
            // Make the child newer than the command even with Linux clock-tick
            // resolution, so it cannot accidentally satisfy the old birth bound.
            thread::sleep(Duration::from_millis(100));
            // SAFETY: fork child invokes only libc operations and never returns
            // into Rust/libtest's inherited multithreaded allocator state.
            let child = unsafe { libc::fork() };
            assert!(child >= 0);
            if child == 0 {
                unsafe {
                    libc::signal(libc::SIGTERM, libc::SIG_IGN);
                    let fd = libc::open(
                        c"wrapper-child-ready".as_ptr(),
                        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                        0o600,
                    );
                    if fd < 0 {
                        libc::_exit(98);
                    }
                    libc::close(fd);
                    loop {
                        libc::pause();
                    }
                }
            }
            println!("wrapper-child {child}");
        }
        "fork-on-term" | "fork-on-term-forever" => {
            // Fork one TERM-ignoring descendant after each TERM, so recovery
            // meets a session member forked after its capture. Its PID goes to
            // a file: stdout belongs to the guard, which the test kills first.
            static TERMINATED: AtomicBool = AtomicBool::new(false);
            extern "C" fn on_term(_: libc::c_int) {
                TERMINATED.store(true, Ordering::SeqCst);
            }
            let forever = mode == "fork-on-term-forever";
            // SAFETY: the handler only stores an atomic flag.
            unsafe {
                libc::signal(
                    libc::SIGTERM,
                    on_term as extern "C" fn(libc::c_int) as libc::sighandler_t,
                );
            }
            println!("fixture-ready");
            std::io::stdout().flush().unwrap();
            loop {
                if TERMINATED.swap(false, Ordering::SeqCst) {
                    // Saved before the fork: a child first scheduled after this
                    // process died would otherwise read its reaper's PID.
                    // SAFETY: getpid has no preconditions.
                    let parent = unsafe { libc::getpid() };
                    // SAFETY: the fork child uses only async-signal-safe libc
                    // calls and never returns into Rust state.
                    let child = unsafe { libc::fork() };
                    assert!(child >= 0);
                    if child == 0 {
                        unsafe {
                            libc::signal(libc::SIGTERM, libc::SIG_IGN);
                            if forever {
                                loop {
                                    libc::pause();
                                }
                            }
                            // Outlive the parent's recovery KILL (at five
                            // seconds), then exit well before the seven-second
                            // deadline. Tie the exit to the parent's death, not
                            // to a fixed time, so a slow host cannot push it
                            // past the deadline.
                            while libc::getppid() == parent {
                                libc::usleep(10_000);
                            }
                            libc::usleep(500_000);
                            libc::_exit(0);
                        }
                    }
                    std::fs::write("late-descendant.tmp", child.to_string()).unwrap();
                    std::fs::rename("late-descendant.tmp", "late-descendant").unwrap();
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(target_os = "linux")]
        "pthread-main-exit" | "pthread-churn" => {
            extern "C" fn worker(_: *mut libc::c_void) -> *mut libc::c_void {
                loop {
                    // SAFETY: pause has no preconditions.
                    unsafe {
                        libc::pause();
                    }
                }
            }
            /// Thread turnover: each worker starts its replacement, then ends.
            /// The group always has a live thread, but no single listing of
            /// its tasks is guaranteed to see one.
            extern "C" fn churn(_: *mut libc::c_void) -> *mut libc::c_void {
                // SAFETY: libc thread calls only; a failed create keeps this
                // thread alive instead of ending the group.
                unsafe {
                    libc::usleep(2000);
                    let mut next: libc::pthread_t = std::mem::zeroed();
                    if libc::pthread_create(
                        &mut next,
                        std::ptr::null(),
                        churn,
                        std::ptr::null_mut(),
                    ) != 0
                    {
                        loop {
                            libc::pause();
                        }
                    }
                    libc::syscall(libc::SYS_exit, 0);
                }
                std::ptr::null_mut()
            }
            let body: extern "C" fn(*mut libc::c_void) -> *mut libc::c_void =
                if mode == "pthread-churn" {
                    churn
                } else {
                    worker
                };
            // The fork child is single-threaded, so its main thread is the
            // thread-group leader. It starts one worker and ends only its main
            // thread (as `pthread_exit` does); Linux then shows the leader as
            // `Z` while the worker runs.
            // SAFETY: the child calls only libc thread and exit functions and
            // never returns into Rust/libtest state.
            let child = unsafe { libc::fork() };
            assert!(child >= 0);
            if child == 0 {
                unsafe {
                    let mut thread: libc::pthread_t = std::mem::zeroed();
                    if libc::pthread_create(
                        &mut thread,
                        std::ptr::null(),
                        body,
                        std::ptr::null_mut(),
                    ) != 0
                    {
                        libc::_exit(96);
                    }
                    // End only the main thread, as pthread_exit would, without
                    // its unwinder: the raw exit syscall is thread-scoped.
                    libc::syscall(libc::SYS_exit, 0);
                    libc::_exit(95);
                }
            }
            println!("pthread-child {child}");
        }
        "hold" | "hold-checkpoint" => (),
        _ => std::process::exit(99),
    }
    println!("fixture-ready");
    std::io::stdout().flush().unwrap();
    if mode == "hold-checkpoint" {
        fs::write("checkpoint-command-ready", b"ready").unwrap();
    }
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

use std::os::unix::fs::DirBuilderExt;

#[test]
fn status_waits_for_inflight_stop_before_reporting_adoptable_liveness() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "ignore-term")]);
    f.await_log("fixture-ready");
    let mut stopping = command(&f.root, "stop").spawn().unwrap();
    send(stopping.stdin.as_mut().unwrap(), &f.control(TOKEN));
    eventually(|| (f.state("worker")["phase"] == "stopping").then_some(()));
    let (mut observer, receipt) = f.request("status", &f.control(TOKEN));
    assert!(receipt["liveProcessNames"].as_array().unwrap().is_empty());
    assert!(
        receipt["unknownProcessNames"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(wait(&mut observer, TIMEOUT).success());
    assert!(wait(&mut stopping, TIMEOUT).success());
    assert!(wait(&mut caller, TIMEOUT).success());
}

#[test]
fn completed_stop_fences_a_run_whose_frame_arrives_after_retirement() {
    let f = Fixture::new();
    let mut delayed = command(&f.root, "run").spawn().unwrap();
    f.stop();
    send(
        delayed.stdin.as_mut().unwrap(),
        &f.launch(vec![f.process("late", "hold")]),
    );
    assert!(!wait(&mut delayed, TIMEOUT).success());
    assert!(!f.root.join("late.json").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn non_dumpable_command_keeps_its_process_uid_for_orphan_recovery() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "non-dumpable")]);
    f.await_log("non-dumpable-ready");
    let state = f.state("worker");
    let command = pid(&state, "commandPid");
    // On an unprivileged runner the inode owner changes to root, while the
    // process UID stays ours. The recovery path must use the latter.
    if unsafe { libc::geteuid() } != 0 {
        assert_eq!(
            fs::metadata(format!("/proc/{command}/stat")).unwrap().uid(),
            0
        );
    }
    // SAFETY: this fixture owns the still-running guard recorded at launch.
    assert_eq!(
        unsafe { libc::kill(pid(&state, "guardPid"), libc::SIGKILL) },
        0
    );
    f.stop();
    let _ = wait(&mut caller, TIMEOUT);
    let live = fs::read_to_string(format!("/proc/{command}/stat"))
        .ok()
        .is_some_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, fields)| !fields.starts_with("Z ") && !fields.starts_with("X "))
        });
    assert!(!live);
}
