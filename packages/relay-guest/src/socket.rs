//! Owned Unix stream checks and bounded connection to a fixed guest slot.
use crate::CandidateError;
use std::{
    io, mem,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    time::{Duration, Instant},
};
fn refused() -> CandidateError {
    CandidateError::new(
        "relay_guest_socket",
        "Guest socket ownership or connection refused.",
    )
}
fn flags(fd: i32) -> Result<(), CandidateError> {
    // SAFETY: fcntl operates on a live descriptor owned by the caller.
    let status = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if status < 0
        || unsafe { libc::fcntl(fd, libc::F_SETFL, status | libc::O_NONBLOCK) } < 0
        || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
    {
        return Err(refused());
    }
    Ok(())
}
fn option(fd: i32, name: i32) -> Result<i32, CandidateError> {
    let mut value: libc::c_int = 0;
    let mut length = mem::size_of_val(&value) as libc::socklen_t;
    // SAFETY: value and length point to initialized writable storage.
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            name,
            (&mut value as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
        || length as usize != mem::size_of_val(&value)
    {
        return Err(refused());
    }
    Ok(value)
}
fn connected(fd: i32) -> Result<(), CandidateError> {
    if option(fd, libc::SO_TYPE)? != libc::SOCK_STREAM || option(fd, libc::SO_ACCEPTCONN)? != 0 {
        return Err(refused());
    }
    // SAFETY: sockaddr_storage is plain C data and getsockname/getpeername initialize it.
    let mut address: libc::sockaddr_storage = unsafe { mem::zeroed() };
    let mut length = mem::size_of_val(&address) as libc::socklen_t;
    if unsafe {
        libc::getsockname(
            fd,
            (&mut address as *mut libc::sockaddr_storage).cast(),
            &mut length,
        )
    } != 0
        || i32::from(address.ss_family) != libc::AF_UNIX
    {
        return Err(refused());
    }
    length = mem::size_of_val(&address) as libc::socklen_t;
    if unsafe {
        libc::getpeername(
            fd,
            (&mut address as *mut libc::sockaddr_storage).cast(),
            &mut length,
        )
    } != 0
        || i32::from(address.ss_family) != libc::AF_UNIX
    {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn application(fd: OwnedFd) -> Result<UnixStream, CandidateError> {
    connected(fd.as_raw_fd())?;
    // Do not accept a duplicate of the credential channel as the application side.
    // SAFETY: libc::stat is plain C metadata; fstat initializes these output buffers.
    let mut application: libc::stat = unsafe { mem::zeroed() };
    // SAFETY: zero is a valid initial representation for this fstat output buffer.
    let mut input: libc::stat = unsafe { mem::zeroed() };
    // SAFETY: both stat structures are valid writable storage; only metadata is read.
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut application) } != 0
        || unsafe { libc::fstat(0, &mut input) } != 0
        || (application.st_dev, application.st_ino) == (input.st_dev, input.st_ino)
    {
        return Err(refused());
    }
    flags(fd.as_raw_fd())?;
    Ok(UnixStream::from(fd))
}
pub(super) fn connect(slot: u8, budget: Duration) -> Result<UnixStream, CandidateError> {
    let deadline = Instant::now() + budget;
    let path = format!("/run/hack-dependencies/dependency-{slot:02}.sock");
    // SAFETY: socket takes only value arguments and returns a new owned FD.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(refused());
    }
    // SAFETY: raw is a newly created unique descriptor, adopted exactly once.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    flags(raw)?;
    // SAFETY: zero initializes the address and terminates the bounded copied path.
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    if path.len() >= address.sun_path.len() {
        return Err(refused());
    }
    for (target, value) in address.sun_path.iter_mut().zip(path.bytes()) {
        *target = value as libc::c_char;
    }
    #[cfg(target_os = "macos")]
    {
        address.sun_len = mem::size_of_val(&address) as u8;
    }
    // SAFETY: address is initialized for the supplied length and remains live.
    let result = unsafe {
        libc::connect(
            raw,
            (&address as *const libc::sockaddr_un).cast(),
            mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error().raw_os_error();
        // AF_UNIX EAGAIN is a full backlog, not a pending connection. Refuse
        // immediately rather than mistaking writable readiness for completion.
        if error != Some(libc::EINPROGRESS) {
            return Err(refused());
        }
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(refused)?;
            let mut poll = libc::pollfd {
                fd: raw,
                events: libc::POLLOUT,
                revents: 0,
            };
            // SAFETY: one initialized pollfd remains writable for this call.
            let ready =
                unsafe { libc::poll(&mut poll, 1, remaining.as_millis().clamp(1, 5000) as i32) };
            if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if ready <= 0 || Instant::now() >= deadline || option(raw, libc::SO_ERROR)? != 0 {
                return Err(refused());
            }
            break;
        }
    }
    connected(raw)?;
    Ok(UnixStream::from(fd))
}
