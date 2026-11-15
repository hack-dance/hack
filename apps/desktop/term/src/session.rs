//! Owning, signalling and retiring the processes of one session.
//!
//! A child started with `setsid()` has `sid == pgid == leader pid`. An
//! interactive shell moves each job into its own process group inside that
//! session, so signalling only the leader's group would miss them.
//!
//! # Ownership anchor
//!
//! [`OwnedSession`] holds the session leader **unreaped** until every signal
//! has been sent. While the leader is unreaped (running or a zombie) the
//! kernel cannot reuse its pid, and so cannot hand that number out as a new
//! process group or session id. Two things follow:
//!
//! - `killpg(leader)` always reaches our group or nothing;
//! - a process whose session id is `leader` is in our session.
//!
//! Exit is observed with `waitid(WNOWAIT)`, which does not reap. The leader
//! is reaped once, after the last signal.
//!
//! # Members outside the leader's group: fail closed
//!
//! Members are found by scanning the process table, and a scanned pid can
//! exit and be reused before it is signalled. A signal is therefore sent
//! only through a handle whose identity cannot be recycled:
//!
//! - **The leader's group**, on every platform: `killpg(leader)` under the
//!   anchor. Closing the PTY master also hangs up the controlling terminal,
//!   so the kernel sends SIGHUP to the foreground group and an interactive
//!   shell sends its own SIGHUP to its jobs.
//! - **Linux, other groups**: a pidfd. Open it, re-read `/proc/<pid>/stat`
//!   and require the session id to still be `leader`, then
//!   `pidfd_send_signal`. The pidfd names one process for its whole life,
//!   so the signal reaches the process that was verified or nobody.
//! - **No handle, no signal.** macOS has no pidfd, and neither do Linux
//!   kernels before 5.3. There a member outside the leader's group is never
//!   signalled by number: it is left alone and reported. `kill(pid)` after
//!   a check is not used anywhere, because the check and the kill can
//!   straddle a pid reuse.
//!
//! What that costs: on macOS (and old Linux) a process that is in another
//! process group of the session **and** ignores or never receives SIGHUP
//! can outlive the terminal, as it would outlive any terminal app that is
//! closed. It is found by a scan of the session and returned in
//! [`Teardown::survivors`] so the caller can tell the user.
//!
//! A descendant that calls `setsid()` leaves the session and is out of reach.

use std::io;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How long a synchronous (caller-thread) teardown may take after SIGKILL.
pub(crate) const SYNC_DEADLINE: Duration = Duration::from_secs(5);
/// How long a background reaper keeps signalling before it only waits.
pub(crate) const BACKGROUND_DEADLINE: Duration = Duration::from_secs(10);
/// After escalation, SIGKILL is re-sent this often to catch late forks.
const REKILL_EVERY: Duration = Duration::from_millis(50);
/// How long unreachable survivors get to exit on their own after SIGKILL
/// has gone to everything that can be reached.
const UNREACHABLE_SETTLE: Duration = Duration::from_millis(200);

/// Live (non-zombie) processes whose session id is `leader`.
pub fn members(leader: libc::pid_t) -> Vec<libc::pid_t> {
    imp::members(leader)
}

/// Whether `pid` is a live (non-zombie) process.
pub fn is_alive(pid: libc::pid_t) -> bool {
    imp::identity(pid).is_some_and(|i| i.live)
}

/// Whether `pid` is in the process table at all, zombies included.
pub fn exists(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks for existence.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether `pid` is a child of this process that has not been reaped. Such
/// a pid is anchored: it cannot have been reused.
#[cfg(test)]
pub(crate) fn is_own_child(pid: libc::pid_t) -> bool {
    // SAFETY: siginfo_t is plain old data; WNOWAIT leaves the child waitable.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    libc::id_t::try_from(pid).is_ok_and(|id| unsafe {
        libc::waitid(
            libc::P_PID,
            id,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) == 0
    })
}

/// How a session leader ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitInfo {
    Exited(i32),
    Signaled(i32),
    /// The exit was observed but its status was not available.
    Unknown,
}

