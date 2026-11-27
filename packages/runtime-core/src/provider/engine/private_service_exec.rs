//! Fresh per-command values travel only over an upgraded exec's stdin.
//!
//! Stream I/O goes through [`super::exec_io`] (poll plus nonblocking send and recv), never
//! `SO_RCVTIMEO`/`SO_SNDTIMEO`: macOS can reject those options once the peer has closed
//! with output still queued, which a short command under host load does (HACK-2357).
//! Every failure names its step and reason, and says whether the command can have run:
//! the environment launcher starts the command only after the complete values document
//! and EOF, so any failure before the last value byte is sent leaves it unrun.
use crate::CandidateError;
use std::{
    collections::BTreeMap,
    io,
    net::Shutdown,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// The private exec step that failed. Steps before [`Stage::Release`] cannot have run
/// the command. Create, connect and start occur only in the macOS engine path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    /// Creating the exec instance; nothing is started.
    Create,
    /// Connecting to the engine socket for the attached start.
    Connect,
    /// The attached start request and its upgrade response.
    Start,
    /// Reading the launcher's hello.
    Hello,
    /// Sending the values document, before its last byte.
    Deliver,
    /// Ending the values document (EOF). The launcher may already hold the whole
    /// document, so the command may run.
    Release,
    /// Reading the command's output.
    Output,
    /// Inspecting the finished exec for its exit code.
    Inspect,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Connect => "connect",
            Self::Start => "start",
            Self::Hello => "hello",
            Self::Deliver => "deliver",
            Self::Release => "release",
            Self::Output => "output",
            Self::Inspect => "inspect",
        }
    }
    fn may_have_run(self) -> bool {
        matches!(self, Self::Release | Self::Output | Self::Inspect)
    }
}

/// Why the step failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reason {
    /// The exec's deadline passed.
    Deadline,
    /// The peer closed or reset the stream early.
    Closed,
    /// Another transport error.
    Io,
    /// The peer sent something outside the protocol, or a response was malformed.
    Protocol,
}
impl Reason {
    fn name(self) -> &'static str {
        match self {
            Self::Deadline => "deadline",
            Self::Closed => "closed",
            Self::Io => "io",
            Self::Protocol => "protocol",
        }
    }
}

