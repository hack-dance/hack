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

/// Decode only complete descriptor integers inside the copied control bytes.
/// Darwin copyout_control truncates the bytes but preserves the original
/// cmsg_len; trusting that length would adopt unrelated stack integers as fds.
/// This parser creates no descriptor ownership, so malformed lengths can be
/// tested without closing any process resources.
fn copied_rights(bytes: &[u8], copied: usize) -> (Vec<i32>, bool) {
    let mut invalid = copied > bytes.len();
    let bytes = &bytes[..copied.min(bytes.len())];
    let base = unsafe { libc::CMSG_LEN(0) } as usize;
    let mut offset = 0;
    let mut descriptors = Vec::new();
    while offset < bytes.len() {
        if bytes.len() - offset < size_of::<libc::cmsghdr>() {
            invalid = true;
            break;
        }
        // SAFETY: a whole cmsghdr fits in this initialized byte slice; its
        // fields are integers, and read_unaligned accepts arbitrary alignment.
        let header = unsafe {
            bytes
                .as_ptr()
                .add(offset)
                .cast::<libc::cmsghdr>()
                .read_unaligned()
        };
        // cmsg_len is usize on Linux and u32 on Darwin.
        #[allow(clippy::unnecessary_cast)]
        let length = header.cmsg_len as usize;
        if length < base || bytes.len() - offset < base {
            invalid = true;
            break;
        }
        let available = length.min(bytes.len() - offset);
        invalid |= length > available;
        if header.cmsg_level == libc::SOL_SOCKET && header.cmsg_type == libc::SCM_RIGHTS {
            invalid |= (length - base) % size_of::<i32>() != 0
                || (available - base) % size_of::<i32>() != 0;
            for chunk in bytes[offset + base..offset + available].chunks_exact(size_of::<i32>()) {
                let fd = i32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                if fd < 0 || descriptors.contains(&fd) {
                    invalid = true;
                } else {
                    descriptors.push(fd);
                }
            }
        } else {
            invalid = true;
        }
        if length > available {
            break;
        }
        // Header and payload are bounded by the small receive buffer. Advance
        // by the platform's padding, never by an unbounded claimed length.
        let space = unsafe { libc::CMSG_SPACE((length - base) as u32) } as usize;
        if space >= bytes.len() - offset {
            break;
        }
        offset += space;
    }
    (descriptors, invalid)
}