impl std::fmt::Display for ExitInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exited(code) => write!(f, "exit status {code}"),
            Self::Signaled(sig) => write!(f, "signal {sig}"),
            Self::Unknown => write!(f, "exited"),
        }
    }
}

/// Whether child `pid` has exited, without reaping it.
pub(crate) fn peek_exit(pid: libc::pid_t) -> Option<ExitInfo> {
    // SAFETY: siginfo_t is plain old data; waitid fills it.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let Ok(id) = libc::id_t::try_from(pid) else {
        return Some(ExitInfo::Unknown);
    };
    loop {
        // SAFETY: WNOWAIT leaves the child waitable; the buffer is valid.
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if rc == 0 {
            break;
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::EINTR) => {}
            // Not our child any more: it was reaped.
            _ => return Some(ExitInfo::Unknown),
        }
    }
    // SAFETY: waitid succeeded, so the SIGCHLD fields are initialised.
    let (si_pid, status) = unsafe { (info.si_pid(), info.si_status()) };
    if si_pid == 0 {
        return None;
    }
    Some(if info.si_code == libc::CLD_EXITED {
        ExitInfo::Exited(status)
    } else {
        ExitInfo::Signaled(status)
    })
}

/// What one signalling pass did to the scanned members.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignalReport {
    /// Verified members of our session that were signalled: through their
    /// own handle, or as part of the leader's group.
    pub signalled: Vec<libc::pid_t>,
    /// Scanned pids that were gone or no longer in our session: not touched.
    pub skipped: Vec<libc::pid_t>,
    /// Members of our session outside the leader's group for which this
    /// platform has no race-free handle: not signalled. See the module docs.
    pub unreachable: Vec<libc::pid_t>,
}

/// The result of ending a session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Teardown {
    /// The leader is reaped and no live session member remains.
    pub gone: bool,
    /// SIGKILL was needed: the session outlived its grace period.
    pub escalated: bool,
    /// Session members still running when teardown stopped. These are pids
    /// for display only; they must never be signalled by number.
    pub survivors: Vec<libc::pid_t>,
}

impl Teardown {
    /// Nothing was running to begin with.
    pub(crate) fn nothing() -> Self {
        Self {
            gone: true,
            escalated: false,
            survivors: Vec::new(),
        }
    }
}

/// What to do with a leader that survives SIGKILL past the deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastResort {
    /// Keep waiting for it (a dedicated reaper thread).
    Block,
    /// Return without reaping (the caller's thread must not hang).
    GiveUp,
}

/// What the process table says a pid is right now.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Identity {
    pub sid: libc::pid_t,
    pub pgid: libc::pid_t,
    pub live: bool,
}

/// A handle that names one process for its whole life.
pub(crate) trait ProcHandle {
    /// Send `sig`; `false` when the process is gone.
    fn send(&self, sig: libc::c_int) -> bool;
}

/// The result of asking for a handle.
#[cfg_attr(
    not(target_os = "linux"),
    allow(dead_code, reason = "only Linux has a race-free handle to construct")
)]
pub(crate) enum Open {
    Handle(Box<dyn ProcHandle>),
    /// No such process.
    Gone,
    /// This platform has no race-free handle for another process.
    Unsupported,
}

/// The process table as teardown sees it. The real one is [`OsTable`];
/// tests substitute their own to control what a pid means at each step.
pub(crate) trait ProcTable {
    fn scan(&self, leader: libc::pid_t) -> Vec<libc::pid_t>;
    fn open(&self, pid: libc::pid_t) -> Open;
    fn identity(&self, pid: libc::pid_t) -> Option<Identity>;
    /// Runs after a member has been verified and before it is signalled.
    /// The boundary a pid reuse would have to fall in; a no-op outside tests.
    fn verified(&self, _pid: libc::pid_t) {}
}

/// The operating system's process table.
pub(crate) struct OsTable;

impl ProcTable for OsTable {
    fn scan(&self, leader: libc::pid_t) -> Vec<libc::pid_t> {
        imp::members(leader)
    }