pub(super) fn failed(stage: Stage, reason: Reason) -> CandidateError {
    let error = if stage.may_have_run() {
        CandidateError::new(
            "graph_service_exec_uncertain",
            "Private exec completion is uncertain; command effects may have occurred. No request was replayed.",
        )
    } else {
        CandidateError::new(
            "graph_service_exec_not_run",
            "Private exec stopped before the command ran, so it had no effects. No request was replayed; it is safe to retry.",
        )
    };
    error.with_exec_stage(stage.name(), reason.name(), stage.may_have_run())
}
fn remaining(deadline: Instant, stage: Stage) -> Result<Duration, CandidateError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or_else(|| failed(stage, Reason::Deadline))
}
/// `Deadline` once the exec's deadline has passed, otherwise `reason`.
#[cfg(all(target_os = "macos", feature = "environment-launcher"))]
fn past_or(deadline: Instant, reason: Reason) -> Reason {
    if Instant::now() >= deadline {
        Reason::Deadline
    } else {
        reason
    }
}
fn io_failure(stage: Stage, error: &io::Error) -> CandidateError {
    let reason = match error.kind() {
        io::ErrorKind::TimedOut => Reason::Deadline,
        io::ErrorKind::BrokenPipe
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::UnexpectedEof => Reason::Closed,
        _ => Reason::Io,
    };
    failed(stage, reason)
}
/// One bounded read; `Ok(0)` is EOF. Interrupted and not-yet-ready reads are retried
/// until the deadline.
fn read_some(
    stream: &UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
    stage: Stage,
) -> Result<usize, CandidateError> {
    loop {
        match super::exec_io::read(stream, bytes, deadline) {
            Ok(count) => return Ok(count),
            Err(error) if super::exec_io::retry(&error) => continue,
            Err(error) => return Err(io_failure(stage, &error)),
        }
    }
}
fn read_exact_until(
    stream: &UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
    stage: Stage,
) -> Result<(), CandidateError> {
    while !bytes.is_empty() {
        let count = read_some(stream, bytes, deadline, stage)?;
        if count == 0 {
            return Err(failed(stage, Reason::Closed));
        }
        bytes = &mut bytes[count..];
    }
    remaining(deadline, stage)?;
    Ok(())
}
fn frame(
    stream: &UnixStream,
    deadline: Instant,
    limit: usize,
) -> Result<(u8, Vec<u8>), CandidateError> {
    let stage = Stage::Hello;
    remaining(deadline, stage)?;
    let mut header = [0u8; 8];
    read_exact_until(stream, &mut header, deadline, stage)?;
    let n = u32::from_be_bytes(
        header[4..8]
            .try_into()
            .map_err(|_| failed(stage, Reason::Protocol))?,
    ) as usize;
    if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] || n > limit {
        return Err(failed(stage, Reason::Protocol));
    }
    let mut bytes = vec![0; n];
    read_exact_until(stream, &mut bytes, deadline, stage)?;
    Ok((header[0], bytes))
}
/// Whole seconds of `remaining`, rounded up, so a sub-second remainder still gives the
/// launcher a future expiry. The host deadline still bounds the exec itself.
fn expiry_seconds(remaining: Duration) -> u64 {
    remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0)
}
fn deliver(
    stream: &mut UnixStream,
    deadline: Instant,
    values: &BTreeMap<String, String>,
) -> Result<(), CandidateError> {
    deliver_with(stream, deadline, values, super::exec_io::write)
}
/// [`deliver`] with an injectable writer, so tests can fail a write after it sent bytes.
fn deliver_with(
    stream: &mut UnixStream,
    deadline: Instant,
    values: &BTreeMap<String, String>,
    mut write: impl FnMut(&UnixStream, &[u8], Instant) -> io::Result<usize>,
) -> Result<(), CandidateError> {
    let mut hello = Vec::new();
    while !hello.ends_with(b"\n") {
        let (kind, bytes) = frame(stream, deadline, 64 - hello.len())?;
        if kind != 1 || bytes.is_empty() {
            return Err(failed(Stage::Hello, Reason::Protocol));
        }
        hello.extend(bytes);
        if hello.len() >= 64 {
            return Err(failed(Stage::Hello, Reason::Protocol));
        }
    }
    let now = std::str::from_utf8(&hello)
        .ok()
        .and_then(|v| v.strip_prefix("HKEE1 "))
        .and_then(|v| v.strip_suffix('\n'))
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| failed(Stage::Hello, Reason::Protocol))?;
    let expires = now
        .checked_add(expiry_seconds(remaining(deadline, Stage::Deliver)?))
        .ok_or_else(|| failed(Stage::Hello, Reason::Protocol))?;
    if expires <= now {
        return Err(failed(Stage::Deliver, Reason::Deadline));
    }
    #[derive(serde::Serialize)]
    struct Envelope<'a> {
        version: u8,
        expires: u64,
        values: &'a BTreeMap<String, String>,
    }
    let mut bytes = Zeroizing::new(vec![0u8; 65536]);
    let used = {
        let mut cursor = std::io::Cursor::new(bytes.as_mut_slice());
        serde_json::to_writer(
            &mut cursor,
            &Envelope {
                version: 1,
                expires,
                values,
            },
        )
        .map_err(|_| failed(Stage::Deliver, Reason::Protocol))?;
        cursor.position() as usize
    };
    bytes.truncate(used);
    // Until the last byte is accepted the launcher holds an incomplete document, which
    // never parses, so the command cannot run. A failure after send accepted bytes of
    // unknown count may have completed the document, so it counts as release.
    let mut pending = bytes.as_slice();
    while !pending.is_empty() {
        match write(stream, pending, deadline) {
            Ok(0) => return Err(failed(Stage::Deliver, Reason::Closed)),
            Ok(count) => pending = &pending[count..],
            Err(error) if super::exec_io::sent_before(&error) => {
                return Err(io_failure(Stage::Release, &error));
            }
            Err(error) if super::exec_io::retry(&error) => continue,
            Err(error) => return Err(io_failure(Stage::Deliver, &error)),
        }
    }
    remaining(deadline, Stage::Release)?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| io_failure(Stage::Release, &error))?;
    Ok(())
}
/// After the exec's deadline, output keeps being read while bytes still arrive: a gap this
/// long with no byte and no EOF ends it.
pub(super) const OUTPUT_IDLE_GRACE: Duration = Duration::from_secs(5);
/// Past the exec's deadline, output is never read for longer than this.
pub(super) const OUTPUT_DRAIN_CEILING: Duration = Duration::from_secs(20);
/// The finished exec's inspection gets at least this long, however late the output ended.
#[cfg(all(target_os = "macos", feature = "environment-launcher"))]
const INSPECT_GRACE: Duration = Duration::from_secs(5);

