//! Length-prefixed JSON frames: a u32 big-endian length, then that many bytes.
//!
//! A reader waits for the first header byte up to the caller's idle bound, then
//! must receive the rest of the frame within [`FRAME_DEADLINE`]. A length of zero
//! or over the cap is refused before any body byte is read, so a hostile peer
//! cannot make the service allocate or wait for an oversized body.
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

/// Cap for control frames (spec 4.2). Frames that carry private input arrive in a
/// later slice with their own, larger cap.
pub const CONTROL_FRAME_LIMIT: usize = 128 * 1024;
/// Time for the rest of a frame once its first byte arrived.
pub const FRAME_DEADLINE: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed before sending any byte of a frame.
    Closed,
    /// No frame began within the idle bound.
    Idle,
    /// The length prefix is zero or above the cap; nothing of the body was read.
    TooLarge(usize),
    /// The peer closed or stalled in the middle of a frame.
    Truncated,
    Io(ErrorKind),
}

/// Read one frame, waiting up to `idle` for it to begin.
pub fn read(stream: &mut UnixStream, idle: Duration, limit: usize) -> Result<Vec<u8>, FrameError> {
    let mut header = [0u8; 4];
    stream
        .set_read_timeout(Some(idle.max(Duration::from_millis(1))))
        .map_err(|e| FrameError::Io(e.kind()))?;
    loop {
        match stream.read(&mut header[..1]) {
            Ok(0) => return Err(FrameError::Closed),
            Ok(_) => break,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Err(FrameError::Idle);
            }
            Err(e) => return Err(FrameError::Io(e.kind())),
        }
    }
    let deadline = Instant::now() + FRAME_DEADLINE;
    read_exact_by(stream, &mut header[1..], deadline)?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > limit {
        return Err(FrameError::TooLarge(size));
    }
    let mut body = vec![0u8; size];
    read_exact_by(stream, &mut body, deadline)?;
    Ok(body)
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
        stream
            .set_read_timeout(Some(left))
            .map_err(|e| FrameError::Io(e.kind()))?;
        match stream.read(bytes) {
            Ok(0) => return Err(FrameError::Truncated),
            Ok(count) => bytes = &mut bytes[count..],
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Err(FrameError::Truncated);
            }
            Err(e) => return Err(FrameError::Io(e.kind())),
        }
    }
    Ok(())
}

/// Write one frame within [`FRAME_DEADLINE`].
pub fn write(stream: &mut UnixStream, bytes: &[u8], limit: usize) -> Result<(), FrameError> {
    if bytes.is_empty() || bytes.len() > limit {
        return Err(FrameError::TooLarge(bytes.len()));
    }
    let mut frame = Vec::with_capacity(bytes.len() + 4);
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(bytes);
    stream
        .set_write_timeout(Some(FRAME_DEADLINE))
        .map_err(|e| FrameError::Io(e.kind()))?;
    stream.write_all(&frame).map_err(|e| match e.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => FrameError::Truncated,
        kind => FrameError::Io(kind),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(matches!(
            write(
                &mut a,
                &vec![b'x'; CONTROL_FRAME_LIMIT + 1],
                CONTROL_FRAME_LIMIT
            ),
            Err(FrameError::TooLarge(_))
        ));
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
}
