//! Read-only Engine log transport. Buffers never grow with frame size or log rate.
use crate::{CandidateError, LogFailurePhase};
#[cfg(test)]
#[path = "log_follow_fragmentation_tests.rs"]
mod fragmentation_tests;
#[path = "log_timestamp.rs"]
mod timestamp;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::{self, BufRead, Read, Write};
use std::{
    cell::{Cell, RefCell},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
pub(in crate::provider) use timestamp::unix_nanos;

pub(in crate::provider) fn failure() -> CandidateError {
    CandidateError::new(
        "native_log_stream_uncertain",
        "Native log stream ended without a confirmed service stop; no cleanup was inferred.",
    )
}

fn frame_failure(message: &'static str) -> CandidateError {
    CandidateError::new("native_log_stream_uncertain", message)
        .with_log_phase(LogFailurePhase::FrameHeader)
}

fn body_failure(error: io::Error, phase: LogFailurePhase) -> CandidateError {
    if error.kind() == io::ErrorKind::InvalidData {
        CandidateError::new("native_log_stream_uncertain", "Invalid HTTP log body framing: expected a hexadecimal chunk size, declared bytes and CRLF, or the declared Content-Length. Body values omitted.")
            .with_log_phase(LogFailurePhase::HttpFraming)
    } else {
        failure().with_log_phase(phase)
    }
}

/// Emits at most 4096 payload bytes per envelope. The frontend owns line assembly.
#[cfg(test)]
pub(in crate::provider) fn copy(
    input: impl Read,
    output: &mut impl Write,
    service: &str,
    container: &str,
) -> Result<(), CandidateError> {
    copy_started(input, output, service, container, false, || {})
}

fn copy_started(
    input: impl Read,
    output: &mut impl Write,
    service: &str,
    container: &str,
    timestamps: bool,
    started: impl FnOnce(),
) -> Result<(), CandidateError> {
    let mut reader = io::BufReader::with_capacity(8192, input);
    let head = headers(&mut reader).map_err(|mut error| {
        error.log_phase.get_or_insert(LogFailurePhase::Headers);
        error
    })?;
    started();
    serde_json::to_writer(
        &mut *output,
        &serde_json::json!({"version":2,
        "kind":"native-log-attached","service":service,"container":container}),
    )
    .map_err(|_| failure())?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| failure())?;
    let mut body = Body {
        reader,
        framing: head,
        remaining: 0,
        ended: false,
        trailer: false,
    };
    loop {
        let mut header = [0u8; 8];
        if body
            .read(&mut header[..1])
            .map_err(|e| body_failure(e, LogFailurePhase::FrameHeader))?
            == 0
        {
            return Ok(());
        }
        body.read_exact(&mut header[1..])
            .map_err(|e| body_failure(e, LogFailurePhase::FrameHeader))?;
        if !matches!(header[0], 1 | 2) {
            return Err(frame_failure(
                "Invalid Engine mux header: first byte is not stdout (1) or stderr (2); expected [stream, 0, 0, 0, length:u32be]. Stream bytes omitted.",
            ));
        }
        if header[1..4] != [0, 0, 0] {
            return Err(frame_failure(
                "Invalid Engine mux header: reserved bytes are nonzero; expected [stream, 0, 0, 0, length:u32be]. Stream bytes omitted.",
            ));
        }
        let mut remaining =
            u32::from_be_bytes(header[4..8].try_into().map_err(|_| failure())?) as usize;
        let timestamp = if timestamps && remaining > 0 {
            Some(
                read_timestamp(&mut body, &mut remaining)
                    .map_err(|e| e.with_log_phase(LogFailurePhase::Timestamp))?,
            )
        } else {
            None
        };
        while remaining > 0 {
            let mut bytes = [0u8; 4096];
            let size = remaining.min(bytes.len());
            let size = body
                .read(&mut bytes[..size])
                .map_err(|e| body_failure(e, LogFailurePhase::Payload))?;
            if size == 0 {
                return Err(CandidateError::new("native_log_stream_uncertain", "Engine mux payload ended before its declared length; the final log line may be incomplete.").with_log_phase(LogFailurePhase::Payload));
            }
            let event = serde_json::json!({"version":2,"kind":"native-log-chunk",
                "timestamp": timestamp,
                "service":service,"container":container,
                "stream":if header[0] == 1 { "stdout" } else { "stderr" },
                "data":STANDARD.encode(&bytes[..size])});
            serde_json::to_writer(&mut *output, &event).map_err(|_| failure())?;
            output
                .write_all(b"\n")
                .and_then(|_| output.flush())
                .map_err(|_| failure())?;
            remaining -= size;
        }
    }
}