    fn open(&self, pid: libc::pid_t) -> Open {
        imp::open(pid)
    }

    fn identity(&self, pid: libc::pid_t) -> Option<Identity> {
        imp::identity(pid)
    }
}

/// Signal the members of `leader`'s session that are outside its group,
/// each through its own handle, and classify every scanned pid. Members of
/// the leader's own group are only verified here; the caller signals that
/// group with `killpg` under the anchor.
///
/// No pid number is ever passed to a signalling call: after `open`, the
/// only thing that can be signalled is the handle.
pub(crate) fn signal_members(
    leader: libc::pid_t,
    sig: libc::c_int,
    table: &dyn ProcTable,
) -> SignalReport {
    let mut report = SignalReport::default();
    for pid in table.scan(leader) {
        if pid == leader {
            continue;
        }
        // Open first: from here a handle, if there is one, pins the process
        // that `pid` named at this instant.
        let handle = match table.open(pid) {
            Open::Gone => {
                report.skipped.push(pid);
                continue;
            }
            Open::Handle(h) => Some(h),
            Open::Unsupported => None,
        };
        let Some(id) = table.identity(pid).filter(|i| i.sid == leader && i.live) else {
            report.skipped.push(pid);
            continue;
        };
        table.verified(pid);
        if id.pgid == leader {
            // The caller's killpg reaches it under the anchor.
            report.signalled.push(pid);
        } else {
            match handle {
                Some(h) if h.send(sig) => report.signalled.push(pid),
                Some(_) => report.skipped.push(pid),
                None => report.unreachable.push(pid),
            }
        }
    }
    report
}

/// A session we started and are responsible for ending. See the module docs.
#[derive(Debug)]
pub(crate) struct OwnedSession {
    leader: libc::pid_t,
    /// `Some` until the leader is reaped.
    child: Option<Child>,
    /// The process table signalling goes through; the OS one outside tests.
    table: Arc<dyn ProcTable + Send + Sync>,
}

impl std::fmt::Debug for dyn ProcTable + Send + Sync {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProcTable")
    }
}

impl OwnedSession {
    /// Take ownership of a child that called `setsid()` before exec.
    pub fn new(child: Child) -> io::Result<Self> {
        match libc::pid_t::try_from(child.id()) {
            Ok(leader) => Ok(Self {
                leader,
                child: Some(child),
                table: Arc::new(OsTable),
            }),
            Err(_) => {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                Err(io::Error::other("child pid out of range"))
            }
        }
    }

    pub fn leader(&self) -> libc::pid_t {
        self.leader
    }

    /// The leader's exit, observed without reaping.
    pub fn exit(&self) -> Option<ExitInfo> {
        peek_exit(self.leader)
    }

    /// Signal the leader's group, and every other verified session member
    /// for which there is a race-free handle.
    pub fn signal(&self, sig: libc::c_int) -> SignalReport {
        self.signal_with(sig, &*self.table)
    }

    /// Replace the process table, to run teardown as another platform would.
    #[cfg(test)]
    pub(crate) fn set_table(&mut self, table: Arc<dyn ProcTable + Send + Sync>) {
        self.table = table;
    }

    /// [`Self::signal`] against a supplied process table.
    pub(crate) fn signal_with(&self, sig: libc::c_int, table: &dyn ProcTable) -> SignalReport {
        if self.child.is_none() {
            // Reaped: the anchor is gone, so nothing may be signalled.
            return SignalReport::default();
        }
        // Members first, while they can still be verified.
        let report = signal_members(self.leader, sig, table);
        // SAFETY: the leader is unreaped, so this group id is still ours.
        unsafe {
            libc::killpg(self.leader, sig);
        }
        report
    }

    /// End the session and reap the leader. Sends SIGKILL once `grace` has
    /// passed (immediately when zero) and keeps re-sending it; runs
    /// `before_reap` after the last signal; then reaps.
    pub fn retire(
        mut self,
        grace: Duration,
        deadline: Duration,
        before_reap: impl FnOnce(),
        last: LastResort,
    ) -> Teardown {
        self.finish(grace, deadline, before_reap, last)
    }

