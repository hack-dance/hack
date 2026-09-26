//! Process-wide foreground-only signal ownership. Handler never accesses an FD.
use super::{CandidateError, refused, transport::Publication};
use std::{
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    sync::atomic::{AtomicBool, Ordering},
};
static OWNED: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);
extern "C" fn notified(_: libc::c_int) {
    PENDING.store(true, Ordering::Release);
}
/// The caller retains Events for the entire callback lifetime.
pub(super) fn startup_pending() -> bool {
    PENDING.load(Ordering::Acquire)
}
pub(super) struct Events {
    queue: OwnedFd,
    previous: Vec<(i32, libc::sigaction)>,
}
impl Events {
    pub fn new(publication: &Publication) -> Result<Self, CandidateError> {
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
            change(publication.fd() as usize, libc::EVFILT_READ),
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
    pub fn wait(&self) -> Result<bool, CandidateError> {
        loop {
            if PENDING.load(Ordering::Acquire) {
                return Ok(true);
            }
            // SAFETY: kevent is plain C output storage filled by the kernel.
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            // SAFETY: queue and writable single event remain live, no changelist.
            let count = unsafe {
                libc::kevent(
                    self.queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    std::ptr::null(),
                )
            };
            if PENDING.load(Ordering::Acquire) {
                return Ok(true);
            }
            if count < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(refused());
            }
            if count != 1 || event.flags & libc::EV_ERROR != 0 {
                return Err(refused());
            }
            if event.filter == libc::EVFILT_PROC {
                return Err(refused());
            }
            return Ok(event.filter == libc::EVFILT_SIGNAL);
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
