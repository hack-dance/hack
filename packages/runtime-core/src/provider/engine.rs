//! Docker HTTP is pinned to the verified private Unix socket. No contexts, proxies,
//! redirects, TCP fallback or transparent retries participate in engine requests.
use super::{
    artifact,
    lifecycle::{ObservedGuest, OwnedGuest},
};
use crate::{Candidate, CandidateError};
use reqwest::{Method, blocking::Client};
use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

#[cfg(any(all(target_os = "macos", feature = "environment-launcher"), test))]
mod private_service_exec;
#[cfg(any(target_os = "macos", test))]
pub(super) mod relay_exec;
mod service_exec;
mod stop;
pub(in crate::provider) use stop::StopBatchFailure;
#[cfg(test)]
pub(in crate::provider) use stop::StopFailure;
#[cfg(all(
    test,
    target_os = "macos",
    target_arch = "aarch64",
    feature = "environment-launcher"
))]
pub(in crate::provider) use stop::with_test_stop_socket;

const MAX_BODY: u64 = 4 * 1024 * 1024;

struct Transport {
    client: Client,
    timeout: Duration,
    admission_deadline: Option<Instant>,
    observation_deadline: Option<Instant>,
}

impl Transport {
    fn new(socket: &Path, timeout: Duration) -> Result<Self, CandidateError> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .unix_socket(socket.to_owned())
            .timeout(timeout)
            .connect_timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| failure("Cannot initialize the private engine transport."))?;
        Ok(Self {
            client,
            timeout,
            admission_deadline: None,
            observation_deadline: None,
        })
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        let bytes = self.request_bytes(method, path, body)?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| failure("Malformed engine response; source values omitted."))
    }

    fn request_bytes(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Vec<u8>, CandidateError> {
        self.request_bytes_until(method, path, body, None)
    }

    fn request_bytes_until(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        deadline: Option<Instant>,
    ) -> Result<Vec<u8>, CandidateError> {
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains('#')
            || path.bytes().any(|b| b.is_ascii_control())
        {
            return Err(failure("Invalid private engine request path."));
        }
        let requires_admission = ![Method::GET, Method::HEAD, Method::DELETE].contains(&method);
        let mut request = self
            .client
            .request(method, format!("http://hack-local{path}"));
        if let Some(body) = body {
            let encoded =
                serde_json::to_vec(body).map_err(|_| failure("Cannot encode engine request."))?;
            if encoded.len() as u64 > MAX_BODY {
                return Err(failure("Engine request exceeds 4 MiB."));
            }
            request = request
                .header("Content-Type", "application/json")
                .body(encoded);
        }
        // This runs after guest/admission verification and encoding, immediately
        // before dispatch. A connection wait cannot extend the original budget.
        // Cleanup observations and deletion remain possible after expiry; owned
        // stop has its separate cleanup-only batch transport and deadline.
        request = request.timeout(request_timeout(
            self.timeout,
            requires_admission
                .then_some(self.admission_deadline)
                .flatten(),
            match (deadline, self.observation_deadline) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            },
        )?);
        let response = request.send().map_err(|_| failure("Engine request failed or timed out; its effect may be uncertain. No request was replayed."))?;
        response_bytes(response)
    }
}

// One minimum budget reaches dispatch. A later explicit deadline cannot replace
// an earlier mutation-admission deadline; cleanup admission exemptions stay above.
fn request_timeout(
    default: Duration,
    admission: Option<Instant>,
    explicit: Option<Instant>,
) -> Result<Duration, CandidateError> {
    let mut timeout = default;
    for deadline in admission.into_iter().chain(explicit) {
        timeout = timeout.min(super::managed_environment::remaining_until(deadline)?);
    }
    Ok(timeout)
}

fn response_bytes(mut response: reqwest::blocking::Response) -> Result<Vec<u8>, CandidateError> {
    let status = response.status();
    if response.content_length().is_some_and(|n| n > MAX_BODY) {
        return Err(failure("Engine response exceeds 4 MiB."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut response)
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("Engine response was interrupted; no request was replayed."))?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(failure("Engine response exceeds 4 MiB."));
    }
    if !status.is_success() {
        let category = rejection_category(&bytes);
        return Err(CandidateError::new(
            if status.as_u16() == 404 {
                "engine_not_found"
            } else {
                "engine_rejected"
            },
            format!(
                "Private engine returned HTTP {} ({category}). Response values are omitted.",
                status.as_u16()
            ),
        ));
    }
    Ok(bytes)
}

