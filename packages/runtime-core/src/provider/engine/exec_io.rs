//! Deadline-bounded exec handshake I/O, restoring descriptor flags after writes.
//! macOS can reject SO_RCVTIMEO after peer closure even with bytes still queued.
//! Poll plus nonblocking I/O preserves those bytes and never reads ahead.
use std::{
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::Instant,
};

fn wait(stream: &UnixStream, deadline: Instant, events: i16) -> io::Result<()> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|value| !value.is_zero())
        .ok_or(io::ErrorKind::TimedOut)?;
    let mut fd = libc::pollfd {
        fd: stream.as_raw_fd(),
        events,
        revents: 0,
    };
    // SAFETY: one initialized poll entry, with its stream retained throughout.
    let result = unsafe { libc::poll(&mut fd, 1, remaining.as_millis().clamp(1, 100) as i32) };
    if Instant::now() >= deadline {
        return Err(io::ErrorKind::TimedOut.into());
    }
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if result == 0 {
        return Err(io::ErrorKind::WouldBlock.into());
    }
    if fd.revents & libc::POLLNVAL != 0 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    // HUP/ERR may accompany buffered output. Let recv drain it or report EOF;
    // send reports a closed peer without replaying any bytes already accepted.
    Ok(())
}

pub(super) fn read(stream: &UnixStream, bytes: &mut [u8], deadline: Instant) -> io::Result<usize> {
    wait(stream, deadline, libc::POLLIN)?;
    // SAFETY: writable slice and live socket; MSG_DONTWAIT is per-call only.
    let result = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT,
        )
    };
    count(result)
}

pub(super) fn write(stream: &UnixStream, bytes: &[u8], deadline: Instant) -> io::Result<usize> {
    wait(stream, deadline, libc::POLLOUT)?;
    // Darwin can block a large send despite MSG_DONTWAIT. Handshake callers own
    // this socket exclusively until attachment; use O_NONBLOCK for the syscall
    // and restore its exact flags before returning or handing the stream off.
    // SAFETY: the borrowed stream retains this descriptor throughout.
    let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: readable slice and live socket. Suppress SIGPIPE on peer closure.
    let result = unsafe {
        libc::send(
            stream.as_raw_fd(),
            bytes.as_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
        )
    };
    let result = count(result);
    // Capture send's errno before restoring flags, and refuse a failed restore.
    if unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_SETFL, flags) } < 0 {
        return Err(io::Error::last_os_error());
    }
    result
}

fn count(result: isize) -> io::Result<usize> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result as usize)
    }
}

pub(super) fn retry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, time::Duration};

    #[test]
    fn closed_peer_keeps_buffered_bytes_and_descriptor_flags() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) };
        peer.write_all(b"ack\noutput").unwrap();
        drop(peer);
        let deadline = Instant::now() + Duration::from_secs(1);
        for expected in b"ack\noutput" {
            let mut byte = [0];
            assert_eq!(read(&stream, &mut byte, deadline).unwrap(), 1);
            assert_eq!(byte[0], *expected);
        }
        assert_eq!(read(&stream, &mut [0], deadline).unwrap(), 0);
        assert_eq!(
            unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) },
            flags
        );
    }

    #[test]
    fn blocked_write_respects_deadline_without_changing_flags() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) };
        let deadline = Instant::now() + Duration::from_millis(50);
        loop {
            match write(&stream, &[0; 87384], deadline) {
                Ok(n) => assert!(n > 0),
                Err(error) if retry(&error) => continue,
                Err(error) => {
                    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
                    break;
                }
            }
        }
        assert!(Instant::now() < deadline + Duration::from_secs(1));
        assert_eq!(
            unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) },
            flags
        );
    }

    #[test]
    fn failed_send_restores_blocking_and_nonblocking_flags() {
        for nonblocking in [false, true] {
            let (stream, peer) = UnixStream::pair().unwrap();
            stream.set_nonblocking(nonblocking).unwrap();
            let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) };
            drop(peer);
            assert!(
                write(
                    &stream,
                    &[0; 87384],
                    Instant::now() + Duration::from_secs(1)
                )
                .is_err()
            );
            assert_eq!(
                unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) },
                flags
            );
        }
    }

    #[test]
    fn silent_peer_and_expired_write_respect_deadline() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        let deadline = Instant::now() + Duration::from_millis(20);
        loop {
            match read(&stream, &mut [0], deadline) {
                Err(error) if retry(&error) => continue,
                result => {
                    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
                    break;
                }
            }
        }
        assert_eq!(
            write(&stream, b"never sent", deadline).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(Instant::now() < deadline + Duration::from_secs(1));
    }
}
