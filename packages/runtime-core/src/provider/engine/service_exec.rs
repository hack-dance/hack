//! Noninteractive exec uses one create and one attached start, never replayed.
use super::*;
use serde_json::json;
use std::time::Instant;

/// The most of each output stream an exec or one-off keeps: its beginning
/// (HACK-2759). The rest is read to the end and only counted.
pub(in crate::provider) const OUTPUT_LIMIT: usize = 1024 * 1024;

pub(in crate::provider) struct ExecOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
    /// Bytes of each stream past [`OUTPUT_LIMIT`], read and dropped. Only the
    /// authored reply carries them; a Compose exec reports `truncated` alone.
    #[cfg_attr(
        not(all(feature = "native-config-plan", target_os = "macos")),
        allow(dead_code)
    )]
    pub stdout_dropped: u64,
    #[cfg_attr(
        not(all(feature = "native-config-plan", target_os = "macos")),
        allow(dead_code)
    )]
    pub stderr_dropped: u64,
}

fn uncertain() -> CandidateError {
    CandidateError::new(
        "graph_service_exec_uncertain",
        "Service exec completion is uncertain; the command may still be running. No request was replayed. Inspect the service before retrying.",
    )
}

/// One multiplexed engine output stream read to its end (HACK-2759). The first
/// [`OUTPUT_LIMIT`] bytes of stdout and of stderr are kept and the rest is only
/// counted, so the size of a command's output never fails the read and memory
/// stays bounded whatever a single frame claims.
#[derive(Default)]
pub(in crate::provider) struct Capture {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_dropped: u64,
    pub stderr_dropped: u64,
    header: Vec<u8>,
    frame: Option<(u8, usize)>,
}
impl Capture {
    fn feed(&mut self, mut bytes: &[u8]) -> Result<(), ()> {
        while !bytes.is_empty() {
            match self.frame {
                None => {
                    let take = (8 - self.header.len()).min(bytes.len());
                    self.header.extend_from_slice(&bytes[..take]);
                    bytes = &bytes[take..];
                    if self.header.len() == 8 {
                        let header = &self.header;
                        if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] {
                            return Err(());
                        }
                        let size =
                            u32::from_be_bytes(header[4..8].try_into().map_err(|_| ())?) as usize;
                        self.frame = (size > 0).then_some((header[0], size));
                        self.header.clear();
                    }
                }
                Some((stream, left)) => {
                    let take = left.min(bytes.len());
                    let (kept, dropped) = if stream == 1 {
                        (&mut self.stdout, &mut self.stdout_dropped)
                    } else {
                        (&mut self.stderr, &mut self.stderr_dropped)
                    };
                    let keep = take.min(OUTPUT_LIMIT - kept.len());
                    kept.extend_from_slice(&bytes[..keep]);
                    *dropped += (take - keep) as u64;
                    bytes = &bytes[take..];
                    self.frame = (left > take).then_some((stream, left - take));
                }
            }
        }
        Ok(())
    }
    /// The stream ended: a partial frame is a protocol failure.
    fn finish(self) -> Result<Self, ()> {
        if self.header.is_empty() && self.frame.is_none() {
            Ok(self)
        } else {
            Err(())
        }
    }
    fn truncated(&self) -> bool {
        self.stdout_dropped + self.stderr_dropped > 0
    }
}

/// [`Capture`] of a complete multiplexed body. Its readers (job logs, private
/// exec) are macOS only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn capture(bytes: &[u8]) -> Result<Capture, CandidateError> {
    let mut capture = Capture::default();
    capture.feed(bytes).map_err(|_| uncertain())?;
    capture.finish().map_err(|_| uncertain())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn decode(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>, bool), CandidateError> {
    let capture = capture(bytes)?;
    let truncated = capture.truncated();
    Ok((capture.stdout, capture.stderr, truncated))
}

/// An engine output stream opened before the command starts (HACK-2759): an
/// exec's upgraded start, or a one-off's attach before its start. It is read to
/// its end into a [`Capture`] afterwards.
pub(in crate::provider) enum Attached {
    Stream {
        stream: std::os::unix::net::UnixStream,
        deadline: Instant,
    },
    #[cfg(test)]
    Recorded(Vec<u8>),
}
impl Attached {
    fn capture(self) -> Result<Capture, ()> {
        match self {
            Self::Stream {
                mut stream,
                deadline,
            } => read_capture(&mut stream, deadline),
            #[cfg(test)]
            Self::Recorded(bytes) => {
                let mut capture = Capture::default();
                capture.feed(&bytes)?;
                capture.finish()
            }
        }
    }
}

