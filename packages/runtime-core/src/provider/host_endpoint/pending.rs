//! Own a nonblocking socket before the connect syscall; close on every failure.
use super::{refused, timeout};
use crate::{CandidateError, provider::relay_auth::EffectGuard};
use std::{
    net::TcpStream,
    os::fd::{AsRawFd, FromRawFd},
    time::Instant,
};

pub(super) fn connect(
    port: u16,
    deadline: Instant,
    guard: &EffectGuard,
) -> Result<TcpStream, CandidateError> {
    // SAFETY: socket takes no pointers and returns a fresh descriptor or -1.
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(refused());
    }
    // SAFETY: fd is newly created and exclusively transferred into this RAII stream.
    let stream = unsafe { TcpStream::from_raw_fd(fd) };
    // SAFETY: fd remains owned by stream; F_SETFD expects an integer argument.
    if unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(refused());
    }
    let enabled: libc::c_int = 1;
    // SAFETY: stream owns the live descriptor; enabled is a readable native int
    // with the matching option size. Raw creation bypasses std's Apple setup.
    if unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&enabled as *const libc::c_int).cast(),
            std::mem::size_of_val(&enabled) as libc::socklen_t,
        )
    } < 0
    {
        return Err(refused());
    }
    stream.set_nonblocking(true).map_err(|_| refused())?;
    let address = libc::sockaddr_in {
        sin_len: std::mem::size_of::<libc::sockaddr_in>() as u8,
        sin_family: libc::AF_INET as u8,
        sin_port: port.to_be(),
        sin_addr: libc::in_addr {
            s_addr: u32::from_ne_bytes([127, 0, 0, 1]),
        },
        sin_zero: [0; 8],
    };
    let result = guard.with_active(|| {
        if Instant::now() >= deadline {
            return Err(timeout());
        }
        // SAFETY: address is a fully initialized native IPv4 sockaddr with matching
        // length; connect borrows it only for this call. fd is live and nonblocking.
        let status = unsafe {
            libc::connect(
                stream.as_raw_fd(),
                (&address as *const libc::sockaddr_in).cast(),
                std::mem::size_of_val(&address) as libc::socklen_t,
            )
        };
        if status == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINPROGRESS | libc::EALREADY | libc::EINTR) => Ok(()),
            _ => Err(refused()),
        }
    })?;
    result?;
    Ok(stream)
}