// Engine timestamps precede each mux frame, including partial log entries. Remove
// them at that boundary so neither timestamps nor repeated prefixes use payload budget.
fn read_timestamp(input: &mut impl Read, remaining: &mut usize) -> Result<String, CandidateError> {
    let mut prefix = Vec::new();
    while *remaining > 0 && prefix.len() < 40 {
        let mut byte = [0];
        input.read_exact(&mut byte).map_err(|_| failure())?;
        *remaining -= 1;
        if byte[0] == b' ' {
            let text = String::from_utf8(prefix).map_err(|_| failure())?;
            if valid_timestamp(&text) {
                return Ok(text);
            }
            return Err(failure());
        }
        prefix.push(byte[0]);
    }
    Err(failure())
}
pub(in crate::provider) fn valid_timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    let date = if let Some(date) = text.strip_suffix('Z') {
        date.as_bytes()
    } else if bytes.len() >= 25 {
        let offset = &bytes[bytes.len() - 6..];
        if !matches!(offset[0], b'+' | b'-')
            || offset[3] != b':'
            || ![offset[1], offset[2], offset[4], offset[5]]
                .iter()
                .all(u8::is_ascii_digit)
        {
            return false;
        }
        &bytes[..bytes.len() - 6]
    } else {
        return false;
    };
    if !(date.len() == 19 || (21..=29).contains(&date.len())) {
        return false;
    }
    date.iter().enumerate().all(|(i, ch)| match i {
        4 | 7 => *ch == b'-',
        10 => *ch == b'T',
        13 | 16 => *ch == b':',
        19 => *ch == b'.',
        _ => ch.is_ascii_digit(),
    })
}
#[derive(Clone)]
pub(in crate::provider) struct LogOptions {
    pub tail: u16,
    pub since: Option<String>,
    pub timestamps: bool,
}

