//! Cancellable waits on a descriptor, and the cancel token they watch.
//!
//! A [`Cancel`] is the write end of a pipe; every worker thread holds the
//! read end as a [`CancelWatch`]. Dropping the `Cancel` makes the read end
//! readable (hang-up), which wakes any thread parked in [`wait_fd`].

use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::sync::Arc;

#[derive(Debug)]
pub(crate) struct Cancel(#[allow(dead_code, reason = "held only to be dropped")] OwnedFd);

#[derive(Clone, Debug)]
pub(crate) struct CancelWatch(Arc<OwnedFd>);

pub(crate) fn cancel_pair() -> io::Result<(Cancel, CancelWatch)> {
    let (r, w) = io::pipe()?;
    Ok((Cancel(w.into()), CancelWatch(Arc::new(r.into()))))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Wait {
    /// The descriptor is ready, or in a state the next read/write reports.
    Ready,
    Cancelled,
    TimedOut,
}

/// Wait until `fd` is ready for `events` (`POLLIN`/`POLLOUT`), the cancel
/// token is dropped, or `timeout_ms` passes (negative waits forever).
pub(crate) fn wait_fd(
    fd: RawFd,
    events: libc::c_short,
    cancel: &CancelWatch,
    timeout_ms: libc::c_int,
) -> io::Result<Wait> {
    loop {
        let mut fds = [
            libc::pollfd {
                fd,
                events,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: `fds` is a valid array of two pollfd for the call.
        let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout_ms) };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if fds[1].revents != 0 {
            return Ok(Wait::Cancelled);
        }
        if n == 0 {
            return Ok(Wait::TimedOut);
        }
        if fds[0].revents & libc::POLLNVAL != 0 {
            // A platform whose poll cannot watch this device: fall back to a
            // short sleep and let the non-blocking read or write decide.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        return Ok(Wait::Ready);
    }
}

pub(crate) fn set_nonblocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        if flags == -1 || libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) == -1
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub(crate) fn set_cloexec(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// In a forked child: mark every descriptor above stderr close-on-exec so
/// descriptors other threads opened without CLOEXEC do not reach the child
/// program. std's exec-error pipe is already CLOEXEC, so marking (not
/// closing) keeps spawn error reporting intact. Async-signal-safe.
pub(crate) fn mark_inherited_fds_cloexec() {
    #[cfg(target_os = "linux")]
    {
        const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
        // SAFETY: close_range only changes descriptor flags here.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                3 as libc::c_uint,
                libc::c_uint::MAX,
                CLOSE_RANGE_CLOEXEC,
            )
        };
        if rc == 0 {
            return;
        }
    }
    // SAFETY: sysconf and fcntl are async-signal-safe.
    let max = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let max = if max <= 0 { 1024 } else { max.min(65_536) };
    for fd in 3..max as libc::c_int {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
}
