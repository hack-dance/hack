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
const TICK: Duration = Duration::from_millis(20);
const LINE_LIMIT: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    version: u32,
    supervisor_pid: u32,
    outcome: &'static str,
    processes: Vec<State>,
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
                    // Only a kernel census can prove they no longer hold work;
                    // a persisted terminal phase alone is never sufficient.
                    return Err(refused());
                }
            }
            let result = if args[0] == "stop" {
                stop(&states)
            } else {
                Ok(())
            };
            protocol::write(
                &mut std::io::stdout(),
                &Receipt {
                    version: 1,
                    supervisor_pid: 0,
                    outcome: if result.is_err() {
                        "unknown"
                    } else if args[0] == "stop" {
                        "stopped"
                    } else {
                        "observed"
                    },
                    processes: root
                        .states()?
                        .into_iter()
                        .filter(|state| state.owner_token == request.owner_token)
                        .collect(),
                },
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
    let _instance_lock = root.lock(".instance.lock")?;
    let launch_lock = root.lock_wait(".stop.lock")?;
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
            let mut command = Command::new(std::env::current_exe()?);
            command
                .arg("guard")
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
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
            &Receipt {
                version: 1,
                supervisor_pid: std::process::id(),
                outcome: "ready",
                processes: states,
            },
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
            thread::sleep(TICK);
        }
    })();
    if outcome.is_err() {
        // Rollback only this start's unreaped children. Never infer authority from
        // another root entry while handling a launch failure.
        rollback(&mut children);
    }
    outcome
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
    let _command_lock = root.lock(&format!("{}.lock", request.process.name))?;
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
    loop {
        // Alternate bounded reads so stdout bursts cannot starve stderr/stop.
        out.drain(&mut stdout, log, &state.name, "stdout")?;
        err.drain(&mut stderr, log, &state.name, "stderr")?;
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
        let live = os::live_group(state.process_group_id, Some(state.guard_pid))?;
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
        thread::sleep(TICK);
    }
}

fn stop(states: &[State]) -> Result<()> {
    let mut active = Vec::new();
    // Validate the full set before taking the first effect.
    for state in states {
        if !os::recorded_live(state, false)? {
            continue;
        }
        let identity = os::inspect(state.guard_pid)?.ok_or_else(refused)?;
        os::same(state, &identity)?;
        active.push(state.clone());
    }
    for state in &active {
        if let Err(error) = os::signal_guard(state) {
            // Natural exit can race between admission and pidfd delivery.
            // Only a new kernel absence proof turns that race into success.
            if os::recorded_live(state, false)? {
                return Err(error);
            }
        }
    }
    let deadline = Instant::now() + GRACE + Duration::from_secs(2);
    while Instant::now() < deadline {
        let mut live = false;
        for state in &active {
            live |= os::recorded_live(state, false)?;
        }
        if !live {
            return Ok(());
        }
        thread::sleep(TICK);
    }
    // Unknown outcome: the guard retains its command lock while any live
    // member remains. Neither timeout nor zombie-only existence implies alive.
    Err(refused())
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
    ) -> Result<()> {
        let mut buffer = [0u8; 8192];
        for _ in 0..32 {
            match input.read(&mut buffer) {
                Ok(0) => break,
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
        Ok(())
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
        // SAFETY: flock borrows this live file descriptor until LOCK_UN.
        if unsafe { libc::flock(log.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let result = log.write_all(record.as_bytes());
        // SAFETY: unlock the same live descriptor after the write completes.
        let unlocked = unsafe { libc::flock(log.as_raw_fd(), libc::LOCK_UN) };
        result?;
        if unlocked != 0 {
            return Err(std::io::Error::last_os_error());
        }
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
