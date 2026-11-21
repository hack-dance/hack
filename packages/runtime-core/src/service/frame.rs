//! Length-prefixed JSON frames: a u32 big-endian length, then that many bytes.
//!
//! A reader waits for the first header byte up to the caller's idle bound, then
//! must receive the rest of the frame within [`FRAME_DEADLINE`]. A writer must
//! send the whole frame within the same bound. Each bound is one monotonic
//! deadline: retries after a signal and partial transfers never extend it, and a
//! transfer that completes after it is refused. A length of zero or over the cap
//! is refused before any body byte is read, so a hostile peer cannot make the
//! reader allocate or wait for an oversized body.
//!
//! Waiting is done with `poll`, and each transfer is one non-blocking `recv` or
//! `send` (`MSG_DONTWAIT`). The socket's own mode and timeouts are never changed,
//! so handles cloned from it are unaffected. A blocking write is not used because
//! it can keep going past `SO_SNDTIMEO` while a peer drains slowly (measured on
//! Linux: 1.3 s against a 200 ms bound).
use std::io::ErrorKind;
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
    /// No frame began within the idle bound; nothing was consumed.
    Idle,
    /// The length is zero, above the cap or above `u32::MAX`; no body byte was
    /// read or written.
    TooLarge(usize),
    /// The peer closed or stalled in the middle of a frame, or the frame did not
    /// finish within its deadline. The stream must be discarded.
    Truncated,
    Io(ErrorKind),
}

/// Read one frame. `idle` bounds the wait for its first byte: zero means "only if
/// a byte is already waiting", and a bound too large to represent means no bound.
pub fn read(stream: &mut UnixStream, idle: Duration, limit: usize) -> Result<Vec<u8>, FrameError> {
    read_within(stream, idle, limit, FRAME_DEADLINE)
}

/// Write one frame within [`FRAME_DEADLINE`].
pub fn write(stream: &mut UnixStream, bytes: &[u8], limit: usize) -> Result<(), FrameError> {
    write_within(stream, bytes, limit, FRAME_DEADLINE, None)
}

/// Read one whole frame by `by`: the wait for its first byte and the rest of the
/// frame both end there (and the rest within [`FRAME_DEADLINE`] at most).
pub fn read_by(stream: &mut UnixStream, by: Instant, limit: usize) -> Result<Vec<u8>, FrameError> {
    let idle = by.saturating_duration_since(Instant::now());
    if idle.is_zero() {
        return Err(FrameError::Idle);
    }
    read_capped(stream, idle, limit, FRAME_DEADLINE, Some(by))
}

/// Write one whole frame by `by` (and within [`FRAME_DEADLINE`] at most).
pub fn write_by(
    stream: &mut UnixStream,
    bytes: &[u8],
    limit: usize,
    by: Instant,
) -> Result<(), FrameError> {
    write_within(stream, bytes, limit, FRAME_DEADLINE, Some(by))
}

/// The earlier of `frame` from now and `cap`; `None` only if neither exists.
fn deadline_for(frame: Duration, cap: Option<Instant>) -> Option<Instant> {
    match (Instant::now().checked_add(frame), cap) {
        (Some(own), Some(cap)) => Some(own.min(cap)),
        (own, cap) => own.or(cap),
    }
}

fn io(error: std::io::Error) -> FrameError {
    FrameError::Io(error.kind())
}

fn read_within(
    stream: &mut UnixStream,
    idle: Duration,
    limit: usize,
    frame: Duration,
) -> Result<Vec<u8>, FrameError> {
    read_capped(stream, idle, limit, frame, None)
}

fn read_capped(
    stream: &mut UnixStream,
    idle: Duration,
    limit: usize,
    frame: Duration,
    cap: Option<Instant>,
) -> Result<Vec<u8>, FrameError> {
    let mut header = [0u8; 4];
    first_byte(stream, &mut header[..1], idle)?;
    let deadline = deadline_for(frame, cap);
    read_exact_by(stream, &mut header[1..], deadline)?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > limit {
        return Err(FrameError::TooLarge(size));
    }
    let mut body = vec![0u8; size];
    read_exact_by(stream, &mut body, deadline)?;
    Ok(body)
}

