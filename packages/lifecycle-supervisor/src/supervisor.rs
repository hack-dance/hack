use crate::{
    Result, os,
    protocol::{self, Control, GuardLaunch, Launch},
    refused,
    storage::{Root, State},
};
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::process::{CommandExt, ExitStatusExt},
    },
    process::{Child, Command, Stdio},
    sync::atomic::Ordering,
    thread,
    time::{Duration, Instant},
};

const GRACE: Duration = Duration::from_secs(5);
const IDLE_TICK: Duration = Duration::from_millis(500);
const TICK: Duration = Duration::from_millis(20);
const LINE_LIMIT: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    version: u32,
    supervisor_pid: u32,
    outcome: &'static str,
    processes: Vec<State>,
    live_process_names: Vec<String>,
    unknown_process_names: Vec<String>,
}

impl Receipt {
    fn new(supervisor_pid: u32, outcome: &'static str, processes: Vec<State>) -> Self {
        let mut live_process_names = Vec::new();
        let mut unknown_process_names = Vec::new();
        for state in &processes {
            match os::observe_state(state) {
                os::Observation::Live => live_process_names.push(state.name.clone()),
                os::Observation::Absent => (),
                os::Observation::Unknown => unknown_process_names.push(state.name.clone()),
            }
        }
        Self {
            version: 1,
            supervisor_pid,
            outcome,
            processes,
            live_process_names,
            unknown_process_names,
        }
    }
}

pub fn main() -> Result<()> {
    os::close_inherited()?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err(refused());
    }
    match args[0].to_str() {
        Some("run") => run(protocol::read(&mut std::io::stdin())?),
        Some("guard") => guard(protocol::read(&mut std::io::stdin())?),
        Some("stop") | Some("status") => {
            let request: Control = protocol::read(&mut std::io::stdin())?;
            protocol::validate_control(request.version, &request.root, &request.owner_token)?;
            let root = Root::open(&request.root)?;
            let _stop_lock = if args[0] == "stop" {
                Some(root.lock_wait(".stop.lock")?)
            } else {
                None
            };
            let mut states = Vec::new();
            for state in root.states()? {
                if state.owner_token == request.owner_token {
                    states.push(state);
                } else if os::recorded_live(&state, false)? {
                    // Old terminal receipts survive renames and new generations.
                    // Guard-written terminal phases prove completed retirement;
                    // non-terminal receipts require native identity evidence.
                    return Err(refused());
                }
            }
            let result = if args[0] == "stop" {
                root.retire(&request.owner_token)?;
                stop(&states)
            } else if root.assert_not_retired(&request.owner_token).is_err()
                && states
                    .iter()
                    .any(|state| !matches!(os::observe_state(state), os::Observation::Absent))
            {
                Err(refused())
            } else {
                Ok(())
            };
            protocol::write(
                &mut std::io::stdout(),
                &Receipt::new(
                    0,
                    if result.is_err() {
                        "unknown"
                    } else if args[0] == "stop" {
                        "stopped"
                    } else {
                        "observed"
                    },
                    root.states()?
                        .into_iter()
                        .filter(|state| state.owner_token == request.owner_token)
                        .collect(),
                ),
            )?;
            result
        }
        _ => Err(refused()),
    }
}

