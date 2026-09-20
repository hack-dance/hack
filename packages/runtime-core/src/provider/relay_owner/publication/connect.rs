//! One immediate nonblocking AF_UNIX connection; backlog pressure is a refusal, not
//! an unbounded connect or a background retry. RAII closes every unsuccessful socket.
use super::super::refused;
use crate::CandidateError;
use std::{
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::Path,
};
pub(super) fn immediate(path: &Path) -> Result<UnixStream, CandidateError> {
    let bytes = path.as_os_str().as_bytes();
    let mut address = libc::sockaddr_un {
        sun_len: 0,
        sun_family: libc::AF_UNIX as u8,
        sun_path: [0; 104],
    };
    if bytes.is_empty() || bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(refused());
    }
    for (to, from) in address.sun_path.iter_mut().zip(bytes) {
        *to = *from as libc::c_char;
    }
    address.sun_len = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as u8;
    // SAFETY: socket takes no pointers and returns a fresh owned FD or -1.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(refused());
    }
    // SAFETY: the newly created descriptor transfers exclusively into this RAII stream.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    // SAFETY: live owned FD; F_SETFD expects an integer argument.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(refused());
    }
    let enabled: libc::c_int = 1;
    // SAFETY: live FD and correctly sized initialized native integer option buffer.
    if unsafe {
        libc::setsockopt(
            fd,
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
    // SAFETY: initialized AF_UNIX address, length includes its terminator; connect
    // retains no pointer and the owned descriptor has already been made nonblocking.
    if unsafe {
        libc::connect(
            stream.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            address.sun_len as libc::socklen_t,
        )
    } != 0
    {
        return Err(refused());
    }
    Ok(stream)
}