/// Wait until `stream` is ready for `events` within `deadline`. The deadline
/// is kept by `poll`: on macOS, changing a socket timeout after the peer
/// closed fails with EINVAL even while output is still buffered.
fn ready(
    stream: &std::os::unix::net::UnixStream,
    events: i16,
    deadline: Instant,
) -> Result<(), ()> {
    use std::os::fd::AsRawFd;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(())?;
        let mut entry = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        let milliseconds = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: one initialized entry for a descriptor the stream owns.
        let count = unsafe { libc::poll(&mut entry, 1, milliseconds) };
        if count > 0 {
            return if entry.revents & libc::POLLNVAL == 0 {
                Ok(())
            } else {
                Err(())
            };
        }
        if count < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(());
        }
    }
}

/// One nonblocking receive within `deadline`; `Ok(0)` is the end of the stream.
fn receive(
    stream: &std::os::unix::net::UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
) -> Result<usize, ()> {
    use std::os::fd::AsRawFd;
    loop {
        ready(stream, libc::POLLIN, deadline)?;
        // SAFETY: the buffer is writable for its length and the stream owns the FD.
        let count = unsafe {
            libc::recv(
                stream.as_raw_fd(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                libc::MSG_DONTWAIT,
            )
        };
        if count >= 0 {
            return Ok(count as usize);
        }
        if !matches!(
            std::io::Error::last_os_error().kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ) {
            return Err(());
        }
    }
}

/// Send all of `bytes` within `deadline`.
fn send_all(
    stream: &std::os::unix::net::UnixStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), ()> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::MSG_DONTWAIT;
    while !bytes.is_empty() {
        ready(stream, libc::POLLOUT, deadline)?;
        // SAFETY: the slice is readable for its length and the stream owns the FD.
        let count = unsafe {
            libc::send(
                stream.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                flags,
            )
        };
        if count > 0 {
            bytes = &bytes[count as usize..];
        } else if count == 0
            || !matches!(
                std::io::Error::last_os_error().kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            )
        {
            return Err(());
        }
    }
    Ok(())
}

/// Send one HTTP request that upgrades `stream` to a raw output stream, and
/// read exactly its response headers, so no stream byte is consumed here.
fn upgrade(
    stream: &mut std::os::unix::net::UnixStream,
    path: &str,
    body: Option<&str>,
    deadline: Instant,
) -> Result<(), ()> {
    let body = body.unwrap_or("");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: hack-local\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    send_all(stream, request.as_bytes(), deadline)?;
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 8192 {
            return Err(());
        }
        let mut byte = [0];
        if receive(stream, &mut byte, deadline)? != 1 {
            return Err(());
        }
        header.push(byte[0]);
    }
    let text = std::str::from_utf8(&header).map_err(|_| ())?;
    let mut lines = text.split("\r\n");
    if !lines
        .next()
        .is_some_and(|status| status.starts_with("HTTP/1.1 101 "))
    {
        return Err(());
    }
    let (mut upgraded, mut connection) = (false, false);
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once(':').ok_or(())?;
        match key.to_ascii_lowercase().as_str() {
            "upgrade" => upgraded = value.trim().eq_ignore_ascii_case("tcp"),
            "connection" => connection = value.trim().eq_ignore_ascii_case("upgrade"),
            "content-length" | "transfer-encoding" => return Err(()),
            _ => {}
        }
    }
    if upgraded && connection {
        Ok(())
    } else {
        Err(())
    }
}

/// Read an upgraded output stream to its end within `deadline`.
fn read_capture(
    stream: &mut std::os::unix::net::UnixStream,
    deadline: Instant,
) -> Result<Capture, ()> {
    let mut capture = Capture::default();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        match receive(stream, &mut buffer, deadline)? {
            0 => return capture.finish(),
            count => capture.feed(&buffer[..count])?,
        }
    }
}

/// How long an exec may still be reported running after its output stream
/// ended: the engine can publish the exit a moment after the stream closes
/// (HACK-2759). Polled, then the outcome stays uncertain.
const EXIT_SETTLE: Duration = if cfg!(test) {
    Duration::from_millis(40)
} else {
    Duration::from_secs(2)
};
const EXIT_POLL: Duration = if cfg!(test) {
    Duration::from_millis(1)
} else {
    Duration::from_millis(25)
};

