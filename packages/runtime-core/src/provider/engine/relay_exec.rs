//! Private Docker exec over the owned Unix endpoint. No long-lived Smol exec
//! connection, host subprocess, credential argument, or request replay is used.
#[cfg(target_os = "macos")]
use super::{OwnedGuest, Transport};
use crate::CandidateError;
#[cfg(target_os = "macos")]
use crate::provider::relay_auth::PrivateInput;
#[cfg(target_os = "macos")]
use reqwest::Method;
#[cfg(target_os = "macos")]
use serde_json::json;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "relay_private_child",
        "Private Docker exec transport failed; guest state may require reconciliation. No request was replayed.",
    )
}
fn remaining(deadline: Instant) -> Result<Duration, CandidateError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(refused)
}

pub(in crate::provider) struct RelayExec {
    stream: UnixStream,
    pending: Vec<u8>,
    closed: bool,
    received: usize,
}
impl RelayExec {
    #[cfg(target_os = "macos")]
    pub(in crate::provider) fn launch(
        guest: &OwnedGuest<'_>,
        container: &str,
        user: &str,
        argv: &[String],
        input: PrivateInput,
    ) -> Result<Self, CandidateError> {
        let deadline = Instant::now() + Duration::from_secs(8);
        guest.verify()?;
        guest.before_effect()?;
        let socket = guest.engine_socket()?;
        let created = Transport::new(&socket, remaining(deadline)?)?.request(
            Method::POST,
            &format!("/v1.53/containers/{container}/exec"),
            Some(&json!({
                "AttachStdin":true,"AttachStdout":true,"AttachStderr":true,
                "Tty":false,"Privileged":false,"User":user,"Cmd":argv
            })),
        )?;
        let id = created["Id"]
            .as_str()
            .filter(|id| {
                id.len() == 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or_else(refused)?;
        guest.verify()?;
        guest.before_effect()?;
        let mut stream =
            crate::provider::agent::connect_until(&socket, deadline).map_err(|_| refused())?;
        start(&mut stream, id, deadline)?;
        // No private bytes enter the HTTP body or headers. Only the accepted
        // upgraded stream receives stdin, followed by EOF on its write half.
        input.forward(&mut stream, deadline)?;
        guest.verify()?;
        stream.set_nonblocking(true).map_err(|_| refused())?;
        Ok(Self {
            stream,
            pending: Vec::new(),
            closed: false,
            received: 0,
        })
    }
    /// EOF is transport loss only. It never proves the guest process stopped.
    pub(in crate::provider) fn poll(
        &mut self,
        stdout: &mut Vec<u8>,
        stderr: &mut Vec<u8>,
    ) -> Result<bool, CandidateError> {
        let mut bytes = [0u8; 1024];
        loop {
            match self.stream.read(&mut bytes) {
                Ok(0) => {
                    self.closed = true;
                    break;
                }
                Ok(n) => {
                    self.received += n;
                    if self.received > 8192 {
                        return Err(refused());
                    }
                    if self.pending.len() + n > 4104 {
                        return Err(refused());
                    }
                    self.pending.extend_from_slice(&bytes[..n]);
                    decode(&mut self.pending, stdout, stderr)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(refused()),
            }
        }
        if self.closed && !self.pending.is_empty() {
            return Err(refused());
        }
        Ok(self.closed)
    }
}

fn start(stream: &mut UnixStream, id: &str, deadline: Instant) -> Result<(), CandidateError> {
    let body = r#"{"Detach":false,"Tty":false}"#;
    let request = format!(
        "POST /v1.53/exec/{id}/start HTTP/1.1\r\nHost: hack-local\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(|_| refused())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|_| refused())?;
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 8192 {
            return Err(refused());
        }
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| refused())?;
        let mut byte = [0];
        stream.read_exact(&mut byte).map_err(|_| refused())?;
        header.push(byte[0]);
    }
    let text = std::str::from_utf8(&header).map_err(|_| refused())?;
    let mut lines = text.split("\r\n");
    if lines.next() != Some("HTTP/1.1 101 UPGRADED")
        && !text.starts_with("HTTP/1.1 101 Switching Protocols\r\n")
    {
        return Err(refused());
    }
    let mut upgrade = false;
    let mut connection = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once(':').ok_or_else(refused)?;
        match key.to_ascii_lowercase().as_str() {
            "upgrade" => {
                if upgrade || !value.trim().eq_ignore_ascii_case("tcp") {
                    return Err(refused());
                }
                upgrade = true;
            }
            "connection" => {
                if connection || !value.trim().eq_ignore_ascii_case("upgrade") {
                    return Err(refused());
                }
                connection = true;
            }
            "content-length" | "transfer-encoding" => return Err(refused()),
            _ => {}
        }
    }
    if !upgrade || !connection {
        return Err(refused());
    }
    Ok(())
}
fn decode(
    pending: &mut Vec<u8>,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
) -> Result<(), CandidateError> {
    while pending.len() >= 8 {
        if ![1, 2].contains(&pending[0]) || pending[1..4] != [0, 0, 0] {
            return Err(refused());
        }
        let length = u32::from_be_bytes(pending[4..8].try_into().map_err(|_| refused())?) as usize;
        if length > 4096 || stdout.len() + stderr.len() + length > 4096 {
            return Err(refused());
        }
        if pending.len() < 8 + length {
            break;
        }
        let output = if pending[0] == 1 {
            &mut *stdout
        } else {
            &mut *stderr
        };
        output.extend_from_slice(&pending[8..8 + length]);
        pending.drain(..8 + length);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::relay_auth::{Binding, Credential};
    fn frame(stream: u8, value: &[u8]) -> Vec<u8> {
        let mut bytes = vec![stream, 0, 0, 0];
        bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
        bytes.extend_from_slice(value);
        bytes
    }
    fn request(stream: &mut UnixStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let length = String::from_utf8(bytes.clone())
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .unwrap()
            .parse::<usize>()
            .unwrap();
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        bytes.extend(body);
        bytes
    }
    #[test]
    fn real_upgrade_keeps_private_stdin_out_of_http_and_reads_fragmented_output() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            let request = request(&mut server);
            assert!(request.starts_with(
                format!("POST /v1.53/exec/{}/start HTTP/1.1", "a".repeat(64)).as_bytes()
            ));
            assert!(!request.windows(8).any(|v| v == b"HKRP0001"));
            server
                .write_all(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
                .unwrap();
            let mut private = zeroize::Zeroizing::new(Vec::new());
            server.read_to_end(&mut private).unwrap();
            assert_eq!(private.len(), 136);
            assert_eq!(&private[..8], b"HKRP0001");
            for byte in frame(1, b"ready\n")
                .into_iter()
                .chain(frame(2, b"diagnostic"))
            {
                server.write_all(&[byte]).unwrap();
            }
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        start(&mut client, &"a".repeat(64), deadline).unwrap();
        Credential::generate(Binding {
            owner: [1; 16],
            boot: [2; 16],
            endpoint: [3; 32],
            service: [4; 32],
        })
        .unwrap()
        .into_private_input()
        .unwrap()
        .forward(&mut client, deadline)
        .unwrap();
        client.set_nonblocking(true).unwrap();
        let mut transport = RelayExec {
            stream: client,
            pending: vec![],
            closed: false,
            received: 0,
        };
        let (mut out, mut err) = (vec![], vec![]);
        while !transport.poll(&mut out, &mut err).unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        worker.join().unwrap();
        assert_eq!(out, b"ready\n");
        assert_eq!(err, b"diagnostic");
    }
    #[test]
    fn refusal_timeout_and_malformed_upgrade_do_not_deliver_stdin() {
        for response in [b"HTTP/1.1 403 Refused\r\nContent-Length: 0\r\n\r\n".as_slice(), b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: wrong\r\n\r\n", b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 4\r\n\r\n"] {
            let (mut client,mut server)=UnixStream::pair().unwrap();
            let response=response.to_vec();
            let worker=std::thread::spawn(move || { request(&mut server); server.write_all(&response).unwrap(); let mut extra=Vec::new(); server.read_to_end(&mut extra).unwrap(); assert!(extra.is_empty()); });
            assert!(start(&mut client,&"a".repeat(64),Instant::now()+Duration::from_secs(1)).is_err());
            drop(client); worker.join().unwrap();
        }
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            request(&mut server);
            std::thread::sleep(Duration::from_millis(100));
        });
        assert!(
            start(
                &mut client,
                &"a".repeat(64),
                Instant::now() + Duration::from_millis(20)
            )
            .is_err()
        );
        worker.join().unwrap();
    }
    #[test]
    fn framing_bounds_reject_truncation_invalid_stream_and_overflow() {
        for bytes in [frame(3, b"bad"), frame(1, &vec![0; 4097])] {
            assert!(decode(&mut bytes.clone(), &mut vec![], &mut vec![]).is_err());
        }
        let (client, mut server) = UnixStream::pair().unwrap();
        server.write_all(&[1, 0, 0, 0, 0, 0, 0, 5, b'x']).unwrap();
        drop(server);
        client.set_nonblocking(true).unwrap();
        let mut transport = RelayExec {
            stream: client,
            pending: vec![],
            closed: false,
            received: 0,
        };
        assert!(transport.poll(&mut vec![], &mut vec![]).is_err());
        let mut out = vec![0; 4096];
        assert!(decode(&mut frame(2, b"x"), &mut out, &mut vec![]).is_err());
    }
}