    fn finish(
        &mut self,
        grace: Duration,
        deadline: Duration,
        before_reap: impl FnOnce(),
        last: LastResort,
    ) -> Teardown {
        let start = Instant::now();
        let mut killed_at: Option<Instant> = None;
        // Set while everything still alive is beyond our reach.
        let mut stuck_since: Option<Instant> = None;
        let gone = loop {
            let exited = self.exit().is_some();
            let alive = members(self.leader);
            if exited && alive.is_empty() {
                break true;
            }
            let rekill = killed_at.is_some_and(|t| t.elapsed() >= REKILL_EVERY);
            if (killed_at.is_none() && start.elapsed() >= grace) || rekill {
                let report = self.signal(libc::SIGKILL);
                killed_at = Some(Instant::now());
                // SIGKILL has gone to everything we can reach. If the leader
                // is dead and all that is left has no handle, waiting longer
                // changes nothing.
                let stuck = exited && alive.iter().all(|p| report.unreachable.contains(p));
                stuck_since = stuck.then(|| stuck_since.unwrap_or_else(Instant::now));
            }
            if stuck_since.is_some_and(|t| t.elapsed() >= UNREACHABLE_SETTLE) {
                break false;
            }
            if start.elapsed() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let survivors = if gone {
            Vec::new()
        } else {
            members(self.leader)
        };
        before_reap();
        // Every signal has been sent. Only now give up the pid.
        if let Some(mut child) = self.child.take()
            && (last == LastResort::Block || peek_exit(self.leader).is_some())
        {
            let _ = child.wait();
        }
        Teardown {
            gone,
            escalated: killed_at.is_some(),
            survivors,
        }
    }

    /// Retire on a reaper thread. If the thread cannot be started, this
    /// thread keeps the responsibility: it kills the session now and reaps.
    /// The result is delivered to `report` either way.
    pub fn retire_in_background(
        self,
        spawner: &ThreadSpawner,
        grace: Duration,
        before_reap: Box<dyn FnOnce() + Send>,
        report: Option<std::sync::mpsc::Sender<Teardown>>,
    ) {
        type Parts = (
            OwnedSession,
            Box<dyn FnOnce() + Send>,
            Option<std::sync::mpsc::Sender<Teardown>>,
        );
        type Slot = Arc<Mutex<Option<Parts>>>;
        let take = |slot: &Slot| slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        let slot: Slot = Arc::new(Mutex::new(Some((self, before_reap, report))));
        let in_thread = slot.clone();
        let job: Job = Box::new(move || {
            if let Some((mut session, before_reap, report)) = take(&in_thread) {
                let done =
                    session.finish(grace, BACKGROUND_DEADLINE, before_reap, LastResort::Block);
                if let Some(tx) = report {
                    let _ = tx.send(done);
                }
            }
        });
        if spawner.spawn("hack-term-reaper", job).is_err()
            && let Some((mut session, before_reap, report)) = take(&slot)
        {
            let done = session.finish(
                Duration::ZERO,
                SYNC_DEADLINE,
                before_reap,
                LastResort::GiveUp,
            );
            if let Some(tx) = report {
                let _ = tx.send(done);
            }
        }
    }
}

/// The result of a teardown that is running on a reaper thread.
#[derive(Debug)]
pub struct PendingTeardown(pub(crate) std::sync::mpsc::Receiver<Teardown>);

impl PendingTeardown {
    /// The result, once teardown has finished. Check
    /// [`Teardown::survivors`] to tell the user about anything left running.
    pub fn try_result(&self) -> Option<Teardown> {
        self.0.try_recv().ok()
    }

