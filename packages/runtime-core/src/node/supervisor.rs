use super::journal::OUTPUT_LIMIT;
use super::{Result, Store, error, try_lock};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long a child gets to settle after this owner's first SIGTERM or SIGKILL
/// before a passed termination deadline quarantines the job.
const TERMINATION_GRACE: Duration = Duration::from_millis(2000);

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
        &mut super::ownership::inspect,
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
/// Owns `child` until it is reaped. `inspect` is the native identity read taken
/// before every signal (`ownership::inspect` in production; tests inject kernel
/// answers such as Darwin's `Gone` window to drive each `Authority`).
fn run_child(
    store: &mut Store,
    id: &str,
    child: &mut Child,
    timeout_ms: u64,
    identity: std::result::Result<&super::ProcessIdentity, &crate::CandidateError>,
    inspect: &mut dyn FnMut(i32) -> Result<super::ownership::Observed>,
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
    let mut killed: Option<Instant> = None;
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
            match verify_before_signal(child, identity, inspect(child.id() as i32))? {
                Authority::Signal => {
                    signal_group(child, libc::SIGTERM)?;
                    stopping = Some((Instant::now(), reason));
                }
                Authority::Exited => break,
                // No signal; the next pass sees the exit or the deadline quarantines.
                Authority::Exiting => {}
            }
        }
        if let Some((since, _)) = stopping {
            if since.elapsed() >= Duration::from_millis(150) {
                match verify_before_signal(child, identity, inspect(child.id() as i32))? {
                    Authority::Signal => {
                        signal_group(child, libc::SIGKILL)?;
                        killed.get_or_insert_with(Instant::now);
                    }
                    Authority::Exited => break,
                    // Our SIGKILL is settling: Darwin drops the leader's metadata
                    // before waitid can report the exit. Keep the stop reason.
                    Authority::Exiting => {}
                }
            }
        }
        // The deadline bounds an unresponsive child, not a late owner. A pass that
        // reaches its first SIGTERM or SIGKILL after the deadline (CPU starvation, a
        // journal busy wait while a restarted node opens it) still gives that signal
        // its own settling window. Each anchor is set once, so this stays bounded.
        let settling = killed.or(stopping.map(|(since, _)| since));
        if started.elapsed() > Duration::from_millis(timeout_ms + 2000)
            && settling.is_none_or(|since| since.elapsed() > TERMINATION_GRACE)
        {
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
/// What one fresh native observation permits for the supervisor's unreaped child.
#[derive(Debug, PartialEq, Eq)]
enum Authority {
    /// The launch identity matched: the group may be signalled.
    Signal,
    /// The kernel confirmed this exited, unreaped child: take the terminal path.
    Exited,
    /// The kernel reported no live entry, but has not yet published the exit. Send
    /// nothing and observe again; the termination deadline still bounds the wait.
    Exiting,
}

// A child may exit, on its own or from this owner's SIGKILL, after the loop's WNOWAIT
// observation but before native metadata collection. Darwin answers ESRCH both
// while that child is exiting and once it is a zombie, and waitid only reports it
// after the transition completes. Only a fresh kernel-confirmed exited, unreaped
// child permits the terminal path; a gone PID never authorizes a signal; other
// missing metadata for a live child and every observed mismatch still refuse. The
// unreaped parent relationship pins the PID, so Gone cannot name another process.
fn verify_before_signal(
    child: &Child,
    identity: &super::ProcessIdentity,
    observed: Result<super::ownership::Observed>,
) -> Result<Authority> {
    match observed {
        Ok(super::ownership::Observed::Present(observed)) => {
            super::ownership::verify(identity, &observed)?;
            Ok(Authority::Signal)
        }
        Ok(super::ownership::Observed::Gone) => Ok(if exited_unreaped(child)? {
            Authority::Exited
        } else {
            Authority::Exiting
        }),
        Err(failure) => {
            if exited_unreaped(child)? {
                Ok(Authority::Exited)
            } else {
                Err(failure)
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn present(identity: &super::super::ProcessIdentity) -> super::super::ownership::Observed {
        super::super::ownership::Observed::Present(identity.clone())
    }

    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn identity_loss_requires_kernel_confirmed_unreaped_exit() {
        let mut child = OwnedChild(
            Command::new("/bin/sh")
                .args(["-c", "read line"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let identity = super::super::ownership::observe(child.0.id() as i32).unwrap();
        assert!(!exited_unreaped(&child.0).unwrap());
        assert!(verify_before_signal(&child.0, &identity, Err(error("unavailable"))).is_err());
        let mut foreign = identity.clone();
        foreign.start += 1;
        assert!(verify_before_signal(&child.0, &identity, Ok(present(&foreign))).is_err());
        // EOF deterministically makes this owned child exit between the earlier
        // WNOWAIT check and the simulated unavailable native metadata result.
        drop(child.0.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !exited_unreaped(&child.0).unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            verify_before_signal(&child.0, &identity, Err(error("unavailable"))).unwrap(),
            Authority::Exited
        );
        assert!(verify_before_signal(&child.0, &identity, Ok(present(&foreign))).is_err());
        // The fallback did not reap: wait still owns the original terminal status.
        assert_eq!(child.0.wait().unwrap().code(), Some(1));
        assert!(verify_before_signal(&child.0, &identity, Err(error("unavailable"))).is_err());
    }

    #[test]
    fn a_gone_owned_child_defers_until_its_own_kill_settles_and_never_signals() {
        use super::super::ownership::{Observed, inspect};
        let mut child = OwnedChild(
            Command::new("/bin/sh")
                .args(["-c", "read line"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let identity = super::super::ownership::observe(child.0.id() as i32).unwrap();
        assert_eq!(
            verify_before_signal(&child.0, &identity, inspect(child.0.id() as i32)).unwrap(),
            Authority::Signal
        );
        // The ESRCH window between this owner's SIGKILL and waitid publishing the exit:
        // the leader is still unreaped, so Gone defers instead of quarantining, and
        // it neither signals nor claims an exit the kernel has not confirmed.
        assert!(!exited_unreaped(&child.0).unwrap());
        assert_eq!(
            verify_before_signal(&child.0, &identity, Ok(Observed::Gone)).unwrap(),
            Authority::Exiting
        );
        signal_group(&child.0, libc::SIGKILL).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !exited_unreaped(&child.0).unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        // Killed, unreaped: the real native read of our own settled kill takes the
        // terminal path (Darwin: Gone; Linux: the zombie's unchanged identity is
        // still present, and the run loop's earlier waitid check breaks first).
        let settled = verify_before_signal(&child.0, &identity, inspect(child.0.id() as i32));
        #[cfg(target_os = "macos")]
        assert_eq!(settled.unwrap(), Authority::Exited);
        #[cfg(target_os = "linux")]
        assert_eq!(settled.unwrap(), Authority::Signal);
        assert_eq!(
            verify_before_signal(&child.0, &identity, Ok(Observed::Gone)).unwrap(),
            Authority::Exited
        );
        // A mismatched identity still refuses even after the exit is confirmed.
        let mut foreign = identity.clone();
        foreign.start += 1;
        assert!(verify_before_signal(&child.0, &identity, Ok(present(&foreign))).is_err());
        // Killed and reaped: wait kept the original status, and a gone PID that is no
        // longer our child never authorizes a signal or a terminal claim.
        assert_eq!(child.0.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert_eq!(inspect(child.0.id() as i32).unwrap(), Observed::Gone);
        assert!(verify_before_signal(&child.0, &identity, Ok(Observed::Gone)).is_err());
    }

    /// One owned job for `run_child`: a private journal holding a running receipt, and
    /// a TERM-ignoring group leader that exits 3 on its own when its stdin closes.
    struct Job {
        root: std::path::PathBuf,
        store: Store,
        id: String,
        child: Child,
        stdin: Option<std::process::ChildStdin>,
        identity: super::super::ProcessIdentity,
    }
    impl Job {
        fn new(timeout_ms: u64) -> Self {
            let root = crate::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                "hkl-node-run",
            );
            let store = Store::open(&root, true).unwrap();
            let id = "a".repeat(64);
            super::super::test_support::job(&store, &id, "running", timeout_ms);
            let mut child = Command::new("/bin/sh")
                .args(["-c", "trap '' TERM; read line; exit 3"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .spawn()
                .unwrap();
            let stdin = child.stdin.take();
            let identity = super::super::ownership::observe(child.id() as i32).unwrap();
            Self {
                root,
                store,
                id,
                child,
                stdin,
                identity,
            }
        }
        fn pid(&self) -> i32 {
            self.child.id() as i32
        }
        fn run(
            &mut self,
            inspect: &mut dyn FnMut(i32) -> Result<super::super::ownership::Observed>,
        ) -> Result<super::super::Receipt> {
            let mut reaped = false;
            let timeout = self.store.get(&self.id)?.execution_timeout_ms;
            run_child(
                &mut self.store,
                &self.id,
                &mut self.child,
                timeout,
                Ok(&self.identity),
                inspect,
                &mut reaped,
            )?;
            assert!(reaped);
            self.store.get(&self.id)
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // Child caches a reaped status, so this never signals a reused PID.
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    /// Whether the kernel has published this child's exit, observed without reaping.
    fn exit_published(pid: i32) -> bool {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: WNOWAIT observes this test's own child without reaping it.
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            },
            0
        );
        #[cfg(target_os = "macos")]
        return info.si_pid != 0;
        #[cfg(target_os = "linux")]
        return unsafe { info.si_pid() } != 0;
    }
    fn until_exit_published(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !exit_published(pid) {
            assert!(Instant::now() < deadline, "child exit was not published");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn run_child_defers_a_gone_live_child_at_timeout_and_keeps_its_own_exit() {
        use super::super::ownership::Observed;
        let mut job = Job::new(50);
        let pid = job.pid();
        let mut stdin = job.stdin.take();
        let mut calls = 0;
        let receipt = job
            .run(&mut |observed| {
                assert_eq!(observed, pid);
                calls += 1;
                if calls == 1 {
                    // Darwin's ESRCH window: no live entry, exit not yet published.
                    // Exiting sends nothing and records no stop reason.
                    assert!(!exit_published(pid));
                } else {
                    // The child then exits on its own before anything signalled it.
                    drop(stdin.take());
                    until_exit_published(pid);
                }
                Ok(Observed::Gone)
            })
            .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(receipt.state, "failed", "{receipt:?}");
        assert_eq!(receipt.exit_code, Some(3), "{receipt:?}");
        assert_eq!(receipt.signal, None, "{receipt:?}");
        assert_eq!(receipt.detail, None, "{receipt:?}");
    }

    #[test]
    fn run_child_never_kills_during_a_gone_window_and_keeps_its_stop_reason() {
        use super::super::ownership::{Observed, inspect};
        let mut job = Job::new(50);
        let pid = job.pid();
        let mut calls = 0;
        let mut alive_after_gone = None;
        let receipt = job
            .run(&mut |observed| {
                calls += 1;
                match calls {
                    // After SIGTERM (ignored), the kill check reads Gone while the
                    // child is still alive: no SIGKILL yet, and the reason stays.
                    2 => {
                        assert!(!exit_published(pid));
                        Ok(Observed::Gone)
                    }
                    3 => {
                        alive_after_gone =
                            Some(!exit_published(pid) && unsafe { libc::kill(pid, 0) } == 0);
                        inspect(observed)
                    }
                    _ => inspect(observed),
                }
            })
            .unwrap();
        assert!(calls >= 3, "observed again after Gone: {calls}");
        assert_eq!(alive_after_gone, Some(true));
        assert_eq!(receipt.state, "timed_out", "{receipt:?}");
        assert_eq!(receipt.signal, Some(libc::SIGKILL), "{receipt:?}");
        assert_eq!(receipt.detail, None, "{receipt:?}");
    }

    #[test]
    fn run_child_bounds_an_endless_gone_window_by_its_deadline_without_signalling() {
        use super::super::ownership::Observed;
        let mut job = Job::new(20);
        let pid = job.pid();
        let failure = job.run(&mut |_| Ok(Observed::Gone)).unwrap_err();
        assert_eq!(failure.message, "Child termination deadline exceeded.");
        // Gone never authorized a signal: the TERM-ignoring child still waits for
        // input, and exits with its own status once that input closes.
        assert!(!exit_published(pid));
        drop(job.stdin.take());
        assert_eq!(job.child.wait().unwrap().code(), Some(3));
    }

    #[test]
    fn a_kill_check_delayed_past_the_deadline_still_settles_as_the_owners_timeout() {
        use super::super::ownership::inspect;
        let mut job = Job::new(50);
        let mut first = None;
        let receipt = job
            .run(&mut |observed| {
                match first {
                    // Timeout: the live TERM-ignoring child is signalled with SIGTERM.
                    None => first = Some(Instant::now()),
                    // The kill check runs late, as when the owner is starved or waits
                    // on the journal: its SIGKILL lands after the termination deadline
                    // (timeout + 2 s from a start at least 50 ms before `first`).
                    Some(first) => {
                        let late = first + Duration::from_millis(2100);
                        std::thread::sleep(late.saturating_duration_since(Instant::now()));
                    }
                }
                inspect(observed)
            })
            .unwrap();
        assert_eq!(receipt.state, "timed_out", "{receipt:?}");
        assert_eq!(receipt.signal, Some(libc::SIGKILL), "{receipt:?}");
        assert_eq!(receipt.detail, None, "{receipt:?}");
    }

    #[test]
    fn a_stop_that_never_settles_is_still_bounded_by_its_grace() {
        use super::super::ownership::{Observed, inspect};
        let mut job = Job::new(50);
        let pid = job.pid();
        let begun = Instant::now();
        let mut calls = 0;
        let failure = job
            .run(&mut |observed| {
                calls += 1;
                // A regression that never quarantines fails here instead of hanging.
                assert!(begun.elapsed() < Duration::from_secs(10), "unbounded stop");
                if calls == 1 {
                    inspect(observed)
                } else {
                    Ok(Observed::Gone)
                }
            })
            .unwrap_err();
        assert_eq!(failure.message, "Child termination deadline exceeded.");
        // SIGTERM was ignored and Gone never authorized SIGKILL: still alive.
        assert!(!exit_published(pid));
        drop(job.stdin.take());
        assert_eq!(job.child.wait().unwrap().code(), Some(3));
    }
}
