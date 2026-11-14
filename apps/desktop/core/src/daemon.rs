//! Read-only client for the `hackd` Unix socket.
//!
//! Only GET requests, one per connection (`Connection: close`), with a read
//! and write timeout. The socket API has no authentication; it is owner-only
//! on disk, and the app only reads from it. A daemon whose version differs
//! from the CLI is treated as unusable for data (the CLI does the same) and
//! the app falls back to the CLI.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::models::{DaemonApiStatus, ProjectsPayload};

const MAX_BODY: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonError {
    /// No socket, or nothing listening.
    Unreachable(String),
    Timeout,
    Http {
        status: u16,
        body: String,
    },
    BadResponse(String),
}

impl std::fmt::Display for DaemonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(e) => write!(f, "hackd is not reachable: {e}"),
            Self::Timeout => write!(f, "hackd did not answer in time"),
            Self::Http { status, body } => write!(f, "hackd returned {status}: {body}"),
            Self::BadResponse(e) => write!(f, "unexpected response from hackd: {e}"),
        }
    }
}

/// `$HACK_HOME/daemon/hackd.sock`, else `~/.hack/daemon/hackd.sock`.
#[must_use]
pub fn default_socket_path(hack_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let root = match hack_home.filter(|h| Path::new(h).is_absolute()) {
        Some(h) => PathBuf::from(h),
        None => PathBuf::from(home?).join(".hack"),
    };
    Some(root.join("daemon").join("hackd.sock"))
}

#[derive(Debug, Clone)]
pub struct DaemonClient {
    socket: PathBuf,
    timeout: Duration,
}

impl DaemonClient {
    #[must_use]
    pub fn new(socket: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            socket: socket.into(),
            timeout,
        }
    }

    /// GET a path and deserialize the JSON body.
    ///
    /// # Errors
    /// Any [`DaemonError`].
    pub fn get_json<T: DeserializeOwned>(&self, path_and_query: &str) -> Result<T, DaemonError> {
        let body = self.get(path_and_query)?;
        serde_json::from_slice(&body).map_err(|e| DaemonError::BadResponse(e.to_string()))
    }

    /// # Errors
    /// Any [`DaemonError`].
    pub fn status(&self) -> Result<DaemonApiStatus, DaemonError> {
        self.get_json("/v1/status")
    }

    /// # Errors
    /// Any [`DaemonError`].
    pub fn projects(&self) -> Result<ProjectsPayload, DaemonError> {
        let v: serde_json::Value = self.get_json("/v1/projects")?;
        ProjectsPayload::from_value(v).map_err(DaemonError::BadResponse)
    }

    fn get(&self, path_and_query: &str) -> Result<Vec<u8>, DaemonError> {
        let mut s = UnixStream::connect(&self.socket)
            .map_err(|e| DaemonError::Unreachable(e.to_string()))?;
        s.set_read_timeout(Some(self.timeout))
            .and_then(|()| s.set_write_timeout(Some(self.timeout)))
            .map_err(|e| DaemonError::Unreachable(e.to_string()))?;
        let req = format!(
            "GET {path_and_query} HTTP/1.1\r\nHost: hackd\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        s.write_all(req.as_bytes()).map_err(io_err)?;
        let mut raw = Vec::new();
        s.take(MAX_BODY as u64 + 64 * 1024)
            .read_to_end(&mut raw)
            .map_err(io_err)?;
        parse_http(&raw)
    }
}

fn io_err(e: std::io::Error) -> DaemonError {
    match e.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => DaemonError::Timeout,
        _ => DaemonError::Unreachable(e.to_string()),
    }
}

/// Parse a full HTTP/1.1 response (Content-Length, chunked, or to EOF).
///
/// # Errors
/// `BadResponse` or `Http` for a non-2xx status.
pub fn parse_http(raw: &[u8]) -> Result<Vec<u8>, DaemonError> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| DaemonError::BadResponse("no header terminator".into()))?;
    let head = std::str::from_utf8(&raw[..split])
        .map_err(|_| DaemonError::BadResponse("header is not UTF-8".into()))?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| DaemonError::BadResponse("bad status line".into()))?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked") {
            chunked = true;
        } else if k == "content-length" {
            length = v.parse().ok();
        }
    }
    let body = if chunked {
        dechunk(body)?
    } else if let Some(n) = length {
        body.get(..n)
            .ok_or_else(|| DaemonError::BadResponse("body shorter than Content-Length".into()))?
            .to_vec()
    } else {
        body.to_vec()
    };
    if !(200..300).contains(&status) {
        return Err(DaemonError::Http {
            status,
            body: String::from_utf8_lossy(&body).chars().take(200).collect(),
        });
    }
    Ok(body)
}