enum Framing {
    Chunked,
    Length(u64),
    Close,
}
fn line(reader: &mut impl BufRead, limit: usize) -> Result<String, CandidateError> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        reader.read_exact(&mut byte).map_err(|_| failure())?;
        bytes.push(byte[0]);
        if bytes.len() > limit {
            return Err(failure());
        }
        if bytes.ends_with(b"\r\n") {
            bytes.truncate(bytes.len() - 2);
            return String::from_utf8(bytes).map_err(|_| failure());
        }
    }
}
fn headers(reader: &mut impl BufRead) -> Result<Framing, CandidateError> {
    let status = line(reader, 1024).map_err(|e| e.with_log_phase(LogFailurePhase::StatusLine))?;
    if !status.starts_with("HTTP/1.1 200 ") {
        return Err(CandidateError::new(
            "native_log_stream_uncertain",
            "Invalid Engine log status line: expected HTTP/1.1 200. Response values omitted.",
        )
        .with_log_phase(LogFailurePhase::StatusLine));
    }
    let mut budget = status.len();
    let (mut chunked, mut length) = (false, None);
    loop {
        let value = line(reader, 8192).map_err(|e| e.with_log_phase(LogFailurePhase::Headers))?;
        budget += value.len() + 2;
        if budget > 8192 {
            return Err(failure());
        }
        if value.is_empty() {
            break;
        }
        let (key, value) = value.split_once(':').ok_or_else(failure)?;
        if key.eq_ignore_ascii_case("transfer-encoding") {
            if chunked || !value.trim().eq_ignore_ascii_case("chunked") {
                return Err(failure());
            }
            chunked = true;
        } else if key.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(failure());
            }
            length = Some(value.trim().parse::<u64>().map_err(|_| failure())?);
        }
    }
    match (chunked, length) {
        (true, None) => Ok(Framing::Chunked),
        (false, Some(n)) => Ok(Framing::Length(n)),
        (false, None) => Ok(Framing::Close),
        _ => Err(failure()),
    }
}
struct Body<R> {
    reader: R,
    framing: Framing,
    remaining: u64,
    ended: bool,
    trailer: bool,
}
impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.ended {
            return Ok(0);
        }
        let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Invalid log body framing");
        let cap = match &mut self.framing {
            Framing::Close => output.len(),
            Framing::Length(left) => {
                if *left == 0 {
                    return Ok(0);
                }
                output.len().min((*left).min(usize::MAX as u64) as usize)
            }
            Framing::Chunked => {
                if self.remaining == 0 {
                    if self.trailer {
                        let mut end = [0; 2];
                        self.reader.read_exact(&mut end)?;
                        if end != *b"\r\n" {
                            return Err(invalid());
                        }
                        self.trailer = false;
                    }
                    let size = line(&mut self.reader, 32).map_err(|_| invalid())?;
                    if size.is_empty() || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err(invalid());
                    }
                    self.remaining = u64::from_str_radix(&size, 16).map_err(|_| invalid())?;
                    if self.remaining == 0 {
                        if !line(&mut self.reader, 2).map_err(|_| invalid())?.is_empty() {
                            return Err(invalid());
                        }
                        self.ended = true;
                        return Ok(0);
                    }
                }
                output
                    .len()
                    .min(self.remaining.min(usize::MAX as u64) as usize)
            }
        };
        let n = self.reader.read(&mut output[..cap])?;
        if n == 0 && !matches!(self.framing, Framing::Close) {
            return Err(invalid());
        }
        match &mut self.framing {
            Framing::Length(left) => *left -= n as u64,
            Framing::Chunked => {
                self.remaining -= n as u64;
                if self.remaining == 0 {
                    // Return the bytes already read before waiting for framing.
                    self.trailer = true;
                }
            }
            Framing::Close => {}
        }
        Ok(n)
    }
}

struct Guarded<'a, F> {
    stream: UnixStream,
    check: &'a F,
    last: Instant,
    deadline: &'a Cell<Option<Instant>>,
    stopped: &'a Cell<bool>,
    check_error: &'a RefCell<Option<CandidateError>>,
    running: bool,
    stopped_since: Option<Instant>,
}
impl<F: Fn() -> Result<bool, CandidateError>> Read for Guarded<'_, F> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.deadline.get().is_some_and(|d| Instant::now() >= d) {
                return Err(io::ErrorKind::TimedOut.into());
            }
            if self.last.elapsed() >= Duration::from_secs(5) {
                self.running = (self.check)().map_err(|error| {
                    *self.check_error.borrow_mut() =
                        Some(error.with_log_phase(LogFailurePhase::PeriodicCheck));
                    io::Error::other("Log selection changed")
                })?;
                self.last = Instant::now();
            }
            match self.stream.read(bytes) {
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    if !self.running && self.deadline.get().is_none() {
                        // Prefer real EOF. A short delivery gap is not a drained
                        // tail: require another observation interval without data.
                        let since = self.stopped_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= Duration::from_secs(5) {
                            self.stopped.set(true);
                            return Err(io::Error::other("Selected service stopped"));
                        }
                    } else {
                        self.stopped_since = None;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                value => {
                    self.stopped_since = None;
                    return value;
                }
            }
        }
    }
}
#[cfg(target_os = "macos")]
pub(in crate::provider) fn follow(
    observer: &super::Observer<'_>,
    container: &str,
    service: &str,
    options: LogOptions,
    check: impl Fn() -> Result<bool, CandidateError>,
) -> Result<(), CandidateError> {
    let path = observer.guest().engine_socket()?;
    follow_socket(
        &path,
        container,
        service,
        options,
        check,
        &mut std::io::stdout().lock(),
    )
}

