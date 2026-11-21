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
    read_capped(stream, Wait::Until(by), limit, FRAME_DEADLINE, Some(by))
}

/// How long to wait for the first byte of a frame.
#[derive(Clone, Copy)]
enum Wait {
    /// Take a byte only if one is already waiting.
    Probe,
    /// Wait for readiness until this instant; `Idle` (deadline passed before the
    /// socket was readable) consumes nothing.
    Until(Instant),
    Forever,
}

impl Wait {
    fn after(idle: Duration) -> Self {
        if idle.is_zero() {
            return Self::Probe;
        }
        Instant::now()
            .checked_add(idle)
            .map_or(Self::Forever, Self::Until)
    }
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
    read_capped(stream, Wait::after(idle), limit, frame, None)
}

fn read_capped(
    stream: &mut UnixStream,
    first: Wait,
    limit: usize,
    frame: Duration,
    cap: Option<Instant>,
) -> Result<Vec<u8>, FrameError> {
    let mut header = [0u8; 4];
    first_byte(stream, &mut header[..1], first)?;
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
fn first_byte(stream: &UnixStream, byte: &mut [u8], first: Wait) -> Result<(), FrameError> {
    let deadline = match first {
        Wait::Probe => None,
        Wait::Until(by) => Some(Some(by)),
        Wait::Forever => Some(None),
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
            // Never start a send after the deadline: a late header would leave
            // the peer a partial frame.
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(FrameError::Truncated);
            }
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

    /// Only a hang can break this bound; the tests prove their property from
    /// results, not from how long a loaded machine took.
    const HANG_GUARD: Duration = Duration::from_secs(30);

    /// Run `f` on its own thread and fail the test if it has not returned within
    /// `HANG_GUARD`.
    fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (sender, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(f());
        });
        received
            .recv_timeout(HANG_GUARD)
            .expect("the call did not return: it hung")
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
        // Without a deadline this read would wait forever: the guard is the proof.
        let result =
            within(move || read_within(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT, frame));
        assert_eq!(result, Err(FrameError::Truncated));
        // A lower bound only: no load can make the deadline arrive early.
        assert!(started.elapsed() >= frame);
        drop(a);
    }

    #[test]
    fn a_slow_trickle_cannot_stretch_the_read_deadline() {
        let (mut a, mut b) = pair();
        // The frame is far longer than the trickle could deliver in any test run
        // (one byte every 20 ms for 128 KiB is about 45 minutes), so a reader whose
        // deadline restarted on each byte would never return and the hang guard
        // fails the test. However late the reader starts, only a few bytes have
        // been buffered, so a correct reader gives Truncated at its frame deadline.
        a.write_all(&(CONTROL_FRAME_LIMIT as u32).to_be_bytes())
            .unwrap();
        let writer = std::thread::spawn(move || {
            while a.write_all(b"x").is_ok() {
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let frame = Duration::from_millis(200);
        let result =
            within(move || read_within(&mut b, Duration::from_secs(1), CONTROL_FRAME_LIMIT, frame));
        assert_eq!(result, Err(FrameError::Truncated));
        // The reader end is gone, so the writer's next write fails and it stops.
        writer.join().unwrap();
    }

    /// Shrink the writer's send buffer and the reader's receive buffer so that a
    /// control frame cannot fit at once. Fails the test if the platform refuses.
    fn small_buffers(writer: &UnixStream, reader: &UnixStream) {
        let small: libc::c_int = 4096;
        for (fd, option) in [
            (writer.as_raw_fd(), libc::SO_SNDBUF),
            (reader.as_raw_fd(), libc::SO_RCVBUF),
        ] {
            // SAFETY: a valid socket descriptor and a correctly sized option value.
            let set = unsafe {
                libc::setsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    option,
                    (&small as *const libc::c_int).cast(),
                    std::mem::size_of::<libc::c_int>() as libc::socklen_t,
                )
            };
            assert_eq!(set, 0, "setsockopt: {}", std::io::Error::last_os_error());
        }
    }

    /// Read until end-of-file, `pause` between reads, and return the byte count.
    fn drain(
        mut reader: UnixStream,
        start_after: Duration,
        pause: Duration,
    ) -> std::thread::JoinHandle<usize> {
        std::thread::spawn(move || {
            std::thread::sleep(start_after);
            let mut chunk = [0u8; 1024];
            let mut received = 0;
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => return received,
                    Ok(count) => received += count,
                }
                std::thread::sleep(pause);
            }
        })
    }

    #[test]
    fn partial_writes_under_backpressure_cannot_stretch_the_write_deadline() {
        let (mut a, b) = pair();
        small_buffers(&a, &b);
        // The reader drains 1 KiB every 10 ms until the writer closes, so every
        // single write makes progress and a writer without one deadline for the
        // whole frame would finish it (about 1.3 s) and return Ok. With the
        // deadline it gives up with bytes left over.
        let reader = drain(b, Duration::ZERO, Duration::from_millis(10));
        let frame = Duration::from_millis(200);
        let result = within(move || {
            let body = vec![b'x'; CONTROL_FRAME_LIMIT];
            let result = write_within(&mut a, &body, CONTROL_FRAME_LIMIT, frame, None);
            drop(a);
            result
        });
        assert_eq!(result, Err(FrameError::Truncated));
        let received = reader.join().unwrap();
        // The bytes that fit before the first wait always arrive: the write made
        // progress on the body before it gave up, and did not finish.
        assert!(received > 4, "no body byte was written: {received} bytes");
        assert!(
            received < CONTROL_FRAME_LIMIT + 4,
            "the whole frame went through: {received} bytes"
        );
    }

    #[test]
    fn a_write_that_has_to_wait_for_room_still_finishes_within_its_deadline() {
        // The counterpart: the reader starts only after the writer has filled the
        // small buffers and must wait, then drains as fast as it can. A writer that
        // gave up at its first wait for room fails here.
        let (mut a, b) = pair();
        small_buffers(&a, &b);
        let reader = drain(b, Duration::from_millis(100), Duration::ZERO);
        let result = within(move || {
            let body = vec![b'x'; CONTROL_FRAME_LIMIT];
            let result = write_within(
                &mut a,
                &body,
                CONTROL_FRAME_LIMIT,
                Duration::from_secs(20),
                None,
            );
            drop(a);
            result
        });
        assert_eq!(result, Ok(()));
        assert_eq!(reader.join().unwrap(), CONTROL_FRAME_LIMIT + 4);
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
        // The cap is what must end this read: the first byte is already waiting,
        // the frame's own deadline is a minute away, and the cap is 300 ms. A read
        // that ignored the cap would hang into the guard. A thread that starts
        // late finds the cap already passed and still gives Truncated.
        let (mut a, mut b) = pair();
        a.write_all(&[0]).unwrap();
        let result = within(move || {
            let cap = Instant::now() + Duration::from_millis(300);
            let first = Wait::Until(Instant::now() + HANG_GUARD);
            read_capped(
                &mut b,
                first,
                CONTROL_FRAME_LIMIT,
                Duration::from_secs(60),
                Some(cap),
            )
        });
        assert_eq!(result, Err(FrameError::Truncated));
        // `read_by` is that call with the frame deadline as its cap; on an empty
        // socket a passed deadline consumes nothing.
        let (_c, mut d) = pair();
        assert_eq!(
            read_by(&mut d, Instant::now(), CONTROL_FRAME_LIMIT),
            Err(FrameError::Idle)
        );
        drop(a);
    }

    #[test]
    fn an_expired_deadline_sends_nothing_and_consumes_nothing() {
        let (mut a, mut b) = pair();
        let past = Instant::now();
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(
            write_by(&mut a, b"{}", CONTROL_FRAME_LIMIT, past),
            Err(FrameError::Truncated)
        );
        // The peer received no byte at all.
        assert_eq!(
            read(&mut b, Duration::ZERO, CONTROL_FRAME_LIMIT),
            Err(FrameError::Idle)
        );
        // A waiting frame is not consumed by a read whose deadline has passed.
        write(&mut a, b"{}", CONTROL_FRAME_LIMIT).unwrap();
        assert_eq!(
            read_by(&mut b, past, CONTROL_FRAME_LIMIT),
            Err(FrameError::Idle)
        );
        assert_eq!(
            read(&mut b, Duration::ZERO, CONTROL_FRAME_LIMIT).unwrap(),
            b"{}"
        );
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
        // A blocking probe would wait forever here: the guard is the proof.
        let (result, b2) = within(move || (read(&mut b, Duration::ZERO, CONTROL_FRAME_LIMIT), b));
        assert_eq!(result, Err(FrameError::Idle));
        let mut b = b2;
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
