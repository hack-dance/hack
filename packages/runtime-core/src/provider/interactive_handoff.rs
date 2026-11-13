//! One descriptor on the already authenticated owner connection. The receiver
//! must validate the following bound reply before using the returned stream.
use crate::CandidateError;
use std::{
    io,
    mem::{size_of, zeroed},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::net::UnixStream,
    time::Instant,
};

fn refused() -> CandidateError {
    CandidateError::new(
        "session_cleanup_uncertain",
        "Interactive session handoff was not confirmed; its durable receipt was retained. No start was replayed.",
    )
}

fn wait(stream: &UnixStream, events: i16, deadline: Instant) -> Result<(), CandidateError> {
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let mut fd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        // SAFETY: fd is one initialized poll entry, retained for this call.
        let count = unsafe { libc::poll(&mut fd, 1, left.as_millis().clamp(1, 1000) as i32) };
        if count < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if count < 0 {
            return Err(refused());
        }
        if count > 0 {
            if fd.revents & libc::POLLNVAL != 0 {
                return Err(refused());
            }
            return Ok(());
        }
    }
}

/// Consumes the sender's copy on *every* outcome. There is never a retry after
/// successful sendmsg; a lost reply is an uncertain session, not a new admission.
pub(super) fn send(
    control: &UnixStream,
    session: Option<UnixStream>,
    deadline: Instant,
) -> Result<(), CandidateError> {
    let mut tag = u8::from(session.is_some());
    let mut iov = libc::iovec {
        iov_base: (&mut tag as *mut u8).cast(),
        iov_len: 1,
    };
    // usize storage provides cmsghdr alignment on both supported platforms.
    let mut ancillary = [0usize; 16];
    // SAFETY: msghdr contains integer/pointer fields with valid zero values.
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    if let Some(session) = &session {
        message.msg_control = ancillary.as_mut_ptr().cast();
        // SAFETY: control storage exceeds CMSG_SPACE for one int; FIRSTHDR and
        // DATA point within it. write_unaligned avoids relying on data alignment.
        unsafe {
            message.msg_controllen = libc::CMSG_SPACE(size_of::<i32>() as u32) as _;
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(size_of::<i32>() as u32) as _;
            libc::CMSG_DATA(header)
                .cast::<i32>()
                .write_unaligned(session.as_raw_fd());
        }
    }
    loop {
        wait(control, libc::POLLOUT, deadline)?;
        // SAFETY: all buffers live through sendmsg; the kernel copies the fd,
        // which remains owned by session until this function returns.
        let count = unsafe {
            libc::sendmsg(
                control.as_raw_fd(),
                &message,
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        };
        if count == 1 {
            return Ok(());
        }
        if count < 0
            && matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            )
        {
            continue;
        }
        return Err(refused());
    }
}

