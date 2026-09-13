//! Minimal pinned SmolVM agent protocol. Connecting never boots or recovers a VM.
use crate::CandidateError;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_FRAME: usize = 64 * 1024;
fn failure(message: impl Into<String>) -> CandidateError {
    CandidateError::new("agent_protocol_uncertain", message)
}

pub fn request(path: &Path, body: Value, timeout: Duration) -> Result<Value, CandidateError> {
    let mut stream = UnixStream::connect(path)
        .map_err(|_| failure("Cannot connect to the owned guest socket; no automatic start."))?;
    exchange(&mut stream, body, timeout)
}
fn exchange(
    stream: &mut UnixStream,
    body: Value,
    timeout: Duration,
) -> Result<Value, CandidateError> {
    let bytes = serde_json::to_vec(&body).map_err(|_| failure("Cannot encode guest request."))?;
    if bytes.len() > MAX_FRAME {
        return Err(failure("Guest request exceeds frame limit."));
    }
    let deadline = Instant::now() + timeout;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| failure(e.to_string()))?;
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|e| failure(e.to_string()))?;
    stream
        .write_all(&bytes)
        .map_err(|e| failure(e.to_string()))?;
    fn read_until(
        stream: &mut UnixStream,
        mut buffer: &mut [u8],
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        while !buffer.is_empty() {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| failure("Guest response deadline exceeded."))?;
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|e| failure(e.to_string()))?;
            match stream.read(buffer) {
                Ok(0) => return Err(failure("Guest disconnected mid-response.")),
                Ok(count) => {
                    buffer = &mut buffer[count..];
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
    if response["status"] != "completed" || response["exit_code"] != 0 {
        return Err(CandidateError::new(
            "guest_command_failed",
            format!(
                "Owned guest check failed (exit {}); phase retained. {}",
                response["exit_code"],
                response["stderr"]
                    .as_str()
                    .and_then(|v| STANDARD.decode(v).ok())
                    .map(|v| String::from_utf8_lossy(&v[..v.len().min(4096)])
                        .trim()
                        .to_owned())
                    .unwrap_or_default()
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
                json!({"method":"ping"}),
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
                json!({"method":"ping"}),
                Duration::from_millis(50)
            )
            .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