/// Take the first byte of a frame once the socket is readable by the idle
/// deadline. `Idle` consumes nothing.
fn first_byte(stream: &UnixStream, byte: &mut [u8], idle: Duration) -> Result<(), FrameError> {
    let deadline = if idle.is_zero() {
        None
    } else {
        Some(Instant::now().checked_add(idle))
    };
    loop {
        if let Some(deadline) = deadline {
            if !wait(stream, libc::POLLIN, deadline)? {
                return Err(FrameError::Idle);
            }
        }
        match recv_now(stream, byte) {
            Ok(0) => return Err(FrameError::Closed),
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if deadline.is_none() {
                    return Err(FrameError::Idle);
                }
            }
            Err(e) => return Err(io(e)),
        }
    }
}

fn read_exact_by(
    stream: &UnixStream,
    mut bytes: &mut [u8],
    deadline: Option<Instant>,
) -> Result<(), FrameError> {
    while !bytes.is_empty() {
        if !wait(stream, libc::POLLIN, deadline)? {
            return Err(FrameError::Truncated);
        }
        match recv_now(stream, bytes) {
            Ok(0) => return Err(FrameError::Truncated),
            Ok(count) => bytes = &mut bytes[count..],
            Err(e) if matches!(e.kind(), ErrorKind::Interrupted | ErrorKind::WouldBlock) => {}
            Err(e) => return Err(io(e)),
        }
        // Bytes that arrive after the deadline do not complete the frame.
        if deadline.is_some_and(|deadline| Instant::now() > deadline) {
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
    cap: Option<Instant>,
) -> Result<(), FrameError> {
    let length = frame_length(bytes.len(), limit)?;
    let deadline = deadline_for(frame, cap);
    for mut part in [&length.to_be_bytes()[..], bytes] {
        while !part.is_empty() {
            match send_now(stream, part) {
                Ok(0) => return Err(FrameError::Truncated),
                Ok(count) => part = &part[count..],
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    if !wait(stream, libc::POLLOUT, deadline)? {
                        return Err(FrameError::Truncated);
                    }
                }
                Err(e) => return Err(io(e)),
            }
            if deadline.is_some_and(|deadline| Instant::now() > deadline) {
                return Err(FrameError::Truncated);
            }
        }
    }
    Ok(())
}

/// Wait until the socket is ready for `events` (or has hung up), at most until
/// `deadline` (`None`: no bound). `Ok(false)` means the deadline passed first.
fn wait(
    stream: &UnixStream,
    events: libc::c_short,
    deadline: Option<Instant>,
) -> Result<bool, FrameError> {
    loop {
        let millis = match deadline {
            None => -1,
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Ok(false);
                }
                // Round up so a sub-millisecond remainder still waits.
                left.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32
            }
        };
        let mut fd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        // SAFETY: one initialized pollfd that outlives the call.
        match unsafe { libc::poll(&mut fd, 1, millis) } {
            n if n > 0 => {
                return Ok(deadline.is_none_or(|deadline| Instant::now() <= deadline));
            }
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

fn recv_now(stream: &UnixStream, bytes: &mut [u8]) -> std::io::Result<usize> {
    // SAFETY: a valid descriptor and a writable buffer of the given length.
    let n = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT,
        )
    };
    if n < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}

/// `MSG_NOSIGNAL` on both Linux and macOS, so a closed peer is an error and
/// never a `SIGPIPE`, whatever the process's signal disposition.
const SEND_FLAGS: libc::c_int = libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL;

