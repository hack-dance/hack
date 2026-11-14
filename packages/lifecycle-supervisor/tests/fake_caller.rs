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
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const TOKEN: &str = "synthetic-owner-token";
const TIMEOUT: Duration = Duration::from_secs(15);

struct Fixture {
    root: PathBuf,
    owned: RefCell<Vec<Identity>>,
}

impl Fixture {
    fn new() -> Self {
        let parent = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = parent.join(format!(
            "supervisor-test-{}-{nonce}-{}",
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
        assert!(wait(&mut child, TIMEOUT).success(), "owned stop failed");
    }

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
        let _ = fs::remove_dir_all(&self.root);
    }
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

fn command(root: &Path, action: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-lifecycle-supervisor"));
    command
        .arg(action)
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

fn receive(reader: &mut (impl Read + AsRawFd)) -> Value {
    let mut header = [0; 4];
    exact(reader, &mut header);
    let length = u32::from_be_bytes(header) as usize;
    assert!((1..=1024 * 1024).contains(&length));
    let mut bytes = vec![0; length];
    exact(reader, &mut bytes);
    serde_json::from_slice(&bytes).unwrap()
}

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

fn refused(fixture: &Fixture, action: &str, request: Value) {
    let mut child = command(&fixture.root, action).spawn().unwrap();
    send(child.stdin.as_mut().unwrap(), &request);
    drop(child.stdin.take());
    assert!(
        !wait(&mut child, TIMEOUT).success(),
        "unsafe operation was accepted"
    );
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
}

#[test]
fn foreign_owner_cannot_stop() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "hold")]);
    f.await_log("fixture-ready");
    refused(&f, "stop", f.control("different-owner"));
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
#[test]
#[ignore = "qualification requires a hard RLIMIT_NOFILE of at least 1048576"]
fn million_descriptor_limit_qualification() {
    descriptor_limit_startup(1_048_576);
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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
    let guard = eventually(|| {
        fs::read_to_string(format!(
            "/proc/{}/task/{}/children",
            caller.id(),
            caller.id()
        ))
        .ok()
        .and_then(|s| {
            s.split_whitespace()
                .filter_map(|v| v.parse::<i32>().ok())
                .find(|p| *p != pid(&first, "guardPid"))
        })
    });
    // Wait for the guard to exec and close all inherited descriptors except
    // stdio; fd 2 must still carry the stop lease while command lock is held.
    eventually(|| {
        fs::read_link(format!("/proc/{guard}/exe"))
            .ok()
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n == "hack-lifecycle-supervisor")
            })
    });
    let lease_inode = fs::metadata(f.root.join(".stop.lock")).unwrap().ino();
    eventually(|| {
        fs::metadata(format!("/proc/{guard}/fd/2"))
            .ok()
            .filter(|metadata| metadata.ino() == lease_inode)
    });
    let guard_identity = identity(guard).unwrap();
    f.owned.borrow_mut().push(guard_identity.clone());
    caller.kill().unwrap();
    caller.wait().unwrap();
    let mut stop = command(&f.root, "stop").spawn().unwrap();
    send(stop.stdin.as_mut().unwrap(), &f.control(TOKEN));
    thread::sleep(Duration::from_millis(150));
    assert!(
        stop.try_wait().unwrap().is_none(),
        "stop passed an unpublished guard"
    );
    assert!(!f.root.join("worker.json").exists());
    // SAFETY: captured direct guard is still blocked on our fixture lock.
    assert!(identity(guard).as_ref() == Some(&guard_identity));
    assert_eq!(unsafe { libc::kill(guard, libc::SIGKILL) }, 0);
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
fn guard_dying_during_stop_gets_a_fresh_authored_term_grace() {
    let f = Fixture::new();
    let (mut caller, _) = f.start(vec![f.process("worker", "ignore-term")]);
    f.await_log("fixture-ready");
    let guard = pid(&f.state("worker"), "guardPid");
    let birth = identity(guard).unwrap();
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
    // SAFETY: the guard belongs to this fixture and its receipt is immutable.
    assert_eq!(unsafe { libc::kill(guard, libc::SIGSTOP) }, 0);
    let (mut stop, receipt) = f.request("stop", &f.control(TOKEN));
    assert_eq!(receipt["outcome"], "unknown");
    assert!(!wait(&mut stop, TIMEOUT).success());
    assert_eq!(unsafe { libc::kill(pid(&state, "commandPid"), 0) }, 0);
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
            eventually(|| {
                #[cfg(target_os = "linux")]
                let zombie = fs::read_to_string(format!("/proc/{child}/stat"))
                    .ok()
                    .is_some_and(|s| {
                        s.rsplit_once(") ")
                            .is_some_and(|(_, tail)| tail.starts_with("Z "))
                    });
                #[cfg(target_os = "macos")]
                let zombie = {
                    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
                    let size = unsafe {
                        libc::proc_pidinfo(
                            child,
                            libc::PROC_PIDTBSDINFO,
                            0,
                            info.as_mut_ptr().cast(),
                            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
                        )
                    };
                    size as usize == std::mem::size_of::<libc::proc_bsdinfo>()
                        && unsafe { info.assume_init().pbi_status == libc::SZOMB }
                };
                zombie.then_some(())
            });
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
        "hold" => (),
        _ => std::process::exit(99),
    }
    println!("fixture-ready");
    std::io::stdout().flush().unwrap();
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
