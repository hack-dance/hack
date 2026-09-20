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
use std::time::Duration;

mod stop;

const MAX_BODY: u64 = 4 * 1024 * 1024;

struct Transport {
    client: Client,
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
        Ok(Self { client })
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
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains('#')
            || path.bytes().any(|b| b.is_ascii_control())
        {
            return Err(failure("Invalid private engine request path."));
        }
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
        let response = request.send().map_err(|_| failure("Engine request failed or timed out; its effect may be uncertain. No request was replayed."))?;
        response_bytes(response)
    }
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

fn failure(message: &str) -> CandidateError {
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
}

impl<'a> Engine<'a> {
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
    pub(super) fn logs(&self, id: &str) -> Result<(String, String, bool), CandidateError> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(failure("Invalid container log identity."));
        }
        self.guest.verify()?;
        let bytes = self.transport.request_bytes(
            Method::GET,
            &format!("/v1.53/containers/{id}/logs?stdout=true&stderr=true&tail=all"),
            None,
        )?;
        let result = decode_logs(&bytes)?;
        self.guest.verify()?;
        Ok(result)
    }
    pub(super) fn guest(&self) -> &OwnedGuest<'a> {
        &self.guest
    }
    pub(super) fn connect(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, false)
    }

    pub(super) fn connect_cleanup(candidate: &'a Candidate) -> Result<Self, CandidateError> {
        Self::connect_mode(candidate, true)
    }

    fn connect_mode(candidate: &'a Candidate, cleanup_only: bool) -> Result<Self, CandidateError> {
        let guest = if cleanup_only {
            OwnedGuest::connect_cleanup(candidate)?
        } else {
            OwnedGuest::connect(candidate)?
        };
        let transport = Transport::new(&guest.engine_socket()?, Duration::from_secs(40))?;
        let engine = Self {
            guest,
            transport,
            cleanup_only,
        };
        engine.info()?;
        Ok(engine)
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