fn send_now(stream: &UnixStream, bytes: &[u8]) -> std::io::Result<usize> {
    // SAFETY: a valid descriptor and a readable buffer of the given length.
    let n = unsafe {
        libc::send(
            stream.as_raw_fd(),
            bytes.as_ptr().cast(),
            bytes.len(),
            SEND_FLAGS,
        )
    };
    if n < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(n as usize)
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
    use std::io::{Read, Write};

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
            write_within(&mut a, &body, CONTROL_FRAME_LIMIT, frame, None),
            Err(FrameError::Truncated)
        );
        assert!(started.elapsed() < frame * 3, "{:?}", started.elapsed());
        drop(a);
        reader.join().unwrap();
    }

    const SIGPIPE_CHILD: &str = "HACK_FRAME_SIGPIPE_CHILD";

    #[test]
    fn writing_to_a_closed_peer_is_an_error_even_with_the_default_sigpipe_action() {
        if std::env::var_os(SIGPIPE_CHILD).is_some() {
            // In a child process only: restore the default action, which kills.
            // SAFETY: resetting one signal's disposition in a single-purpose child.
            unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
            let (mut a, b) = pair();
            drop(b);
            assert_eq!(
                write(&mut a, b"{}", CONTROL_FRAME_LIMIT),
                Err(FrameError::Io(ErrorKind::BrokenPipe))
            );
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "service::frame::tests::writing_to_a_closed_peer_is_an_error_even_with_the_default_sigpipe_action",
                "--test-threads",
                "1",
            ])
            .env(SIGPIPE_CHILD, "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "child ended with {status:?}");
    }

    #[test]
    fn a_partial_header_cannot_stretch_a_whole_frame_deadline() {
        let (mut a, mut b) = pair();
        a.write_all(&[0]).unwrap();
        let started = Instant::now();
        let by = started + Duration::from_millis(100);
        assert_eq!(
            read_by(&mut b, by, CONTROL_FRAME_LIMIT),
            Err(FrameError::Truncated)
        );
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "{:?}",
            started.elapsed()
        );
        let (_c, mut d) = pair();
        assert_eq!(
            read_by(
                &mut d,
                Instant::now() + Duration::from_millis(30),
                CONTROL_FRAME_LIMIT
            ),
            Err(FrameError::Idle)
        );
        drop(a);
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
    fn a_zero_idle_bound_takes_only_a_waiting_frame() {
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
    }

    #[test]
    fn an_unrepresentable_idle_bound_means_no_bound_and_never_panics() {
        let (mut a, mut b) = pair();
        write(&mut a, b"{}", CONTROL_FRAME_LIMIT).unwrap();
        assert_eq!(
            read(&mut b, Duration::MAX, CONTROL_FRAME_LIMIT).unwrap(),
            b"{}"
        );
        drop(a);
        assert_eq!(
            read(&mut b, Duration::MAX, CONTROL_FRAME_LIMIT),
            Err(FrameError::Closed)
        );
    }

    fn nonblocking(stream: &UnixStream) -> bool {
        // SAFETY: F_GETFL only reads the descriptor's status flags.
        unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) & libc::O_NONBLOCK != 0 }
    }

    #[test]
    fn reads_and_writes_never_change_the_sockets_mode() {
        for start_nonblocking in [false, true] {
            let (mut a, mut b) = pair();
            a.set_nonblocking(start_nonblocking).unwrap();
            b.set_nonblocking(start_nonblocking).unwrap();
            let clone = b.try_clone().unwrap();
            write(&mut a, b"{}", CONTROL_FRAME_LIMIT).unwrap();
            assert_eq!(
                read(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT).unwrap(),
                b"{}"
            );
            assert_eq!(
                read(&mut b, Duration::ZERO, CONTROL_FRAME_LIMIT),
                Err(FrameError::Idle)
            );
            assert_eq!(
                read(&mut b, Duration::from_millis(20), CONTROL_FRAME_LIMIT),
                Err(FrameError::Idle)
            );
            for stream in [&a, &b, &clone] {
                assert_eq!(nonblocking(stream), start_nonblocking);
            }
        }
    }
}
