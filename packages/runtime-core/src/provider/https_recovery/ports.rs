//! MacOS wildcard and loopback claims held across HTTPS recovery effects.
use super::{CandidateError, refused};
pub(super) fn port_absent(port: u16) -> Result<Vec<std::os::fd::OwnedFd>, CandidateError> {
    let mut guards = Vec::from(bind_pair(port, true)?);
    // macOS permits a later SO_REUSEADDR loopback bind beside a wildcard listener.
    // Reserve the actual local HTTPS path too; neither guard enables SO_REUSEPORT.
    guards.extend(bind_pair(port, false)?);
    Ok(guards)
}
fn bind_pair(port: u16, wildcard: bool) -> Result<[std::os::fd::OwnedFd; 2], CandidateError> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let make = |family| {
        // SAFETY: socket takes scalar constants; a successful new descriptor is uniquely owned below.
        let fd = unsafe { libc::socket(family, libc::SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(refused());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: fd is owned; fcntl uses only scalar arguments and does not retain pointers.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(refused());
        }
        Ok(fd)
    };
    let v4 = make(libc::AF_INET)?;
    let v6 = make(libc::AF_INET6)?;
    let only: libc::c_int = 1;
    // SAFETY: only points to one live integer of the declared size. No address reuse is enabled.
    if unsafe {
        libc::setsockopt(
            v6.as_raw_fd(),
            libc::IPPROTO_IPV6,
            libc::IPV6_V6ONLY,
            (&only as *const libc::c_int).cast(),
            std::mem::size_of_val(&only) as libc::socklen_t,
        )
    } != 0
    {
        return Err(refused());
    }
    if !wildcard {
        for fd in [&v4, &v6] {
            // SAFETY: only is a live integer; this permits our specific loopback guard beside the wildcard guard.
            // SO_REUSEPORT is never enabled, so another listener cannot share this exact address.
            if unsafe {
                libc::setsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_REUSEADDR,
                    (&only as *const libc::c_int).cast(),
                    std::mem::size_of_val(&only) as libc::socklen_t,
                )
            } != 0
            {
                return Err(refused());
            }
        }
    }
    let mut address4: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address4.sin_family = libc::AF_INET as _;
    address4.sin_port = port.to_be();
    let mut address6: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
    address6.sin6_family = libc::AF_INET6 as _;
    address6.sin6_port = port.to_be();
    if !wildcard {
        address4.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
        address6.sin6_addr.s6_addr[15] = 1;
    }
    #[cfg(target_os = "macos")]
    {
        address4.sin_len = std::mem::size_of_val(&address4) as u8;
        address6.sin6_len = std::mem::size_of_val(&address6) as u8;
    }
    // SAFETY: both zero-initialized wildcard addresses have the matching family and live sized storage.
    if unsafe {
        libc::bind(
            v4.as_raw_fd(),
            (&address4 as *const libc::sockaddr_in).cast(),
            std::mem::size_of_val(&address4) as libc::socklen_t,
        )
    } != 0
        || unsafe {
            libc::bind(
                v6.as_raw_fd(),
                (&address6 as *const libc::sockaddr_in6).cast(),
                std::mem::size_of_val(&address6) as libc::socklen_t,
            )
        } != 0
    {
        return Err(refused());
    }
    // SAFETY: both descriptors are owned bound TCP sockets; listen retains the exact address claim.
    for fd in [&v4, &v6] {
        if unsafe { libc::listen(fd.as_raw_fd(), 1) } != 0 {
            return Err(refused());
        }
    }
    // Retain these listeners across archival; never accept a connection.
    Ok([v4, v6])
}