/// Received descriptors are owned immediately, including on truncated/invalid
/// messages. No descriptor is exposed until its count, type and CLOEXEC are valid.
/// Darwin may install additional rights that it does not copy out on truncation.
/// Their numbers are unknowable: refuse without guessing or replay, and let the
/// short-lived receiving CLI process release them when it exits.
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
        // SAFETY: ancillary is initialized storage of this exact byte size;
        // the parser borrows it and never reads beyond the returned length.
        let bytes = unsafe {
            std::slice::from_raw_parts(ancillary.as_ptr().cast::<u8>(), size_of_val(&ancillary))
        };
        let (raw, invalid) = copied_rights(bytes, message.msg_controllen as usize);
        // SAFETY: only complete SCM_RIGHTS integers copied by this recvmsg are
        // returned, each once. Each such descriptor transfers ownership to us.
        let mut descriptors: Vec<OwnedFd> = raw
            .into_iter()
            .map(|fd| unsafe { OwnedFd::from_raw_fd(fd) })
            .collect();
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
        engine
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
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
        engine
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(
            send(&sender, Some(session), deadline).unwrap_err().code,
            "session_cleanup_uncertain"
        );
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
            engine
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "provider::interactive_handoff::tests::truncated_rights_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("HACK_HANDOFF_TEST_CHILD", "1")
                .stdin(std::process::Stdio::from(OwnedFd::from(receiver)))
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = command.spawn().unwrap();
            drop(command);
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
            let deadline = Instant::now() + Duration::from_secs(10);
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("isolated handoff receiver exceeded its deadline");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                engine.read(&mut [0]).unwrap(),
                0,
                "all received rights must close"
            );
        }
    }
    #[test]
    #[ignore = "isolated receiver launched by multiple_and_truncated_rights_close_every_received_copy"]
    fn truncated_rights_child() {
        if std::env::var("HACK_HANDOFF_TEST_CHILD").as_deref() != Ok("1") {
            return;
        }
        // SAFETY: the parent installed the control socket as this process's
        // stdin through Stdio. No other Rust object owns fd 0 in this child.
        let receiver = unsafe { UnixStream::from_raw_fd(0) };
        let (mut sentinel, mut peer) = UnixStream::pair().unwrap();
        let protected = [0, 1, 2, sentinel.as_raw_fd(), peer.as_raw_fd()];
        let before = protected.map(|fd| unsafe { libc::fcntl(fd, libc::F_GETFD) });
        assert!(before.iter().all(|flags| *flags >= 0));
        assert_eq!(
            receive(&receiver, Instant::now() + Duration::from_secs(2))
                .unwrap_err()
                .code,
            "session_cleanup_uncertain"
        );
        let after = protected.map(|fd| unsafe { libc::fcntl(fd, libc::F_GETFD) });
        assert_eq!(
            after, before,
            "refusal must not close unrelated descriptors"
        );
        sentinel.write_all(b"alive").unwrap();
        let mut value = [0; 5];
        peer.read_exact(&mut value).unwrap();
        assert_eq!(&value, b"alive");
        // macOS may have installed uncopied rights. This isolated process
        // exits to close them; the parent requires EOF after that exit.
    }

    fn control_bytes(fds: &[i32], claimed: usize) -> Vec<u8> {
        let mut bytes = vec![0; 512];
        // SAFETY: storage fits this header and the supplied test descriptors;
        // unaligned accesses do not assume Vec<u8> has cmsghdr alignment.
        unsafe {
            let mut header: libc::cmsghdr = zeroed();
            header.cmsg_level = libc::SOL_SOCKET;
            header.cmsg_type = libc::SCM_RIGHTS;
            header.cmsg_len = libc::CMSG_LEN((claimed * size_of::<i32>()) as u32) as _;
            bytes
                .as_mut_ptr()
                .cast::<libc::cmsghdr>()
                .write_unaligned(header);
            let base = libc::CMSG_LEN(0) as usize;
            for (index, fd) in fds.iter().enumerate() {
                bytes
                    .as_mut_ptr()
                    .add(base + index * size_of::<i32>())
                    .cast::<i32>()
                    .write_unaligned(*fd);
            }
        }
        bytes
    }

    #[test]
    fn claimed_control_length_cannot_adopt_uncopied_zero_padding() {
        let bytes = control_bytes(&[41], 200);
        let copied = unsafe { libc::CMSG_LEN(size_of::<i32>() as u32) } as usize;
        assert_eq!(copied_rights(&bytes, copied), (vec![41], true));
        let mut shorter = bytes[..copied].to_vec();
        shorter.extend_from_slice(&[0, 0]);
        assert_eq!(copied_rights(&shorter, shorter.len()), (vec![41], true));
        assert_eq!(
            copied_rights(&bytes, size_of::<libc::cmsghdr>() - 1),
            (vec![], true)
        );
        assert_eq!(
            copied_rights(&bytes[..copied], usize::MAX),
            (vec![41], true)
        );
    }

    #[test]
    fn complete_control_returns_each_received_integer_once() {
        let bytes = control_bytes(&[41, 42], 2);
        let copied = unsafe { libc::CMSG_LEN(2 * size_of::<i32>() as u32) } as usize;
        assert_eq!(copied_rights(&bytes, copied), (vec![41, 42], false));
        assert_eq!(
            copied_rights(&control_bytes(&[41, 41], 2), copied),
            (vec![41], true)
        );
        assert_eq!(
            copied_rights(&control_bytes(&[-1, 42], 2), copied),
            (vec![42], true)
        );
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
