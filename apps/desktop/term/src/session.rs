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
//! # Members outside the leader's group
//!
//! Members are found by scanning the process table, and a scanned pid can
//! exit and be reused before it is signalled. So each one is re-verified at
//! the moment of signalling:
//!
//! - **Linux**: open a pidfd for the pid, re-read `/proc/<pid>/stat` and
//!   require the session id to still be `leader`, then `pidfd_send_signal`.
//!   The pidfd names one process for its whole life, so the signal reaches
//!   the process that was verified or nobody. Kernels without pidfd (before
//!   5.3) fall back to re-check then `kill`.
//! - **macOS**: there is no pidfd. `getsid(pid)` and the process status are
//!   re-checked immediately before `kill(pid)`. A residual race remains: the
//!   process would have to exit, be reaped, and have its pid reused between
//!   those two calls. Members of the leader's own group never take this
//!   path; they are covered by `killpg` under the anchor.
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
    /// Verified members of our session that were signalled (directly, or as
    /// part of the leader's group).
    pub signalled: Vec<libc::pid_t>,
    /// Scanned pids that were gone or no longer in our session: not touched.
    pub skipped: Vec<libc::pid_t>,
}

/// The result of ending a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Teardown {
    /// The leader is reaped and no live session member remains.
    pub gone: bool,
    /// SIGKILL was needed: the session outlived its grace period.
    pub escalated: bool,
}

/// What to do with a leader that survives SIGKILL past the deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastResort {
    /// Keep waiting for it (a dedicated reaper thread).
    Block,
    /// Return without reaping (the caller's thread must not hang).
    GiveUp,
}

#[derive(Clone, Copy, Debug)]
struct Identity {
    sid: libc::pid_t,
    pgid: libc::pid_t,
    live: bool,
}

enum Outcome {
    Signalled,
    Skipped,
}

/// A session we started and are responsible for ending. See the module docs.
#[derive(Debug)]
pub(crate) struct OwnedSession {
    leader: libc::pid_t,
    /// `Some` until the leader is reaped.
    child: Option<Child>,
}

impl OwnedSession {
    /// Take ownership of a child that called `setsid()` before exec.
    pub fn new(child: Child) -> io::Result<Self> {
        match libc::pid_t::try_from(child.id()) {
            Ok(leader) => Ok(Self {
                leader,
                child: Some(child),
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

    /// Signal the leader's group and every verified session member.
    pub fn signal(&self, sig: libc::c_int) -> SignalReport {
        self.signal_with(sig, &members)
    }

    /// [`Self::signal`] with the member scan supplied by the caller.
    pub(crate) fn signal_with(
        &self,
        sig: libc::c_int,
        scan: &dyn Fn(libc::pid_t) -> Vec<libc::pid_t>,
    ) -> SignalReport {
        let mut report = SignalReport::default();
        if self.child.is_none() {
            // Reaped: the anchor is gone, so nothing may be signalled.
            return report;
        }
        // Members first, while they can still be verified; members of the
        // leader's own group are only verified here and signalled below.
        for pid in scan(self.leader) {
            if pid == self.leader {
                continue;
            }
            match imp::signal_verified(self.leader, pid, sig) {
                Outcome::Signalled => report.signalled.push(pid),
                Outcome::Skipped => report.skipped.push(pid),
            }
        }
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
        let gone = loop {
            let exited = self.exit().is_some();
            if exited && members(self.leader).is_empty() {
                break true;
            }
            let rekill = killed_at.is_some_and(|t| t.elapsed() >= REKILL_EVERY);
            if (killed_at.is_none() && start.elapsed() >= grace) || rekill {
                self.signal(libc::SIGKILL);
                killed_at = Some(Instant::now());
            }
            if start.elapsed() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
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
        }
    }

    /// Retire on a reaper thread. If the thread cannot be started, this
    /// thread keeps the responsibility: it kills the session now and reaps.
    pub fn retire_in_background(
        self,
        spawner: &ThreadSpawner,
        grace: Duration,
        before_reap: Box<dyn FnOnce() + Send>,
    ) {
        type Slot = Arc<Mutex<Option<(OwnedSession, Box<dyn FnOnce() + Send>)>>>;
        let take = |slot: &Slot| slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        let slot: Slot = Arc::new(Mutex::new(Some((self, before_reap))));
        let in_thread = slot.clone();
        let job: Job = Box::new(move || {
            if let Some((mut session, before_reap)) = take(&in_thread) {
                session.finish(grace, BACKGROUND_DEADLINE, before_reap, LastResort::Block);
            }
        });
        if spawner.spawn("hack-term-reaper", job).is_err()
            && let Some((mut session, before_reap)) = take(&slot)
        {
            session.finish(
                Duration::ZERO,
                SYNC_DEADLINE,
                before_reap,
                LastResort::GiveUp,
            );
        }
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
    use super::{Identity, Outcome};
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

    /// Signal `pid` only if it is, right now, a live member of `leader`'s
    /// session. See the module docs.
    pub fn signal_verified(leader: libc::pid_t, pid: libc::pid_t, sig: libc::c_int) -> Outcome {
        // SAFETY: pidfd_open takes a pid and flags and returns a descriptor.
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0 as libc::c_uint) };
        let pidfd = if raw >= 0 {
            // SAFETY: a fresh descriptor we own. pidfds are close-on-exec.
            Some(unsafe { OwnedFd::from_raw_fd(raw as libc::c_int) })
        } else {
            match std::io::Error::last_os_error().raw_os_error() {
                // No pidfd on this kernel: re-check, then plain kill.
                Some(libc::ENOSYS) => None,
                // ESRCH and anything else: the process is gone or not ours.
                _ => return Outcome::Skipped,
            }
        };
        // The pidfd, if any, now pins one process. Verify what the pid names.
        let Some(id) = identity(pid).filter(|i| i.sid == leader && i.live) else {
            return Outcome::Skipped;
        };
        if id.pgid == leader {
            // Signalled by the caller's killpg under the anchor.
            return Outcome::Signalled;
        }
        let rc = match &pidfd {
            // SAFETY: a valid pidfd; a null siginfo means a kill-style signal.
            Some(fd) => unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    sig,
                    std::ptr::null::<libc::siginfo_t>(),
                    0 as libc::c_uint,
                )
            },
            // SAFETY: plain kill of a pid verified a moment ago.
            None => libc::c_long::from(unsafe { libc::kill(pid, sig) }),
        };
        if rc == 0 {
            Outcome::Signalled
        } else {
            Outcome::Skipped
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Identity, Outcome};

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

    /// No pidfd here: re-check the session immediately before the kill.
    /// See the module docs for the race that remains.
    pub fn signal_verified(leader: libc::pid_t, pid: libc::pid_t, sig: libc::c_int) -> Outcome {
        let Some(id) = identity(pid).filter(|i| i.sid == leader && i.live) else {
            return Outcome::Skipped;
        };
        if id.pgid == leader {
            return Outcome::Signalled;
        }
        // SAFETY: plain kill of a pid verified a moment ago.
        if unsafe { libc::kill(pid, sig) } == 0 {
            Outcome::Signalled
        } else {
            Outcome::Skipped
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use super::{Identity, Outcome};

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

    pub fn signal_verified(leader: libc::pid_t, pid: libc::pid_t, sig: libc::c_int) -> Outcome {
        match identity(pid) {
            Some(id) if id.sid == leader => {
                if id.pgid != leader {
                    // SAFETY: plain kill of a pid verified a moment ago.
                    unsafe { libc::kill(pid, sig) };
                }
                Outcome::Signalled
            }
            _ => Outcome::Skipped,
        }
    }
}