    /// Wait up to `timeout` for the result.
    pub fn wait(&self, timeout: Duration) -> Option<Teardown> {
        self.0.recv_timeout(timeout).ok()
    }
}

impl Drop for OwnedSession {
    /// A session dropped without being retired (an error path between spawn
    /// and hand-over) is killed and reaped here, on the caller's thread.
    fn drop(&mut self) {
        if self.child.is_some() {
            self.finish(Duration::ZERO, SYNC_DEADLINE, || {}, LastResort::GiveUp);
        }
    }
}

pub(crate) type Job = Box<dyn FnOnce() + Send + 'static>;

type SpawnFn = dyn Fn(&str, Job) -> io::Result<JoinHandle<()>> + Send + Sync;

/// How worker threads are started. Injectable so tests can make it fail.
#[derive(Clone)]
pub(crate) struct ThreadSpawner(Arc<SpawnFn>);

impl std::fmt::Debug for ThreadSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ThreadSpawner")
    }
}

impl ThreadSpawner {
    /// Real OS threads.
    pub fn os() -> Self {
        Self(Arc::new(|name, job| {
            std::thread::Builder::new().name(name.to_owned()).spawn(job)
        }))
    }

    pub fn spawn(&self, name: &str, job: Job) -> io::Result<JoinHandle<()>> {
        (self.0)(name, job)
    }

    /// Succeeds `ok` times, then fails every call. For tests.
    #[cfg(test)]
    pub fn failing_after(ok: usize) -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let real = Self::os();
        Self(Arc::new(move |name, job| {
            if calls.fetch_add(1, Ordering::SeqCst) < ok {
                real.spawn(name, job)
            } else {
                Err(io::Error::other("injected thread-spawn failure"))
            }
        }))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{Identity, Open, ProcHandle};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    /// State, process group and session from `/proc/<pid>/stat`.
    pub fn identity(pid: libc::pid_t) -> Option<Identity> {
        let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm may contain spaces and parentheses; fields resume after the last ')'.
        let rest = &text[text.rfind(')')? + 1..];
        let mut fields = rest.split_ascii_whitespace();
        let state = fields.next()?.chars().next()?;
        let _ppid = fields.next()?;
        let pgid = fields.next()?.parse().ok()?;
        let sid = fields.next()?.parse().ok()?;
        Some(Identity {
            sid,
            pgid,
            live: state != 'Z' && state != 'X',
        })
    }

