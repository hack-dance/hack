//! Foreground private routing authority; its owner must retain a pipe on stdin.
use super::{publication, state};
use crate::{Candidate, CandidateError};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const LIMIT: usize = 4096;
const CLIENTS: usize = 32;
fn error() -> CandidateError {
    CandidateError::new(
        "hostname_authority",
        "Private authority transport refused; preserve unknown resources.",
    )
}
struct SocketOwner {
    path: PathBuf,
    device: u64,
    inode: u64,
}
impl Drop for SocketOwner {
    fn drop(&mut self) {
        if let Ok(m) = fs::symlink_metadata(&self.path)
            && m.file_type().is_socket()
            && m.dev() == self.device
            && m.ino() == self.inode
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
struct Client {
    stream: UnixStream,
    request: Vec<u8>,
    response: Option<Vec<u8>>,
    sent: usize,
    deadline: Instant,
}
fn response(code: u16, body: &[u8], endpoint: Option<&str>) -> Vec<u8> {
    let status = match code {
        200 => "OK",
        403 => "Forbidden",
        503 => "Service Unavailable",
        _ => "Bad Request",
    };
    let mut out = format!(
        "HTTP/1.1 {code} {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(endpoint) = endpoint {
        out.push_str(&format!("X-Hack-Endpoint: {endpoint}\r\n"));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
fn parse(bytes: &[u8]) -> Result<(String, bool), ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    if !text.is_ascii() || !text.ends_with("\r\n\r\n") {
        return Err(());
    }
    let mut lines = text[..text.len() - 4].split("\r\n");
    let first = lines.next().ok_or(())?.split(' ').collect::<Vec<_>>();
    if first.len() != 3 || first[0] != "GET" || first[2] != "HTTP/1.1" {
        return Err(());
    }
    let mut headers = std::collections::BTreeMap::new();
    for (index, line) in lines.enumerate() {
        let (key, value) = line.split_once(':').ok_or(())?;
        if index >= 64
            || key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.bytes().any(|b| b < 32 && b != b'\t')
            || value.contains('\x7f')
        {
            return Err(());
        }
        if headers
            .insert(key.to_ascii_lowercase(), value.trim())
            .is_some()
        {
            return Err(());
        }
    }
    if !headers.contains_key("host")
        || headers.contains_key("transfer-encoding")
        || headers.get("content-length").is_some_and(|n| *n != "0")
    {
        return Err(());
    }
    let (name, route) = if first[1] == "/route" {
        let authority = headers.get("x-forwarded-host").ok_or(())?;
        let name = if let Some((name, port)) = authority.split_once(':') {
            if port.is_empty()
                || !port.bytes().all(|b| b.is_ascii_digit())
                || port.parse::<u16>().is_err()
            {
                return Err(());
            }
            name
        } else {
            authority
        };
        (name, true)
    } else if let Some(name) = first[1].strip_prefix("/lookup?hostname=") {
        (name, false)
    } else {
        return Err(());
    };
    Ok((
        publication::normalize_hostname(name).map_err(|_| ())?,
        route,
    ))
}
fn answer(candidate: &Candidate, bytes: &[u8]) -> Vec<u8> {
    let Ok((hostname, route)) = parse(bytes) else {
        return response(400, b"{}", None);
    };
    let found = match publication::lookup_hostname(candidate, &hostname) {
        Ok(found) => found,
        Err(error) if error.code == "provider_busy" => return response(503, b"{}", None),
        Err(_) => return response(403, b"{}", None),
    };
    if route {
        let Some(endpoint) = found["endpoint"]
            .as_str()
            .filter(|s| s.is_ascii() && !s.bytes().any(|b| b < 32 || b == 127))
        else {
            return response(403, b"{}", None);
        };
        response(200, b"", Some(endpoint))
    } else {
        response(200, &serde_json::to_vec(&found).expect("JSON value"), None)
    }
}
/// No background daemon, idle polling or implicit socket adoption. EOF revokes this service.
pub fn serve(candidate: &Candidate, socket: &Path) -> Result<(), CandidateError> {
    let mut input = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(0, input.as_mut_ptr()) } != 0 {
        return Err(error());
    }
    let input = unsafe { input.assume_init() };
    if input.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Err(error());
    }
    if !socket.is_absolute() || socket.as_os_str().len() > 100 {
        return Err(error());
    }
    let parent = socket.parent().ok_or_else(error)?;
    state::check_private_directory(parent)?;
    if !fs::symlink_metadata(parent).map_err(state::io)?.is_dir() {
        return Err(error());
    }
    let listener = UnixListener::bind(socket).map_err(state::io)?;
    let m = fs::symlink_metadata(socket).map_err(state::io)?;
    let _owned = SocketOwner {
        path: socket.into(),
        device: m.dev(),
        inode: m.ino(),
    };
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600)).map_err(state::io)?;
    listener.set_nonblocking(true).map_err(state::io)?;
    let mut clients: Vec<Client> = Vec::new();
    println!("ready");
    std::io::stdout().flush().map_err(state::io)?;
    loop {
        let now = Instant::now();
        clients.retain(|c| c.deadline > now);
        let mut fds = vec![
            libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        fds.extend(clients.iter().map(|c| libc::pollfd {
            fd: c.stream.as_raw_fd(),
            events: if c.response.is_some() {
                libc::POLLOUT
            } else {
                libc::POLLIN
            },
            revents: 0,
        }));
        let timeout = clients
            .iter()
            .map(|c| {
                c.deadline
                    .saturating_duration_since(now)
                    .as_millis()
                    .clamp(1, 1000) as i32
            })
            .min()
            .unwrap_or(-1);
        let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if result < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(state::io(e));
        }
        if fds[0].revents != 0 {
            let mut bytes = [0u8; 64];
            // Input is only an owner-lifetime pipe; payload is never a command.
            if unsafe { libc::read(0, bytes.as_mut_ptr().cast(), bytes.len()) } <= 0 {
                return Ok(());
            }
        }
        for index in (0..clients.len()).rev() {
            let events = fds[index + 2].revents;
            let c = &mut clients[index];
            let mut done = false;
            if events & (libc::POLLERR | libc::POLLNVAL) != 0 {
                done = true;
            } else if c.response.is_none() && events & (libc::POLLIN | libc::POLLHUP) != 0 {
                let mut bytes = [0u8; 1024];
                match c.stream.read(&mut bytes) {
                    Ok(0) => done = true,
                    Ok(n) => {
                        c.request.extend_from_slice(&bytes[..n]);
                        if c.request.len() > LIMIT {
                            done = true;
                        } else if let Some(end) =
                            c.request.windows(4).position(|b| b == b"\r\n\r\n")
                        {
                            c.response = Some(if end + 4 == c.request.len() {
                                answer(candidate, &c.request)
                            } else {
                                response(400, b"{}", None)
                            });
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => done = true,
                }
            } else if events & libc::POLLOUT != 0
                && let Some(out) = &c.response
            {
                match c.stream.write(&out[c.sent..]) {
                    Ok(0) => done = true,
                    Ok(n) => {
                        c.sent += n;
                        done = c.sent == out.len();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => done = true,
                }
            }
            if done {
                clients.swap_remove(index);
            }
        }
        if fds[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(error());
        }
        if fds[1].revents & libc::POLLIN != 0 {
            for _ in 0..CLIENTS {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if clients.len() == CLIENTS {
                            continue;
                        }
                        stream.set_nonblocking(true).map_err(state::io)?;
                        clients.push(Client {
                            stream,
                            request: Vec::new(),
                            response: None,
                            sent: 0,
                            deadline: Instant::now() + Duration::from_secs(1),
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) => return Err(state::io(e)),
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_authority_request_contract() {
        assert_eq!(
            parse(b"GET /lookup?hostname=API.Demo.Hack. HTTP/1.1\r\nHost: local\r\n\r\n").unwrap(),
            ("api.demo.hack".into(), false)
        );
        assert_eq!(parse(b"GET /route HTTP/1.1\r\nHost: local\r\nX-Forwarded-Host: api.demo.hack:443\r\n\r\n").unwrap(),("api.demo.hack".into(),true));
        for request in [
            "POST /route HTTP/1.1\r\nHost: a\r\n\r\n",
            "GET /route HTTP/1.1\r\nHost: a\r\n\r\n",
            "GET /lookup?hostname=a/b HTTP/1.1\r\nHost: a\r\n\r\n",
            "GET /lookup?hostname=a HTTP/1.1\r\nHost: a\r\nhost: b\r\n\r\n",
            "GET /lookup?hostname=a HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n",
            "GET /lookup?hostname=a HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\n\r\n",
            "GET /ask?domain=a HTTP/1.1\r\nHost: a\r\n\r\n",
        ] {
            assert!(parse(request.as_bytes()).is_err());
        }
    }
}
