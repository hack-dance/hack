//! Process-wide foreground-only signal ownership. Handler never accesses an FD.
use super::{CandidateError, refused, transport::Publication};
use std::{
    os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
/// Marks EVFILT_PROC registrations for host dependency listeners. Publisher
/// child watches keep a null tag, and their exit remains fatal to the owner.
const LISTENER_EXIT: usize = 1;
/// One foreground wake. `Ready` covers every readable descriptor (control
/// listener and dependency notices); the caller re-reads them non-blockingly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::provider::graph) enum Wake {
    Signal,
    Ready,
    ListenerExit,
    Timeout,
}
static OWNED: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);
extern "C" fn notified(_: libc::c_int) {
    PENDING.store(true, Ordering::Release);
}
/// The caller retains Events for the entire callback lifetime.
pub(super) fn startup_pending() -> bool {
    PENDING.load(Ordering::Acquire)
}
pub(in crate::provider::graph) struct Events {
    queue: OwnedFd,
    previous: Vec<(i32, libc::sigaction)>,
}
impl Events {
    pub(super) fn new(publication: &Publication) -> Result<Self, CandidateError> {
        Self::new_descriptor(publication.descriptor())
    }
    /// Caller retains the exact listener for the entire signal queue lifetime.
    pub(in crate::provider::graph) fn new_descriptor(
        listener: BorrowedFd<'_>,
    ) -> Result<Self, CandidateError> {
        if OWNED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(refused());
        }
        // SAFETY: kqueue has no pointer arguments and returns a fresh descriptor.
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            OWNED.store(false, Ordering::Release);
            return Err(refused());
        }
        // SAFETY: adopt the fresh descriptor exactly once.
        let mut events = Self {
            queue: unsafe { OwnedFd::from_raw_fd(fd) },
            previous: Vec::new(),
        };
        // SAFETY: F_SETFD operates on our owned descriptor with a valid flag.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(refused());
        }
        let change = |ident, filter| libc::kevent {
            ident,
            filter,
            flags: libc::EV_ADD | libc::EV_ENABLE,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let changes = [
            change(listener.as_raw_fd() as usize, libc::EVFILT_READ),
            change(libc::SIGTERM as usize, libc::EVFILT_SIGNAL),
            change(libc::SIGINT as usize, libc::EVFILT_SIGNAL),
        ];
        // Register signal filters BEFORE installing handlers. Every signal caught by
        // our handler therefore also wakes kevent; the atomic flag covers coalescing.
        // SAFETY: changes is live initialized storage; no event output is requested.
        if unsafe {
            libc::kevent(
                fd,
                changes.as_ptr(),
                changes.len() as i32,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(refused());
        }
        PENDING.store(false, Ordering::Release);
        for signal in [libc::SIGTERM, libc::SIGINT] {
            // SAFETY: sigaction is plain C storage; mask is initialized before use.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            // SAFETY: initialized output storage for saved disposition.
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = notified as *const () as usize;
            // SAFETY: valid writable mask and action/previous pointers remain live.
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            // SAFETY: kernel copies action and fills previous before returning.
            if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                return Err(refused());
            }
            events.previous.push((signal, previous));
        }
        Ok(events)
    }
    /// Register only a retained child handle; no process discovered by PID is adopted.
    pub fn watch_child(&self, child: &std::process::Child) -> Result<(), CandidateError> {
        self.child_filter(child, libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT)
    }
    /// Remove queued exit notifications before reaping or replacing a publisher.
    pub fn unwatch_child(&self, child: &std::process::Child) -> Result<(), CandidateError> {
        self.child_filter(child, libc::EV_DELETE)
    }
    fn child_filter(&self, child: &std::process::Child, flags: u16) -> Result<(), CandidateError> {
        let change = libc::kevent {
            ident: child.id() as usize,
            filter: libc::EVFILT_PROC,
            flags,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: owned queue and initialized change remain valid for this call.
        let result = unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if result < 0 {
            let code = std::io::Error::last_os_error().raw_os_error();
            // A one-shot notification may already have been consumed.
            if flags == libc::EV_DELETE && code == Some(libc::ENOENT) {
                return Ok(());
            }
            return Err(refused());
        }
        Ok(())
    }
    pub fn pending(&self) -> bool {
        PENDING.load(Ordering::Acquire)
    }
    /// Watch one admitted host dependency listener for exit, without adopting or
    /// signalling it. The identity is rechecked after registration, so a PID that
    /// already exited (or was reused) reports `false`: treat it as already stale.
    pub fn watch_listener_exit(
        &self,
        identity: &crate::provider::identity::ProcessIdentity,
    ) -> Result<bool, CandidateError> {
        let change = libc::kevent {
            ident: usize::try_from(identity.pid).map_err(|_| refused())?,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: LISTENER_EXIT as *mut libc::c_void,
        };
        // SAFETY: owned queue and initialized change remain valid for this call.
        let result = unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if result < 0 {
            return match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ESRCH) => Ok(false),
                _ => Err(refused()),
            };
        }
        let current = crate::provider::identity::observe(identity.pid);
        if current.as_ref().ok() != Some(identity) {
            // The PID is gone or reused: stale either way. The one-shot watch
            // can only fire for that PID, so a failed removal is harmless.
            let _ = self.unwatch_listener_exit(identity.pid);
            return Ok(false);
        }
        Ok(true)
    }
    /// Remove a listener watch that is no longer admitted. An already delivered
    /// one-shot watch or an exited process is not an error.
    pub fn unwatch_listener_exit(&self, pid: i32) -> Result<(), CandidateError> {
        let change = libc::kevent {
            ident: usize::try_from(pid).map_err(|_| refused())?,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_DELETE,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: owned queue and initialized change remain valid for this call.
        let result = unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if result < 0
            && !matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ENOENT | libc::ESRCH)
            )
        {
            return Err(refused());
        }
        Ok(())
    }
    /// The runtime retains this notification descriptor for this queue's lifetime.
    pub fn watch_read(&self, descriptor: BorrowedFd<'_>) -> Result<(), CandidateError> {
        let change = libc::kevent {
            ident: descriptor.as_raw_fd() as usize,
            filter: libc::EVFILT_READ,
            flags: libc::EV_ADD | libc::EV_ENABLE,
            fflags: 0,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: owned queue, retained descriptor and initialized change are live.
        if unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(refused());
        }
        Ok(())
    }
    /// Untimed wait: `true` for a termination signal. The compose foreground
    /// loop uses [`Self::wait_until`] for its bounded refresh retries.
    #[cfg(any(test, feature = "native-config-plan"))]
    pub fn wait(&self) -> Result<bool, CandidateError> {
        Ok(self.wait_until(None)? == Wake::Signal)
    }
    /// Wait for one event, or until `deadline` (a bounded retry time; never an
    /// idle poll). Publisher child exit remains an error; a watched dependency
    /// listener's exit is reported as `ListenerExit`.
    pub fn wait_until(&self, deadline: Option<Instant>) -> Result<Wake, CandidateError> {
        loop {
            if PENDING.load(Ordering::Acquire) {
                return Ok(Wake::Signal);
            }
            let timeout = deadline.map(|deadline| {
                let remaining = deadline.saturating_duration_since(Instant::now());
                libc::timespec {
                    tv_sec: remaining.as_secs() as libc::time_t,
                    tv_nsec: remaining.subsec_nanos() as libc::c_long,
                }
            });
            // SAFETY: kevent is plain C output storage filled by the kernel.
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            // SAFETY: queue, writable single event and optional timeout remain live.
            let count = unsafe {
                libc::kevent(
                    self.queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    timeout
                        .as_ref()
                        .map_or(std::ptr::null(), |timeout| timeout as *const libc::timespec),
                )
            };
            if PENDING.load(Ordering::Acquire) {
                return Ok(Wake::Signal);
            }
            if count < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(refused());
            }
            if count == 0 && deadline.is_some() {
                return Ok(Wake::Timeout);
            }
            if count != 1 || event.flags & libc::EV_ERROR != 0 {
                return Err(refused());
            }
            if event.filter == libc::EVFILT_PROC {
                if event.udata as usize == LISTENER_EXIT {
                    return Ok(Wake::ListenerExit);
                }
                return Err(refused());
            }
            return Ok(if event.filter == libc::EVFILT_SIGNAL {
                Wake::Signal
            } else {
                Wake::Ready
            });
        }
    }
}
impl Drop for Events {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.iter().rev() {
            // SAFETY: restore the exact saved disposition. The handler touches only
            // static atomic storage, so an in-flight handler cannot use a closed FD.
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
        OWNED.store(false, Ordering::Release);
    }
}
