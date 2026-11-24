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
/// Time after KILL for a stop to confirm absence.
const CONFIRM_BOUND: Duration = Duration::from_secs(2);
const ORPHAN_STOP_BOUND: Duration = GRACE.saturating_add(CONFIRM_BOUND);
/// The caller's clock starts independently of the guard. Allow extra time for
/// the guard to handle the signal, publish its phase and run escalation.
const GUARDED_STOP_BOUND: Duration = ORPHAN_STOP_BOUND.saturating_add(Duration::from_secs(3));
/// Outlast the guard wait followed by a fresh orphan recovery after late guard
/// loss. Admission, census and signalling can add time. An expired lock wait
/// returns `unknown` with reason `stop-lock-wait-expired` and acts on nothing.
pub(crate) const STOP_LOCK_WAIT: Duration = GUARDED_STOP_BOUND
    .saturating_add(ORPHAN_STOP_BOUND)
    .saturating_add(Duration::from_secs(2));
/// Bounded wait for a previous command owner to release its lock.
const COMMAND_LOCK_WAIT: Duration = Duration::from_secs(10);
/// Bounded wait for another project supervisor to release the instance lock.
pub(crate) const INSTANCE_LOCK_WAIT: Duration = Duration::from_secs(10);
const LINE_LIMIT: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    version: u32,
    supervisor_pid: u32,
    outcome: &'static str,
    processes: Vec<State>,
    live_process_names: Vec<String>,
    unknown_process_names: Vec<String>,
    /// Why a stop or status request did not complete; absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl Receipt {
    pub(crate) fn new(supervisor_pid: u32, outcome: &'static str, processes: Vec<State>) -> Self {
        let mut live_process_names = Vec::new();
        let mut unknown_process_names = Vec::new();
        for state in &processes {
            match os::observe_state(state) {
                os::Observation::Live => live_process_names
                    .push(state.display_name.as_ref().unwrap_or(&state.name).clone()),
                os::Observation::Unknown => unknown_process_names
                    .push(state.display_name.as_ref().unwrap_or(&state.name).clone()),
                os::Observation::Absent => (),
            }
        }
        Self {
            version: 1,
            supervisor_pid,
            outcome,
            processes,
            live_process_names,
            unknown_process_names,
            reason: None,
        }
    }
}

/// Answer one `stop` or `status` request. Every request that reaches this
/// point ends with exactly one framed receipt, including refusals and expired
/// waits, so a caller can tell an incomplete request from a crash. A failure
/// keeps the nonzero exit and reports outcome `refused` (no request was
/// admitted) or `unknown`, with a `reason` code.
fn control(action: &str) -> Result<()> {
    let mut stdout = std::io::stdout();
    let admitted = protocol::read::<Control>(&mut std::io::stdin()).and_then(|request| {
        protocol::validate_control(request.version, &request.root, &request.owner_token)?;
        let root = Root::open(&request.root)?;
        Ok((request, root))
    });
    let (request, root) = match admitted {
        Ok(admitted) => admitted,
        Err(error) => {
            let mut receipt = Receipt::new(0, "refused", Vec::new());
            receipt.reason = Some("invalid-request");
            protocol::write(&mut stdout, &receipt)?;
            return Err(error);
        }
    };
    let mut reason = "io-error";
    let mut result = control_effects(action, &request, &root, &mut reason);
    // Receipts are atomically replaced files, so this read is safe without the
    // lock, also after a lock wait expired. A failed read never reports
    // success: it keeps an earlier error, or becomes `receipt-read-failed`.
    let processes = match root.states() {
        Ok(states) => states
            .into_iter()
            .filter(|state| state.owner_token == request.owner_token)
            .collect(),
        Err(error) => {
            if result.is_ok() {
                reason = "receipt-read-failed";
                result = Err(error);
            }
            Vec::new()
        }
    };
    let outcome = match (&result, action) {
        (Err(_), _) => "unknown",
        (Ok(()), "stop") => "stopped",
        (Ok(()), _) => "observed",
    };
    let mut receipt = Receipt::new(0, outcome, processes);
    if result.is_err() {
        receipt.reason = Some(reason);
    }
    protocol::write(&mut stdout, &receipt)?;
    result
}

