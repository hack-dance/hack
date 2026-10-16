//! Minimal pinned SmolVM agent protocol. Connecting never boots or recovers a VM.
use crate::CandidateError;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_FRAME: usize = 64 * 1024;
fn failure(message: impl Into<String>) -> CandidateError {
    CandidateError::new("agent_protocol_uncertain", message)
}

pub fn request(path: &Path, body: Value, timeout: Duration) -> Result<Value, CandidateError> {
    let bytes = encode(&body)?;
    let mut stream = UnixStream::connect(path)
        .map_err(|_| failure("Cannot connect to the owned guest socket; no automatic start."))?;
    exchange(&mut stream, &bytes, timeout)
}

/// Bound encoded allocation as well as transmitted bytes. Never report serialization content.
fn encode(body: &Value) -> Result<Vec<u8>, CandidateError> {
    struct Frame(Vec<u8>);
    impl Write for Frame {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_FRAME - self.0.len() {
                return Err(std::io::Error::other("frame limit"));
            }
            let needed = self.0.len() + bytes.len();
            if needed > self.0.capacity() {
                let capacity = needed
                    .max(self.0.capacity().saturating_mul(2))
                    .min(MAX_FRAME);
                self.0.reserve_exact(capacity - self.0.len());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut frame = Frame(Vec::new());
    serde_json::to_writer(&mut frame, body)
        .map_err(|_| failure("Guest request exceeds frame limit."))?;
    Ok(frame.0)
}

fn exchange(
    stream: &mut UnixStream,
    bytes: &[u8],
    timeout: Duration,
) -> Result<Value, CandidateError> {
    let deadline = Instant::now() + timeout;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| failure(e.to_string()))?;
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|e| failure(e.to_string()))?;
    stream
        .write_all(bytes)
        .map_err(|e| failure(e.to_string()))?;
    stream
        .set_nonblocking(true)
        .map_err(|_| failure("Cannot configure bounded guest response reads."))?;
    fn read_until(
        stream: &mut UnixStream,
        mut buffer: &mut [u8],
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        while !buffer.is_empty() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| failure("Guest response deadline exceeded."))?;
            match stream.read(buffer) {
                Ok(0) => return Err(failure("Guest disconnected mid-response.")),
                Ok(count) => {
                    buffer = &mut buffer[count..];
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    let mut descriptor = libc::pollfd {
                        fd: stream.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    let milliseconds = (remaining.as_millis() + 1).min(i32::MAX as u128) as i32;
                    // The descriptor is borrowed from the live stream for this synchronous wait.
                    let result = unsafe { libc::poll(&mut descriptor, 1, milliseconds) };
                    if result < 0
                        && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                    {
                        return Err(failure("Cannot wait for the guest response."));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(failure(e.to_string())),
            }
        }
        Ok(())
    }
    let mut header = [0; 4];
    read_until(stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME {
        return Err(failure("Guest response exceeds frame limit."));
    }
    let mut body = vec![0; length];
    read_until(stream, &mut body, deadline)?;
    serde_json::from_slice(&body).map_err(|_| failure("Malformed guest response."))
}

pub fn ping(path: &Path) -> Result<(), CandidateError> {
    let response = request(path, json!({"method":"ping"}), Duration::from_secs(3))?;
    if response["status"] != "pong" || response["version"] != 1 {
        return Err(failure("Pinned guest protocol version mismatch."));
    }
    Ok(())
}

pub fn exec(
    path: &Path,
    script: &str,
    arguments: &[&str],
    background: bool,
) -> Result<String, CandidateError> {
    exec_input(path, script, arguments, background, None)
}

pub fn exec_input(
    path: &Path,
    script: &str,
    arguments: &[&str],
    background: bool,
    input: Option<&str>,
) -> Result<String, CandidateError> {
    let mut command = vec!["/bin/sh", "-c", script, "hack-local"];
    command.extend_from_slice(arguments);
    let response = request(
        path,
        json!({"method":"vm_exec", "command":command,
        "env":[["PATH","/opt/hack-engine:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]],
        "workdir":"/", "timeout_ms":if background {None} else {Some(40000)},
        "interactive":false,"tty":false,"background":background,"stdin_data":input}),
        Duration::from_secs(45),
    )?;
    decode_execution(response)
}

/// Fixed synchronous guest-cache effect: guest kills its entire exec process group
/// after seven seconds; host response is bounded to eight. Timeout is uncertain.
pub(super) fn release_guest_cache(
    path: &Path,
    owner: &str,
    boot: &str,
) -> Result<(), CandidateError> {
    let script = r#"set -eu; test "$(cat /storage/.hack-local-owner)" = "$1"; test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"; sync; printf 3 > /proc/sys/vm/drop_caches; printf 'cache-release-v1\n'"#;
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut stream = connect_until(path, deadline)?;
    let body = json!({"method":"vm_exec","command":["/bin/sh","-c",script,"hack-local",owner,boot],"env":[["PATH","/usr/sbin:/usr/bin:/sbin:/bin"]],"workdir":"/","timeout_ms":7000,"interactive":false,"tty":false,"background":false,"stdin_data":null});
    let response = exchange(
        &mut stream,
        &encode(&body)?,
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| failure("Cache release deadline expired."))?,
    )?;
    if decode_execution(response)? != "cache-release-v1\n" {
        return Err(failure("Cache release acknowledgement differs."));
    }
    Ok(())
}

// Keep this effect's connect and response inside one deadline, including a full
// agent backlog. No thread or detached request outlives the caller.
fn connect_until(path: &Path, deadline: Instant) -> Result<UnixStream, CandidateError> {
    if Instant::now() >= deadline {
        return Err(failure("Guest connect deadline expired."));
    }
    use std::os::fd::FromRawFd;
    // SAFETY: socket returns a fresh descriptor, adopted once below.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(failure("Cannot create guest connection."));
    }
    // SAFETY: fd is newly owned and valid.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    // SAFETY: the live owned descriptor is the only argument; no pointers retained.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(failure("Cannot secure guest connection."));
    }
    stream
        .set_nonblocking(true)
        .map_err(|_| failure("Cannot bound guest connection."))?;
    // SAFETY: sockaddr_un is plain zero-initialized C storage populated below.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as _;
    let bytes = path.as_os_str().as_encoded_bytes();
    if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(failure("Invalid guest socket path."));
    }
    for (to, from) in address.sun_path.iter_mut().zip(bytes) {
        *to = *from as _;
    }
    // SAFETY: initialized address and exact storage length remain live for connect.
    let status = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as _,
        )
    };
    if status < 0 {
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(failure("Guest connection unavailable."));
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| failure("Guest connect deadline expired."))?;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: poll borrows one initialized descriptor entry for the bounded call.
        if unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        } <= 0
            || stream
                .take_error()
                .map_err(|_| failure("Guest connection uncertain."))?
                .is_some()
        {
            return Err(failure("Guest connection uncertain."));
        }
    }
    stream
        .set_nonblocking(false)
        .map_err(|_| failure("Cannot configure guest connection."))?;
    Ok(stream)
}

