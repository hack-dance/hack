//! Length-prefixed JSON frames: a u32 big-endian length, then that many bytes.
//!
//! A reader waits for the first header byte up to the caller's idle bound, then
//! must receive the rest of the frame within [`FRAME_DEADLINE`]. A writer must
//! send the whole frame within the same bound. Each bound is one monotonic
//! deadline: retries after a signal and partial transfers never extend it, and a
//! transfer that completes after it is refused. A length of zero or over the cap
//! is refused before any body byte is read, so a hostile peer cannot make the
//! reader allocate or wait for an oversized body.
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

/// Cap for control frames (spec 4.2). Frames that carry private input arrive in a
/// later slice with their own, larger cap.
pub const CONTROL_FRAME_LIMIT: usize = 128 * 1024;
/// Time for the rest of a frame once its first byte arrived, and for a whole write.
pub const FRAME_DEADLINE: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed before sending any byte of a frame.
    Closed,
    /// No frame began within the idle bound.
    Idle,
    /// The length is zero, above the cap or above `u32::MAX`; no body byte was
    /// read or written.
    TooLarge(usize),
    /// The peer closed or stalled in the middle of a frame, or the frame did not
    /// finish within its deadline.
    Truncated,
    Io(ErrorKind),
}

/// Read one frame. `idle` bounds the wait for its first byte; zero means "only
/// if a byte is already available".
pub fn read(stream: &mut UnixStream, idle: Duration, limit: usize) -> Result<Vec<u8>, FrameError> {
    read_within(stream, idle, limit, FRAME_DEADLINE)
}

/// Write one frame within [`FRAME_DEADLINE`].
pub fn write(stream: &mut UnixStream, bytes: &[u8], limit: usize) -> Result<(), FrameError> {
    write_within(stream, bytes, limit, FRAME_DEADLINE)
}

fn io(error: std::io::Error) -> FrameError {
    FrameError::Io(error.kind())
}

fn timed_out(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

fn read_within(
    stream: &mut UnixStream,
    idle: Duration,
    limit: usize,
    frame: Duration,
) -> Result<Vec<u8>, FrameError> {
    let mut header = [0u8; 4];
    first_byte(stream, &mut header[..1], Instant::now() + idle)?;
    let deadline = Instant::now() + frame;
    read_exact_by(stream, &mut header[1..], deadline)?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > limit {
        return Err(FrameError::TooLarge(size));
    }
    let mut body = vec![0u8; size];
    read_exact_by(stream, &mut body, deadline)?;
    Ok(body)
}

fn first_byte(
    stream: &mut UnixStream,
    byte: &mut [u8],
    deadline: Instant,
) -> Result<(), FrameError> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let outcome = if left.is_zero() {
            // No time left (or none given): take a byte only if one is waiting.
            stream.set_nonblocking(true).map_err(io)?;
            let outcome = stream.read(byte);
            stream.set_nonblocking(false).map_err(io)?;
            outcome
        } else {
            stream.set_read_timeout(Some(left)).map_err(io)?;
            stream.read(byte)
        };
        match outcome {
            Ok(0) => return Err(FrameError::Closed),
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if timed_out(e.kind()) => {
                if Instant::now() >= deadline {
                    return Err(FrameError::Idle);
                }
            }
            Err(e) => return Err(io(e)),
        }
    }
}

fn read_exact_by(
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), FrameError> {
    while !bytes.is_empty() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(FrameError::Truncated);
        }
        stream.set_read_timeout(Some(left)).map_err(io)?;
        match stream.read(bytes) {
            Ok(0) => return Err(FrameError::Truncated),
            Ok(count) => bytes = &mut bytes[count..],
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if timed_out(e.kind()) => return Err(FrameError::Truncated),
            Err(e) => return Err(io(e)),
        }
        // Bytes that arrive after the deadline do not complete the frame.
        if Instant::now() > deadline {
            return Err(FrameError::Truncated);
        }
    }
    Ok(())
}