impl Engine<'_> {
    pub(in crate::provider) fn service_exec(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutput, CandidateError> {
        self.service_exec_until(container, argv, workdir, Instant::now() + timeout, &|| {
            Ok(())
        })
    }
    /// Caller-owned identity checks share the original observation deadline.
    pub(in crate::provider) fn service_exec_until(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<ExecOutput, CandidateError> {
        crate::timings::measure(crate::timings::Step::ContainerExec, None, |_| {
            self.service_exec_observed(container, argv, workdir, deadline, fresh)
        })
    }

    /// Open an upgraded output stream on a fresh engine connection: the effect
    /// guard runs first, as for any POST.
    fn upgraded(
        &self,
        path: &str,
        body: Option<&str>,
        deadline: Instant,
    ) -> Result<std::os::unix::net::UnixStream, ()> {
        self.guest.verify().map_err(|_| ())?;
        self.guest.before_effect().map_err(|_| ())?;
        let socket = self.guest.engine_socket().map_err(|_| ())?;
        let mut stream =
            crate::provider::agent::connect_until(&socket, deadline).map_err(|_| ())?;
        upgrade(&mut stream, path, body, deadline)?;
        Ok(stream)
    }

    fn service_exec_observed(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<ExecOutput, CandidateError> {
        if self.cleanup_only {
            return Err(failure("A cleanup connection cannot execute commands."));
        }
        execute_guarded(
            container,
            argv,
            workdir,
            fresh,
            |method, path, body| {
                self.guest.verify()?;
                if method == Method::POST {
                    self.guest.before_effect()?;
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .filter(|d| !d.is_zero())
                    .ok_or_else(uncertain)?;
                let transport = Transport::new(&self.guest.engine_socket()?, remaining)?;
                let bytes = transport
                    .request_bytes(method, path, body)
                    .map_err(|_| uncertain())?;
                self.guest.verify().map_err(|_| uncertain())?;
                Ok(bytes)
            },
            |path, body| {
                let stream = self
                    .upgraded(path, Some(body), deadline)
                    .map_err(|_| uncertain())?;
                Ok(Attached::Stream { stream, deadline })
            },
        )
    }
}

/// Known completion of one reaped one-off container.
#[cfg(any(all(feature = "native-config-plan", target_os = "macos"), test))]
pub(in crate::provider) struct OneOffOutput {
    pub container: String,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Bytes of each stream past [`OUTPUT_LIMIT`], read and dropped.
    pub stdout_dropped: u64,
    pub stderr_dropped: u64,
}

#[cfg(any(all(feature = "native-config-plan", target_os = "macos"), test))]
fn one_off_uncertain() -> CandidateError {
    CandidateError::new(
        "graph_service_one_off_uncertain",
        "One-off service command completion or removal is uncertain; its container may remain. No request was replayed. Inspect the project before retrying.",
    )
}

#[cfg(all(feature = "native-config-plan", any(target_os = "macos", test)))]
impl Engine<'_> {
    /// One create, attach, start, read, wait, completion inspection and forced
    /// removal of a named one-off container. Caller-owned identity checks share the
    /// original observation deadline; nothing is replayed after an uncertain step.
    pub(in crate::provider) fn service_one_off_until(
        &self,
        name: &str,
        config: &Value,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<OneOffOutput, CandidateError> {
        crate::timings::measure(crate::timings::Step::ContainerRun, None, |_| {
            self.service_one_off_observed(name, config, deadline, fresh)
        })
    }

    fn service_one_off_observed(
        &self,
        name: &str,
        config: &Value,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<OneOffOutput, CandidateError> {
        if self.cleanup_only {
            return Err(failure("A cleanup connection cannot execute commands."));
        }
        one_off_guarded(
            name,
            config,
            fresh,
            |method, path, body| {
                self.guest.verify()?;
                if method == Method::POST {
                    self.guest.before_effect()?;
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .filter(|d| !d.is_zero())
                    .ok_or_else(one_off_uncertain)?;
                let transport = Transport::new(&self.guest.engine_socket()?, remaining)?;
                let bytes = transport
                    .request_bytes(method, path, body)
                    .map_err(|error| {
                        if error.code == "engine_not_found" {
                            error
                        } else {
                            one_off_uncertain()
                        }
                    })?;
                self.guest.verify().map_err(|_| one_off_uncertain())?;
                Ok(bytes)
            },
            |path| {
                let stream = self
                    .upgraded(path, None, deadline)
                    .map_err(|_| one_off_uncertain())?;
                Ok(Attached::Stream { stream, deadline })
            },
        )
    }
}

#[cfg(any(all(feature = "native-config-plan", target_os = "macos"), test))]
fn one_off_guarded(
    name: &str,
    config: &Value,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
    mut attach: impl FnMut(&str) -> Result<Attached, CandidateError>,
) -> Result<OneOffOutput, CandidateError> {
    one_off(
        name,
        config,
        |method, path, body| {
            fresh()?;
            let result = request(method, path, body)?;
            fresh().map_err(|_| one_off_uncertain())?;
            Ok(result)
        },
        |path| {
            fresh()?;
            let result = attach(path)?;
            fresh().map_err(|_| one_off_uncertain())?;
            Ok(result)
        },
    )
}

/// HACK-2759: the one-off's output is read from an attach opened before its
/// start, not from its logs afterwards. The service's log options (a rotating
/// 1 MB json-file) kept only the end of a large output, so the beginning was
/// lost without any truncation signal; the logs body was also bounded by the
/// transport's 4 MiB.
#[cfg(any(all(feature = "native-config-plan", target_os = "macos"), test))]
fn one_off(
    name: &str,
    config: &Value,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
    mut attach: impl FnMut(&str) -> Result<Attached, CandidateError>,
) -> Result<OneOffOutput, CandidateError> {
    if name.is_empty()
        || name.len() > 128
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || config["HostConfig"]["AutoRemove"] != false
    {
        return Err(failure("Invalid one-off container selection."));
    }
    let created = request(
        Method::POST,
        &format!("/v1.53/containers/create?name={name}"),
        Some(config),
    )?;
    let created: Value = serde_json::from_slice(&created).map_err(|_| one_off_uncertain())?;
    let id = created["Id"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(one_off_uncertain)?
        .to_owned();
    let attached = attach(&format!(
        "/v1.53/containers/{id}/attach?stream=1&stdout=1&stderr=1"
    ))?;
    request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
    // The attach ends when the container exits; read it before the wait, so a
    // full output pipe never stalls the command.
    let output = attached.capture().map_err(|_| one_off_uncertain())?;
    let waited = request(Method::POST, &format!("/v1.53/containers/{id}/wait"), None)?;
    let waited: Value = serde_json::from_slice(&waited).map_err(|_| one_off_uncertain())?;
    let status = waited["StatusCode"]
        .as_i64()
        .filter(|n| (0..=255).contains(n))
        .ok_or_else(one_off_uncertain)?;
    let inspected = request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    let inspected: Value = serde_json::from_slice(&inspected).map_err(|_| one_off_uncertain())?;
    if inspected["Id"] != id.as_str()
        || inspected["Name"]
            .as_str()
            .is_none_or(|observed| observed.trim_start_matches('/') != name)
        || inspected["State"]["Running"] != false
        || inspected["State"]["ExitCode"] != status
    {
        return Err(one_off_uncertain());
    }
    request(
        Method::DELETE,
        &format!("/v1.53/containers/{id}?force=true&v=true"),
        None,
    )?;
    match request(Method::GET, &format!("/v1.53/containers/{id}/json"), None) {
        Err(error) if error.code == "engine_not_found" => {}
        _ => return Err(one_off_uncertain()),
    }
    Ok(OneOffOutput {
        container: id,
        exit_code: status as i32,
        stdout: output.stdout,
        stderr: output.stderr,
        stdout_dropped: output.stdout_dropped,
        stderr_dropped: output.stderr_dropped,
    })
}

/// The caller's original selection spans each transport, including create/start.
fn execute_guarded(
    container: &str,
    argv: &[String],
    workdir: Option<&str>,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
    mut start: impl FnMut(&str, &str) -> Result<Attached, CandidateError>,
) -> Result<ExecOutput, CandidateError> {
    execute(
        container,
        argv,
        workdir,
        |method, path, body| {
            fresh()?;
            let result = request(method, path, body)?;
            fresh().map_err(|_| uncertain())?;
            Ok(result)
        },
        |path, body| {
            fresh()?;
            let result = start(path, body)?;
            fresh().map_err(|_| uncertain())?;
            Ok(result)
        },
    )
}

fn execute(
    container: &str,
    argv: &[String],
    workdir: Option<&str>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
    mut start: impl FnMut(&str, &str) -> Result<Attached, CandidateError>,
) -> Result<ExecOutput, CandidateError> {
    if container.len() != 64 || !container.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(failure("Invalid exec container identity."));
    }
    let mut body = json!({"AttachStdin":false,"AttachStdout":true,"AttachStderr":true,"Tty":false,"Privileged":false,"Cmd":argv});
    if let Some(workdir) = workdir {
        body["WorkingDir"] = json!(workdir);
    }
    let created = request(
        Method::POST,
        &format!("/v1.53/containers/{container}/exec"),
        Some(&body),
    )?;
    let created: Value = serde_json::from_slice(&created).map_err(|_| uncertain())?;
    let id = created["Id"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(uncertain)?
        .to_owned();
    // HACK-2759: the started exec's output is read as a stream to its end, not
    // as one bounded response body, so its size never makes the outcome
    // uncertain.
    let output = start(
        &format!("/v1.53/exec/{id}/start"),
        r#"{"Detach":false,"Tty":false}"#,
    )?
    .capture()
    .map_err(|_| uncertain())?;
    // The engine can report the exec running for a moment after its stream
    // ended; poll for its exit within a short bound before calling it uncertain.
    let settle = Instant::now() + EXIT_SETTLE;
    let exit_code = loop {
        let inspected = request(Method::GET, &format!("/v1.53/exec/{id}/json"), None)?;
        let inspected: Value = serde_json::from_slice(&inspected).map_err(|_| uncertain())?;
        if inspected["ID"] != id.as_str() || inspected["ContainerID"] != container {
            return Err(uncertain());
        }
        if inspected["Running"] == false {
            break inspected["ExitCode"]
                .as_i64()
                .filter(|n| (0..=255).contains(n))
                .ok_or_else(uncertain)? as i32;
        }
        if inspected["Running"] != true || Instant::now() >= settle {
            return Err(uncertain());
        }
        std::thread::sleep(EXIT_POLL);
    };
    let truncated = output.truncated();
    Ok(ExecOutput {
        exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated,
        stdout_dropped: output.stdout_dropped,
        stderr_dropped: output.stderr_dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(stream: u8, bytes: &[u8]) -> Vec<u8> {
        let mut result = vec![stream, 0, 0, 0];
        result.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        result.extend_from_slice(bytes);
        result
    }
    /// `total` bytes of a recognisable pattern on one stream, in engine-sized frames.
    fn frames(stream: u8, total: usize) -> (Vec<u8>, Vec<u8>) {
        let output: Vec<u8> = (0..total).map(|i| b'a' + (i % 23) as u8).collect();
        let mut multiplexed = Vec::new();
        for chunk in output.chunks(32 * 1024 + 7) {
            multiplexed.extend(frame(stream, chunk));
        }
        (output, multiplexed)
    }
    fn no_start(_: &str, _: &str) -> Result<Attached, CandidateError> {
        panic!("started")
    }
    fn no_attach(_: &str) -> Result<Attached, CandidateError> {
        panic!("attached")
    }
    #[test]
    fn caller_selection_loss_after_create_never_starts_or_replays() {
        use std::cell::Cell;
        for lose_at in [1, 2, 3] {
            let checks = Cell::new(0);
            let mut calls = 0;
            let result = execute_guarded(
                &"a".repeat(64),
                &["tool".into()],
                None,
                &|| {
                    checks.set(checks.get() + 1);
                    if checks.get() == lose_at {
                        Err(uncertain())
                    } else {
                        Ok(())
                    }
                },
                |_, path, _| {
                    calls += 1;
                    assert!(path.ends_with("/exec"));
                    Ok(serde_json::to_vec(&json!({"Id":"b".repeat(64)})).unwrap())
                },
                no_start,
            );
            assert!(result.is_err());
            assert_eq!(calls, if lose_at == 1 { 0 } else { 1 });
        }
    }
    #[test]
    fn preserves_binary_streams_and_bounds_retained_output() {
        let stream = [
            frame(1, b"\0\xffout"),
            frame(2, b"\x1berr"),
            frame(1, b"more"),
        ]
        .concat();
        let (out, err, truncated) = decode(&stream).unwrap();
        assert_eq!(out, b"\0\xffoutmore");
        assert_eq!(err, b"\x1berr");
        assert!(!truncated);
        let (out, err, truncated) = decode(&frame(1, &vec![b'x'; 1024 * 1024 + 1])).unwrap();
        assert_eq!(out.len(), 1024 * 1024);
        assert!(err.is_empty());
        assert!(truncated);
        for bad in [
            vec![1],
            vec![3, 0, 0, 0, 0, 0, 0, 0],
            vec![1, 0, 0, 0, 0, 0, 0, 1],
        ] {
            assert!(decode(&bad).is_err());
        }
    }
    /// HACK-2759: at 1.35 MB, past 4 MiB and at 10 MB, fed in arbitrary chunks,
    /// the capture keeps exactly the first 1 MiB of each stream, counts every
    /// dropped byte and never fails on size.
    #[test]
    fn a_large_output_keeps_its_beginning_and_counts_the_rest() {
        for total in [1_350_880, 4 * 1024 * 1024 + 13, 10_000_000] {
            let (output, multiplexed) = frames(1, total);
            let (errors, error_frames) = frames(2, total / 3);
            let mut capture = Capture::default();
            for chunk in [multiplexed, error_frames].concat().chunks(4093) {
                capture.feed(chunk).unwrap();
            }
            let capture = capture.finish().unwrap();
            assert_eq!(capture.stdout, output[..OUTPUT_LIMIT], "{total}");
            assert_eq!(capture.stdout_dropped, (total - OUTPUT_LIMIT) as u64);
            let kept = errors.len().min(OUTPUT_LIMIT);
            assert_eq!(capture.stderr, errors[..kept], "{total}");
            assert_eq!(capture.stderr_dropped, (errors.len() - kept) as u64);
            assert!(capture.truncated());
        }
    }
    #[test]
    fn creates_and_starts_once_with_eof_and_returns_nonzero_exit() {
        let container = "a".repeat(64);
        let id = "b".repeat(64);
        let argv = vec!["tool".into(), "$literal; value".into()];
        let mut calls = 0;
        let mut started = 0;
        let result = execute(
            &container,
            &argv,
            Some("/app"),
            |method, path, body| {
                calls += 1;
                match calls {
                    1 => {
                        assert_eq!(method, Method::POST);
                        assert_eq!(path, format!("/v1.53/containers/{container}/exec"));
                        let body = body.unwrap();
                        assert_eq!(body["Cmd"], json!(argv));
                        assert_eq!(body["AttachStdin"], false);
                        assert_eq!(body["Tty"], false);
                        assert_eq!(body["Privileged"], false);
                        assert!(body.get("Env").is_none());
                        assert!(body.get("User").is_none());
                        assert_eq!(body["WorkingDir"], "/app");
                        Ok(serde_json::to_vec(&json!({"Id":id})).unwrap())
                    }
                    2 => {
                        assert_eq!(method, Method::GET);
                        Ok(serde_json::to_vec(
                            &json!({"ID":id,"ContainerID":container,"Running":false,"ExitCode":23}),
                        )
                        .unwrap())
                    }
                    _ => panic!("request replayed"),
                }
            },
            |path, body| {
                started += 1;
                assert_eq!(path, format!("/v1.53/exec/{id}/start"));
                assert_eq!(
                    serde_json::from_str::<Value>(body).unwrap(),
                    json!({"Detach":false,"Tty":false})
                );
                Ok(Attached::Recorded(frame(2, b"failed")))
            },
        )
        .unwrap();
        assert_eq!((calls, started), (2, 1));
        assert_eq!(result.exit_code, 23);
        assert_eq!(result.stderr, b"failed");
        assert!(!result.truncated);
    }
    #[test]
    fn interrupted_start_never_replays_or_claims_completion() {
        let mut calls = 0;
        let error = execute(
            &"a".repeat(64),
            &["tool".into()],
            None,
            |_, _, _| {
                calls += 1;
                Ok(serde_json::to_vec(&json!({"Id":"b".repeat(64)})).unwrap())
            },
            |_, _| Err(uncertain()),
        )
        .err()
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(error.code, "graph_service_exec_uncertain");
    }
    #[test]
    fn refuses_changed_exec_identity_or_unfinished_process() {
        for (changed, settles) in [
            (
                json!({"ID":"c".repeat(64),"ContainerID":"a".repeat(64),"Running":false,"ExitCode":0}),
                false,
            ),
            (
                json!({"ID":"b".repeat(64),"ContainerID":"c".repeat(64),"Running":false,"ExitCode":0}),
                false,
            ),
            // Still running past the settle bound: uncertain, after polling.
            (
                json!({"ID":"b".repeat(64),"ContainerID":"a".repeat(64),"Running":true,"ExitCode":0}),
                true,
            ),
        ] {
            let mut calls = 0;
            assert!(
                execute(
                    &"a".repeat(64),
                    &["true".into()],
                    None,
                    |_, _, _| {
                        calls += 1;
                        Ok(match calls {
                            1 => serde_json::to_vec(&json!({"Id":"b".repeat(64)})).unwrap(),
                            _ => serde_json::to_vec(&changed).unwrap(),
                        })
                    },
                    |_, _| Ok(Attached::Recorded(vec![])),
                )
                .is_err()
            );
            if settles {
                assert!(calls > 2, "{calls}");
            } else {
                assert_eq!(calls, 2);
            }
        }
    }
    /// HACK-2759: the exec's exit can be published a moment after its output
    /// stream ends. A bounded poll waits for it instead of reporting the exec
    /// as uncertain.
    #[test]
    fn an_exec_still_reported_running_after_its_stream_is_polled_to_its_exit() {
        let container = "a".repeat(64);
        let id = "b".repeat(64);
        let mut calls = 0;
        let result = execute(
            &container,
            &["tool".into()],
            None,
            |_, _, _| {
                calls += 1;
                Ok(serde_json::to_vec(&match calls {
                    1 => json!({"Id":id}),
                    2 | 3 => json!({"ID":id,"ContainerID":container,"Running":true,"ExitCode":0}),
                    _ => json!({"ID":id,"ContainerID":container,"Running":false,"ExitCode":0}),
                })
                .unwrap())
            },
            |_, _| Ok(Attached::Recorded(frame(1, b"done"))),
        )
        .unwrap();
        assert_eq!(calls, 4);
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, b"done");
    }
    fn one_off_config() -> Value {
        json!({"Image":format!("sha256:{}", "d".repeat(64)),"Cmd":["tool"],"HostConfig":{"NetworkMode":format!("container:{}", "a".repeat(64)),"AutoRemove":false}})
    }
    /// The calls of a one-off whose output arrives on its attach.
    fn completed_one_off(
        name: &str,
        id: &str,
        output: Vec<u8>,
    ) -> Result<(OneOffOutput, usize), CandidateError> {
        let config = one_off_config();
        let mut calls = 0;
        let attached = std::cell::Cell::new(false);
        let result = one_off(
            name,
            &config,
            |method, path, body| {
                calls += 1;
                match calls {
                    1 => {
                        assert_eq!(method, Method::POST);
                        assert_eq!(path, format!("/v1.53/containers/create?name={name}"));
                        assert_eq!(body.unwrap(), &config);
                        Ok(serde_json::to_vec(&json!({"Id":id})).unwrap())
                    }
                    2 => {
                        // The attach was opened before the start.
                        assert!(attached.get());
                        assert_eq!(method, Method::POST);
                        assert_eq!(path, format!("/v1.53/containers/{id}/start"));
                        assert!(body.is_none());
                        Ok(vec![])
                    }
                    3 => {
                        assert_eq!(method, Method::POST);
                        assert_eq!(path, format!("/v1.53/containers/{id}/wait"));
                        Ok(serde_json::to_vec(&json!({"StatusCode":3,"Error":null})).unwrap())
                    }
                    4 => {
                        assert_eq!(method, Method::GET);
                        assert_eq!(path, format!("/v1.53/containers/{id}/json"));
                        Ok(serde_json::to_vec(&json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":3}})).unwrap())
                    }
                    5 => {
                        assert_eq!(method, Method::DELETE);
                        assert_eq!(path, format!("/v1.53/containers/{id}?force=true&v=true"));
                        Ok(vec![])
                    }
                    6 => {
                        assert_eq!(method, Method::GET);
                        Err(CandidateError::new("engine_not_found", "absent"))
                    }
                    _ => panic!("request replayed"),
                }
            },
            |path| {
                assert!(!attached.replace(true));
                assert_eq!(
                    path,
                    format!("/v1.53/containers/{id}/attach?stream=1&stdout=1&stderr=1")
                );
                Ok(Attached::Recorded(output.clone()))
            },
        )?;
        Ok((result, calls))
    }
    #[test]
    fn one_off_creates_attaches_starts_reads_waits_inspects_and_removes_once_with_nonzero_exit() {
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        let id = "e".repeat(64);
        let (result, calls) = completed_one_off(
            &name,
            &id,
            [frame(1, b"ok\n\xff"), frame(2, b"\0warn")].concat(),
        )
        .unwrap();
        assert_eq!(calls, 6);
        assert_eq!(result.container, id);
        assert_eq!(result.exit_code, 3);
        assert_eq!(result.stdout, b"ok\n\xff");
        assert_eq!(result.stderr, b"\0warn");
        assert_eq!((result.stdout_dropped, result.stderr_dropped), (0, 0));
    }
    /// HACK-2759: a one-off's large output keeps its beginning (it was read from
    /// rotated logs, which kept only the end), and the drop is reported.
    #[test]
    fn a_one_off_large_output_keeps_its_beginning_and_reports_the_drop() {
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        let id = "e".repeat(64);
        for total in [1_350_880, 4 * 1024 * 1024 + 13, 10_000_000] {
            let (output, multiplexed) = frames(1, total);
            let (result, _) = completed_one_off(&name, &id, multiplexed).unwrap();
            assert_eq!(result.stdout, output[..OUTPUT_LIMIT], "{total}");
            assert_eq!(result.stdout_dropped, (total - OUTPUT_LIMIT) as u64);
            assert_eq!(result.stderr_dropped, 0);
        }
    }
    #[test]
    fn one_off_caller_selection_loss_never_starts_or_replays() {
        use std::cell::Cell;
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        for lose_at in [1, 2, 3] {
            let checks = Cell::new(0);
            let mut calls = 0;
            let result = one_off_guarded(
                &name,
                &one_off_config(),
                &|| {
                    checks.set(checks.get() + 1);
                    if checks.get() == lose_at {
                        Err(uncertain())
                    } else {
                        Ok(())
                    }
                },
                |_, path, _| {
                    calls += 1;
                    assert!(path.contains("/create?name="));
                    Ok(serde_json::to_vec(&json!({"Id":"e".repeat(64)})).unwrap())
                },
                |_| Err(one_off_uncertain()),
            );
            assert!(result.is_err());
            assert_eq!(calls, if lose_at == 1 { 0 } else { 1 });
        }
    }
    #[test]
    fn one_off_refuses_changed_identity_unfinished_process_unproven_removal_and_auto_remove() {
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        let id = "e".repeat(64);
        let inspected =
            json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":0}});
        for (stage, changed) in [
            (
                4,
                json!({"Id":"f".repeat(64),"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":0}}),
            ),
            (
                4,
                json!({"Id":id,"Name":"/foreign","State":{"Running":false,"ExitCode":0}}),
            ),
            (
                4,
                json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":true,"ExitCode":0}}),
            ),
            (
                4,
                json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":1}}),
            ),
            (6, inspected.clone()),
        ] {
            let mut calls = 0;
            let error = one_off(
                &name,
                &one_off_config(),
                |_, _, _| {
                    calls += 1;
                    Ok(match calls {
                        1 => serde_json::to_vec(&json!({"Id":id})).unwrap(),
                        2 | 5 => vec![],
                        3 => serde_json::to_vec(&json!({"StatusCode":0})).unwrap(),
                        4 if stage == 4 => serde_json::to_vec(&changed).unwrap(),
                        4 => serde_json::to_vec(&inspected).unwrap(),
                        _ => serde_json::to_vec(&changed).unwrap(),
                    })
                },
                |_| Ok(Attached::Recorded(vec![])),
            )
            .err()
            .unwrap();
            assert_eq!(calls, stage);
            assert_eq!(error.code, "graph_service_one_off_uncertain");
        }
        let mut config = one_off_config();
        config["HostConfig"]["AutoRemove"] = json!(true);
        let mut calls = 0;
        assert!(
            one_off(
                &name,
                &config,
                |_, _, _| {
                    calls += 1;
                    Ok(vec![])
                },
                no_attach,
            )
            .is_err()
        );
        assert_eq!(calls, 0);
    }
    /// A fake engine socket: each accepted connection reads one request and
    /// writes its response. The exec start is answered as an upgraded stream.
    fn serve(
        path: std::path::PathBuf,
        responses: Vec<(bool, Vec<u8>)>,
    ) -> std::thread::JoinHandle<()> {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            for (upgraded, response) in responses {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                // macOS may inherit the listener's nonblocking flag on accept.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let headers = String::from_utf8(request).unwrap();
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(|v| v.parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                if upgraded {
                    assert!(headers.contains("Upgrade: tcp"), "{headers}");
                    socket
                        .write_all(b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
                        .unwrap();
                } else {
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .unwrap();
                }
                socket.write_all(&response).unwrap();
            }
        })
    }
    fn socket_path() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "hce-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    /// The real Unix transport and upgraded start, at small and at 10 MB of
    /// output (past the 4 MiB response bound that made a large exec uncertain).
    #[test]
    fn real_unix_transport_delivers_multiplexed_binary_command_output() {
        let container = "a".repeat(64);
        let id = "b".repeat(64);
        let (large, large_frames) = frames(1, 10_000_000);
        for (stream, expected_stdout, dropped) in [
            (
                [frame(1, b"out\xff"), frame(2, b"err\0")].concat(),
                b"out\xff".to_vec(),
                0,
            ),
            (
                large_frames,
                large[..OUTPUT_LIMIT].to_vec(),
                (10_000_000 - OUTPUT_LIMIT) as u64,
            ),
        ] {
            let path = socket_path();
            let worker = serve(
                path.clone(),
                vec![
                    (false, serde_json::to_vec(&json!({"Id":id})).unwrap()),
                    (true, stream),
                    (
                        false,
                        serde_json::to_vec(
                            &json!({"ID":id,"ContainerID":container,"Running":false,"ExitCode":7}),
                        )
                        .unwrap(),
                    ),
                ],
            );
            let transport = Transport::new(&path, Duration::from_secs(5)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let result = execute(
                &container,
                &["tool".into()],
                None,
                |method, path, body| transport.request_bytes(method, path, body),
                |path_, body| {
                    let mut stream = crate::provider::agent::connect_until(&path, deadline)?;
                    upgrade(&mut stream, path_, Some(body), deadline).map_err(|_| uncertain())?;
                    Ok(Attached::Stream { stream, deadline })
                },
            );
            worker.join().unwrap();
            std::fs::remove_file(&path).unwrap();
            let result = result.unwrap();
            assert_eq!(result.exit_code, 7);
            assert_eq!(result.stdout, expected_stdout);
            assert_eq!(result.stdout_dropped, dropped);
            assert_eq!(result.truncated, dropped > 0);
        }
    }
}