/// Error details are guest-controlled and may echo input values. Retain only a numeric exit code.
fn decode_execution(response: Value) -> Result<String, CandidateError> {
    if response["status"] != "completed" || response["exit_code"] != 0 {
        let exit = response["exit_code"]
            .as_i64()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".into());
        return Err(CandidateError::new(
            "guest_command_failed",
            format!(
                "Owned guest check failed (exit {exit}); phase retained. Guest output omitted."
            ),
        ));
    }
    let encoded = response["stdout"]
        .as_str()
        .ok_or_else(|| failure("Missing base64 guest output."))?;
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| failure("Invalid base64 guest output."))?;
    String::from_utf8(decoded).map_err(|_| failure("Guest receipt is not UTF-8."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_guest_output_and_malformed_metadata_never_enter_errors() {
        let sentinel = "synthetic-private-input";
        for response in [
            json!({"status":"completed", "exit_code":23, "stdout":STANDARD.encode(sentinel), "stderr":STANDARD.encode(sentinel)}),
            json!({"status":sentinel, "exit_code":sentinel, "stderr":sentinel}),
            json!({"status":"completed", "exit_code":{"detail":sentinel}, "stderr":STANDARD.encode(sentinel)}),
            json!({"status":"completed", "exit_code":0, "stdout":sentinel}),
            json!({"status":"completed", "exit_code":0, "stdout":STANDARD.encode([0xff]), "stderr":sentinel}),
        ] {
            let failure = decode_execution(response).unwrap_err();
            let serialized = serde_json::to_string(&failure).unwrap();
            assert!(!serialized.contains(sentinel));
            assert!(!serialized.contains(&STANDARD.encode(sentinel)));
        }
        let failure = decode_execution(json!({"status":"completed", "exit_code":23})).unwrap_err();
        assert_eq!(failure.code, "guest_command_failed");
        assert!(failure.message.contains("exit 23"));
    }

    #[test]
    fn successful_public_receipts_are_preserved() {
        let receipt = "public-fixture-receipt\n";
        assert_eq!(decode_execution(json!({"status":"completed", "exit_code":0, "stdout":STANDARD.encode(receipt), "stderr":STANDARD.encode("ignored diagnostic")})).unwrap(), receipt);
    }

    #[test]
    fn encoded_frame_budget_counts_json_escaping_and_accepts_exact_limit() {
        let exact = json!("x".repeat(MAX_FRAME - 2));
        assert_eq!(encode(&exact).unwrap().len(), MAX_FRAME);
        assert!(encode(&json!("x".repeat(MAX_FRAME - 1))).is_err());
        // The raw value fits, but JSON escaping makes its wire representation exceed the budget.
        assert!(encode(&json!("\n".repeat(MAX_FRAME / 2))).is_err());
        assert_eq!(
            encode(&json!({"stdin_data":"line\n'\\$"})).unwrap(),
            serde_json::to_vec(&json!({"stdin_data":"line\n'\\$"})).unwrap()
        );
    }

    #[test]
    fn oversized_sensitive_input_is_refused_before_connecting() {
        let error = request(
            Path::new("/nonexistent/hack-test-agent.sock"),
            json!({"stdin_data":"synthetic-sensitive-input".repeat(MAX_FRAME)}),
            Duration::from_millis(10),
        )
        .unwrap_err();
        assert_eq!(error.message, "Guest request exceeds frame limit.");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("synthetic-sensitive-input")
        );
    }

    #[test]
    fn guest_echo_over_wire_is_not_retained_in_failure() {
        let sentinel = "synthetic-wire-private-value";
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let mut header = [0; 4];
            peer.read_exact(&mut header).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(header) as usize];
            peer.read_exact(&mut bytes).unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["stdin_data"], sentinel);
            let response = serde_json::to_vec(&json!({"status":"completed", "exit_code":1, "stderr":STANDARD.encode(body["stdin_data"].as_str().unwrap())})).unwrap();
            peer.write_all(&(response.len() as u32).to_be_bytes())
                .unwrap();
            peer.write_all(&response).unwrap();
        });
        let response = exchange(
            &mut client,
            &encode(&json!({"stdin_data":sentinel})).unwrap(),
            Duration::from_secs(1),
        )
        .unwrap();
        let error = decode_execution(response).unwrap_err();
        assert!(!serde_json::to_string(&error).unwrap().contains(sentinel));
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains(&STANDARD.encode(sentinel))
        );
        worker.join().unwrap();
    }

    #[test]
    fn oversized_frame_is_rejected_before_body_allocation() {
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let mut header = [0; 4];
            peer.read_exact(&mut header).unwrap();
            let mut request = vec![0; u32::from_be_bytes(header) as usize];
            peer.read_exact(&mut request).unwrap();
            peer.write_all(&((MAX_FRAME + 1) as u32).to_be_bytes())
                .unwrap();
        });
        assert_eq!(
            exchange(
                &mut client,
                &encode(&json!({"method":"ping"})).unwrap(),
                Duration::from_secs(1)
            )
            .unwrap_err()
            .code,
            "agent_protocol_uncertain"
        );
        worker.join().unwrap();
    }
    #[test]
    fn a_stalled_mid_frame_has_a_wall_clock_deadline() {
        let (mut client, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(&100_u32.to_be_bytes()).unwrap();
        peer.write_all(b"{").unwrap();
        let start = Instant::now();
        assert!(
            exchange(
                &mut client,
                &encode(&json!({"method":"ping"})).unwrap(),
                Duration::from_millis(50)
            )
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