fn dechunk(mut b: &[u8]) -> Result<Vec<u8>, DaemonError> {
    let bad = || DaemonError::BadResponse("bad chunked body".into());
    let mut out = Vec::new();
    loop {
        let eol = b.windows(2).position(|w| w == b"\r\n").ok_or_else(bad)?;
        let size_txt = std::str::from_utf8(&b[..eol]).map_err(|_| bad())?;
        let size = usize::from_str_radix(size_txt.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| bad())?;
        b = &b[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        // Checked arithmetic: a huge size must be an error, not a panic.
        let end = size.checked_add(2).ok_or_else(bad)?;
        if size > MAX_BODY.saturating_sub(out.len()) || b.len() < end {
            return Err(bad());
        }
        if &b[size..end] != b"\r\n" {
            return Err(bad());
        }
        out.extend_from_slice(&b[..size]);
        b = &b[end..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::thread;

    fn serve_once(response: Vec<u8>) -> (PathBuf, thread::JoinHandle<String>) {
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-daemon-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("hackd.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let h = thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = c.read(&mut buf).unwrap();
            c.write_all(&response).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (sock, h)
    }

    #[test]
    fn reads_status_with_content_length() {
        let (sock, h) = serve_once(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 35\r\n\r\n{\"status\":\"ok\",\"version\":\"5.0.0\"}  "
                .to_vec(),
        );
        let s = DaemonClient::new(&sock, Duration::from_secs(2))
            .status()
            .unwrap();
        assert_eq!(s.version, "5.0.0");
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /v1/status HTTP/1.1\r\n"));
    }

    #[test]
    fn reads_chunked_projects() {
        let parts = [r#"{"projects":[{""#, r#"name":"a"}],"x":1}"#];
        let mut resp = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for p in parts {
            resp.extend(format!("{:x}\r\n{p}\r\n", p.len()).into_bytes());
        }
        resp.extend(b"0\r\n\r\n");
        let (sock, h) = serve_once(resp);
        let p = DaemonClient::new(&sock, Duration::from_secs(2))
            .projects()
            .unwrap();
        assert_eq!(p.projects[0].name, "a");
        h.join().unwrap();
    }

    #[test]
    fn http_error_is_reported() {
        let (sock, h) = serve_once(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 21\r\n\r\n{\"error\":\"not_found\"}"
                .to_vec(),
        );
        let r = DaemonClient::new(&sock, Duration::from_secs(2)).status();
        assert!(matches!(r, Err(DaemonError::Http { status: 404, .. })));
        h.join().unwrap();
    }

    #[test]
    fn malformed_chunks_are_errors_not_panics() {
        let huge = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\nab\r\n0\r\n\r\n",
            usize::MAX
        );
        assert!(matches!(
            parse_http(huge.as_bytes()),
            Err(DaemonError::BadResponse(_))
        ));
        let bad_delim = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabXY0\r\n\r\n";
        assert!(matches!(
            parse_http(bad_delim),
            Err(DaemonError::BadResponse(_))
        ));
        let short = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\nab";
        assert!(matches!(
            parse_http(short),
            Err(DaemonError::BadResponse(_))
        ));
    }

    #[test]
    fn missing_socket_is_unreachable() {
        let r = DaemonClient::new("/nonexistent/hackd.sock", Duration::from_millis(100)).status();
        assert!(matches!(r, Err(DaemonError::Unreachable(_))));
    }

    #[test]
    fn socket_path_resolution() {
        assert_eq!(
            default_socket_path(Some("/tmp/hh"), Some("/u")),
            Some(PathBuf::from("/tmp/hh/daemon/hackd.sock"))
        );
        // A relative HACK_HOME is ignored, as the CLI requires an absolute one.
        assert_eq!(
            default_socket_path(Some("rel"), Some("/u")),
            Some(PathBuf::from("/u/.hack/daemon/hackd.sock"))
        );
        assert_eq!(default_socket_path(None, None), None);
    }
}