fn rejection_category(bytes: &[u8]) -> &'static str {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    for (needle, category) in [
        ("no space left on device", "storage-exhausted"),
        ("apparmor", "apparmor-unavailable"),
        ("seccomp", "seccomp-rejected"),
        ("cgroup", "cgroup-rejected"),
        ("nanocpu", "cpu-quota-rejected"),
        ("no command", "command-missing"),
        ("executable file not found", "executable-missing"),
        ("no matching entries in passwd", "container-user-missing"),
        ("ttrpc: closed", "runtime-channel-closed"),
        ("permission denied", "permission-denied"),
        ("read-only file system", "read-only-filesystem"),
        ("no such file or directory", "path-missing"),
        ("mount", "mount-rejected"),
        ("oci runtime", "oci-runtime-rejected"),
        ("content-type", "content-type-rejected"),
    ] {
        if text.contains(needle) {
            return category;
        }
    }
    "unclassified"
}

fn failure(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new("engine_protocol", message)
}

#[derive(Debug, Serialize)]
pub struct EngineInfo {
    pub version: String,
    pub api_version: String,
    pub operating_system: String,
    pub architecture: String,
    pub transport: &'static str,
}

pub(super) struct Engine<'a> {
    guest: OwnedGuest<'a>,
    transport: Transport,
    cleanup_only: bool,
    #[cfg(feature = "native-config-plan")]
    tool_lifetime: super::guest_tool::Lifetime,
}