fn write_within(
    stream: &mut UnixStream,
    bytes: &[u8],
    limit: usize,
    frame: Duration,
) -> Result<(), FrameError> {
    let length = frame_length(bytes.len(), limit)?;
    let deadline = Instant::now() + frame;
    // A blocking write to a Unix socket can keep going past SO_SNDTIMEO while the
    // peer drains slowly (measured on Linux). Write without blocking and wait for
    // room with poll, so the deadline bounds the whole frame.
    stream.set_nonblocking(true).map_err(io)?;
    let outcome = write_nonblocking(stream, &length.to_be_bytes(), bytes, deadline);
    let restored = stream.set_nonblocking(false).map_err(io);
    outcome.and(restored)
}

fn write_nonblocking(
    stream: &mut UnixStream,
    header: &[u8],
    body: &[u8],
    deadline: Instant,
) -> Result<(), FrameError> {
    for mut part in [header, body] {
        while !part.is_empty() {
            match stream.write(part) {
                Ok(0) => return Err(FrameError::Truncated),
                Ok(count) => part = &part[count..],
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) if e.kind() == ErrorKind::WouldBlock => wait_writable(stream, deadline)?,
                Err(e) => return Err(io(e)),
            }
            if Instant::now() > deadline {
                return Err(FrameError::Truncated);
            }
        }
    }
    Ok(())
}

/// Wait until the socket accepts more bytes, at most until `deadline`.
fn wait_writable(stream: &UnixStream, deadline: Instant) -> Result<(), FrameError> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(FrameError::Truncated);
        }
        let mut fd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        let millis = left.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: one initialized pollfd that outlives the call.
        match unsafe { libc::poll(&mut fd, 1, millis) } {
            n if n > 0 => return Ok(()),
            0 => {}
            _ => {
                let e = std::io::Error::last_os_error();
                if e.kind() != ErrorKind::Interrupted {
                    return Err(io(e));
                }
            }
        }
    }
}