/// Received descriptors are owned immediately, including on truncated/invalid
/// messages. No descriptor is exposed until its count, type and CLOEXEC are valid.
pub(super) fn receive(
    control: &UnixStream,
    deadline: Instant,
) -> Result<Option<UnixStream>, CandidateError> {
    loop {
        wait(control, libc::POLLIN, deadline)?;
        let mut tag = 255u8;
        let mut iov = libc::iovec {
            iov_base: (&mut tag as *mut u8).cast(),
            iov_len: 1,
        };
        let mut ancillary = [0usize; 64];
        // SAFETY: zero is a valid initial value for all msghdr fields.
        let mut message: libc::msghdr = unsafe { zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = ancillary.as_mut_ptr().cast();
        message.msg_controllen = size_of_val(&ancillary) as _;
        // SAFETY: the initialized header describes writable local buffers of
        // their exact sizes. UnixStream retains the live control descriptor.
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC;
        #[cfg(not(target_os = "linux"))]
        let flags = libc::MSG_DONTWAIT;
        let count = unsafe { libc::recvmsg(control.as_raw_fd(), &mut message, flags) };
        if count < 0
            && matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            )
        {
            continue;
        }
        if count < 0 {
            return Err(refused());
        }
        let mut descriptors = Vec::new();
        let mut invalid = false;
        // SAFETY: the kernel populated these headers within msg_controllen.
        // Every SCM_RIGHTS integer transfers ownership once, even on refusal.
        unsafe {
            let mut header = libc::CMSG_FIRSTHDR(&message);
            while !header.is_null() {
                let length = (*header).cmsg_len as usize;
                let base = libc::CMSG_LEN(0) as usize;
                if length < base {
                    invalid = true;
                    break;
                }
                if (*header).cmsg_level == libc::SOL_SOCKET
                    && (*header).cmsg_type == libc::SCM_RIGHTS
                {
                    invalid |= (length - base) % size_of::<i32>() != 0;
                    for index in 0..(length - base) / size_of::<i32>() {
                        let fd = libc::CMSG_DATA(header)
                            .cast::<i32>()
                            .add(index)
                            .read_unaligned();
                        descriptors.push(OwnedFd::from_raw_fd(fd));
                    }
                } else {
                    invalid = true;
                }
                header = libc::CMSG_NXTHDR(&message, header);
            }
        }
        for fd in &descriptors {
            // SAFETY: OwnedFd keeps this descriptor alive; macOS requires an
            // explicit CLOEXEC since it lacks MSG_CMSG_CLOEXEC.
            if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err(refused());
            }
        }
        if count != 1 || invalid || message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
            return Err(refused());
        }
        match (tag, descriptors.len()) {
            (0, 0) => return Ok(None),
            (1, 1) => {
                let socket = UnixStream::from(descriptors.pop().ok_or_else(refused)?);
                // getsockname/getpeername reject files and non-Unix descriptors.
                socket.local_addr().map_err(|_| refused())?;
                socket.peer_addr().map_err(|_| refused())?;
                let mut kind: libc::c_int = 0;
                let mut length = size_of::<libc::c_int>() as libc::socklen_t;
                // SAFETY: socket owns the fd and both output buffers have the
                // exact writable sizes supplied to getsockopt.
                if unsafe {
                    libc::getsockopt(
                        socket.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_TYPE,
                        (&mut kind as *mut libc::c_int).cast(),
                        &mut length,
                    )
                } != 0
                    || kind != libc::SOCK_STREAM
                    || length as usize != size_of::<libc::c_int>()
                {
                    return Err(refused());
                }
                return Ok(Some(socket));
            }
            _ => return Err(refused()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        time::Duration,
    };

    #[test]
    fn handoff_preserves_early_output_and_drops_sender_copy() {
        let (sender, receiver) = UnixStream::pair().unwrap();
        let (session, mut engine) = UnixStream::pair().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        engine.write_all(b"first output with upgrade").unwrap();
        send(&sender, Some(session), deadline).unwrap();
        let mut attached = receive(&receiver, deadline).unwrap().unwrap();
        assert_ne!(
            unsafe { libc::fcntl(attached.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        let mut early = [0; 25];
        attached.read_exact(&mut early).unwrap();
        assert_eq!(&early, b"first output with upgrade");
        drop(attached);
        engine
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        assert_eq!(engine.read(&mut [0]).unwrap(), 0);
    }

    #[test]
    fn absent_descriptor_and_disconnect_are_distinct() {
        let (sender, receiver) = UnixStream::pair().unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        send(&sender, None, deadline).unwrap();
        assert!(receive(&receiver, deadline).unwrap().is_none());
        drop(receiver);
        let (session, mut engine) = UnixStream::pair().unwrap();
        assert_eq!(
            send(&sender, Some(session), deadline).unwrap_err().code,
            "session_cleanup_uncertain"
        );
        engine
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(engine.read(&mut [0]).unwrap(), 0);
    }

    #[test]
    fn invalid_tag_and_missing_descriptor_refuse() {
        for tag in [1, 2, 255] {
            let (mut sender, receiver) = UnixStream::pair().unwrap();
            sender.write_all(&[tag]).unwrap();
            assert!(receive(&receiver, Instant::now() + Duration::from_secs(1)).is_err());
        }
    }
    #[test]
    fn multiple_and_truncated_rights_close_every_received_copy() {
        for count in [2usize, 200] {
            let (sender, receiver) = UnixStream::pair().unwrap();
            let (session, mut engine) = UnixStream::pair().unwrap();
            let mut tag = 1u8;
            let mut iov = libc::iovec {
                iov_base: (&mut tag as *mut u8).cast(),
                iov_len: 1,
            };
            let mut ancillary = [0usize; 256];
            // SAFETY: fully sized, aligned ancillary storage; every payload int
            // borrows session's live descriptor and sendmsg duplicates it.
            unsafe {
                let mut message: libc::msghdr = zeroed();
                message.msg_iov = &mut iov;
                message.msg_iovlen = 1;
                message.msg_control = ancillary.as_mut_ptr().cast();
                message.msg_controllen = libc::CMSG_SPACE((count * size_of::<i32>()) as u32) as _;
                let header = libc::CMSG_FIRSTHDR(&message);
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN((count * size_of::<i32>()) as u32) as _;
                for index in 0..count {
                    libc::CMSG_DATA(header)
                        .cast::<i32>()
                        .add(index)
                        .write_unaligned(session.as_raw_fd());
                }
                assert_eq!(
                    libc::sendmsg(sender.as_raw_fd(), &message, libc::MSG_NOSIGNAL),
                    1
                );
            }
            drop(session);
            assert_eq!(
                receive(&receiver, Instant::now() + Duration::from_secs(1))
                    .unwrap_err()
                    .code,
                "session_cleanup_uncertain"
            );
            engine
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            assert_eq!(
                engine.read(&mut [0]).unwrap(),
                0,
                "all received rights must close"
            );
        }
    }
    #[test]
    fn datagram_is_not_an_engine_stream() {
        let (sender, receiver) = UnixStream::pair().unwrap();
        let (datagram, _peer) = std::os::unix::net::UnixDatagram::pair().unwrap();
        let fd: OwnedFd = datagram.into();
        let deadline = Instant::now() + Duration::from_secs(1);
        send(&sender, Some(UnixStream::from(fd)), deadline).unwrap();
        assert!(receive(&receiver, deadline).is_err());
    }
}
