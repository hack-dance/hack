//! A small client for one request on a fresh session (`hello`, then the op),
//! used by `hack-native service status|stop` and the tests. It reaches only the
//! service of the home it names: the service directory and socket path must not
//! go through a symlink, must belong to this user, and the server's peer uid must
//! match. Connecting, each request and each reply are bounded.
use super::{FRAME_VERSION, failure, frame, paths};
use crate::CandidateError;
use serde_json::{Value, json};
use std::io::ErrorKind;
use std::os::fd::FromRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

const CLIENT_DEADLINE: Duration = Duration::from_secs(5);
/// Linux refuses a non-blocking connect with EAGAIN while the listener's backlog
/// is full; retry at this interval until the deadline.
const BACKLOG_RETRY: Duration = Duration::from_millis(10);
/// How long to wait for a connection-level refusal after a failed write.
const REFUSAL_WAIT: Duration = Duration::from_millis(200);

pub fn call(state_root: &Path, op: &str, args: Value) -> Result<Value, CandidateError> {
    call_within(state_root, op, args, CLIENT_DEADLINE)
}

pub(super) fn call_within(
    state_root: &Path,
    op: &str,
    args: Value,
    deadline: Duration,
) -> Result<Value, CandidateError> {
    let paths = paths(state_root);
    let absent = || failure("service_absent", "No runtime service is serving this home.");
    crate::reject_aliased_state(&paths.dir)?;
    match paths.dir.symlink_metadata() {
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(absent()),
        Err(e) => return Err(failure("service_io", e)),
        Ok(_) => super::check_private_directory(&paths.dir)?,
    }
    match paths.socket.symlink_metadata() {
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(absent()),
        Err(e) => return Err(failure("service_io", e)),
        Ok(m) if !m.file_type().is_socket() || m.uid() != super::euid() => {
            return Err(failure(
                "service_socket_path_refused",
                "The service socket path is not a socket owned by this user.",
            ));
        }
        Ok(_) => {}
    }
    let mut stream = connect(&paths.socket, Instant::now() + deadline)?;
    if crate::node::peer_uid(&stream)? != super::euid() {
        return Err(failure(
            "service_foreign",
            "The service runs as another user.",
        ));
    }
    let mut ask = |id: &str, op: &str, args: Value| -> Result<Value, CandidateError> {
        let request = json!({"v": FRAME_VERSION, "id": id, "op": op, "args": args});
        let bytes = serde_json::to_vec(&request).map_err(|e| failure("service_io", e))?;
        let written = frame::write(&mut stream, &bytes, frame::CONTROL_FRAME_LIMIT);
        // A server that refused the whole connection (for example the session
        // limit) may already have replied and closed; read that reply first.
        let wait = if written.is_ok() {
            deadline
        } else {
            REFUSAL_WAIT
        };
        let body = frame::read(&mut stream, wait, frame::CONTROL_FRAME_LIMIT).map_err(|e| {
            let error = written.as_ref().err().unwrap_or(&e);
            failure("service_io", format!("{error:?}"))
        })?;
        let value: Value = serde_json::from_slice(&body).map_err(|e| failure("service_io", e))?;
        answer_for(id, value)
    };
    ask("1", "hello", json!({"client": {"kind": "cli"}}))?;
    ask("2", op, args)
}

/// Accept a reply only for the request it names, with a complete envelope. A
/// refusal with a null id refuses the whole connection, before any request.
fn answer_for(id: &str, mut value: Value) -> Result<Value, CandidateError> {
    let malformed = || failure("service_protocol", "The service sent a malformed reply.");
    let ok = value.get("ok").and_then(Value::as_bool);
    let named = match value.get("id") {
        Some(Value::String(reply)) => reply == id,
        Some(Value::Null) => ok == Some(false),
        _ => false,
    };
    if !named {
        return Err(malformed());
    }
    match ok {
        Some(true) => value
            .as_object_mut()
            .and_then(|reply| reply.remove("result"))
            .ok_or_else(malformed),
        Some(false) => {
            let error = value.get("error").ok_or_else(malformed)?;
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .ok_or_else(malformed)?;
            Err(failure(
                "service_refused",
                format!(
                    "{code}: {}",
                    error.get("message").and_then(Value::as_str).unwrap_or("")
                ),
            ))
        }
        None => Err(malformed()),
    }
}