fn control_effects(
    action: &str,
    request: &Control,
    root: &Root,
    reason: &mut &'static str,
) -> Result<()> {
    let _stop_lock = if action == "stop" {
        match root.lock_wait(".stop.lock", STOP_LOCK_WAIT) {
            Ok(lock) => Some(lock),
            Err(error) => {
                *reason = if error.kind() == std::io::ErrorKind::TimedOut {
                    // Another stop or a launch still holds the lock; act on nothing.
                    "stop-lock-wait-expired"
                } else {
                    "stop-lock-failed"
                };
                return Err(error);
            }
        }
    } else {
        // Status waits for a stop in progress, but never creates the lock file.
        match root.existing_lock_wait(".stop.lock", STOP_LOCK_WAIT) {
            Ok(lock) => lock,
            Err(error) => {
                if error.kind() == std::io::ErrorKind::TimedOut {
                    *reason = "stop-lock-wait-expired";
                }
                return Err(error);
            }
        }
    };
    let mut states = Vec::new();
    *reason = "receipt-read-failed";
    for state in root.states()? {
        *reason = "io-error";
        if state.owner_token == request.owner_token {
            states.push(state);
            continue;
        }
        // Old terminal receipts survive renames and new generations.
        // Guard-written terminal phases prove completed retirement;
        // non-terminal receipts require native identity evidence.
        match os::recorded_live(&state, false) {
            Ok(false) => (),
            Ok(true) => {
                *reason = "foreign-live-process";
                return Err(refused());
            }
            Err(error) => {
                // Only live members that no witness ties to that receipt are
                // `foreign-unknown-process`; a census, inspection or boot-ID
                // failure stays `io-error`. Neither signals or retires anything.
                if os::is_no_witness(&error) {
                    *reason = "foreign-unknown-process";
                }
                return Err(error);
            }
        }
    }
    *reason = "io-error";
    if action == "stop" {
        *reason = "retire-failed";
        root.retire(&request.owner_token)?;
        *reason = "stop-incomplete";
        return stop(&states);
    }
    if root.assert_not_retired(&request.owner_token).is_err()
        && states
            .iter()
            .any(|state| !matches!(os::observe_state(state), os::Observation::Absent))
    {
        *reason = "retired-owner-live";
        return Err(refused());
    }
    Ok(())
}

pub fn main() -> Result<()> {
    let result = dispatch();
    if result.is_err() && !protocol::stdout_started() {
        let _ = protocol::write(
            &mut std::io::stdout(),
            &Receipt::new(0, "refused", Vec::new()),
        );
    }
    result
}

fn dispatch() -> Result<()> {
    os::close_inherited()?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err(refused());
    }
    match args[0].to_str() {
        Some("run") => run(protocol::read(&mut std::io::stdin())?),
        Some("serve") => crate::incremental::serve(protocol::read(&mut std::io::stdin())?),
        Some("add") => crate::incremental::add(protocol::read(&mut std::io::stdin())?),
        Some("guard") => guard(protocol::read(&mut std::io::stdin())?),
        Some(action @ ("stop" | "status")) => control(action),
        _ => Err(refused()),
    }
}

pub(crate) fn validate_launch(request: &Launch) -> Result<()> {
    protocol::validate_control(request.version, &request.root, &request.owner_token)?;
    if request
        .log_path
        .as_ref()
        .is_some_and(|path| !path.is_absolute() || path.file_name().is_none())
    {
        return Err(refused());
    }
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
    Ok(())
}