fn run(request: Launch) -> Result<()> {
    protocol::validate_control(request.version, &request.root, &request.owner_token)?;
    if request.processes.is_empty() || request.processes.len() > 128 {
        return Err(refused());
    }
    let mut names = std::collections::BTreeSet::new();
    for process in &request.processes {
        process.validate()?;
        if !names.insert(process.name.to_ascii_lowercase()) {
            return Err(refused());
        }
    }
    let root = Root::open(&request.root)?;
    let _instance_lock = instance_lock(&root)?;
    os::census_preflight()?;
    let launch_lock = root.lock_wait(".stop.lock")?;
    root.assert_not_retired(&request.owner_token)?;
    // Validate every old claim before starting any new command. A guard survives
    // project-owner death; its command lock also closes concurrent restart races.
    for state in root.states()? {
        if os::recorded_live(&state, false)? {
            return Err(refused());
        }
    }
    os::session()?;
    os::signals()?;
    let mut children = Vec::new();
    let outcome = (|| {
        let mut states = Vec::new();
        for process in request.processes {
            if os::STOP.load(Ordering::Relaxed) {
                return Err(refused());
            }
            #[cfg(target_os = "linux")]
            let executable = std::path::PathBuf::from("/proc/self/exe");
            #[cfg(not(target_os = "linux"))]
            let executable = std::env::current_exe()?;
            let mut command = Command::new(executable);
            command
                .arg("guard")
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                // Keep stop admission leased even if this supervisor dies
                // before the guard publishes its durable identity. fd 2 is
                // reserved until guard receipt delivery/detach (or exit).
                .stderr(Stdio::from(launch_lock.try_clone()?));
            // SAFETY: setsid is async-signal-safe, and this closure allocates no
            // application state. It runs in the freshly forked child only.
            unsafe {
                command.pre_exec(os::session);
            }
            let child = command.spawn()?;
            children.push(child);
            let child = children.last_mut().ok_or_else(refused)?;
            let plan = GuardLaunch {
                version: 1,
                root: request.root.clone(),
                owner_token: request.owner_token.clone(),
                process,
            };
            protocol::write(&mut child.stdin.take().ok_or_else(refused)?, &plan)?;
            let state: State = protocol::read(&mut child.stdout.take().ok_or_else(refused)?)?;
            if state.guard_pid != child.id() as i32 || state.owner_token != request.owner_token {
                return Err(refused());
            }
            if state.phase == "failed-start" {
                return Err(refused());
            }
            states.push(state);
        }
        protocol::write(
            &mut std::io::stdout(),
            &Receipt::new(std::process::id(), "ready", states),
        )?;
        drop(launch_lock);
        detach_stdio()?;
        loop {
            if os::STOP.load(Ordering::Relaxed) {
                match root.lock_wait(".stop.lock") {
                    Ok(_lock) => {
                        stop(&root.states()?)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::TimedOut => (),
                    Err(error) => return Err(error),
                }
            }
            let mut running = false;
            for child in &mut children {
                if child.try_wait()?.is_none() {
                    running = true;
                }
            }
            if !running {
                return Ok(());
            }
            os::wait_activity(&[], IDLE_TICK)?;
        }
    })();
    if outcome.is_err() {
        // Rollback only this start's unreaped children. Never infer authority from
        // another root entry while handling a launch failure.
        rollback(&mut children);
    }
    outcome
}

fn instance_lock(root: &Root) -> Result<File> {
    // Preserve the uncontended fast path; a bounded retry below distinguishes
    // contention from persistent file/OS failures with the actual errno.
    if let Ok(file) = root.lock(".instance.lock") {
        return Ok(file);
    }
    let file = root.file(".instance.lock", libc::O_RDWR | libc::O_CREAT)?;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        // SAFETY: file remains owned throughout this bounded retry.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ) || Instant::now() >= deadline
        {
            return Err(error);
        }
        thread::sleep(TICK);
    }
}

