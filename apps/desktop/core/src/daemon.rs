//! Read-only client for the `hackd` Unix socket.
//!
//! Only GET requests, one per connection (`Connection: close`), with a read
//! and write timeout. The socket API has no authentication; it is owner-only
//! on disk, and the app only reads from it. A daemon whose version differs
//! from the CLI is treated as unusable for data (the CLI does the same) and
//! project reads remain unavailable until a matching daemon can be read.

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
    /// The socket or its directory is not provably this user's own.
    Untrusted(String),
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
            Self::Untrusted(why) => write!(f, "hackd socket not trusted: {why}"),
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
        // hackd's API has no authentication: trust it only when the socket's
        // directory is this user's own and nobody else can replace entries
        // in it, and the peer process runs as this user. Otherwise the app
        // refuses this snapshot.
        check_socket_path_len(&self.socket)?;
        let uid = current_uid();
        check_private_dir(&self.socket, uid)?;
        let mut s = UnixStream::connect(&self.socket)
            .map_err(|e| DaemonError::Unreachable(e.to_string()))?;
        match peer_uid(&s) {
            Some(p) if p == uid => {}
            Some(p) => {
                return Err(DaemonError::Untrusted(format!(
                    "peer runs as uid {p}, not {uid}"
                )));
            }
            None => return Err(DaemonError::Untrusted("peer uid unavailable".into())),
        }
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

/// Longest Unix socket path, in bytes, this platform accepts
/// (`sockaddr_un.sun_path` minus the terminating NUL).
#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd"))]
pub const MAX_SOCKET_PATH: usize = 103;
#[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd")))]
pub const MAX_SOCKET_PATH: usize = 107;

/// A socket path the OS cannot address (for example under a long home
/// directory on macOS) is reported clearly, without attempting a connection.
fn check_socket_path_len(socket: &Path) -> Result<(), DaemonError> {
    use std::os::unix::ffi::OsStrExt;
    let n = socket.as_os_str().as_bytes().len();
    if n > MAX_SOCKET_PATH {
        return Err(DaemonError::Unreachable(format!(
            "the hackd socket path is {n} bytes, longer than the {MAX_SOCKET_PATH} this system allows"
        )));
    }
    Ok(())
}

fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// The socket and its directory must be owned by `uid`, not symlinks, and
/// the directory must not be writable by group or others.
fn check_private_dir(socket: &Path, uid: u32) -> Result<(), DaemonError> {
    use std::os::unix::fs::MetadataExt;
    let untrusted = DaemonError::Untrusted;
    let dir = socket
        .parent()
        .ok_or_else(|| untrusted("socket has no parent directory".into()))?;
    let dm = std::fs::symlink_metadata(dir).map_err(|e| DaemonError::Unreachable(e.to_string()))?;
    if !dm.is_dir() {
        return Err(untrusted("daemon directory is not a directory".into()));
    }
    if dm.uid() != uid {
        return Err(untrusted(
            "daemon directory is owned by another user".into(),
        ));
    }
    if dm.mode() & 0o022 != 0 {
        return Err(untrusted(
            "daemon directory is group- or world-writable".into(),
        ));
    }
    let sm =
        std::fs::symlink_metadata(socket).map_err(|e| DaemonError::Unreachable(e.to_string()))?;
    if sm.file_type().is_symlink() || sm.uid() != uid {
        return Err(untrusted(
            "socket is a link or owned by another user".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = libc::socklen_t::try_from(std::mem::size_of::<libc::ucred>()).ok()?;
    // SAFETY: valid fd, out-pointer sized for ucred.
    let rc = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut cred).cast(),
            &raw mut len,
        )
    };
    (rc == 0).then_some(cred.uid)
}

#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd"))]
fn peer_uid(s: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: valid fd and out-pointers.
    let rc = unsafe { libc::getpeereid(s.as_raw_fd(), &raw mut uid, &raw mut gid) };
    (rc == 0).then_some(uid)
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

    /// A short private directory for test sockets: the system temp dir can
    /// be too long for a Unix socket path (macOS allows 103 bytes).
    fn short_socket_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = PathBuf::from(format!(
            "/tmp/hd{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    fn serve_once(response: Vec<u8>) -> (PathBuf, thread::JoinHandle<String>) {
        let dir = short_socket_dir();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let sock = dir.join("hackd.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let h = thread::spawn(move || {
            let accepted = listener.accept();
            // Clean up first: the client may already be gone (refused or
            // dropped), and a failed write must not leave the directory.
            let _ = std::fs::remove_dir_all(&dir);
            let Ok((mut c, _)) = accepted else {
                return String::new();
            };
            let mut buf = [0u8; 4096];
            let n = c.read(&mut buf).unwrap_or(0);
            let _ = c.write_all(&response);
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
    fn group_writable_daemon_dir_is_not_trusted() {
        use std::os::unix::fs::PermissionsExt;
        let (sock, h) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec());
        let dir = sock.parent().unwrap().to_path_buf();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o770)).unwrap();
        let r = DaemonClient::new(&sock, Duration::from_secs(2)).status();
        assert!(matches!(r, Err(DaemonError::Untrusted(_))), "{r:?}");
        // Release the test server so its thread ends.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        drop(UnixStream::connect(&sock));
        let _ = h.join();
    }

    #[test]
    fn own_peer_passes_the_peer_check() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a), Some(current_uid()));
    }

    #[test]
    fn an_over_long_socket_path_is_a_clear_error_not_a_panic() {
        let long = PathBuf::from(format!("/tmp/{}/hackd.sock", "x".repeat(200)));
        let r = DaemonClient::new(&long, Duration::from_millis(100)).status();
        match r {
            Err(DaemonError::Unreachable(m)) => assert!(m.contains("socket path"), "{m}"),
            other => panic!("{other:?}"),
        }
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