impl<'a> Engine<'a> {
    #[cfg(feature = "native-config-plan")]
    pub(in crate::provider) fn tool_lifetime(&self) -> &super::guest_tool::Lifetime {
        &self.tool_lifetime
    }
    #[cfg(feature = "native-config-plan")]
    pub(in crate::provider) fn request_until(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        deadline: Instant,
    ) -> Result<Value, CandidateError> {
        if self.cleanup_only && ![Method::GET, Method::HEAD, Method::DELETE].contains(&method) {
            return Err(failure(
                "A cleanup connection cannot allocate or start resources.",
            ));
        }
        self.guest.verify()?;
        if ![Method::GET, Method::HEAD, Method::DELETE].contains(&method) {
            self.guest.before_effect()?;
        }
        let bytes = self
            .transport
            .request_bytes_until(method, path, body, Some(deadline));
        self.guest.verify()?;
        if Instant::now() >= deadline {
            return Err(failure(
                "Private engine deadline expired; outcome remains uncertain.",
            ));
        }
        let bytes = bytes?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| failure("Malformed engine response; values omitted."))
    }
    pub(super) fn load_image_archive(&self, archive: Vec<u8>) -> Result<(), CandidateError> {
        if self.cleanup_only {
            return Err(failure("A cleanup connection cannot load images."));
        }
        self.guest.verify()?;
        self.guest.before_effect()?;
        let response = self
            .transport
            .client
            .post("http://hack-local/v1.53/images/load?quiet=true")
            .header("Content-Type", "application/x-tar")
            .body(archive)
            .send()
            .map_err(|_| {
                failure("Image load reply was lost or timed out; no request was replayed.")
            })?;
        let bytes = response_bytes(response)?;
        for line in bytes.split(|b| *b == b'\n').filter(|b| !b.is_empty()) {
            let value: Value = serde_json::from_slice(line)
                .map_err(|_| failure("Malformed image-load response."))?;
            if value.get("error").is_some() || value.get("errorDetail").is_some() {
                return Err(failure(
                    "Private image load failed; response values are omitted.",
                ));
            }
        }
        self.guest.verify()?;
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn job_events(
        &self,
        job: &str,
        since: u64,
        until: u64,
    ) -> Result<Vec<String>, CandidateError> {
        if job.len() != 64 || !job.bytes().all(|b| b.is_ascii_hexdigit()) || until < since {
            return Err(failure("Invalid job event boundary."));
        }
        self.guest.verify()?;
        let path = format!(
            "/v1.53/events?since={since}&until={until}&filters=%7B%22label%22%3A%5B%22io.hack-local.job%3D{job}%22%5D%7D"
        );
        let bytes = self.transport.request_bytes(Method::GET, &path, None)?;
        let mut events = Vec::new();
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let value: Value =
                serde_json::from_slice(line).map_err(|_| failure("Malformed job event."))?;
            if value["Actor"]["Attributes"]["io.hack-local.job"] != job {
                return Err(failure("Foreign job event."));
            }
            events.push(
                value["Action"]
                    .as_str()
                    .ok_or_else(|| failure("Missing event action."))?
                    .to_owned(),
            );
        }
        self.guest.verify()?;
        Ok(events)
    }
    pub(super) fn probe_status(&self, id: &str) -> Result<Option<String>, CandidateError> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("Invalid probe container identity."));
        }
        self.guest.verify()?;
        let bytes = match self.transport.request_bytes(
            Method::GET,
            &format!("/v1.53/containers/{id}/archive?path=/run/hack-http-probe-state/status"),
            None,
        ) {
            Ok(bytes) => bytes,
            Err(e) if e.code == "engine_not_found" => {
                self.guest.verify()?;
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        if bytes.len() > 32_768 {
            return Err(failure("Probe archive exceeds its budget."));
        }
        let mut archive = tar::Archive::new(bytes.as_slice());
        let mut entries = archive
            .entries()
            .map_err(|_| failure("Invalid probe archive."))?;
        let mut entry = entries
            .next()
            .ok_or_else(|| failure("Empty probe archive."))?
            .map_err(|_| failure("Invalid probe archive."))?;
        if entry
            .path()
            .map_err(|_| failure("Invalid probe path."))?
            .as_ref()
            != Path::new("status")
            || !entry.header().entry_type().is_file()
            || entry.size() > 256
        {
            return Err(failure("Unexpected probe archive entry."));
        }
        let mut raw = String::new();
        entry
            .read_to_string(&mut raw)
            .map_err(|_| failure("Invalid probe status."))?;
        drop(entry);
        if entries.next().is_some() {
            return Err(failure("Multiple probe archive entries."));
        }
        self.guest.verify()?;
        Ok(Some(raw))
    }
    #[cfg(target_os = "macos")]
    pub(in crate::provider) fn job_logs(
        &self,
        id: &str,
    ) -> Result<(Vec<u8>, Vec<u8>, bool), CandidateError> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("Invalid job container identity."));
        }
        self.guest.verify()?;
        let bytes = self.transport.request_bytes(
            Method::GET,
            &format!("/v1.53/containers/{id}/logs?stdout=true&stderr=true&tail=all"),
            None,
        )?;
        let result = service_exec::decode(&bytes)?;
        self.guest.verify()?;
        Ok(result)
    }
    pub(super) fn logs(&self, id: &str) -> Result<(String, String, bool), CandidateError> {
        self.logs_with_tail(id, "all")
    }
    /// Bounded per-stream tail for callers that keep the streams apart. Built from
    /// the same whole-line, newest-first selection as [`Self::logs_tail_lines`].
    #[cfg(feature = "native-config-plan")]
    pub(super) fn logs_tail(
        &self,
        id: &str,
        tail: u16,
    ) -> Result<(String, String, bool), CandidateError> {
        let tail = self.logs_tail_lines(id, tail)?;
        let (stdout, stderr) = tail.split();
        Ok((stdout, stderr, tail.truncated))
    }
    /// Bounded tail in engine order, which interleaves stdout and stderr by time.
    /// Whole lines are kept newest first; see [`LogTail`].
    pub(super) fn logs_tail_lines(&self, id: &str, tail: u16) -> Result<LogTail, CandidateError> {
        if !(1..=1000).contains(&tail) {
            return Err(failure("Container log tail must be from 1 to 1000."));
        }
        let bytes = self.logs_bytes(id, &tail.to_string())?;
        decode_log_lines(&bytes)
    }
    fn logs_with_tail(
        &self,
        id: &str,
        tail: &str,
    ) -> Result<(String, String, bool), CandidateError> {
        decode_logs(&self.logs_bytes(id, tail)?)
    }
    fn logs_bytes(&self, id: &str, tail: &str) -> Result<Vec<u8>, CandidateError> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("Invalid container log identity."));
        }
        self.guest.verify()?;
        let bytes = self.transport.request_bytes(
            Method::GET,
            &format!("/v1.53/containers/{id}/logs?stdout=true&stderr=true&tail={tail}"),
            None,
        )?;
        self.guest.verify()?;
        Ok(bytes)
    }
    pub(super) fn guest(&self) -> &OwnedGuest<'a> {
        &self.guest
    }
    pub(super) fn connect(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, false)
    }

    /// Wait only for the mutation lease. A busy acquisition admits no operation;
    /// other verification or transport failures are returned without replay.
    #[cfg(target_os = "macos")]
    pub(super) fn connect_until(
        candidate: &'a Candidate,
        deadline: std::time::Instant,
        cancelled: impl Fn() -> bool,
    ) -> Result<Self, CandidateError> {
        loop {
            if cancelled() {
                return Err(CandidateError::new(
                    "provider_acquisition_cancelled",
                    "Provider acquisition was cancelled before admission.",
                ));
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(CandidateError::new(
                    "provider_busy",
                    "Provider lease acquisition expired before admission.",
                ));
            }
            match Self::connect(candidate) {
                Err(error) if error.code == "provider_busy" => {
                    std::thread::sleep(remaining.min(Duration::from_millis(50)))
                }
                result => return result,
            }
        }
    }

    pub(super) fn connect_cleanup(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, true)
    }

    /// Read-only operations share one fixed budget across connection and every query.
    #[cfg(all(target_os = "macos", feature = "native-config-plan"))]
    pub(in crate::provider) fn connect_cleanup_until(
        candidate: &'a Candidate,
        deadline: Instant,
    ) -> Result<Self, CandidateError> {
        super::managed_environment::remaining_until(deadline)?;
        Self::from_guest_until(
            OwnedGuest::connect_cleanup(candidate)?,
            true,
            Some(deadline),
        )
    }

    /// One live-owner command keeps its original budget through every engine query.
    #[cfg(all(target_os = "macos", feature = "native-config-plan"))]
    pub(in crate::provider) fn connect_command_until(
        candidate: &'a Candidate,
        deadline: Instant,
    ) -> Result<Self, CandidateError> {
        super::managed_environment::remaining_until(deadline)?;
        Self::from_guest_until(OwnedGuest::connect(candidate)?, false, Some(deadline))
    }

    #[cfg(target_os = "macos")]
    pub(super) fn connect_cleanup_wait(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::from_guest(OwnedGuest::connect_cleanup_wait(candidate)?, true)
    }

    fn connect_mode(candidate: &'a Candidate, cleanup_only: bool) -> Result<Self, CandidateError> {
        let guest = if cleanup_only {
            OwnedGuest::connect_cleanup(candidate)?
        } else {
            OwnedGuest::connect(candidate)?
        };
        Self::from_guest(guest, cleanup_only)
    }

    fn from_guest(guest: OwnedGuest<'a>, cleanup_only: bool) -> Result<Self, CandidateError> {
        Self::from_guest_until(guest, cleanup_only, None)
    }
    fn from_guest_until(
        guest: OwnedGuest<'a>,
        cleanup_only: bool,
        deadline: Option<Instant>,
    ) -> Result<Self, CandidateError> {
        let mut transport = Transport::new(&guest.engine_socket()?, Duration::from_secs(40))?;
        transport.observation_deadline = deadline;
        let engine = Self {
            guest,
            transport,
            cleanup_only,
            #[cfg(feature = "native-config-plan")]
            tool_lifetime: super::guest_tool::Lifetime::default(),
        };
        engine.info()?;
        Ok(engine)
    }

    /// Carry the private request's original admission deadline to dispatch. This
    /// is independent of environment mounts, including requests with no values.
    #[cfg(target_os = "macos")]
    pub(in crate::provider) fn with_admission_deadline(mut self, deadline: Instant) -> Self {
        self.transport.admission_deadline = Some(deadline);
        self
    }

    pub(super) fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        if self.cleanup_only && ![Method::GET, Method::HEAD, Method::DELETE].contains(&method) {
            return Err(failure(
                "A cleanup connection cannot allocate or start resources.",
            ));
        }
        self.guest.verify()?;
        // Cleanup must remain possible when a capacity check blocks new allocations.
        if method != Method::GET && method != Method::HEAD && method != Method::DELETE {
            self.guest.before_effect()?;
        }
        let value = self.transport.request(method, path, body)?;
        self.guest.verify()?;
        Ok(value)
    }

    fn info(&self) -> Result<EngineInfo, CandidateError> {
        decode_info(self.request(Method::GET, "/version", None)?)
    }
}

