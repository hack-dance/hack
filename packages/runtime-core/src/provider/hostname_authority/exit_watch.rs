//! Observe native exit without sending a PID signal.
use super::super::identity;
#[cfg(target_os = "macos")]
use super::super::state;
use crate::CandidateError;
#[cfg(target_os = "macos")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(target_os = "macos")]
pub(super) struct ExitWatch {
    fd: OwnedFd,
    pid: i32,
}
#[cfg(target_os = "macos")]
impl ExitWatch {
    pub(super) fn new(process: &identity::ProcessIdentity) -> Result<Self, CandidateError> {
        let raw = unsafe { libc::kqueue() };
        if raw < 0 {
            return Err(state::io(std::io::Error::last_os_error()));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(super::error());
        }
        let change = libc::kevent {
            ident: process.pid as usize,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        if unsafe {
            libc::kevent(
                fd.as_raw_fd(),
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(super::error());
        }
        identity::verify(
            process,
            &identity::observe(process.pid)?,
            &process.executable,
            unsafe { libc::geteuid() },
        )?;
        Ok(Self {
            fd,
            pid: process.pid,
        })
    }
    pub(super) fn wait(self) -> Result<(), CandidateError> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .ok_or_else(super::error)?;
            let timeout = libc::timespec {
                tv_sec: remaining.as_secs() as _,
                tv_nsec: remaining.subsec_nanos() as _,
            };
            let mut event = std::mem::MaybeUninit::<libc::kevent>::zeroed();
            let count = unsafe {
                libc::kevent(
                    self.fd.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    event.as_mut_ptr(),
                    1,
                    &timeout,
                )
            };
            if count < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            if count != 1 {
                return Err(super::error());
            }
            let event = unsafe { event.assume_init() };
            if event.ident != self.pid as usize
                || event.filter != libc::EVFILT_PROC
                || event.flags & libc::EV_ERROR != 0
                || event.fflags & libc::NOTE_EXIT == 0
            {
                return Err(super::error());
            }
            return Ok(());
        }
    }
}
#[cfg(not(target_os = "macos"))]
pub(super) struct ExitWatch;
#[cfg(not(target_os = "macos"))]
impl ExitWatch {
    pub(super) fn new(_: &identity::ProcessIdentity) -> Result<Self, CandidateError> {
        Err(super::error())
    }
    pub(super) fn wait(self) -> Result<(), CandidateError> {
        Err(super::error())
    }
}