    pub fn members(leader: libc::pid_t) -> Vec<libc::pid_t> {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<libc::pid_t>().ok())
            .filter(|&pid| identity(pid).is_some_and(|i| i.sid == leader && i.live))
            .collect()
    }

    struct PidFd(OwnedFd);

    impl ProcHandle for PidFd {
        fn send(&self, sig: libc::c_int) -> bool {
            // SAFETY: a valid pidfd; a null siginfo means a kill-style signal.
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.0.as_raw_fd(),
                    sig,
                    std::ptr::null::<libc::siginfo_t>(),
                    0 as libc::c_uint,
                )
            };
            rc == 0
        }
    }

    /// A pidfd for `pid`. Kernels before 5.3 have none: `Unsupported`, and
    /// the caller then signals nothing by number.
    pub fn open(pid: libc::pid_t) -> Open {
        // SAFETY: pidfd_open takes a pid and flags and returns a descriptor.
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0 as libc::c_uint) };
        if raw >= 0 {
            // SAFETY: a fresh descriptor we own. pidfds are close-on-exec.
            return Open::Handle(Box::new(PidFd(unsafe {
                OwnedFd::from_raw_fd(raw as libc::c_int)
            })));
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOSYS) => Open::Unsupported,
            _ => Open::Gone,
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Identity, Open};

    /// `SZOMB` from `<sys/proc.h>`.
    const SZOMB: u32 = 5;

    fn bsd_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
        // SAFETY: proc_bsdinfo is plain old data.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
        // SAFETY: the buffer is one proc_bsdinfo of `size` bytes.
        let n = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size)
        };
        (n == size).then_some(info)
    }

    pub fn identity(pid: libc::pid_t) -> Option<Identity> {
        let info = bsd_info(pid)?;
        // SAFETY: getsid only reads the process table.
        let sid = unsafe { libc::getsid(pid) };
        Some(Identity {
            sid,
            pgid: libc::pid_t::try_from(info.pbi_pgid).ok()?,
            live: info.pbi_status != SZOMB,
        })
    }

    fn all_pids() -> Vec<libc::pid_t> {
        for _ in 0..4 {
            // SAFETY: a null buffer asks for the current count.
            let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
            let Ok(n) = usize::try_from(n) else {
                return Vec::new();
            };
            let mut buf: Vec<libc::pid_t> = vec![0; n + 64];
            let Ok(bytes) = libc::c_int::try_from(buf.len() * std::mem::size_of::<libc::pid_t>())
            else {
                return Vec::new();
            };
            // SAFETY: the buffer holds `bytes` bytes; the result is a pid count.
            let got = unsafe { libc::proc_listallpids(buf.as_mut_ptr().cast(), bytes) };
            let Ok(got) = usize::try_from(got) else {
                return Vec::new();
            };
            if got < buf.len() {
                buf.truncate(got);
                return buf;
            }
        }
        Vec::new()
    }

    pub fn members(leader: libc::pid_t) -> Vec<libc::pid_t> {
        all_pids()
            .into_iter()
            .filter(|&pid| pid > 0)
            .filter(|&pid| identity(pid).is_some_and(|i| i.sid == leader && i.live))
            .collect()
    }

    /// macOS has no handle that pins another process, so nothing outside
    /// the anchored leader group is signalled. See the module docs.
    pub fn open(_pid: libc::pid_t) -> Open {
        Open::Unsupported
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use super::{Identity, Open};

    pub fn identity(pid: libc::pid_t) -> Option<Identity> {
        // SAFETY: these calls only read the process table.
        let (sid, pgid) = unsafe { (libc::getsid(pid), libc::getpgid(pid)) };
        (sid > 0).then_some(Identity {
            sid,
            pgid,
            live: true,
        })
    }

    pub fn members(_leader: libc::pid_t) -> Vec<libc::pid_t> {
        Vec::new()
    }

    pub fn open(_pid: libc::pid_t) -> Open {
        Open::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    const LEADER: libc::pid_t = 1000;

    /// A process in the fake table. `generation` tells apart two processes
    /// that held the same pid one after the other.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct FakeProc {
        generation: u32,
        sid: libc::pid_t,
        pgid: libc::pid_t,
    }

    /// A process table the test controls, with pid reuse on demand.
    #[derive(Default)]
    struct FakeTable {
        procs: RefCell<HashMap<libc::pid_t, FakeProc>>,
        scan: Vec<libc::pid_t>,
        handles: bool,
        /// Pids whose process is replaced right after verification.
        replace_after_verify: Vec<libc::pid_t>,
        /// Every signal delivered: (pid, generation that received it).
        delivered: Rc<RefCell<Vec<(libc::pid_t, u32)>>>,
        /// Every send attempted through a handle: the generation it pins.
        attempts: Rc<RefCell<Vec<(libc::pid_t, u32)>>>,
    }

    struct FakeHandle {
        pid: libc::pid_t,
        pinned: u32,
        procs: *const RefCell<HashMap<libc::pid_t, FakeProc>>,
        delivered: Rc<RefCell<Vec<(libc::pid_t, u32)>>>,
        attempts: Rc<RefCell<Vec<(libc::pid_t, u32)>>>,
    }

    impl ProcHandle for FakeHandle {
        fn send(&self, _sig: libc::c_int) -> bool {
            self.attempts.borrow_mut().push((self.pid, self.pinned));
            // SAFETY: the table outlives every handle in these tests.
            let procs = unsafe { &*self.procs }.borrow();
            // Like a pidfd: the signal goes to the pinned process if it
            // still exists, never to whatever holds the pid now.
            let alive = procs
                .get(&self.pid)
                .is_some_and(|p| p.generation == self.pinned);
            if alive {
                self.delivered.borrow_mut().push((self.pid, self.pinned));
            }
            alive
        }
    }

    impl ProcTable for FakeTable {
        fn scan(&self, _leader: libc::pid_t) -> Vec<libc::pid_t> {
            self.scan.clone()
        }

        fn open(&self, pid: libc::pid_t) -> Open {
            if !self.handles {
                return Open::Unsupported;
            }
            match self.procs.borrow().get(&pid) {
                None => Open::Gone,
                Some(p) => Open::Handle(Box::new(FakeHandle {
                    pid,
                    pinned: p.generation,
                    procs: &self.procs,
                    delivered: self.delivered.clone(),
                    attempts: self.attempts.clone(),
                })),
            }
        }

        fn identity(&self, pid: libc::pid_t) -> Option<Identity> {
            self.procs.borrow().get(&pid).map(|p| Identity {
                sid: p.sid,
                pgid: p.pgid,
                live: true,
            })
        }

        fn verified(&self, pid: libc::pid_t) {
            if self.replace_after_verify.contains(&pid) {
                // The verified process exits and an unrelated one, in
                // another session, takes over its pid number.
                self.procs.borrow_mut().insert(
                    pid,
                    FakeProc {
                        generation: 2,
                        sid: 7777,
                        pgid: 7777,
                    },
                );
            }
        }
    }

    fn member(pgid: libc::pid_t) -> FakeProc {
        FakeProc {
            generation: 1,
            sid: LEADER,
            pgid,
        }
    }

    #[test]
    fn a_pid_replaced_between_verification_and_signalling_receives_nothing() {
        let table = FakeTable {
            procs: RefCell::new(HashMap::from([
                (2001, member(2001)),   // a job, replaced at the boundary
                (2002, member(2002)),   // a job that stays
                (2003, member(LEADER)), // in the leader's group, replaced
            ])),
            scan: vec![2001, 2002, 2003],
            handles: true,
            replace_after_verify: vec![2001, 2003],
            ..FakeTable::default()
        };
        let report = signal_members(LEADER, libc::SIGTERM, &table);
        // The send for 2001 went through the handle pinned to the verified
        // process (generation 1), which no longer exists.
        assert_eq!(*table.attempts.borrow(), [(2001, 1), (2002, 1)]);
        // Only the member that is still itself received a signal. The
        // replacement at pid 2001 (generation 2) received nothing.
        assert_eq!(*table.delivered.borrow(), [(2002, 1)]);
        assert!(!table.delivered.borrow().iter().any(|&(_, g)| g == 2));
        // 2003 is covered by the leader's group signal and is never
        // signalled by number, so its replacement cannot be hit here either.
        assert_eq!(report.signalled, [2002, 2003]);
        assert_eq!(report.skipped, [2001]);
        assert!(report.unreachable.is_empty());
    }

    #[test]
    fn without_a_handle_nothing_outside_the_leader_group_is_signalled() {
        // What macOS, and Linux without pidfd, look like.
        let table = FakeTable {
            procs: RefCell::new(HashMap::from([
                (2001, member(2001)),
                (2002, member(LEADER)),
                (
                    2003,
                    FakeProc {
                        generation: 1,
                        sid: 4242,
                        pgid: 4242,
                    },
                ),
            ])),
            scan: vec![2001, 2002, 2003, 2004],
            handles: false,
            replace_after_verify: vec![2001],
            ..FakeTable::default()
        };
        let report = signal_members(LEADER, libc::SIGKILL, &table);
        assert!(
            table.attempts.borrow().is_empty(),
            "no per-process signal at all"
        );
        assert!(table.delivered.borrow().is_empty());
        assert_eq!(report.unreachable, [2001], "reported, not signalled");
        assert_eq!(report.signalled, [2002], "the leader's group, by killpg");
        assert_eq!(report.skipped, [2003, 2004], "another session; no such pid");
    }

    #[test]
    fn stale_scan_results_are_skipped() {
        let table = FakeTable {
            procs: RefCell::new(HashMap::from([(
                2001,
                FakeProc {
                    generation: 1,
                    sid: 9,
                    pgid: 9,
                },
            )])),
            scan: vec![LEADER, 2001, 2002],
            handles: true,
            ..FakeTable::default()
        };
        let report = signal_members(LEADER, libc::SIGTERM, &table);
        assert_eq!(report.skipped, [2001, 2002]);
        assert!(report.signalled.is_empty() && table.attempts.borrow().is_empty());
    }
}