/// Observation exposes only fixed read-only endpoints; it cannot execute guest scripts or mutations.
/// Only an explicit not-found response permits retirement of a container-bound slot.
pub(super) fn require_container_absent(
    guest: &OwnedGuest<'_>,
    name: &str,
) -> Result<(), CandidateError> {
    guest.verify()?;
    let transport = Transport::new(&guest.engine_socket()?, Duration::from_secs(10))?;
    let result = transport.request(Method::GET, &format!("/v1.53/containers/{name}/json"), None);
    guest.verify()?;
    match result {
        Err(e) if e.code == "engine_not_found" => Ok(()),
        Err(e) => Err(e),
        Ok(_) => Err(CandidateError::new(
            "environment_container_present",
            "Remove the recorded graph container before retiring its environment allocation.",
        )),
    }
}

pub(super) struct Observer<'a> {
    guest: ObservedGuest<'a>,
    transport: Transport,
}
impl<'a> Observer<'a> {
    pub(super) fn connect(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        let guest = ObservedGuest::connect(candidate)?;
        let transport = Transport::new(&guest.engine_socket()?, Duration::from_secs(10))?;
        Ok(Self { guest, transport })
    }

    pub(super) fn incarnation(&self) -> &str {
        self.guest.incarnation()
    }

    /// One read-only engine GET, with runtime identity verified on both sides.
    pub(super) fn get(&self, path: &str) -> Result<Value, CandidateError> {
        self.guest.verify()?;
        let value = self.transport.request(Method::GET, path, None)?;
        self.guest.verify()?;
        Ok(value)
    }

