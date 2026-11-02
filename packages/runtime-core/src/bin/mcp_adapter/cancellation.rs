//! Temporary signal handling for startup. Relay retains normal process signals.
use std::io;
use std::sync::atomic::{AtomicI32, Ordering};

use super::error;

static CANCELLED: AtomicI32 = AtomicI32::new(0);

extern "C" fn cancel(signal: libc::c_int) {
    // AtomicI32 is lock-free on the supported macOS/Linux targets. No allocation,
    // I/O or Rust cleanup runs in a signal handler; the startup owner does cleanup.
    CANCELLED.store(signal, Ordering::Relaxed);
}

pub(super) struct Cancellation {
    previous: Vec<(libc::c_int, libc::sigaction)>,
}

impl Cancellation {
    pub(super) fn install() -> io::Result<Self> {
        CANCELLED.store(0, Ordering::Relaxed);
        let mut guard = Self {
            previous: Vec::with_capacity(2),
        };
        for signal in [libc::SIGINT, libc::SIGTERM] {
            // SAFETY: sigaction consists of integer/pointer fields. Initialize its
            // handler and mask before passing it to libc; the old action output is
            // writable. This binary installs one startup guard on its main thread.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = cancel as *const () as usize;
            if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0
                || unsafe { libc::sigaction(signal, &action, &mut previous) } != 0
            {
                return Err(error("cannot install startup cancellation"));
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }

    pub(super) fn check(&self) -> io::Result<()> {
        if CANCELLED.load(Ordering::Relaxed) == 0 {
            Ok(())
        } else {
            Err(error("managed backend startup cancelled"))
        }
    }
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.iter().rev() {
            // SAFETY: these are the exact actions returned by successful installs;
            // libc only reads them. No pointer is retained after sigaction returns.
            unsafe { libc::sigaction(*signal, previous, std::ptr::null_mut()) };
        }
        let signal = CANCELLED.swap(0, Ordering::Relaxed);
        if signal != 0 {
            // SAFETY: only SIGINT/SIGTERM are stored. Restore the caller's action
            // first, then redeliver: a signal racing the last check must not be
            // swallowed when startup hands control to the normal relay.
            unsafe { libc::raise(signal) };
        }
    }
}
