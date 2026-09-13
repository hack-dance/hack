use super::journal::OUTPUT_LIMIT;
use super::{Result, Store, error, try_lock};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Only this live parent may signal its unreaped child's process group. Recovery never
/// signals a recorded PID. A crashed supervisor leaves an explicitly uncertain receipt.
pub fn supervise(root: &Path, executable: &Path, checkout: &Path, id: &str) -> Result<()> {
    let mut store = Store::open(root, false)?;
    let _lock =
        try_lock(&store.lock_path(id)?)?.ok_or_else(|| error("Supervisor already owns job."))?;
    let receipt = store.update(id, |r| {
        if r.state != "preparing" {
            return Err(error("Job is not claimable."));
        }
        r.state = "running".into();
        r.supervisor_pid = Some(std::process::id() as i32);
        r.supervisor_identity = Some(super::ownership::observe(std::process::id() as i32)?);
        Ok(())
    })?;
    if receipt.state != "running" {
        return Err(error("Claim was quarantined or cancelled."));
    }
    if receipt.cancel_requested {
        store.update(id, |r| {
            r.state = "cancelled".into();
            Ok(())
        })?;
        return Ok(());
    }
    if let Some(source) = &receipt.source {
        let candidate = crate::Candidate::discover(checkout)?;
        if super::root(&candidate) != root {
            return Err(error("Source job journal is not bound to this candidate."));
        }
        let result = crate::provider::run_source_job(
            &candidate,
            id,
            source,
            receipt.execution_timeout_ms,
            |event| match event {
                crate::provider::SourceJobEvent::Started => store
                    .update(id, |r| {
                        r.starts += 1;
                        Ok(())
                    })
                    .map(|r| r.cancel_requested),
                crate::provider::SourceJobEvent::CheckCancellation => {
                    store.get(id).map(|r| r.cancel_requested)
                }
            },
        );
        return match result {
            Ok(result) => {
                store.update(id, |r| {
                    r.state = result.state.into();
                    r.stdout = result.stdout;
                    r.stderr = result.stderr;
                    r.truncated = result.truncated;
                    r.exit_code = result.exit_code;
                    r.detail = Some("Accepted immutable input reverified at launch; owned container absence confirmed.".into());
                    Ok(())
                })?;
                Ok(())
            }
            Err(failure) => {
                let _ = store.update(id, |r| {
                    r.state = if failure.code == "source_job_failed_cleaned" {
                        "failed"
                    } else {
                        "quarantined"
                    }
                    .into();
                    r.detail = Some(format!(
                        "Source job failed or cleanup is uncertain: {}",
                        failure.code
                    ));
                    Ok(())
                });
                Err(failure)
            }
        };
    }
    let mut command = Command::new(executable);
    command
        .arg("--candidate-root")
        .arg(checkout)
        .arg("__job_fixture")
        .arg(&receipt.fixture)
        .env_clear()
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: setpgid is async-signal-safe; creates an owned group before exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(error)?;
    let identity = super::ownership::observe(child.id() as i32);
    let mut reaped = false;
    let result = run_child(
        &mut store,
        id,
        &mut child,
        receipt.execution_timeout_ms,
        identity.as_ref(),
        &mut reaped,
    );
    if result.is_err() && !reaped {
        // Journal failure must not abandon the child while the owner is still alive.
        // run_child only reaps after all potentially failing work has completed.
        if let Ok(recorded) = &identity {
            if super::ownership::observe(child.id() as i32)
                .and_then(|observed| super::ownership::verify(recorded, &observed))
                .is_ok()
            {
                let _ = signal_group(&child, libc::SIGKILL);
            }
        }
        // Fixed fixtures self-expire even when identity cannot authorize cleanup.
        let _ = child.wait();
    }
    if let Err(ref failure) = result {
        let _ = store.update(id, |r| {
            r.state = "quarantined".into();
            r.detail = Some(format!("Supervisor failure: {}", failure.message));
            Ok(())
        });
    }
    result
}
fn run_child(
    store: &mut Store,
    id: &str,
    child: &mut Child,
    timeout_ms: u64,
    identity: std::result::Result<&super::ProcessIdentity, &crate::CandidateError>,
    reaped: &mut bool,
) -> Result<()> {
    let identity = identity.map_err(|e| error(&e.message))?;
    super::ownership::verify(identity, identity)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| error("Missing stdout pipe."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| error("Missing stderr pipe."))?;
    nonblocking(&stdout)?;
    nonblocking(&stderr)?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut truncated = false;
    store.update(id, |r| {
        r.child_pid = Some(child.id() as i32);
        r.child_identity = Some(identity.clone());
        r.starts += 1;
        Ok(())
    })?;
    let started = Instant::now();
    let mut persisted = Instant::now();
    let mut stopping: Option<(Instant, &'static str)> = None;
    loop {
        drain(&mut stdout, &mut output, &mut truncated)?;
        drain(&mut stderr, &mut errors, &mut truncated)?;
        if persisted.elapsed() >= Duration::from_millis(100) {
            store.update(id, |r| {
                r.stdout = String::from_utf8_lossy(&output).into_owned();
                r.stderr = String::from_utf8_lossy(&errors).into_owned();
                r.truncated = truncated;
                Ok(())
            })?;
            persisted = Instant::now();
        }
        let current = store.get(id)?;
        if current.terminal() {
            return Err(error("Job became terminal outside its owner."));
        }
        if exited_unreaped(child)? {
            break;
        }
        if stopping.is_none()
            && (current.cancel_requested || started.elapsed() >= Duration::from_millis(timeout_ms))
        {
            let reason = if current.cancel_requested {
                "cancelled"
            } else {
                "timed_out"
            };
            super::ownership::verify(identity, &super::ownership::observe(child.id() as i32)?)?;
            signal_group(child, libc::SIGTERM)?;
            stopping = Some((Instant::now(), reason));
        }
        if let Some((since, _)) = stopping {
            if since.elapsed() >= Duration::from_millis(150) {
                super::ownership::verify(identity, &super::ownership::observe(child.id() as i32)?)?;
                signal_group(child, libc::SIGKILL)?;
            }
        }
        if started.elapsed() > Duration::from_millis(timeout_ms + 2000) {
            return Err(error("Child termination deadline exceeded."));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // The unreaped leader pins the PGID while terminating any lingering descendants.
    // Darwin can return EPERM for a group containing only zombies. Absence after
    // reaping remains mandatory, including when this last signal is refused.
    // Native start metadata may disappear for a Darwin zombie. waitid(WNOWAIT)
    // established that this is our exited, unreaped child; that kernel relationship
    // still pins its PID/PGID and the launch-time identity until child.wait().
    let _cleanup_signal = signal_group(child, libc::SIGKILL);
    for _ in 0..20 {
        drain(&mut stdout, &mut output, &mut truncated)?;
        drain(&mut stderr, &mut errors, &mut truncated)?;
        std::thread::sleep(Duration::from_millis(5));
    }
    store.update(id, |r| {
        r.state = "finishing".into();
        Ok(())
    })?;
    *reaped = true;
    let status = child.wait().map_err(error)?;
    // No signal is sent after wait: a reused PID/PGID cannot authorize an effect.
    let absent = group_absent(child.id() as i32);
    let outcome = store.update(id, |r| {
        r.stdout = String::from_utf8_lossy(&output).into_owned();
        r.stderr = String::from_utf8_lossy(&errors).into_owned();
        r.truncated = truncated;
        r.exit_code = status.code();
        r.signal = status.signal();
        r.state = if !absent {
            "quarantined"
        } else if let Some((_, reason)) = stopping {
            reason
        } else if status.success() {
            "succeeded"
        } else {
            "failed"
        }
        .into();
        if !absent {
            r.detail = Some(
                "Process group absence was not established; no recovery signal is authorized."
                    .into(),
            );
        }
        Ok(())
    });
    // All processes were reaped/observed before publication. On a failed commit leave
    // finishing for recovery, and avoid signalling the already reaped child's PID.
    outcome.map(|_| ())
}
fn nonblocking(pipe: &impl AsRawFd) -> Result<()> {
    // SAFETY: fcntl operates on a valid borrowed pipe descriptor.
    let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(error(std::io::Error::last_os_error()));
    }
    Ok(())
}
fn drain(pipe: &mut impl Read, retained: &mut Vec<u8>, truncated: &mut bool) -> Result<()> {
    // Bound each pass so a continuously writing fixture cannot starve cancellation.
    let mut bytes = [0; 8192];
    for _ in 0..32 {
        match pipe.read(&mut bytes) {
            Ok(0) => break,
            Ok(size) => {
                let take = size.min(OUTPUT_LIMIT.saturating_sub(retained.len()));
                retained.extend_from_slice(&bytes[..take]);
                *truncated |= take < size;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(error(e)),
        }
    }
    Ok(())
}
fn signal_group(child: &Child, signal: i32) -> Result<()> {
    // SAFETY: caller owns this unreaped child, whose pre-exec setpgid fixed PGID=PID.
    if unsafe { libc::kill(-(child.id() as i32), signal) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::ESRCH) {
            return Err(error(format!("signal group {}: {e}", child.id())));
        }
    }
    Ok(())
}
fn exited_unreaped(child: &Child) -> Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: waitid observes only our child's status, deliberately retaining its PID.
    if unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(error(format!(
            "waitid: {}",
            std::io::Error::last_os_error()
        )));
    }
    #[cfg(target_os = "macos")]
    let pid = info.si_pid;
    #[cfg(target_os = "linux")]
    let pid = unsafe { info.si_pid() };
    Ok(pid != 0)
}
fn group_absent(pgid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // Signal zero only observes; ambiguity becomes quarantine, never success.
        if unsafe { libc::kill(-pgid, 0) } != 0 {
            return std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Fixed conformance payloads, never a shell or arbitrary project command. Every
/// payload self-expires even if its supervisor crashes during a negative test.
pub fn fixture(name: &str) -> Result<()> {
    match name {
        "success" => {
            std::thread::sleep(Duration::from_millis(350));
            println!("fixture success");
        }
        "failure" => {
            eprintln!("fixture failure");
            std::process::exit(23);
        }
        "output" => {
            let data = vec![b'x'; 1024 * 1024];
            std::io::stdout().write_all(&data).map_err(error)?;
            std::io::stderr().write_all(&data).map_err(error)?;
        }
        "tree" => {
            // SAFETY: this fixed single-threaded payload ignores TERM, forks once,
            // and both branches perform only bounded work then exit.
            unsafe {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
            let descendant = unsafe { libc::fork() };
            if descendant < 0 {
                return Err(error(std::io::Error::last_os_error()));
            }
            if descendant == 0 {
                std::thread::sleep(Duration::from_secs(8));
                unsafe {
                    libc::_exit(0);
                }
            }
            println!("leader={} descendant={descendant}", std::process::id());
            std::io::stdout().flush().map_err(error)?;
            std::thread::sleep(Duration::from_secs(8));
            unsafe {
                libc::waitpid(descendant, std::ptr::null_mut(), 0);
            }
        }
        _ => return Err(error("Unsupported built-in fixture.")),
    }
    Ok(())
}