/// Connect without blocking past `deadline`, then return a blocking stream.
fn connect(path: &Path, deadline: Instant) -> Result<UnixStream, CandidateError> {
    let io = |e: std::io::Error| failure("service_io", e);
    let bytes = path.as_os_str().as_encoded_bytes();
    // SAFETY: an all-zero sockaddr_un is a valid empty address.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= address.sun_path.len() {
        return Err(failure(
            "service_socket_path_too_long",
            "The service socket path is too long.",
        ));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(target_vendor = "apple")]
    {
        address.sun_len = length as u8;
    }
    // SAFETY: plain socket creation; the descriptor is owned by `stream` below.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    // SAFETY: a fresh descriptor, wrapped exactly once.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    // SAFETY: F_SETFD on our own descriptor.
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    stream.set_nonblocking(true).map_err(io)?;
    loop {
        // SAFETY: a valid address of the computed length.
        let rc =
            unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), length) };
        if rc == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            // An interrupted connect continues in the background, like EINPROGRESS.
            Some(libc::EINTR | libc::EINPROGRESS) => {
                wait_connected(&stream, deadline)?;
                break;
            }
            Some(libc::EAGAIN) => {
                if Instant::now() + BACKLOG_RETRY >= deadline {
                    return Err(busy());
                }
                std::thread::sleep(BACKLOG_RETRY);
            }
            Some(libc::ENOENT | libc::ECONNREFUSED) => {
                return Err(failure(
                    "service_absent",
                    "No runtime service is serving this home.",
                ));
            }
            _ => return Err(io(error)),
        }
    }
    stream.set_nonblocking(false).map_err(io)?;
    Ok(stream)
}

fn busy() -> CandidateError {
    failure(
        "service_busy",
        "The runtime service did not accept the connection in time.",
    )
}

fn wait_connected(stream: &UnixStream, deadline: Instant) -> Result<(), CandidateError> {
    use std::os::fd::AsRawFd;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(busy());
        }
        let mut fd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        let millis = left.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32;
        // SAFETY: one initialized pollfd that outlives the call.
        match unsafe { libc::poll(&mut fd, 1, millis) } {
            n if n > 0 => break,
            0 => return Err(busy()),
            _ => {
                let e = std::io::Error::last_os_error();
                if e.kind() != ErrorKind::Interrupted {
                    return Err(failure("service_io", e));
                }
            }
        }
    }
    match stream.take_error() {
        Ok(None) => Ok(()),
        Ok(Some(e)) | Err(e) => Err(failure("service_io", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_reply_to_the_request_sent_is_accepted() {
        assert_eq!(
            answer_for("2", json!({"id": "2", "ok": true, "result": {"a": 1}})).unwrap(),
            json!({"a": 1})
        );
        for wrong in [
            json!({"id": "1", "ok": true, "result": {}}),
            json!({"ok": true, "result": {}}),
            json!({"id": "2", "ok": true}),
            json!({"id": "2", "result": {}}),
            json!({"id": "2", "ok": "yes", "result": {}}),
            json!({"id": "2", "ok": false}),
            json!({"id": "2", "ok": false, "error": {"message": "x"}}),
        ] {
            assert_eq!(answer_for("2", wrong).unwrap_err().code, "service_protocol");
        }
        // A null id is accepted only for a refusal of the whole connection.
        let null_ok = answer_for("1", json!({"id": null, "ok": true, "result": {}}));
        assert_eq!(null_ok.unwrap_err().code, "service_protocol");
        let whole = answer_for(
            "1",
            json!({"id": null, "ok": false, "error": {"code": "E_SESSION_LIMIT"}}),
        );
        assert!(whole.unwrap_err().message.contains("E_SESSION_LIMIT"));
        let refused = answer_for(
            "2",
            json!({"id": "2", "ok": false, "error": {"code": "E_X"}}),
        );
        assert_eq!(refused.unwrap_err().code, "service_refused");
    }
}