/// Read the attached output to EOF, keeping bytes the peer queued before it closed.
///
/// The exec's deadline bounds how long a silent command is waited for, not how long a slow
/// host may take to read output that is already arriving (HACK-2357): a command that
/// finished while a starved host fell behind still ends in EOF, and reporting it as
/// uncertain would tell the user a completed command may not have run. So once the deadline
/// has passed, reading continues while bytes keep arriving, with `idle_grace` allowed
/// between them and an absolute `ceiling` past the deadline. Only a stream that stays silent
/// for `idle_grace`, or keeps going past `ceiling`, is uncertain. Retained output is the
/// streaming capture's first 1 MiB of each stream; the rest is read and counted
/// (HACK-2759: a 4 MiB bound on the raw stream failed a larger output as uncertain).
fn read_capture(
    stream: &UnixStream,
    deadline: Instant,
) -> Result<super::service_exec::Capture, CandidateError> {
    let mut capture = super::service_exec::Capture::default();
    read_output_within(
        stream,
        deadline,
        OUTPUT_IDLE_GRACE,
        OUTPUT_DRAIN_CEILING,
        &mut |bytes| {
            capture
                .feed(bytes)
                .map_err(|_| failed(Stage::Output, Reason::Protocol))
        },
    )?;
    capture
        .finish()
        .map_err(|_| failed(Stage::Output, Reason::Protocol))
}
/// The raw bytes [`read_output_within`] reads, for the read-loop tests.
#[cfg(test)]
fn read_output(stream: &UnixStream, deadline: Instant) -> Result<Vec<u8>, CandidateError> {
    let mut raw = Vec::new();
    read_output_within(
        stream,
        deadline,
        OUTPUT_IDLE_GRACE,
        OUTPUT_DRAIN_CEILING,
        &mut |bytes| {
            raw.extend_from_slice(bytes);
            Ok(())
        },
    )?;
    Ok(raw)
}
/// When the next output read gives up: never before `deadline`; after it, one `idle_grace`
/// past the last byte (or the start of reading), but never past `deadline + ceiling`.
fn output_window(
    deadline: Instant,
    last_progress: Instant,
    idle_grace: Duration,
    ceiling: Duration,
) -> Instant {
    deadline.max((last_progress + idle_grace).min(deadline + ceiling))
}
fn read_output_within(
    stream: &UnixStream,
    deadline: Instant,
    idle_grace: Duration,
    ceiling: Duration,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let mut last_progress = Instant::now();
    let mut buffer = [0u8; 8192];
    loop {
        let window = output_window(deadline, last_progress, idle_grace, ceiling);
        let n = match read_some(stream, &mut buffer, window, Stage::Output) {
            Ok(n) => n,
            // The window passed while this host was not running. Whatever the peer had
            // already queued, including EOF, still counts (from #982); only a stream with
            // nothing queued is uncertain. Draining never waits; the sink bounds what it keeps.
            Err(timeout) if Instant::now() >= window => return drain_queued(stream, sink, timeout),
            Err(error) => return Err(error),
        };
        if n == 0 {
            return Ok(());
        }
        sink(&buffer[..n])?;
        last_progress = Instant::now();
    }
}
/// The most a drain after the output window reads before it calls the stream unfinished.
const DRAIN_LIMIT: usize = 4 * 1024 * 1024;
/// Read what the peer already queued after the output window passed: the output if it
/// reaches EOF, otherwise the window's own failure. A finished command leaves at most a
/// socket buffer queued; a peer still writing past [`DRAIN_LIMIT`] has not finished, so the
/// drain ends there instead of following it forever (HACK-2759).
fn drain_queued(
    stream: &UnixStream,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), CandidateError>,
    timeout: CandidateError,
) -> Result<(), CandidateError> {
    let mut buffer = [0u8; 8192];
    let mut drained = 0;
    loop {
        match super::exec_io::read_queued(stream, &mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) if drained + n > DRAIN_LIMIT => return Err(timeout),
            Ok(n) => {
                drained += n;
                sink(&buffer[..n])?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(timeout),
        }
    }
}
#[cfg(all(target_os = "macos", feature = "environment-launcher"))]
impl super::Engine<'_> {
    pub(in crate::provider) fn service_exec_private(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        deadline: Instant,
        values_deadline: Instant,
        values: &BTreeMap<String, String>,
    ) -> Result<super::service_exec::ExecOutput, CandidateError> {
        use reqwest::Method;
        // The values' lifetime bounds every step until they are delivered; afterwards only
        // the exec's own deadline applies, extended for output already arriving.
        let deadline_for_values = values_deadline.min(deadline);
        use serde_json::json;
        if self.cleanup_only {
            return Err(failed(Stage::Create, Reason::Protocol));
        }
        self.guest.verify()?;
        self.guest.before_effect()?;
        let socket = self.guest.engine_socket()?;
        let mut body = json!({"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"Tty":false,"Privileged":false,"Cmd":argv});
        if let Some(dir) = workdir {
            body["WorkingDir"] = json!(dir);
        }
        // An engine refusal such as a missing container keeps its own code; every other
        // create failure is tagged. Nothing has started either way.
        let tagged = |stage: Stage, error: CandidateError| {
            if error.code == "engine_not_found" {
                error
            } else {
                failed(stage, past_or(deadline_for_values, Reason::Io))
            }
        };
        let created =
            super::Transport::new(&socket, remaining(deadline_for_values, Stage::Create)?)
                .map_err(|error| tagged(Stage::Create, error))?
                .request(
                    Method::POST,
                    &format!("/v1.53/containers/{container}/exec"),
                    Some(&body),
                )
                .map_err(|error| tagged(Stage::Create, error))?;
        let id = created["Id"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| failed(Stage::Create, Reason::Protocol))?;
        self.guest.verify()?;
        self.guest.before_effect()?;
        let mut stream = crate::provider::agent::connect_until(&socket, deadline_for_values)
            .map_err(|_| failed(Stage::Connect, past_or(deadline_for_values, Reason::Io)))?;
        super::relay_exec::start_classified(&mut stream, id, deadline_for_values).map_err(
            |failure| {
                use super::relay_exec::StartFailure;
                failed(
                    Stage::Start,
                    match failure {
                        StartFailure::Deadline => Reason::Deadline,
                        StartFailure::Closed => Reason::Closed,
                        StartFailure::Io => past_or(deadline_for_values, Reason::Io),
                        StartFailure::Protocol => Reason::Protocol,
                    },
                )
            },
        )?;
        deliver(&mut stream, deadline_for_values, values)?;
        let output = read_capture(&stream, deadline)?;
        self.guest
            .verify()
            .map_err(|_| failed(Stage::Inspect, Reason::Io))?;
        // EOF means the command's output is complete; the engine may record its exit a
        // moment later, so inspection gets its own short grace and retries while the exec
        // still reads as running.
        let inspect_deadline = deadline.max(Instant::now() + INSPECT_GRACE);
        let inspected = loop {
            let inspected =
                super::Transport::new(&socket, remaining(inspect_deadline, Stage::Inspect)?)
                    .map_err(|_| failed(Stage::Inspect, past_or(inspect_deadline, Reason::Io)))?
                    .request(Method::GET, &format!("/v1.53/exec/{id}/json"), None)
                    .map_err(|_| failed(Stage::Inspect, past_or(inspect_deadline, Reason::Io)))?;
            if inspected["ID"] != id || inspected["ContainerID"] != container {
                return Err(failed(Stage::Inspect, Reason::Protocol));
            }
            match inspected["Running"].as_bool() {
                Some(false) => break inspected,
                Some(true) if Instant::now() + Duration::from_millis(50) < inspect_deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Some(true) => return Err(failed(Stage::Inspect, Reason::Deadline)),
                None => return Err(failed(Stage::Inspect, Reason::Protocol)),
            }
        };
        let exit_code = inspected["ExitCode"]
            .as_i64()
            .filter(|v| (0..=255).contains(v))
            .ok_or_else(|| failed(Stage::Inspect, Reason::Protocol))?
            as i32;
        Ok(super::service_exec::ExecOutput {
            exit_code,
            truncated: output.stdout_dropped + output.stderr_dropped > 0,
            stdout: output.stdout,
            stderr: output.stderr,
            stdout_dropped: output.stdout_dropped,
            stderr_dropped: output.stderr_dropped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn send(stream: &mut UnixStream, body: &[u8]) {
        let mut header = [0u8; 8];
        header[0] = 1;
        header[4..].copy_from_slice(&(body.len() as u32).to_be_bytes());
        stream.write_all(&header).unwrap();
        stream.write_all(body).unwrap();
    }
    #[test]
    fn partial_frame_cannot_extend_deadline() {
        let (host, mut guest) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            for byte in [1, 0, 0, 0, 0, 0, 0, 8] {
                if guest.write_all(&[byte]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let started = Instant::now();
        assert!(frame(&host, started + Duration::from_millis(50), 64).is_err());
        assert!(started.elapsed() < Duration::from_millis(140));
        drop(host);
        worker.join().unwrap();
    }
    #[test]
    fn fresh_values_follow_valid_split_hello_and_end_at_eof() {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            guest
                .set_read_timeout(Some(Duration::from_millis(30)))
                .unwrap();
            assert!(guest.read(&mut [0u8; 1]).is_err());
            send(&mut guest, b"HKEE1 ");
            send(&mut guest, b"100\n");
            guest
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            guest.read_to_end(&mut bytes).unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        });
        deliver(
            &mut host,
            Instant::now() + Duration::from_secs(3),
            &BTreeMap::from([("TOKEN".into(), "synthetic-private-value".into())]),
        )
        .unwrap();
        let result = thread.join().unwrap();
        assert_eq!(result["values"]["TOKEN"], "synthetic-private-value");
        assert_eq!(result["version"], 1);
        assert!(result["expires"].as_u64().unwrap() <= 103);
    }
    #[test]
    fn malformed_hello_or_expired_deadline_never_delivers_values() {
        for hello in [
            b"unknown\n".as_slice(),
            b"HKEE1 18446744073709551615\n",
            b"HKEE1 -1\n",
        ] {
            let (mut host, mut guest) = UnixStream::pair().unwrap();
            send(&mut guest, hello);
            assert!(
                deliver(
                    &mut host,
                    Instant::now() + Duration::from_secs(2),
                    &BTreeMap::new()
                )
                .is_err()
            );
            drop(host);
            let mut bytes = Vec::new();
            guest.read_to_end(&mut bytes).unwrap();
            assert!(bytes.is_empty());
        }
        let (mut host, _guest) = UnixStream::pair().unwrap();
        assert!(deliver(&mut host, Instant::now(), &BTreeMap::new()).is_err());
    }
    #[test]
    fn split_hello_cannot_refresh_original_deadline() {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        send(&mut guest, b"HKEE1 ");
        let started = Instant::now();
        assert!(
            deliver(
                &mut host,
                started + Duration::from_millis(50),
                &BTreeMap::new()
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    fn stage_of(error: &CandidateError) -> serde_json::Value {
        serde_json::to_value(error).unwrap()["exec_stage"].clone()
    }
    #[test]
    fn failures_name_their_stage_and_whether_the_command_can_have_run() {
        // The launcher never sends a hello: the deadline passes in the hello stage.
        let (mut host, _guest) = UnixStream::pair().unwrap();
        let error = deliver(
            &mut host,
            Instant::now() + Duration::from_millis(30),
            &BTreeMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, "graph_service_exec_not_run");
        assert_eq!(
            stage_of(&error),
            serde_json::json!({"version":1,"stage":"hello","reason":"deadline","command_may_have_run":false})
        );
        // The launcher closes after its hello: delivery cannot finish, so nothing ran.
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        send(&mut guest, b"HKEE1 100\n");
        drop(guest);
        let error = deliver(
            &mut host,
            Instant::now() + Duration::from_secs(2),
            &BTreeMap::from([("TOKEN".into(), "synthetic-private-value".into())]),
        )
        .unwrap_err();
        assert_eq!(error.code, "graph_service_exec_not_run");
        assert_eq!(stage_of(&error)["stage"], "deliver");
        assert_eq!(stage_of(&error)["reason"], "closed");
        // Output and inspection failures may follow a command that ran.
        for stage in [Stage::Release, Stage::Output, Stage::Inspect] {
            let error = failed(stage, Reason::Io);
            assert_eq!(error.code, "graph_service_exec_uncertain");
            assert_eq!(stage_of(&error)["command_may_have_run"], true);
        }
        // A malformed frame is a protocol failure, never a value.
        let (host, mut guest) = UnixStream::pair().unwrap();
        guest.write_all(&[9, 0, 0, 0, 0, 0, 0, 1, b'x']).unwrap();
        let error = frame(&host, Instant::now() + Duration::from_secs(1), 64).unwrap_err();
        assert_eq!(stage_of(&error)["reason"], "protocol");
        assert!(!serde_json::to_string(&error).unwrap().contains("synthetic"));
    }
    #[test]
    fn output_queued_before_the_peer_closes_is_read_to_eof() {
        // HACK-2357: a short command finishes and the engine closes the stream while its
        // output is still queued for a slow host. Every queued byte is still delivered.
        let (host, mut guest) = UnixStream::pair().unwrap();
        let output: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let writer = {
            let output = output.clone();
            std::thread::spawn(move || {
                guest.write_all(&output).unwrap();
            })
        };
        // The host is late: the peer has written and closed before the first read.
        std::thread::sleep(Duration::from_millis(50));
        let raw = read_output(&host, Instant::now() + Duration::from_secs(5)).unwrap();
        writer.join().unwrap();
        assert_eq!(raw, output);
    }
    #[test]
    fn a_sub_second_remainder_still_gives_the_launcher_a_future_expiry() {
        assert_eq!(expiry_seconds(Duration::from_millis(1)), 1);
        assert_eq!(expiry_seconds(Duration::from_millis(1500)), 2);
        assert_eq!(expiry_seconds(Duration::from_secs(3)), 3);
    }
    /// One full fake conversation: hello, values to EOF, then a command that writes its
    /// output and exits. The host reads the output only after the command has finished and
    /// after the exec's deadline has passed, as a starved host does.
    fn finished_conversation() -> Result<Vec<u8>, CandidateError> {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        let launcher = std::thread::spawn(move || {
            send(&mut guest, b"HKEE1 7\n");
            let mut values = Vec::new();
            // A delivery the host abandoned never runs the command.
            if guest.read_to_end(&mut values).is_err() {
                return false;
            }
            let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&values) else {
                return false;
            };
            assert_eq!(parsed["values"]["TOKEN"], "synthetic-private-value");
            let mut out = vec![1u8, 0, 0, 0, 0, 0, 0, 3];
            out.extend_from_slice(b"ok\n");
            guest.write_all(&out).unwrap();
            true
        });
        deliver(
            &mut host,
            Instant::now() + Duration::from_secs(60),
            &BTreeMap::from([("TOKEN".into(), "synthetic-private-value".into())]),
        )?;
        assert!(launcher.join().unwrap(), "the command ran and finished");
        // The exec's deadline has already passed when the starved host gets to the output.
        read_output(&host, Instant::now())
    }
    #[test]
    fn a_finished_command_read_after_the_deadline_is_complete_not_uncertain() {
        assert_eq!(
            finished_conversation().unwrap(),
            [1u8, 0, 0, 0, 0, 0, 0, 3, b'o', b'k', b'\n']
        );
    }
    #[test]
    fn the_output_window_waits_for_the_deadline_then_for_silence_or_the_ceiling() {
        let base = Instant::now();
        let at = |ms: u64| base + Duration::from_millis(ms);
        let grace = Duration::from_millis(5_000);
        let ceiling = Duration::from_millis(20_000);
        // Before the deadline the deadline itself governs, however recent the last byte.
        assert_eq!(output_window(at(30_000), at(0), grace, ceiling), at(30_000));
        assert_eq!(
            output_window(at(30_000), at(29_000), grace, ceiling),
            at(34_000)
        );
        // After it, one grace past the last byte.
        assert_eq!(
            output_window(at(30_000), at(31_000), grace, ceiling),
            at(36_000)
        );
        // A byte late in the drain cannot push past the ceiling.
        assert_eq!(
            output_window(at(30_000), at(48_000), grace, ceiling),
            at(50_000)
        );
        // Reading that starts after the ceiling gets no extra time.
        assert_eq!(
            output_window(at(30_000), at(60_000), grace, ceiling),
            at(50_000)
        );
    }
    #[test]
    fn output_queued_past_the_ceiling_is_still_read_to_eof() {
        // From #982: even a host that resumes after the whole drain window has passed
        // returns a finished command's queued output rather than calling it uncertain.
        let (host, mut guest) = UnixStream::pair().unwrap();
        // Below macOS's default 8 KiB AF_UNIX send buffer, so the write completes unread.
        let output: Vec<u8> = (0..6_000u32).map(|i| (i % 251) as u8).collect();
        let writer = {
            let output = output.clone();
            std::thread::spawn(move || guest.write_all(&output).unwrap())
        };
        writer.join().unwrap();
        let long_ago = Instant::now() - Duration::from_secs(120);
        let raw = read_output(&host, long_ago).unwrap();
        assert_eq!(raw, output);
    }
    #[test]
    fn a_silent_open_stream_past_the_deadline_is_uncertain_output() {
        // No scheduling assumption: nothing is ever written.
        let (host, _guest) = UnixStream::pair().unwrap();
        let started = Instant::now();
        let error = read_output_within(
            &host,
            started,
            Duration::from_millis(100),
            Duration::from_secs(5),
            &mut |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code, "graph_service_exec_uncertain");
        assert_eq!(stage_of(&error)["stage"], "output");
        assert_eq!(stage_of(&error)["reason"], "deadline");
        assert!(started.elapsed() >= Duration::from_millis(100));
    }

    #[test]
    fn on_a_cpu_starved_host_a_finished_command_is_never_uncertain() {
        // Saturate every core while many exec conversations run. Each command finishes
        // before the host reads its output, after the exec's deadline. A delivery that a
        // starved host could not finish in time is `not_run` and is allowed; a finished
        // command reported as uncertain is not.
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let spinners: Vec<_> = (0..std::thread::available_parallelism().map_or(4, |n| n.get() * 2))
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        std::hint::spin_loop();
                    }
                })
            })
            .collect();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(move || {
                    let mut uncertain = 0;
                    for _ in 0..25 {
                        match finished_conversation() {
                            Ok(raw) => {
                                assert_eq!(raw, [1u8, 0, 0, 0, 0, 0, 0, 3, b'o', b'k', b'\n']);
                            }
                            Err(error) if error.code == "graph_service_exec_not_run" => {}
                            Err(_) => uncertain += 1,
                        }
                    }
                    uncertain
                })
            })
            .collect();
        let uncertain: Vec<_> = workers.into_iter().map(|w| w.join()).collect();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for spinner in spinners {
            spinner.join().unwrap();
        }
        assert!(
            uncertain.iter().all(|count| matches!(count, Ok(0))),
            "a finished command was reported uncertain: {uncertain:?}"
        );
    }

    #[test]
    fn a_write_that_fails_after_sending_bytes_may_have_run_and_is_never_resent() {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        send(&mut guest, b"HKEE1 100\n");
        let mut calls = 0;
        let error = deliver_with(
            &mut host,
            Instant::now() + Duration::from_secs(2),
            &BTreeMap::from([("TOKEN".into(), "synthetic-private-value".into())]),
            |stream, bytes, deadline| {
                calls += 1;
                // Send everything, then report the flag-restore failure.
                super::super::exec_io::write(stream, bytes, deadline)?;
                Err(io::Error::other(super::super::exec_io::SentThenFailed))
            },
        )
        .unwrap_err();
        assert_eq!(calls, 1, "bytes the peer may hold are never resent");
        assert_eq!(error.code, "graph_service_exec_uncertain");
        assert_eq!(stage_of(&error)["stage"], "release");
        assert_eq!(stage_of(&error)["command_may_have_run"], true);
    }
    #[test]
    fn every_stage_names_itself_and_only_release_and_later_may_have_run() {
        let stages = [
            (Stage::Create, "create", false),
            (Stage::Connect, "connect", false),
            (Stage::Start, "start", false),
            (Stage::Hello, "hello", false),
            (Stage::Deliver, "deliver", false),
            (Stage::Release, "release", true),
            (Stage::Output, "output", true),
            (Stage::Inspect, "inspect", true),
        ];
        for (stage, name, may_have_run) in stages {
            let error = failed(stage, Reason::Deadline);
            assert_eq!(stage_of(&error)["stage"], name);
            assert_eq!(stage_of(&error)["command_may_have_run"], may_have_run);
            assert_eq!(
                error.code,
                if may_have_run {
                    "graph_service_exec_uncertain"
                } else {
                    "graph_service_exec_not_run"
                }
            );
        }
    }
    /// `total` bytes of one stream, multiplexed in engine-sized frames.
    fn framed(stream: u8, total: usize) -> (Vec<u8>, Vec<u8>) {
        let output: Vec<u8> = (0..total).map(|i| b'a' + (i % 23) as u8).collect();
        let mut multiplexed = Vec::new();
        for chunk in output.chunks(32 * 1024 + 7) {
            multiplexed.extend_from_slice(&[stream, 0, 0, 0]);
            multiplexed.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
            multiplexed.extend_from_slice(chunk);
        }
        (output, multiplexed)
    }
    /// HACK-2759 (review M2): a Compose exec with fresh values failed past 4 MiB of raw
    /// output. At 1.35 MB, 4 MiB + 13 and 10 MB it keeps the first 1 MiB of each stream
    /// and counts the rest.
    #[test]
    fn a_large_private_exec_output_keeps_its_beginning_and_counts_the_rest() {
        for total in [1_350_880, 4 * 1024 * 1024 + 13, 10_000_000] {
            let (host, mut guest) = UnixStream::pair().unwrap();
            let (output, multiplexed) = framed(1, total);
            let writer = std::thread::spawn(move || guest.write_all(&multiplexed).unwrap());
            let capture = read_capture(&host, Instant::now() + Duration::from_secs(20)).unwrap();
            writer.join().unwrap();
            let limit = super::super::service_exec::OUTPUT_LIMIT;
            assert_eq!(capture.stdout, output[..limit], "{total}");
            assert_eq!(capture.stdout_dropped, (total - limit) as u64);
            assert!(capture.stderr.is_empty());
        }
    }
    /// HACK-2759 (review L2): a command whose output never ends is not read forever.
    /// The read gives up at its ceiling past the deadline, the queued drain at its own
    /// bound, and the outcome is uncertain.
    #[test]
    fn a_writer_that_never_stops_ends_the_read_as_uncertain() {
        let (host, mut guest) = UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            let (_, frame) = framed(1, 64 * 1024);
            while guest.write_all(&frame).is_ok() {}
        });
        let started = Instant::now();
        let mut capture = super::super::service_exec::Capture::default();
        let error = read_output_within(
            &host,
            started,
            Duration::from_millis(50),
            Duration::from_millis(300),
            &mut |bytes| {
                capture
                    .feed(bytes)
                    .map_err(|_| failed(Stage::Output, Reason::Protocol))
            },
        )
        .unwrap_err();
        drop(host);
        writer.join().unwrap();
        assert_eq!(error.code, "graph_service_exec_uncertain");
        assert_eq!(stage_of(&error)["stage"], "output");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(
            capture.stdout.len(),
            super::super::service_exec::OUTPUT_LIMIT
        );
        assert!(capture.stdout_dropped > 0);
    }
}