/// The portable transport used by the observer. The caller supplies the verified
/// socket and identity check; this layer never admits mutations or owns a lease.
pub(in crate::provider) fn follow_socket(
    path: &std::path::Path,
    container: &str,
    service: &str,
    options: LogOptions,
    check: impl Fn() -> Result<bool, CandidateError>,
    output: &mut impl Write,
) -> Result<(), CandidateError> {
    let running = check().map_err(|e| e.with_log_phase(LogFailurePhase::Admission))?;
    let mut stream =
        crate::provider::agent::connect_until(path, Instant::now() + Duration::from_secs(5))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|_| failure())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| failure())?;
    stream
        .write_all(request(container, &options).as_bytes())
        .map_err(|_| failure())?;
    let timestamps = options.timestamps;
    let deadline = Cell::new(Some(Instant::now() + Duration::from_secs(5)));
    let stopped = Cell::new(false);
    let check_error = RefCell::new(None);
    let input = Guarded {
        stream,
        check: &check,
        last: Instant::now(),
        deadline: &deadline,
        stopped: &stopped,
        check_error: &check_error,
        running,
        stopped_since: None,
    };
    let result = copy_started(input, output, service, container, timestamps, || {
        deadline.set(None)
    });
    if let Some(error) = check_error.into_inner() {
        return Err(error);
    }
    if stopped.get() {
        return Err(CandidateError::new(
            "native_log_stopped_idle",
            "Selected service stopped, but the log transport did not reach EOF within five idle seconds; the final tail may be incomplete.",
        ));
    }
    result?;
    // A socket ending while the selected service still runs is transport loss.
    if check().map_err(|e| e.with_log_phase(LogFailurePhase::FinalCheck))? {
        return Err(failure());
    }
    Ok(())
}