    pub(super) fn storage_usage(&self) -> Result<Value, CandidateError> {
        self.info()?;
        self.guest.verify()?;
        let value = self
            .transport
            .request(Method::GET, "/v1.53/system/df?verbose=true", None)?;
        self.guest.verify()?;
        Ok(value)
    }

    fn info(&self) -> Result<EngineInfo, CandidateError> {
        self.guest.verify()?;
        let value = self.transport.request(Method::GET, "/version", None)?;
        self.guest.verify()?;
        decode_info(value)
    }
}

fn decode_info(value: Value) -> Result<EngineInfo, CandidateError> {
    if value["Version"] != artifact::ENGINE_VERSION
        || value["Os"] != "linux"
        || value["Arch"] != "arm64"
    {
        return Err(failure(
            "Private engine version or platform does not match the pinned provider.",
        ));
    }
    let api = value["ApiVersion"]
        .as_str()
        .ok_or_else(|| failure("Missing engine API version."))?;
    if api.len() > 16 || !api.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(failure("Invalid engine API version."));
    }
    Ok(EngineInfo {
        version: artifact::ENGINE_VERSION.into(),
        api_version: api.into(),
        operating_system: "linux".into(),
        architecture: "arm64".into(),
        transport: "verified-candidate-unix-socket",
    })
}

fn decode_logs(bytes: &[u8]) -> Result<(String, String, bool), CandidateError> {
    let mut offset = 0;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset + 8)
            .ok_or_else(|| failure("Truncated container log header."))?;
        if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] {
            return Err(failure("Invalid container log stream."));
        }
        let length = u32::from_be_bytes(header[4..8].try_into().expect("length field")) as usize;
        offset += 8;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| failure("Invalid container log length."))?;
        let payload = bytes
            .get(offset..end)
            .ok_or_else(|| failure("Truncated container log payload."))?;
        let output = if header[0] == 1 {
            &mut stdout
        } else {
            &mut stderr
        };
        let keep = payload
            .len()
            .min((16 * 1024_usize).saturating_sub(output.len()));
        output.extend_from_slice(&payload[..keep]);
        truncated |= keep < payload.len();
        offset = end;
    }
    let stdout = bounded_log_text(&stdout, &mut truncated);
    let stderr = bounded_log_text(&stderr, &mut truncated);
    Ok((stdout, stderr, truncated))
}

/// Output stream of one log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// One log line in engine order. `text` keeps its trailing newline when the
/// engine supplied one; only the final line of a stream can lack it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LogLine {
    pub stream: LogStream,
    pub text: String,
}

/// A bounded log tail. Lines are whole and in engine order, so stdout and stderr
/// interleave by time. When the selection exceeds [`LOG_TAIL_BUDGET`] JSON bytes,
/// the oldest whole lines are dropped and `truncated` is set; a line is cut only
/// when it alone exceeds the budget (or [`LOG_LINE_LIMIT`] while decoding), and
/// that also sets `truncated`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogTail {
    pub lines: Vec<LogLine>,
    pub truncated: bool,
}