fn rollback(children: &mut [Child]) {
    for child in children.iter_mut() {
        if child.try_wait().ok().flatten().is_some() {
            continue;
        }
        let pid = child.id() as i32;
        // An unreaped direct Child pins the PID; only the guard receives TERM.
        // SAFETY: the child has not been reaped, so this PID cannot be reused.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + GRACE + Duration::from_secs(2);
    while Instant::now() < deadline {
        if children
            .iter_mut()
            .all(|child| child.try_wait().ok().flatten().is_some())
        {
            break;
        }
        thread::sleep(TICK);
    }
    // A guard still alive after KILL confirmation remains the owner of unknown
    // or uninterruptible work. Do not kill it and discard its lock.
}

fn guard(request: GuardLaunch) -> Result<()> {
    protocol::validate_control(request.version, &request.root, &request.owner_token)?;
    request.process.validate()?;
    let root = Root::open(&request.root)?;
    let _command_lock = root.lock_wait(&format!("{}.lock", request.process.name))?;
    if let Some(previous) = root.load(&request.process.name)?
        && os::recorded_live(&previous, false)?
    {
        return Err(refused());
    }
    let pid = std::process::id() as i32;
    let identity = os::inspect(pid)?.ok_or_else(refused)?;
    if identity.group != pid {
        return Err(refused());
    }
    os::signals()?;
    os::subreaper()?;
    os::census_preflight()?;
    let mut state = State {
        version: 1,
        name: request.process.name.clone(),
        owner_token: request.owner_token,
        guard_pid: pid,
        process_group_id: pid,
        guard_start_time: identity.start,
        boot_id: os::boot()?,
        uid: identity.uid,
        command_pid: None,
        command_start_time: None,
        phase: "starting".into(),
        exit_code: None,
        signal: None,
    };
    let mut log = root.file(
        "lifecycle.log",
        libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT,
    )?;
    root.save(&state)?;
    let outcome = guard_command(&request.process, &root, &mut state, &mut log);
    if outcome.is_err() && state.command_pid.is_some() {
        // Keep ownership while confirming internal-error cleanup. If even the
        // census fails, retain the guard and lock rather than silently orphan.
        let _ = os::session_signal(pid, libc::SIGTERM);
        thread::sleep(GRACE);
        loop {
            let _ = os::session_signal(pid, libc::SIGKILL);
            let _ = os::reap();
            if matches!(os::live_group(pid, Some(pid)), Ok(false)) {
                break;
            }
            thread::sleep(TICK);
        }
    }
    outcome
}

fn guard_command(
    process: &protocol::Process,
    root: &Root,
    state: &mut State,
    log: &mut File,
) -> Result<()> {
    let mut command = Command::new(&process.argv[0]);
    command
        .args(&process.argv[1..])
        .current_dir(&process.cwd)
        .env_clear()
        .envs(&process.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: command_setup uses only async-signal-safe operations after fork.
    unsafe {
        command.pre_exec(os::command_setup);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            state.phase = "failed-start".into();
            root.save(state)?;
            protocol::write(&mut std::io::stdout(), state)?;
            return Err(refused());
        }
    };
    state.command_pid = Some(child.id() as i32);
    state.command_start_time = os::inspect(child.id() as i32)?.map(|identity| identity.start);
    state.phase = "running".into();
    root.save(state)?;
    let mut stdout = child.stdout.take().ok_or_else(refused)?;
    let mut stderr = child.stderr.take().ok_or_else(refused)?;
    os::nonblocking(&stdout)?;
    os::nonblocking(&stderr)?;
    protocol::write(&mut std::io::stdout(), state)?;
    detach_stdio()?;
    let mut out = Lines::default();
    let mut err = Lines::default();
    let mut stopping = None;
    let mut killed = false;
    let mut direct_exited = false;
    let mut drained_after_exit = None;
    let mut last_census = Instant::now() - IDLE_TICK;
    let mut live = true;
    let mut stdout_open = true;
    let mut stderr_open = true;
    loop {
        // Alternate bounded reads so stdout bursts cannot starve stderr/stop.
        if stdout_open {
            stdout_open = out.drain(&mut stdout, log, &state.name, "stdout")?;
        }
        if stderr_open {
            stderr_open = err.drain(&mut stderr, log, &state.name, "stderr")?;
        }
        let was_exited = direct_exited;
        if !direct_exited && let Some(status) = child.try_wait()? {
            direct_exited = true;
            state.exit_code = status.code();
            state.signal = status.signal();
        }
        // Linux's subreaper may adopt exited grandchildren while the direct
        // command remains alive. Reap continuously, retaining the direct child's
        // wait status if it exits between try_wait and this raw waitpid census.
        for (pid, status) in os::reap()? {
            if pid == child.id() as i32 {
                direct_exited = true;
                state.exit_code = status.code();
                state.signal = status.signal();
            }
        }
        // A live direct child already proves work remains. Census is needed
        // only after that child exits (descendants may remain), or during stop.
        if (direct_exited && (last_census.elapsed() >= IDLE_TICK || !was_exited))
            || stopping.is_some()
        {
            live = os::live_group(state.process_group_id, Some(state.guard_pid))?;
            last_census = Instant::now();
        }
        if os::STOP.swap(false, Ordering::Relaxed) && stopping.is_none() {
            state.phase = "stopping".into();
            root.save(state)?;
            stopping = Some(Instant::now());
            os::session_signal(state.guard_pid, libc::SIGTERM)?;
        }
        if !live && direct_exited {
            let since = *drained_after_exit.get_or_insert_with(Instant::now);
            // Never wait on EOF: foreign fork/exec activity can transiently
            // inherit a pipe on Darwin. Drain a bounded final interval instead.
            if since.elapsed() >= Duration::from_millis(100) {
                if !out.pending.is_empty() {
                    out.flush(log, &state.name, "stdout", true)?;
                }
                if !err.pending.is_empty() {
                    err.flush(log, &state.name, "stderr", true)?;
                }
                state.phase = if killed { "killed" } else { "exited" }.into();
                root.save(state)?;
                return Ok(());
            }
        }
        if stopping.is_some_and(|start| start.elapsed() >= GRACE) {
            state.phase = "kill-pending".into();
            if !killed {
                root.save(state)?;
                killed = true;
            }
            os::session_signal(state.guard_pid, libc::SIGKILL)?;
        }
        let fds: Vec<_> = [
            (stdout_open, stdout.as_raw_fd()),
            (stderr_open, stderr.as_raw_fd()),
        ]
        .into_iter()
        .filter_map(|(open, fd)| open.then_some(fd))
        .collect();
        os::wait_activity(
            &fds,
            if stopping.is_some() || drained_after_exit.is_some() {
                TICK
            } else {
                IDLE_TICK
            },
        )?;
    }
}

// A live guard owns shutdown even when a complete recovery census is unavailable
// (for example, a different-UID descendant). Orphans require strict capture.
fn stop_capture<T>(
    guard_live: bool,
    capture: impl FnOnce() -> Result<T>,
) -> Result<(Option<T>, Option<T>)> {
    if guard_live {
        Ok((None, capture().ok()))
    } else {
        Ok((Some(capture()?), None))
    }
}

fn guard_lost(state: &State) -> Result<bool> {
    Ok(os::inspect(state.guard_pid)?.is_none_or(|p| p.zombie))
}

// None transfers to orphan recovery. A census error cannot bypass that transfer
// when the guard disappears during the census or its witness recheck.
fn guarded_live(state: &State) -> Result<Option<bool>> {
    if guard_lost(state)? {
        return Ok(None);
    }
    match os::recorded_live(state, false) {
        Ok(live) => Ok(Some(live)),
        Err(_) if guard_lost(state)? => Ok(None),
        Err(error) => Err(error),
    }
}

fn stop(states: &[State]) -> Result<()> {
    struct Target {
        state: State,
        recovery: Option<os::Recovery>,
        admission: Option<os::Recovery>,
        orphan_term: Option<Instant>,
        finished: bool,
    }
    impl Target {
        fn recover(&mut self) -> Result<()> {
            // Prefer a fresh census, but retain already-proved identities if
            // TERM ended the command witness before the guard was lost.
            let recovery = os::Recovery::capture(&self.state)
                .or_else(|error| self.admission.take().ok_or(error))?;
            recovery.signal(libc::SIGTERM)?;
            self.orphan_term = Some(Instant::now());
            self.recovery = Some(recovery);
            Ok(())
        }

        fn advance(&mut self, start: Instant) -> Result<bool> {
            if self.recovery.is_none() {
                match guarded_live(&self.state)? {
                    None => self.recover()?,
                    Some(false) => return Ok(false),
                    Some(true) => {
                        if start.elapsed() >= GRACE + Duration::from_secs(2) {
                            return Err(refused());
                        }
                        return Ok(true);
                    }
                }
            }
            let recovery = self.recovery.as_ref().ok_or_else(refused)?;
            if !recovery.live()? {
                return Ok(false);
            }
            let elapsed = self.orphan_term.ok_or_else(refused)?.elapsed();
            if elapsed >= GRACE + Duration::from_secs(2) {
                return Err(refused());
            }
            if elapsed >= GRACE {
                recovery.signal(libc::SIGKILL)?;
            }
            Ok(true)
        }
    }
    let mut active = Vec::new();
    // Validate admission before effects. Capture while a live guard can still
    // prove membership, so loss during the later liveness check retains authority.
    for state in states {
        let guard_live = match os::inspect(state.guard_pid)? {
            Some(identity) if !identity.zombie => {
                if let Err(error) = os::same(state, &identity) {
                    if !os::recorded_live(state, false)? {
                        continue;
                    }
                    return Err(error);
                }
                true
            }
            _ => false,
        };
        let (recovery, admission) = stop_capture(guard_live, || os::Recovery::capture(state))?;
        match os::recorded_live(state, false) {
            Ok(false) => continue,
            Ok(true) => (),
            Err(_) if guard_lost(state)? && (recovery.is_some() || admission.is_some()) => (),
            Err(error) => return Err(error),
        }
        active.push(Target {
            state: state.clone(),
            recovery,
            admission,
            orphan_term: None,
            finished: false,
        });
    }
    let mut failure = None;
    for target in &mut active {
        let signalled = if let Some(recovery) = &target.recovery {
            target.orphan_term = Some(Instant::now());
            recovery.signal(libc::SIGTERM)
        } else {
            match os::signal_guard(&target.state) {
                Ok(()) => Ok(()),
                Err(error) => match guarded_live(&target.state) {
                    Ok(None) => target.recover(),
                    Ok(Some(false)) => Ok(()),
                    Ok(Some(true)) => Err(error),
                    Err(error) => Err(error),
                },
            }
        };
        if let Err(error) = signalled {
            target.finished = true;
            failure.get_or_insert(error);
        }
    }
    let start = Instant::now();
    loop {
        let mut live = false;
        for target in active.iter_mut().filter(|target| !target.finished) {
            match target.advance(start) {
                Ok(true) => live = true,
                Ok(false) => target.finished = true,
                Err(error) => {
                    target.finished = true;
                    failure.get_or_insert(error);
                }
            }
        }
        if !live {
            return failure.map_or(Ok(()), Err);
        }
        thread::sleep(TICK);
    }
}

fn detach_stdio() -> Result<()> {
    let null = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null")?;
    for fd in 0..=2 {
        // SAFETY: dup2 replaces only this process's standard descriptors with
        // the borrowed live /dev/null descriptor; no pointer is retained.
        if unsafe { libc::dup2(null.as_raw_fd(), fd) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[derive(Default)]
struct Lines {
    pending: Vec<u8>,
}

impl Lines {
    fn drain(
        &mut self,
        input: &mut impl Read,
        log: &mut File,
        name: &str,
        stream: &str,
    ) -> Result<bool> {
        let mut buffer = [0u8; 8192];
        for _ in 0..32 {
            match input.read(&mut buffer) {
                Ok(0) => return Ok(false),
                Ok(count) => {
                    for byte in &buffer[..count] {
                        if *byte == b'\n' {
                            self.flush(log, name, stream, true)?;
                        } else {
                            self.pending.push(*byte);
                            if self.pending.len() == LINE_LIMIT {
                                let tail_length = incomplete_utf8_tail(&self.pending);
                                let tail = self.pending.split_off(self.pending.len() - tail_length);
                                self.flush(log, name, stream, false)?;
                                self.pending = tail;
                            }
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }

    fn flush(&mut self, log: &mut File, name: &str, stream: &str, trim_cr: bool) -> Result<()> {
        let bytes = if trim_cr {
            self.pending.strip_suffix(b"\r").unwrap_or(&self.pending)
        } else {
            &self.pending
        };
        let message = String::from_utf8_lossy(bytes).replace('\t', "    ");
        let record = format!("{}\t{name}\t{stream}\t{message}\n", os::timestamp()?);
        // One append per complete record; concurrent guards share the same
        // flock so records larger than PIPE_BUF never interleave.
        os::flock_retry(log.as_raw_fd(), libc::LOCK_EX)?;
        let result = log.write_all(record.as_bytes());
        let unlocked = os::flock_retry(log.as_raw_fd(), libc::LOCK_UN);
        result?;
        unlocked?;
        self.pending.clear();
        Ok(())
    }
}

fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
    for index in (bytes.len().saturating_sub(4)..bytes.len()).rev() {
        let byte = bytes[index];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let expected = match byte {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => 1,
        };
        let available = bytes.len() - index;
        return if expected > available { available } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::incomplete_utf8_tail;

    #[test]
    fn live_guard_admission_tolerates_unavailable_recovery_census() {
        let denied = || Err::<(), _>(std::io::Error::from_raw_os_error(libc::EPERM));
        let (recovery, admission) = super::stop_capture(true, denied).unwrap();
        assert!(recovery.is_none() && admission.is_none());
        assert!(super::stop_capture(false, denied).is_err());
        let (recovery, admission) = super::stop_capture(true, || Ok(42)).unwrap();
        assert!(recovery.is_none());
        assert_eq!(admission, Some(42));
    }

    #[test]
    fn chunk_boundary_retains_only_incomplete_codepoints() {
        for text in ["a", "é", "€", "🦀"] {
            let bytes = text.as_bytes();
            assert_eq!(incomplete_utf8_tail(bytes), 0);
            for length in 1..bytes.len() {
                assert_eq!(incomplete_utf8_tail(&bytes[..length]), length);
            }
        }
        assert_eq!(incomplete_utf8_tail(b"abc\xff"), 0);
    }
}