fn request(container: &str, options: &LogOptions) -> String {
    format!(
        "GET /v1.53/containers/{container}/logs?follow=1&stdout=1&stderr=1&timestamps={}&tail={}{} HTTP/1.1\r\nHost: hack-local\r\nConnection: close\r\n\r\n",
        u8::from(options.timestamps),
        options.tail,
        options
            .since
            .as_ref()
            .map(|s| format!("&since={s}"))
            .unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_uses_unix_nanoseconds_for_both_utc_and_offset_generations() {
        for stamp in [
            "2026-01-01T00:00:00.123456789Z",
            "2026-01-01T02:00:00.123456789+02:00",
        ] {
            let options = LogOptions {
                tail: 1000,
                since: unix_nanos(stamp),
                timestamps: false,
            };
            assert_eq!(
                request("container", &options),
                "GET /v1.53/containers/container/logs?follow=1&stdout=1&stderr=1&timestamps=0&tail=1000&since=1767225600.123456789 HTTP/1.1\r\nHost: hack-local\r\nConnection: close\r\n\r\n"
            );
        }
    }
    #[test]
    fn idle_stopped_service_ends_without_fabricating_http_eof() {
        let (reader, _writer) = UnixStream::pair().unwrap();
        reader
            .set_read_timeout(Some(Duration::from_millis(10)))
            .unwrap();
        let deadline = Cell::new(None);
        let stopped = Cell::new(false);
        let error = RefCell::new(None);
        let calls = Cell::new(0);
        let check = || {
            calls.set(calls.get() + 1);
            Ok(false)
        };
        let mut guarded = Guarded {
            stream: reader,
            check: &check,
            last: Instant::now() - Duration::from_secs(5),
            deadline: &deadline,
            stopped: &stopped,
            check_error: &error,
            running: true,
            stopped_since: Some(Instant::now() - Duration::from_secs(5)),
        };
        assert!(guarded.read(&mut [0; 1]).is_err());
        assert!(stopped.get());
        assert_eq!(calls.get(), 1);
        assert!(error.borrow().is_none());
    }
    #[test]
    fn slow_headers_have_an_absolute_deadline_and_reads_do_not_poll_each_chunk() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&[1; 30]).unwrap();
        let deadline = Cell::new(Some(Instant::now() + Duration::from_secs(5)));
        let stopped = Cell::new(false);
        let error = RefCell::new(None);
        let calls = Cell::new(0);
        let check = || {
            calls.set(calls.get() + 1);
            Ok(true)
        };
        let mut guarded = Guarded {
            stream: reader,
            check: &check,
            last: Instant::now(),
            deadline: &deadline,
            stopped: &stopped,
            check_error: &error,
            running: true,
            stopped_since: None,
        };
        for _ in 0..30 {
            assert_eq!(guarded.read(&mut [0; 1]).unwrap(), 1);
        }
        assert_eq!(calls.get(), 0);
        deadline.set(Some(Instant::now()));
        assert_eq!(
            guarded.read(&mut [0; 1]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(!stopped.get());
    }
    #[test]
    fn a_short_gap_after_stop_does_not_discard_delayed_tail_bytes() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        reader
            .set_read_timeout(Some(Duration::from_millis(5)))
            .unwrap();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            writer.write_all(b"x").unwrap();
        });
        let deadline = Cell::new(None);
        let stopped = Cell::new(false);
        let error = RefCell::new(None);
        let check = || Ok(false);
        let mut guarded = Guarded {
            stream: reader,
            check: &check,
            last: Instant::now(),
            deadline: &deadline,
            stopped: &stopped,
            check_error: &error,
            running: false,
            stopped_since: None,
        };
        let mut byte = [0];
        assert_eq!(guarded.read(&mut byte).unwrap(), 1);
        assert_eq!(byte, *b"x");
        assert!(!stopped.get());
        assert!(guarded.stopped_since.is_none());
        sender.join().unwrap();
    }
    #[test]
    fn identity_failure_retains_its_named_refusal() {
        let (reader, _writer) = UnixStream::pair().unwrap();
        let deadline = Cell::new(None);
        let stopped = Cell::new(false);
        let error = RefCell::new(None);
        let check = || {
            Err(CandidateError::new(
                "native_log_selection_changed",
                "Selection changed.",
            ))
        };
        let mut guarded = Guarded {
            stream: reader,
            check: &check,
            last: Instant::now() - Duration::from_secs(5),
            deadline: &deadline,
            stopped: &stopped,
            check_error: &error,
            running: true,
            stopped_since: None,
        };
        assert!(guarded.read(&mut [0; 1]).is_err());
        assert_eq!(
            error.into_inner().unwrap().code,
            "native_log_selection_changed"
        );
        assert!(!stopped.get());
    }
    fn frame(bytes: &[u8]) -> Vec<u8> {
        let mut v = vec![1, 0, 0, 0];
        v.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        v.extend_from_slice(bytes);
        v
    }
    #[test]
    fn streams_large_frames_in_fixed_envelopes_across_http_chunks() {
        let payload = vec![b'a'; 300_000];
        let frame = frame(&payload);
        let mut wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for chunk in frame.chunks(37) {
            write!(wire, "{:x}\r\n", chunk.len()).unwrap();
            wire.extend_from_slice(chunk);
            wire.extend_from_slice(b"\r\n");
        }
        wire.extend_from_slice(b"0\r\n\r\n");
        let mut output = Vec::new();
        copy(&wire[..], &mut output, "web", &"a".repeat(64)).unwrap();
        let mut total = 0;
        for line in output.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            assert!(line.len() < 6000);
            let v: serde_json::Value = serde_json::from_slice(line).unwrap();
            if v["kind"] == "native-log-attached" {
                continue;
            }
            total += STANDARD.decode(v["data"].as_str().unwrap()).unwrap().len();
        }
        assert_eq!(total, payload.len());
    }
    #[test]
    fn engine_timestamp_syntax_accepts_offsets_and_refuses_query_bytes() {
        for stamp in [
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.123456789Z",
            "2026-01-01T00:00:00+02:00",
            "2026-01-01T00:00:00.1-05:30",
        ] {
            assert!(valid_timestamp(stamp));
        }
        for stamp in [
            "",
            "2026-01-01T00:00:00Z&tail=all",
            "2026-01-01T00:00:00+02:000",
            "2026-01-01T00:00:00.1234567890Z",
        ] {
            assert!(!valid_timestamp(stamp));
        }
    }
    #[test]
    fn timestamps_are_metadata_even_on_partial_engine_frames() {
        let stamp = "2026-01-01T00:00:00.123456789+02:00";
        let wire = [
            b"HTTP/1.1 200 OK\r\n\r\n".as_slice(),
            &frame(format!("{stamp} abc").as_bytes()),
            &frame(format!("{stamp} def\n").as_bytes()),
        ]
        .concat();
        let mut output = Vec::new();
        copy_started(&wire[..], &mut output, "web", &"a".repeat(64), true, || {}).unwrap();
        let events: Vec<serde_json::Value> = output
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice(l).unwrap())
            .collect();
        assert_eq!(events[0]["kind"], "native-log-attached");
        assert_eq!(events[1]["timestamp"], stamp);
        assert_eq!(events[2]["timestamp"], stamp);
        assert_eq!(
            STANDARD
                .decode(events[1]["data"].as_str().unwrap())
                .unwrap(),
            b"abc"
        );
        assert_eq!(
            STANDARD
                .decode(events[2]["data"].as_str().unwrap())
                .unwrap(),
            b"def\n"
        );
    }
    #[test]
    fn truncated_http_chunk_delivers_payload_before_missing_trailer_refusal() {
        let mut wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nc\r\n".to_vec();
        wire.extend_from_slice(&frame(b"tail"));
        let mut output = Vec::new();
        assert!(copy(&wire[..], &mut output, "web", &"a".repeat(64)).is_err());
        let events: Vec<serde_json::Value> = output
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice(l).unwrap())
            .collect();
        assert_eq!(events[1]["data"], "dGFpbA==");
    }
    #[test]
    fn refuses_bad_frames_headers_and_truncated_body() {
        for wire in [
            b"HTTP/1.1 500 Error\r\n\r\n".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n\x01\0\0\0\0\0\0\x02x".to_vec(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nX\r\n".to_vec(),
            [
                b"HTTP/1.1 200 OK\r\n\r\n".as_slice(),
                &[3, 0, 0, 0, 0, 0, 0, 1, b'x'],
            ]
            .concat(),
        ] {
            assert!(copy(&wire[..], &mut Vec::new(), "web", "id").is_err());
        }
    }
    #[test]
    fn broken_consumer_stops_reading_without_accumulating() {
        let wire = [
            b"HTTP/1.1 200 OK\r\n\r\n".as_slice(),
            &frame(&vec![b'a'; 10000]),
        ]
        .concat();
        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        struct Counted<'a> {
            input: &'a [u8],
            read: &'a Cell<usize>,
        }
        impl Read for Counted<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                let n = self.input.read(out)?;
                self.read.set(self.read.get() + n);
                Ok(n)
            }
        }
        let count = Cell::new(0);
        assert!(
            copy(
                Counted {
                    input: &wire,
                    read: &count
                },
                &mut Closed,
                "web",
                "id"
            )
            .is_err()
        );
        assert!(count.get() <= 8192);
        assert!(count.get() < wire.len());
    }
}