impl LogTail {
    /// Per-stream text of the same retained lines.
    pub fn split(&self) -> (String, String) {
        let mut stdout = String::new();
        let mut stderr = String::new();
        for line in &self.lines {
            match line.stream {
                LogStream::Stdout => stdout.push_str(&line.text),
                LogStream::Stderr => stderr.push_str(&line.text),
            }
        }
        (stdout, stderr)
    }
}

/// JSON-encoded budget for the retained text of one tail, across both streams.
pub const LOG_TAIL_BUDGET: usize = 32 * 1024;
/// Raw bytes kept for one line while decoding; the response body is bounded too.
pub const LOG_LINE_LIMIT: usize = 64 * 1024;
/// Approximate JSON overhead of one line entry (`{"stream":"stderr","text":""},`).
const LOG_LINE_OVERHEAD: usize = 32;

fn json_text_cost(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if c <= '\u{1f}' => 6,
        c => c.len_utf8(),
    }
}

fn decode_log_lines(bytes: &[u8]) -> Result<LogTail, CandidateError> {
    struct Entry {
        stream: LogStream,
        bytes: Vec<u8>,
        clipped: bool,
    }
    let mut entries: Vec<Entry> = Vec::new();
    // Index of the unterminated line each stream is still filling.
    let mut open: [Option<usize>; 2] = [None, None];
    let mut offset = 0;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset + 8)
            .ok_or_else(|| failure("Truncated container log header."))?;
        if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] {
            return Err(failure("Invalid container log stream."));
        }
        let length = u32::from_be_bytes(header[4..8].try_into().expect("length field")) as usize;
        offset += 8;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| failure("Invalid container log length."))?;
        let mut rest = bytes
            .get(offset..end)
            .ok_or_else(|| failure("Truncated container log payload."))?;
        offset = end;
        let (slot, stream) = if header[0] == 1 {
            (0, LogStream::Stdout)
        } else {
            (1, LogStream::Stderr)
        };
        while !rest.is_empty() {
            let (chunk, complete) = match rest.iter().position(|byte| *byte == b'\n') {
                Some(index) => (&rest[..=index], true),
                None => (rest, false),
            };
            rest = &rest[chunk.len()..];
            let index = *open[slot].get_or_insert_with(|| {
                entries.push(Entry {
                    stream,
                    bytes: Vec::new(),
                    clipped: false,
                });
                entries.len() - 1
            });
            let entry = &mut entries[index];
            let keep = chunk
                .len()
                .min(LOG_LINE_LIMIT.saturating_sub(entry.bytes.len()));
            entry.bytes.extend_from_slice(&chunk[..keep]);
            if keep < chunk.len() {
                entry.clipped = true;
                if complete {
                    entry.bytes.push(b'\n');
                }
            }
            if complete {
                open[slot] = None;
            }
        }
    }
    let mut truncated = entries.iter().any(|entry| entry.clipped);
    let mut lines = Vec::new();
    let mut used = 0;
    for entry in entries.iter().rev() {
        let text = String::from_utf8_lossy(&entry.bytes);
        let cost = LOG_LINE_OVERHEAD + text.chars().map(json_text_cost).sum::<usize>();
        if used + cost <= LOG_TAIL_BUDGET {
            used += cost;
            lines.push(LogLine {
                stream: entry.stream,
                text: text.into_owned(),
            });
            continue;
        }
        truncated = true;
        if lines.is_empty() {
            // The newest line alone exceeds the budget: keep its start.
            let mut clipped = String::new();
            let mut cost = LOG_LINE_OVERHEAD;
            for character in text.chars() {
                cost += json_text_cost(character);
                if cost > LOG_TAIL_BUDGET {
                    break;
                }
                clipped.push(character);
            }
            lines.push(LogLine {
                stream: entry.stream,
                text: clipped,
            });
        }
        break;
    }
    lines.reverse();
    Ok(LogTail { lines, truncated })
}

