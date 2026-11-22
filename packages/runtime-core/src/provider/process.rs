//! Bounded, credential-blind child processes. A timed-out provider operation is uncertain.
use crate::CandidateError;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

pub struct Captured {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Time source for bounded waits, so a test can drive a deadline without real time.
pub trait Clock {
    /// Monotonic time since an arbitrary fixed origin.
    fn now(&self) -> Duration;
    fn sleep(&self, duration: Duration);
}

/// The host's monotonic clock.
pub struct MonotonicClock(Instant);

impl MonotonicClock {
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// Started work that [`wait_within`] waits on until it completes or its bound expires. `T`
/// is what the finished work reports: a child's [`Captured`] exit and output unless stated.
pub trait Pending<T = Captured> {
    /// `Some` once the work finished. For a child: once it exited and both its output
    /// streams closed; `None` while it runs or a detached helper still holds a stream open.
    fn poll(&mut self) -> Result<Option<T>, CandidateError>;
    /// The bound expired: stop only what this value owns and return the uncertain outcome.
    /// For a child: signal and reap only the unreaped direct child (no PID-file or
    /// process-group kill).
    fn expire(&mut self) -> CandidateError;
    /// Return once the next [`Pending::poll`] may answer differently, and after at most
    /// `limit` on `clock` either way. Returning early is always allowed.
    ///
    /// This default has no completion signal, so it sleeps one [`POLL_INTERVAL`] on the clock.
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        clock.sleep(limit.min(POLL_INTERVAL));
    }
}

/// A spawned child whose streams are drained continuously, keeping at most 64 KiB each.
///
/// Three helper threads report over one channel: each stream's drain when that stream
/// closes, and a watcher when the child has exited. A waiter therefore blocks until something
/// changed instead of polling on a timer.
///
/// The watcher only observes the exit (`WNOWAIT`). This owner alone signals and reaps the
/// child, and reaps only after the watcher has finished observing, so the watcher never
/// waits on a PID the host has recycled.
///
/// Limits:
/// - A handle dropped before the child completed or expired signals and reaps nothing, as
///   before, and now also leaves the watcher thread blocked until that child exits. Callers
///   wait every child to completion or expiry.
/// - Nothing else in this process may reap the child: no `waitpid(-1)` loop, and `SIGCHLD`
///   keeps its default disposition (ignoring it, or `SA_NOCLDWAIT`, makes the host reap
///   children itself). Otherwise the exit status is lost and the wait fails as
///   `provider_wait_failed`, as it did when the exit was polled.
pub struct Running {
    child: std::process::Child,
    status: Option<std::process::ExitStatus>,
    exit: ExitWatch,
    watcher: Option<std::thread::JoinHandle<()>>,
    progress: mpsc::Receiver<Progress>,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
}

/// What a helper thread of a [`Running`] child reports, once each.
enum Progress {
    /// The child exited and is ready to be reaped.
    Exited,
    /// The host refused to watch for the exit; the owner polls for it.
    ExitUnobserved,
    /// The stream closed; the bytes kept from it.
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
}

#[derive(PartialEq, Eq)]
enum ExitWatch {
    /// The watcher has not reported: the child is not reaped while this holds.
    Watching,
    /// The watcher saw the exit and is done.
    Reported,
    /// No exit report can be relied on; the owner polls on [`POLL_INTERVAL`].
    Lost,
}

pub fn spawn(command: &mut Command) -> Result<Running, CandidateError> {
    start(command, exited)
}

/// [`spawn`] with the blocking exit observation injected, so a test can take it away.
fn start(command: &mut Command, observe_exit: fn(u32) -> bool) -> Result<Running, CandidateError> {
    let child = spawn_child(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .map_err(|e| CandidateError::new("provider_spawn_failed", e.to_string()))?;
    supervise(child, observe_exit, helper)
}

/// Held while a child is being spawned, so two threads of this process are never inside a
/// spawn at once.
///
/// A spawn creates pipes: the child's piped streams, and the pipe the standard library reads
/// the exec result from when it forks (which [`clean_command`]'s `pre_exec` makes it do). A
/// host that cannot create a pipe already marked close-on-exec (macOS has no `pipe2`) sets
/// the mark in a second step. A child that another thread forks between the two steps
/// inherits the pipe and keeps it open until it exits, so the pipe's owner waits on that
/// unrelated child: for end-of-file on a stream, or inside the spawn for the exec result.
///
/// The lock covers the spawn alone, never the wait: children still run side by side.
///
/// Limits:
/// - It protects only spawns made through [`spawn_child`]. A child forked any other way can
///   still inherit a pipe that a spawn under the lock is creating.
/// - A descriptor that other code opens without close-on-exec is not covered.
static SPAWNING: Mutex<()> = Mutex::new(());

/// The spawn lock. A thread that panicked inside a spawn left nothing behind that the next
/// spawn depends on, so a poisoned lock is taken as it is: never a panic or a refusal.
fn spawning() -> MutexGuard<'static, ()> {
    SPAWNING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// [`Command::spawn`] under the process-wide spawn lock (see [`SPAWNING`]). Every child this
/// process starts while other threads may be spawning goes through here. It returns as soon
/// as the child was started or refused; waiting for the child is the caller's.
pub(crate) fn spawn_child(command: &mut Command) -> std::io::Result<std::process::Child> {
    let _spawning = spawning();
    command.spawn()
}

/// Starts one helper thread of a [`Running`] child. Injected so a test can make it fail.
type Helper = fn(Box<dyn FnOnce() + Send>) -> std::io::Result<std::thread::JoinHandle<()>>;

fn helper(work: Box<dyn FnOnce() + Send>) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().spawn(work)
}

/// A spawned child nobody owns yet: killed and reaped on drop unless it was handed on.
struct Unowned(Option<std::process::Child>);

impl Drop for Unowned {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            // No watcher exists yet (it is started last), so reaping here cannot leave one
            // waiting on a recycled PID.
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Take ownership of a child that was just spawned with both streams piped: start its
/// stream readers and its exit watcher.
///
/// The child has an owner from here on. If a helper thread cannot be started (the host is
/// out of threads), supervision failed after the spawn: the direct child is killed and
/// reaped and the caller gets `provider_spawn_failed`, instead of a panic that left the
/// child running with nobody to stop or reap it. The child did run until then, so whatever
/// it had already done is not undone, and a caller must not take the error to mean no effect.
fn supervise(
    child: std::process::Child,
    observe_exit: fn(u32) -> bool,
    helper: Helper,
) -> Result<Running, CandidateError> {
    fn drain(mut pipe: impl Read) -> Vec<u8> {
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(count) = pipe.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let keep = count.min(65536_usize.saturating_sub(output.len()));
            output.extend_from_slice(&buffer[..keep]);
        }
        output
    }
    let mut unowned = Unowned(Some(child));
    let child = unowned.0.as_mut().expect("the child was just put here");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let pid = child.id();
    let (report, progress) = mpsc::channel();
    let thread = |work: Box<dyn FnOnce() + Send>| {
        helper(work).map_err(|e| {
            CandidateError::new(
                "provider_spawn_failed",
                format!("Cannot start a helper thread for a provider child: {e}"),
            )
        })
    };
    // A send fails only when the owner dropped the child's handle; nobody is waiting then.
    let (out, err) = (report.clone(), report.clone());
    thread(Box::new(move || {
        let _ = out.send(Progress::Stdout(drain(stdout)));
    }))?;
    thread(Box::new(move || {
        let _ = err.send(Progress::Stderr(drain(stderr)));
    }))?;
    let watcher = thread(Box::new(move || {
        let _ = report.send(if observe_exit(pid) {
            Progress::Exited
        } else {
            Progress::ExitUnobserved
        });
    }))?;
    Ok(Running {
        child: unowned.0.take().expect("the child is still here"),
        status: None,
        exit: ExitWatch::Watching,
        watcher: Some(watcher),
        progress,
        stdout: None,
        stderr: None,
    })
}

/// Block until this process's direct child `pid` has exited, without reaping it. `false`
/// when the host cannot report that.
fn exited(pid: u32) -> bool {
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: valid writable output. `pid` is a direct child that its owner keeps
        // unreaped until this call has returned (see `Running`), so it names no other
        // process. WNOWAIT leaves the exit status for the owner's own reap.
        let observed = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if observed == 0 {
            return true;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}

impl Running {
    fn note(&mut self, progress: Progress) {
        match progress {
            Progress::Exited => self.exit = ExitWatch::Reported,
            Progress::ExitUnobserved => self.exit = ExitWatch::Lost,
            Progress::Stdout(output) => self.stdout = Some(output),
            Progress::Stderr(output) => self.stderr = Some(output),
        }
    }

    /// Collect the exit status once the watcher is done with the child.
    fn reap(&mut self) -> Result<(), CandidateError> {
        if self.status.is_some() || self.exit == ExitWatch::Watching {
            return Ok(());
        }
        match self.child.try_wait() {
            Ok(Some(status)) => self.status = Some(status),
            // Unwatched, or reported before the status can be collected: poll for it.
            Ok(None) => self.exit = ExitWatch::Lost,
            Err(e) => return Err(CandidateError::new("provider_wait_failed", e.to_string())),
        }
        Ok(())
    }
}

impl Pending for Running {
    fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
        while let Ok(progress) = self.progress.try_recv() {
            self.note(progress);
        }
        self.reap()?;
        // Do not complete early: detached provider helpers may inherit pipe descriptors.
        let Some(status) = self.status else {
            return Ok(None);
        };
        if self.stdout.is_none() || self.stderr.is_none() {
            return Ok(None);
        }
        Ok(Some(Captured {
            status,
            stdout: self.stdout.take().unwrap_or_default(),
            stderr: self.stderr.take().unwrap_or_default(),
        }))
    }

    fn expire(&mut self) -> CandidateError {
        if self.status.is_some() {
            // A helper retaining output is treated as uncertain, with a bounded wait.
            return CandidateError::new(
                "provider_output_uncertain",
                "A provider helper retained output descriptors; inspect owned state.",
            );
        }
        let _ = self.child.kill();
        // The watcher returns when the killed child can be reaped, which is when the reap
        // below would return too. Reaping first could leave it waiting on a recycled PID.
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        let _ = self.child.wait();
        CandidateError::new(
            "provider_timeout_uncertain",
            "Provider request timed out. Detached effects may remain; inspect before retry.",
        )
    }

    /// Block until a helper thread reports, for at most `limit`.
    fn wait(&mut self, limit: Duration, clock: &dyn Clock) {
        if self.exit == ExitWatch::Lost && self.status.is_none() {
            return clock.sleep(limit.min(POLL_INTERVAL));
        }
        let started = clock.now();
        match self.progress.recv_timeout(limit) {
            Ok(progress) => self.note(progress),
            Err(_) => {
                // Nothing changed for `limit` of real time. A clock that is not real time has
                // not seen that wait: pass it on, so the caller's bound still expires.
                let unseen = limit.saturating_sub(clock.now().saturating_sub(started));
                if !unseen.is_zero() {
                    clock.sleep(unseen);
                }
            }
        }
    }
}

/// How often a pending child without a completion signal is polled. A [`Running`] child
/// reports its own exit and stream closure, and falls back to this only when the host cannot
/// watch for the exit.
pub const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Wait for `pending` on `clock` until it completes, or expire it once `timeout` has passed
/// since this call. The bound covers both the child's exit and its streams closing.
///
/// The child is polled at once and after every [`Pending::wait`], which is given the rest of
/// the bound: a child that has finished is reported as soon as its pending says so, and one
/// that has not is expired at the bound.
///
/// A result counts only if it is observed before the bound: the clock is read after each
/// poll, so a waiter that oversleeps past the bound and then finds the child finished
/// refuses it as `provider_timeout_uncertain` rather than accepting a result it cannot
/// place inside the bound. Such a child has already exited and been reaped, so nothing is
/// signalled. A child still running, or one whose streams are still held open, at the bound
/// is expired by [`Pending::expire`], which keeps the timeout and output-retention outcomes
/// apart.
pub fn wait_within<T>(
    pending: &mut dyn Pending<T>,
    timeout: Duration,
    clock: &dyn Clock,
) -> Result<T, CandidateError> {
    let start = clock.now();
    loop {
        let polled = pending.poll()?;
        let left = timeout.saturating_sub(clock.now().saturating_sub(start));
        match polled {
            Some(finished) if !left.is_zero() => return Ok(finished),
            Some(_) => return Err(completed_late()),
            None if !left.is_zero() => pending.wait(left, clock),
            None => return Err(pending.expire()),
        }
    }
}

/// A child observed complete only after its bound: its result is not trusted.
fn completed_late() -> CandidateError {
    CandidateError::new(
        "provider_timeout_uncertain",
        "Provider request finished only after its time bound; its result is not trusted. \
         Inspect before retry.",
    )
}

pub fn capture(command: &mut Command, timeout: Duration) -> Result<Captured, CandidateError> {
    let mut running = spawn(command)?;
    wait_within(&mut running, timeout, &MonotonicClock::new())
}

pub fn run(command: &mut Command, timeout: Duration) -> Result<String, CandidateError> {
    let output = capture(command, timeout)?;
    if !output.status.success() {
        return Err(CandidateError::new(
            "provider_command_failed",
            format!(
                "Provider command exited {}; no automatic retry. {}",
                output.status,
                String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(8192)]).trim()
            ),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| CandidateError::new("provider_protocol", "Non-UTF8 provider response."))
}

pub fn clean_command(binary: &std::path::Path) -> Command {
    let mut command = Command::new(binary);
    // Child-only: changing the multithreaded parent's umask would race unrelated file creation.
    unsafe {
        command.pre_exec(|| {
            libc::umask(0o077);
            Ok(())
        });
    }
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C");
    command
}

/// A publisher is stopped through its authenticated control channel, never by
/// a terminal or graph-owner group signal. Set the group in the child before
/// exec; parent-side setpgid would race readiness and terminal interruption.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn publisher_command(binary: &std::path::Path) -> Command {
    let mut command = Command::new(binary);
    command.process_group(0);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publisher_survives_owner_group_interrupt() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::process::tests::publisher_group_probe",
                "--nocapture",
            ])
            .env("HACK_TEST_PUBLISHER_GROUP_PROBE", "1")
            .process_group(0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("publisher-group-verified"));
    }

    #[test]
    fn publisher_group_probe() {
        if std::env::var_os("HACK_TEST_PUBLISHER_GROUP_PROBE").is_none() {
            return;
        }
        extern "C" fn caught(_: libc::c_int) {}
        // SAFETY: isolated helper process, static signal-safe handler; exec
        // resets this caught disposition in the publisher to its default.
        unsafe {
            libc::signal(libc::SIGINT, caught as *const () as libc::sighandler_t);
        }
        let child = publisher_command(std::path::Path::new("/bin/cat"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        struct Owned(std::process::Child);
        impl Drop for Owned {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        // SAFETY: observe this direct, unreaped child and signal only the
        // helper's own group, created by the outer fixture.
        assert_eq!(
            unsafe { libc::getpgid(child.id() as i32) },
            child.id() as i32
        );
        let mut owned = Owned(child);
        assert_eq!(
            unsafe { libc::kill(-(std::process::id() as i32), libc::SIGINT) },
            0
        );
        use std::io::{Read, Write};
        owned
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"owned stop")
            .unwrap();
        let mut output = String::new();
        owned
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert!(owned.0.wait().unwrap().success());
        assert_eq!(output, "owned stop");
        println!("publisher-group-verified");
    }

    fn shell(script: &str) -> Command {
        let mut command = clean_command(std::path::Path::new("/bin/sh"));
        command.args(["-c", script]);
        command
    }

    /// A child whose helper threads cannot all be started has no reader or watcher to own
    /// it. It is killed and reaped at once and the caller gets an error, whichever of the
    /// three threads failed, instead of a panic that left the child running.
    #[test]
    fn a_child_whose_helper_thread_cannot_start_is_killed_and_reaped() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        /// Which helper of the child under test fails to start; the earlier ones start.
        static FAILING: AtomicUsize = AtomicUsize::new(0);
        static STARTED: AtomicUsize = AtomicUsize::new(0);
        fn out_of_threads(
            work: Box<dyn FnOnce() + Send>,
        ) -> std::io::Result<std::thread::JoinHandle<()>> {
            if STARTED.fetch_add(1, Ordering::Relaxed) == FAILING.load(Ordering::Relaxed) {
                return Err(std::io::Error::from_raw_os_error(libc::EAGAIN));
            }
            helper(work)
        }
        for failing in 0..3 {
            FAILING.store(failing, Ordering::Relaxed);
            STARTED.store(0, Ordering::Relaxed);
            let child = shell("exec sleep 600")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let pid = child.id() as i32;
            // SAFETY: signal 0 only asks whether this test's own child still exists.
            assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
            let error = supervise(child, exited, out_of_threads).err().unwrap();
            assert_eq!(error.code, "provider_spawn_failed", "helper {failing}");
            assert_eq!(STARTED.load(Ordering::Relaxed), failing + 1);
            // Gone and reaped: a zombie would still answer the signal.
            // SAFETY: as above; a reaped child of this process has no process left.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "helper {failing}");
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
        // The same child is owned and waited for as usual when every helper starts.
        let child = shell("printf done")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut running = supervise(child, exited, helper).unwrap();
        let output = wait_within(
            &mut running,
            Duration::from_secs(30),
            &MonotonicClock::new(),
        )
        .unwrap();
        assert_eq!(output.stdout, b"done");
    }

    /// Children spawned from several threads at once each start with only their own
    /// descriptors. Each child lists what it has open; a pipe another thread's spawn was
    /// still creating would show up as one more entry than a child spawned alone has.
    ///
    /// The race runs alone in a subprocess (see [`spawn_leak_probe`]): in this process
    /// other tests spawn children outside the lock and open descriptors of their own.
    ///
    /// macOS only: that is the host whose pipes need the lock. When this was written, 99 of
    /// 100 runs of the probe failed with the lock taken out of [`spawn_child`] (about 7
    /// children in 512 inherited a descriptor), and 100 of 100 passed with it. A pass says
    /// nothing about children spawned outside [`spawn_child`].
    #[cfg(target_os = "macos")]
    #[test]
    fn concurrent_spawns_leak_no_descriptor_into_another_threads_child() {
        let output = capture(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider::process::tests::spawn_leak_probe",
                    "--nocapture",
                ])
                .env("HACK_TEST_SPAWN_LEAK_PROBE", "1"),
            Duration::from_secs(120),
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("no-descriptor-leaked"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn spawn_leak_probe() {
        if std::env::var_os("HACK_TEST_SPAWN_LEAK_PROBE").is_none() {
            return;
        }
        // Many threads with few spawns each: what exposes a leak is how many spawns overlap.
        const THREADS: usize = 32;
        const SPAWNS: usize = 16;
        // The shell opens the directory to list it, so the list is the descriptors the
        // child started with and that one.
        fn open_descriptors() -> String {
            let listed = capture(&mut shell("echo /dev/fd/*"), Duration::from_secs(30)).unwrap();
            assert!(listed.status.success());
            String::from_utf8(listed.stdout).unwrap()
        }
        let alone = open_descriptors();
        assert!(
            alone.starts_with("/dev/fd/0 /dev/fd/1 /dev/fd/2"),
            "{alone}"
        );
        let together = std::sync::Barrier::new(THREADS);
        let inherited: Vec<String> = std::thread::scope(|scope| {
            let spawners: Vec<_> = (0..THREADS)
                .map(|_| {
                    scope.spawn(|| {
                        together.wait();
                        (0..SPAWNS)
                            .map(|_| open_descriptors())
                            .filter(|listed| *listed != alone)
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            spawners
                .into_iter()
                .flat_map(|spawner| spawner.join().unwrap())
                .collect()
        });
        assert!(
            inherited.is_empty(),
            "{} of {} children inherited another spawn's descriptors; alone: {alone:?}, \
             first: {:?}",
            inherited.len(),
            THREADS * SPAWNS,
            inherited[0],
        );
        println!("no-descriptor-leaked");
    }

    /// A thread that panicked while it held the spawn lock does not stop later spawns.
    #[test]
    fn a_poisoned_spawn_lock_still_spawns() {
        let poisoned = std::thread::spawn(|| {
            let _spawning = spawning();
            // Unwinds without the panic hook, so the test prints no panic message.
            std::panic::resume_unwind(Box::new(()));
        })
        .join();
        assert!(poisoned.is_err());
        assert!(SPAWNING.is_poisoned());
        let output = capture(&mut shell("printf spawned"), Duration::from_secs(30)).unwrap();
        // Later tests in this process start from an unpoisoned lock again.
        SPAWNING.clear_poison();
        assert_eq!(output.stdout, b"spawned");
    }

    #[test]
    fn capture_returns_the_exit_status_and_both_streams() {
        let output = capture(
            &mut shell("printf out; printf err >&2; exit 3"),
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[test]
    fn capture_kills_and_reaps_a_child_that_outlives_its_bound() {
        let started = Instant::now();
        let error = capture(&mut shell("exec sleep 30"), Duration::from_millis(200))
            .err()
            .unwrap();
        assert_eq!(error.code, "provider_timeout_uncertain");
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn capture_reports_a_helper_that_retains_output_as_uncertain() {
        // The shell exits at once; its background child keeps stdout open past the bound.
        let error = capture(&mut shell("sleep 3 & exit 0"), Duration::from_millis(300))
            .err()
            .unwrap();
        assert_eq!(error.code, "provider_output_uncertain");
    }

    /// Real time, and a refusal to sleep on it: a wait that reaches for a timed poll fails.
    struct NoTimedPoll(MonotonicClock);

    impl Clock for NoTimedPoll {
        fn now(&self) -> Duration {
            self.0.now()
        }
        fn sleep(&self, duration: Duration) {
            panic!("waited {duration:?} on a timer instead of for the child");
        }
    }

    /// A clock that moves only when the code under test sleeps on it.
    #[derive(Default)]
    struct SleepDriven(std::cell::Cell<Duration>);

    impl Clock for SleepDriven {
        fn now(&self) -> Duration {
            self.0.get()
        }
        fn sleep(&self, duration: Duration) {
            self.0.set(self.0.get() + duration);
        }
    }

    /// The wait this module had before a child reported its own exit, kept only so the
    /// timing report compares against it: no watcher, `try_wait` on every poll, drains
    /// checked with `is_finished`, and one [`POLL_INTERVAL`] sleep between polls.
    struct TimerPolled {
        child: std::process::Child,
        status: Option<std::process::ExitStatus>,
        out: Option<std::thread::JoinHandle<Vec<u8>>>,
        err: Option<std::thread::JoinHandle<Vec<u8>>>,
    }

    impl TimerPolled {
        fn spawn(command: &mut Command) -> Self {
            fn drain(mut pipe: impl Read) -> Vec<u8> {
                let mut output = Vec::new();
                let mut buffer = [0; 4096];
                while let Ok(count) = pipe.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    let keep = count.min(65536_usize.saturating_sub(output.len()));
                    output.extend_from_slice(&buffer[..keep]);
                }
                output
            }
            let mut child = command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            Self {
                child,
                status: None,
                out: Some(std::thread::spawn(move || drain(stdout))),
                err: Some(std::thread::spawn(move || drain(stderr))),
            }
        }
    }

    impl Pending for TimerPolled {
        fn poll(&mut self) -> Result<Option<Captured>, CandidateError> {
            if self.status.is_none() {
                match self.child.try_wait() {
                    Ok(Some(status)) => self.status = Some(status),
                    Ok(None) => return Ok(None),
                    Err(e) => panic!("try_wait: {e}"),
                }
            }
            let finished = |stream: &Option<std::thread::JoinHandle<Vec<u8>>>| {
                stream.as_ref().is_some_and(|handle| handle.is_finished())
            };
            if !finished(&self.out) || !finished(&self.err) {
                return Ok(None);
            }
            let join = |stream: &mut Option<std::thread::JoinHandle<Vec<u8>>>| {
                stream
                    .take()
                    .map(|handle| handle.join().unwrap_or_default())
                    .unwrap_or_default()
            };
            Ok(Some(Captured {
                status: self.status.expect("exit status recorded"),
                stdout: join(&mut self.out),
                stderr: join(&mut self.err),
            }))
        }
        fn expire(&mut self) -> CandidateError {
            let _ = self.child.kill();
            let _ = self.child.wait();
            CandidateError::new("provider_timeout_uncertain", "timer-polled child expired")
        }
        fn wait(&mut self, _limit: Duration, clock: &dyn Clock) {
            clock.sleep(POLL_INTERVAL);
        }
    }

    /// Whether this process still has `pid` as a child it could reap.
    fn is_unreaped_child(pid: u32) -> bool {
        let mut status = 0;
        // SAFETY: valid writable status; WNOHANG never blocks.
        let result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
        result != -1 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ECHILD)
    }

    #[test]
    fn a_finished_child_is_reported_by_its_exit_not_by_a_timed_poll() {
        for _ in 0..5 {
            let mut running = spawn(&mut shell("printf out; exit 3")).unwrap();
            let clock = NoTimedPoll(MonotonicClock::new());
            let output = wait_within(&mut running, Duration::from_secs(30), &clock).unwrap();
            assert_eq!(output.status.code(), Some(3));
            assert_eq!(output.stdout, b"out");
            assert!(!is_unreaped_child(running.child.id()));
        }
    }

    #[test]
    fn a_helper_releasing_output_within_the_bound_completes_when_it_does() {
        // The shell exits at once; completion waits for its helper to close stdout. Seeing
        // that only at the 30 s bound would refuse the result as late.
        let mut running = spawn(&mut shell(
            "(sleep 0.3; printf late) & printf early; exit 0",
        ))
        .unwrap();
        let clock = NoTimedPoll(MonotonicClock::new());
        let output = wait_within(&mut running, Duration::from_secs(30), &clock).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"earlylate");
    }

    #[test]
    fn a_child_running_past_its_bound_is_killed_and_reaped_at_the_bound() {
        let bound = Duration::from_millis(200);
        let mut running = spawn(&mut shell("exec sleep 30")).unwrap();
        let pid = running.child.id();
        let started = Instant::now();
        let error = wait_within(&mut running, bound, &MonotonicClock::new())
            .err()
            .unwrap();
        let took = started.elapsed();
        assert_eq!(error.code, "provider_timeout_uncertain");
        assert!(took >= bound, "expired early, after {took:?}");
        assert!(took < Duration::from_secs(20), "expired after {took:?}");
        assert!(!is_unreaped_child(pid));
    }

    #[test]
    fn each_stream_keeps_at_most_64_kib_and_the_child_still_completes() {
        let output = capture(
            &mut shell("head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2; exit 4"),
            Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(4));
        assert_eq!(output.stdout.len(), 65536);
        assert_eq!(output.stderr.len(), 65536);
    }

    #[test]
    fn a_clock_that_moves_only_when_slept_on_still_expires_a_running_child() {
        let bound = Duration::from_millis(100);
        let clock = SleepDriven::default();
        let mut running = spawn(&mut shell("exec sleep 30")).unwrap();
        let pid = running.child.id();
        let error = wait_within(&mut running, bound, &clock).err().unwrap();
        assert_eq!(error.code, "provider_timeout_uncertain");
        assert_eq!(clock.now(), bound);
        assert!(!is_unreaped_child(pid));
    }

    #[test]
    fn a_host_that_cannot_watch_for_the_exit_falls_back_to_polling() {
        let unwatched = |script| start(&mut shell(script), |_| false).unwrap();
        let clock = MonotonicClock::new();

        let mut running = unwatched("printf out; exit 3");
        let output = wait_within(&mut running, Duration::from_secs(30), &clock).unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"out");

        let mut running = unwatched("exec sleep 30");
        let pid = running.child.id();
        let error = wait_within(&mut running, Duration::from_millis(200), &clock)
            .err()
            .unwrap();
        assert_eq!(error.code, "provider_timeout_uncertain");
        assert!(!is_unreaped_child(pid));
    }

    /// Timing report with no assertions: `cargo test --lib -- --ignored --nocapture --exact
    /// provider::process::tests::time_to_notice_a_finished_child`.
    ///
    /// For a child that exits at once it prints how long the spawn took and then how long the
    /// wait took three ways: the previous timer-polled wait ([`TimerPolled`]), this module's
    /// exit-driven wait, and the standard library's unbounded blocking wait as the floor.
    /// Both bounded waits poll once before waiting, so the timer-polled one pays its sleep
    /// only when that first poll finds the child or a stream unfinished; its lag behind the
    /// real exit is then anywhere up to one [`POLL_INTERVAL`]. The numbers depend on the
    /// build profile and the host's load: report them with both.
    #[test]
    #[ignore = "timing report; prints, asserts nothing"]
    fn time_to_notice_a_finished_child() {
        const RUNS: usize = 40;
        fn median(mut samples: Vec<Duration>) -> Duration {
            samples.sort();
            samples[samples.len() / 2]
        }
        /// How long the spawn took, then how long the wait for the finished child took.
        fn timed(start: fn() -> Box<dyn Pending>) -> (Duration, Duration) {
            let started = Instant::now();
            let mut pending = start();
            let spawned = started.elapsed();
            wait_within(
                pending.as_mut(),
                Duration::from_secs(30),
                &MonotonicClock::new(),
            )
            .unwrap();
            (spawned, started.elapsed() - spawned)
        }
        fn unbounded() -> Duration {
            let child = shell("exit 0")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let spawned = Instant::now();
            child.wait_with_output().unwrap();
            spawned.elapsed()
        }
        let mut spawns = Vec::new();
        let (mut timer_polled, mut exit_driven, mut blocking) =
            (Vec::new(), Vec::new(), Vec::new());
        let mut unslept = 0;
        for _ in 0..RUNS {
            let (spawned, waited) = timed(|| Box::new(TimerPolled::spawn(&mut shell("exit 0"))));
            spawns.push(spawned);
            unslept += usize::from(waited < POLL_INTERVAL);
            timer_polled.push(waited);
            let (spawned, waited) = timed(|| Box::new(spawn(&mut shell("exit 0")).unwrap()));
            spawns.push(spawned);
            exit_driven.push(waited);
            blocking.push(unbounded());
        }
        println!(
            "`sh -c 'exit 0'`, medians of {RUNS}: spawn {:?}; then the wait: timer-polled \
             {:?} ({unslept} of {RUNS} waits shorter than 10 ms), exit-driven {:?}, \
             unbounded blocking {:?}",
            median(spawns),
            median(timer_polled),
            median(exit_driven),
            median(blocking),
        );
    }

    #[test]
    fn private_child_mask_does_not_depend_on_or_change_parent_mask() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::process::tests::permissive_parent_mask_probe",
                "--nocapture",
            ])
            .env("HACK_TEST_PERMISSIVE_MASK_PROBE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("private-child-mask-verified"));
    }

    #[test]
    fn permissive_parent_mask_probe() {
        if std::env::var_os("HACK_TEST_PERMISSIVE_MASK_PROBE").is_none() {
            return;
        }
        // This exact test runs alone in a subprocess; never mutate the suite's shared mask.
        let previous = unsafe { libc::umask(0) };
        let result = run(
            clean_command(std::path::Path::new("/bin/sh")).args(["-c", "umask"]),
            Duration::from_secs(5),
        );
        let parent = unsafe { libc::umask(previous) };
        assert_eq!(parent, 0);
        let mask = u32::from_str_radix(result.unwrap().trim(), 8).unwrap();
        assert_eq!(mask, 0o077);
        println!("private-child-mask-verified");
    }
}

#[cfg(all(test, feature = "native-stream-relay"))]
pub(crate) mod native_publisher_tests;