/// The wire length of a body: nonzero, within `limit`, and representable as u32.
fn frame_length(len: usize, limit: usize) -> Result<u32, FrameError> {
    match u32::try_from(len) {
        Ok(length) if length > 0 && len <= limit => Ok(length),
        _ => Err(FrameError::TooLarge(len)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    fn pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    #[test]
    fn a_frame_round_trips() {
        let (mut a, mut b) = pair();
        write(&mut a, b"{\"v\":1}", CONTROL_FRAME_LIMIT).unwrap();
        let body = read(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT).unwrap();
        assert_eq!(body, b"{\"v\":1}");
    }

    #[test]
    fn an_oversized_or_empty_length_is_refused_before_the_body() {
        for size in [0u32, (CONTROL_FRAME_LIMIT + 1) as u32, u32::MAX] {
            let (mut a, mut b) = pair();
            a.write_all(&size.to_be_bytes()).unwrap();
            assert_eq!(
                read(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT),
                Err(FrameError::TooLarge(size as usize))
            );
        }
        let (mut a, _b) = pair();
        let big = vec![b'x'; CONTROL_FRAME_LIMIT + 1];
        assert!(matches!(
            write(&mut a, &big, CONTROL_FRAME_LIMIT),
            Err(FrameError::TooLarge(_))
        ));
        assert_eq!(
            write(&mut a, b"", CONTROL_FRAME_LIMIT),
            Err(FrameError::TooLarge(0))
        );
    }

    #[test]
    fn a_length_the_prefix_cannot_carry_is_refused_even_under_a_larger_limit() {
        // Checked before anything is allocated or written; no multi-gigabyte body.
        let len = u32::MAX as usize + 1;
        assert_eq!(
            frame_length(len, usize::MAX),
            Err(FrameError::TooLarge(len))
        );
        assert_eq!(frame_length(u32::MAX as usize, usize::MAX), Ok(u32::MAX));
        assert_eq!(frame_length(0, usize::MAX), Err(FrameError::TooLarge(0)));
        assert_eq!(frame_length(11, 10), Err(FrameError::TooLarge(11)));
    }

    #[test]
    fn a_truncated_frame_or_header_is_refused() {
        let (mut a, mut b) = pair();
        a.write_all(&10u32.to_be_bytes()).unwrap();
        a.write_all(b"abc").unwrap();
        drop(a);
        assert_eq!(
            read(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT),
            Err(FrameError::Truncated)
        );
        let (mut a, mut b) = pair();
        a.write_all(&[0, 0]).unwrap();
        drop(a);
        assert_eq!(
            read(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT),
            Err(FrameError::Truncated)
        );
    }

    #[test]
    fn a_peer_that_stalls_mid_frame_with_the_socket_open_is_cut_off_at_the_deadline() {
        let (mut a, mut b) = pair();
        a.write_all(&10u32.to_be_bytes()).unwrap();
        a.write_all(b"abc").unwrap();
        let started = Instant::now();
        let frame = Duration::from_millis(150);
        assert_eq!(
            read_within(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT, frame),
            Err(FrameError::Truncated)
        );
        let took = started.elapsed();
        assert!(took >= frame && took < frame * 4, "{took:?}");
        drop(a);
    }

    #[test]
    fn a_slow_trickle_cannot_stretch_the_read_deadline() {
        let (mut a, mut b) = pair();
        a.write_all(&64u32.to_be_bytes()).unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..64 {
                if a.write_all(b"x").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let started = Instant::now();
        let frame = Duration::from_millis(200);
        assert_eq!(
            read_within(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT, frame),
            Err(FrameError::Truncated)
        );
        assert!(started.elapsed() < frame * 3, "{:?}", started.elapsed());
        drop(b);
        writer.join().unwrap();
    }

    #[test]
    fn partial_writes_under_backpressure_cannot_stretch_the_write_deadline() {
        let (mut a, b) = pair();
        let small: libc::c_int = 4096;
        // SAFETY: valid socket descriptors and a correctly sized option value.
        unsafe {
            for (fd, option) in [
                (a.as_raw_fd(), libc::SO_SNDBUF),
                (b.as_raw_fd(), libc::SO_RCVBUF),
            ] {
                libc::setsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    option,
                    (&small as *const libc::c_int).cast(),
                    std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                );
            }
        }
        // The reader drains a little at a time: every single write makes progress
        // well within its own timeout, but the whole frame cannot finish in time.
        let reader = std::thread::spawn(move || {
            let mut b = b;
            let mut chunk = [0u8; 1024];
            for _ in 0..400 {
                if matches!(b.read(&mut chunk), Ok(0) | Err(_)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let body = vec![b'x'; CONTROL_FRAME_LIMIT];
        let started = Instant::now();
        let frame = Duration::from_millis(200);
        assert_eq!(
            write_within(&mut a, &body, CONTROL_FRAME_LIMIT, frame),
            Err(FrameError::Truncated)
        );
        assert!(started.elapsed() < frame * 3, "{:?}", started.elapsed());
        drop(a);
        reader.join().unwrap();
    }

    #[test]
    fn closed_and_idle_peers_are_told_apart() {
        let (a, mut b) = pair();
        drop(a);
        assert_eq!(
            read(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT),
            Err(FrameError::Closed)
        );
        let (_a, mut b) = pair();
        assert_eq!(
            read(&mut b, Duration::from_millis(20), CONTROL_FRAME_LIMIT),
            Err(FrameError::Idle)
        );
    }

    #[test]
    fn a_zero_idle_bound_takes_only_a_waiting_frame_and_leaves_the_socket_blocking() {
        let (mut a, mut b) = pair();
        let started = Instant::now();
        assert_eq!(
            read(&mut b, Duration::ZERO, CONTROL_FRAME_LIMIT),
            Err(FrameError::Idle)
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        write(&mut a, b"{}", CONTROL_FRAME_LIMIT).unwrap();
        assert_eq!(
            read(&mut b, Duration::ZERO, CONTROL_FRAME_LIMIT).unwrap(),
            b"{}"
        );
        // Blocking mode is restored: the next wait honours its own bound.
        assert_eq!(
            read(&mut b, Duration::from_millis(30), CONTROL_FRAME_LIMIT),
            Err(FrameError::Idle)
        );
    }
}