fn bounded_log_text(bytes: &[u8], truncated: &mut bool) -> String {
    let text = String::from_utf8_lossy(bytes);
    // JSON escaping and invalid UTF-8 replacement must not overflow the node frame.
    let mut retained = String::new();
    let mut encoded_bytes = 2;
    for character in text.chars() {
        let cost = match character {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            c if c <= '\u{1f}' => 6,
            c => c.len_utf8(),
        };
        if encoded_bytes + cost > 16 * 1024 + 2 {
            *truncated = true;
            break;
        }
        retained.push(character);
        encoded_bytes += cost;
    }
    retained
}

pub fn info(candidate: &Candidate) -> Result<EngineInfo, CandidateError> {
    Observer::connect(candidate)?.info()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixListener;

    #[test]
    fn explicit_request_budget_never_extends_mutation_admission() {
        let now = Instant::now();
        let early = now + Duration::from_secs(1);
        let late = now + Duration::from_secs(20);
        let default = Duration::from_secs(40);
        assert!(
            request_timeout(default, Some(early), Some(late)).unwrap() <= Duration::from_secs(1)
        );
        assert!(
            request_timeout(default, Some(late), Some(early)).unwrap() <= Duration::from_secs(1)
        );
        assert_eq!(request_timeout(default, None, None).unwrap(), default);
        assert!(request_timeout(default, Some(now), Some(late)).is_err());
        assert!(request_timeout(default, Some(late), Some(now)).is_err());
        // GET/HEAD/DELETE omit admission but still honor an explicit cleanup budget.
        assert!(request_timeout(default, None, Some(late)).unwrap() > Duration::from_secs(1));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bounded_acquisition_cancellation_and_expiry_do_not_initialize_state() {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!(
            "hack-engine-acquire-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        let candidate = Candidate::discover(&path).unwrap();
        let cancelled = Engine::connect_until(
            &candidate,
            std::time::Instant::now() + Duration::from_secs(1),
            || true,
        );
        assert_eq!(
            cancelled.err().unwrap().code,
            "provider_acquisition_cancelled"
        );
        let expired = Engine::connect_until(&candidate, std::time::Instant::now(), || false);
        assert_eq!(expired.err().unwrap().code, "provider_busy");
        assert!(!candidate.state_root.exists());
        std::fs::remove_dir(path).unwrap();
    }

    #[test]
    fn logs_preserve_streams_bound_output_and_reject_partial_frames() {
        let frame = |stream: u8, payload: &[u8]| {
            let mut bytes = vec![stream, 0, 0, 0];
            bytes.extend((payload.len() as u32).to_be_bytes());
            bytes.extend(payload);
            bytes
        };
        let mut bytes = frame(1, b"hello");
        bytes.extend(frame(2, b"failure"));
        assert_eq!(
            decode_logs(&bytes).unwrap(),
            ("hello".into(), "failure".into(), false)
        );
        assert!(decode_logs(&bytes[..bytes.len() - 1]).is_err());
        assert!(decode_logs(&[1, 0, 0]).is_err());
        assert!(decode_logs(&[3, 0, 0, 0, 0, 0, 0, 0]).is_err());
        let (stdout, stderr, truncated) = decode_logs(&frame(1, &vec![b'x'; 20000])).unwrap();
        assert_eq!(stdout.len(), 16384);
        assert!(stderr.is_empty() && truncated);
        let (stdout, _, truncated) = decode_logs(&frame(1, &vec![0; 16000])).unwrap();
        assert!(truncated);
        assert!(serde_json::to_vec(&stdout).unwrap().len() <= 16386);
    }

    #[test]
    fn log_tails_interleave_by_engine_order_and_keep_whole_newest_lines() {
        let frame = |stream: u8, payload: &[u8]| {
            let mut bytes = vec![stream, 0, 0, 0];
            bytes.extend((payload.len() as u32).to_be_bytes());
            bytes.extend(payload);
            bytes
        };
        let line = |stream, text: &str| LogLine {
            stream,
            text: text.into(),
        };
        // Engine order interleaves streams; a line split across frames stays whole.
        let mut bytes = frame(1, b"one\n");
        bytes.extend(frame(2, b"warn\n"));
        bytes.extend(frame(1, b"tw"));
        bytes.extend(frame(2, b"err\n"));
        bytes.extend(frame(1, b"o\nlast"));
        let tail = decode_log_lines(&bytes).unwrap();
        assert_eq!(
            tail.lines,
            vec![
                line(LogStream::Stdout, "one\n"),
                line(LogStream::Stderr, "warn\n"),
                line(LogStream::Stdout, "two\n"),
                line(LogStream::Stderr, "err\n"),
                line(LogStream::Stdout, "last"),
            ]
        );
        assert!(!tail.truncated);
        assert_eq!(
            tail.split(),
            ("one\ntwo\nlast".into(), "warn\nerr\n".into())
        );
        assert!(decode_log_lines(&bytes[..bytes.len() - 1]).is_err());
        assert!(decode_log_lines(&[3, 0, 0, 0, 0, 0, 0, 0]).is_err());

        // Over budget: the oldest whole lines are dropped, newest kept, never cut.
        let mut bytes = Vec::new();
        for index in 0..2000 {
            let stream = if index % 3 == 0 { 2 } else { 1 };
            bytes.extend(frame(stream, format!("line {index:04} \"x\"\n").as_bytes()));
        }
        let tail = decode_log_lines(&bytes).unwrap();
        assert!(tail.truncated);
        assert_eq!(tail.lines.last().unwrap().text, "line 1999 \"x\"\n");
        assert!(tail.lines.len() < 2000);
        assert!(
            tail.lines
                .iter()
                .all(|line| { line.text.starts_with("line ") && line.text.ends_with("\"x\"\n") })
        );
        let first: usize = tail.lines[0].text[5..9].parse().unwrap();
        assert_eq!(first + tail.lines.len(), 2000);
        let encoded = serde_json::to_vec(&tail.lines).unwrap().len();
        assert!(encoded <= LOG_TAIL_BUDGET, "{encoded}");

        // Only a single line larger than the whole budget is cut, and that is explicit.
        let tail = decode_log_lines(&frame(1, &vec![b'y'; 100_000])).unwrap();
        assert!(tail.truncated);
        assert_eq!(tail.lines.len(), 1);
        assert!(serde_json::to_vec(&tail.lines).unwrap().len() <= LOG_TAIL_BUDGET);
        let tail = decode_log_lines(&frame(2, &vec![0; 20_000])).unwrap();
        assert!(tail.truncated);
        assert!(serde_json::to_vec(&tail.lines).unwrap().len() <= LOG_TAIL_BUDGET);
    }

    #[test]
    fn rejection_classification_never_returns_response_values() {
        assert_eq!(
            rejection_category(br#"{"message":"permission denied at /secret/DO_NOT_RETURN"}"#),
            "permission-denied"
        );
        assert_eq!(rejection_category(b"DO_NOT_RETURN"), "unclassified");
        assert_eq!(
            rejection_category(
                br#"{"message":"symlink /secret/DO_NOT_RETURN: no space left on device"}"#
            ),
            "storage-exhausted"
        );
    }

    fn exchange(response: &'static [u8]) -> Result<Value, CandidateError> {
        let path = std::env::temp_dir().join(format!(
            "hc-{}-{}.sock",
            std::process::id(),
            crate::node::now()
        ));
        let listener = UnixListener::bind(&path).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut data = [0_u8; 4096];
            let n = socket.read(&mut data).unwrap();
            assert!(
                std::str::from_utf8(&data[..n])
                    .unwrap()
                    .starts_with("GET /version HTTP/1.1\r\n")
            );
            socket.write_all(response).unwrap();
        });
        let result = Transport::new(&path, Duration::from_millis(500))
            .unwrap()
            .request(Method::GET, "/version", None);
        worker.join().unwrap();
        std::fs::remove_file(path).unwrap();
        result
    }

    #[test]
    fn unix_engine_transport_decodes_chunked_json_and_refuses_redirects() {
        assert_eq!(
            exchange(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"x\":1}\r\n0\r\n\r\n"
            )
            .unwrap(),
            serde_json::json!({"x":1})
        );
        assert_eq!(exchange(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n").unwrap_err().code, "engine_rejected");
        let error = exchange(b"HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n{\"message\":\"failed to create shim task: ttrpc: closed /secret/DO_NOT_RETURN\"}").unwrap_err();
        assert_eq!(error.code, "engine_rejected");
        assert_eq!(
            error.message,
            "Private engine returned HTTP 500 (runtime-channel-closed). Response values are omitted."
        );
        assert!(exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 4194305\r\n\r\n").is_err());
        assert!(exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{\"x\":").is_err());
    }
}

#[cfg(all(test, feature = "environment-launcher"))]
mod admission_tests;