fn run(request: Launch) -> Result<()> {
    validate_launch(&request)?;
    let root = Root::open(&request.root)?;
    let _instance_lock = match root.lock(".instance.lock") {
        Ok(lock) => lock,
        Err(_) => root.lock_wait(".instance.lock", INSTANCE_LOCK_WAIT)?,
    };
    os::census_preflight()?;
    let launch_lock = root.lock_wait(".stop.lock", STOP_LOCK_WAIT)?;
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
            let state = start_guard(
                &request.root,
                &request.owner_token,
                request.log_path.as_deref(),
                &launch_lock,
                process,
                &mut children,
            )?;
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
                match root.lock_wait(".stop.lock", STOP_LOCK_WAIT) {
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

pub(crate) fn start_guard(
    root: &std::path::Path,
    owner_token: &str,
    log_path: Option<&std::path::Path>,
    launch_lock: &File,
    process: protocol::Process,
    children: &mut Vec<Child>,
) -> Result<State> {
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
        .stderr(Stdio::from(launch_lock.try_clone()?));
    // SAFETY: setsid only uses async-signal-safe operations in the fresh child.
    unsafe {
        command.pre_exec(os::session);
    }
    children.push(command.spawn()?);
    let child = children.last_mut().ok_or_else(refused)?;
    let plan = GuardLaunch {
        version: 1,
        root: root.into(),
        owner_token: owner_token.into(),
        process,
        log_path: log_path.map(std::path::Path::to_path_buf),
    };
    protocol::write(&mut child.stdin.take().ok_or_else(refused)?, &plan)?;
    let state: State = protocol::read(&mut child.stdout.take().ok_or_else(refused)?)?;
    if state.guard_pid != child.id() as i32
        || state.owner_token != owner_token
        || state.phase == "failed-start"
    {
        return Err(refused());
    }
    Ok(state)
}

pub(crate) fn rollback(children: &mut [Child]) {
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
    let deadline = Instant::now() + GRACE + CONFIRM_BOUND;
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
    let _command_lock =
        root.lock_wait(&format!("{}.lock", request.process.name), COMMAND_LOCK_WAIT)?;
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
        display_name: request.process.display_name.clone(),
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
    let mut log = if let Some(path) = request.log_path {
        if !path.is_absolute() {
            return Err(refused());
        }
        let parent = Root::open(path.parent().ok_or_else(refused)?)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(refused)?;
        if name == "." || name == ".." || name.contains('/') {
            return Err(refused());
        }
        parent.file(name, libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT)?
    } else {
        root.file(
            "lifecycle.log",
            libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT,
        )?
    };
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

/// Only qualification builds can pause at these instruction boundaries. The
/// requested checkpoint is read from the explicit test process plan, never the
/// guard's ambient environment. Shipped/default builds contain no checkpoint.
#[cfg(feature = "test-hooks")]
fn test_pause(process: &protocol::Process, checkpoint: &str) {
    if process
        .env
        .get("SUPERVISOR_TEST_CHECKPOINT")
        .map(String::as_str)
        == Some(checkpoint)
    {
        // SAFETY: affects only this guard, which the fixture owns and kills.
        unsafe {
            libc::raise(libc::SIGSTOP);
        }
    }
}

fn guard_command(
    process: &protocol::Process,
    root: &Root,
    state: &mut State,
    log: &mut File,
) -> Result<()> {
    let log_name = sanitize_service(state.display_name.as_deref().unwrap_or(&state.name));
    #[cfg(feature = "test-hooks")]
    test_pause(process, "before-spawn");
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
    #[cfg(feature = "test-hooks")]
    test_pause(process, "after-spawn");
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
            stdout_open = out.drain(&mut stdout, log, &log_name, "stdout")?;
        }
        if stderr_open {
            stderr_open = err.drain(&mut stderr, log, &log_name, "stderr")?;
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
                    out.flush(log, &log_name, "stdout", true)?;
                }
                if !err.pending.is_empty() {
                    err.flush(log, &log_name, "stderr", true)?;
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
                        if start.elapsed() >= GUARDED_STOP_BOUND {
                            return Err(refused());
                        }
                        return Ok(true);
                    }
                }
            }
            let recovery = self.recovery.as_ref().ok_or_else(refused)?;
            let liveness = recovery.live()?;
            if liveness == os::RecoveryLiveness::Gone {
                return Ok(false);
            }
            let elapsed = self.orphan_term.ok_or_else(refused)?.elapsed();
            if elapsed >= ORPHAN_STOP_BOUND {
                return Err(refused());
            }
            // Only captured incarnations are signalled. Unobserved members get
            // the rest of this target's deadline to exit on their own.
            if elapsed >= GRACE && liveness == os::RecoveryLiveness::Captured {
                recovery.signal(libc::SIGKILL)?;
            }
            Ok(true)
        }
    }
    let mut active = Vec::new();
    let mut failure = None;
    // Validate admission before effects. Capture while a live guard can still
    // prove membership, so loss during the later liveness check retains authority.
    // A receipt that cannot be verified is never signalled; it records the first
    // failure, and the other admitted targets still get their stop.
    for state in states {
        let admitted = (|| -> Result<Option<Target>> {
            let guard_live = match os::inspect(state.guard_pid)? {
                Some(identity) if !identity.zombie => {
                    if let Err(error) = os::same(state, &identity) {
                        if !os::recorded_live(state, false)? {
                            return Ok(None);
                        }
                        return Err(error);
                    }
                    true
                }
                _ => false,
            };
            let (recovery, admission) = stop_capture(guard_live, || os::Recovery::capture(state))?;
            match os::recorded_live(state, false) {
                Ok(false) => return Ok(None),
                Ok(true) => (),
                Err(_) if guard_lost(state)? && (recovery.is_some() || admission.is_some()) => (),
                Err(error) => return Err(error),
            }
            Ok(Some(Target {
                state: state.clone(),
                recovery,
                admission,
                orphan_term: None,
                finished: false,
            }))
        })();
        match admitted {
            Ok(Some(target)) => active.push(target),
            Ok(None) => (),
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
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

pub(crate) fn detach_stdio() -> Result<()> {
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
        // One write per complete record on an O_APPEND descriptor, with no
        // lock: the kernel positions and writes each append atomically, so
        // whole records from sibling guards do not interleave on a local file
        // system. A guard never waits on another guard to log, so a stopped or
        // hung sibling cannot stall this guard's loop (STOP, exit, census).
        // Only a short write (for example a full disk) splits a record.
        log.write_all(record.as_bytes())?;
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

fn sanitize_service(name: &str) -> String {
    let compact = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut units = 0;
    compact
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= 96
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{incomplete_utf8_tail, sanitize_service};

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
        assert_eq!(sanitize_service("  API\t/\nworker  "), "API / worker");
        assert_eq!(sanitize_service(&"x".repeat(120)).len(), 96);
        assert_eq!(sanitize_service(&format!("{}🦀", "x".repeat(95))).len(), 95);
    }
}
