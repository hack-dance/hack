//! Fresh per-command values travel only over an upgraded exec's stdin.
use crate::CandidateError;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
fn uncertain() -> CandidateError {
    CandidateError::new(
        "graph_service_exec_uncertain",
        "Private exec completion is uncertain; command effects may have occurred. No request was replayed.",
    )
}
fn remaining(deadline: Instant) -> Result<Duration, CandidateError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or_else(uncertain)
}
fn read_exact_until(
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), CandidateError> {
    while !bytes.is_empty() {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| uncertain())?;
        let count = stream.read(bytes).map_err(|_| uncertain())?;
        if count == 0 {
            return Err(uncertain());
        }
        bytes = &mut bytes[count..];
    }
    remaining(deadline)?;
    Ok(())
}
fn frame(
    stream: &mut UnixStream,
    deadline: Instant,
    limit: usize,
) -> Result<(u8, Vec<u8>), CandidateError> {
    stream
        .set_read_timeout(Some(remaining(deadline)?))
        .map_err(|_| uncertain())?;
    let mut header = [0u8; 8];
    read_exact_until(stream, &mut header, deadline)?;
    let n = u32::from_be_bytes(header[4..8].try_into().map_err(|_| uncertain())?) as usize;
    if ![1, 2].contains(&header[0]) || header[1..4] != [0, 0, 0] || n > limit {
        return Err(uncertain());
    }
    let mut bytes = vec![0; n];
    stream
        .set_read_timeout(Some(remaining(deadline)?))
        .map_err(|_| uncertain())?;
    read_exact_until(stream, &mut bytes, deadline)?;
    Ok((header[0], bytes))
}
fn deliver(
    stream: &mut UnixStream,
    deadline: Instant,
    values: &BTreeMap<String, String>,
) -> Result<(), CandidateError> {
    let mut hello = Vec::new();
    while !hello.ends_with(b"\n") {
        let (kind, bytes) = frame(stream, deadline, 64 - hello.len())?;
        if kind != 1 || bytes.is_empty() {
            return Err(uncertain());
        }
        hello.extend(bytes);
        if hello.len() >= 64 {
            return Err(uncertain());
        }
    }
    let now = std::str::from_utf8(&hello)
        .ok()
        .and_then(|v| v.strip_prefix("HKEE1 "))
        .and_then(|v| v.strip_suffix('\n'))
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(uncertain)?;
    let expires = now
        .checked_add(remaining(deadline)?.as_secs())
        .ok_or_else(uncertain)?;
    if expires <= now {
        return Err(uncertain());
    }
    #[derive(serde::Serialize)]
    struct Envelope<'a> {
        version: u8,
        expires: u64,
        values: &'a BTreeMap<String, String>,
    }
    let mut bytes = Zeroizing::new(vec![0u8; 65536]);
    let used = {
        let mut cursor = std::io::Cursor::new(bytes.as_mut_slice());
        serde_json::to_writer(
            &mut cursor,
            &Envelope {
                version: 1,
                expires,
                values,
            },
        )
        .map_err(|_| uncertain())?;
        cursor.position() as usize
    };
    bytes.truncate(used);
    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(|_| uncertain())?;
    let mut pending = bytes.as_slice();
    while !pending.is_empty() {
        stream
            .set_write_timeout(Some(remaining(deadline)?))
            .map_err(|_| uncertain())?;
        let count = stream.write(pending).map_err(|_| uncertain())?;
        if count == 0 {
            return Err(uncertain());
        }
        pending = &pending[count..];
    }
    remaining(deadline)?;
    stream.shutdown(Shutdown::Write).map_err(|_| uncertain())?;
    Ok(())
}
#[cfg(all(target_os = "macos", feature = "environment-launcher"))]
impl super::Engine<'_> {
    pub(in crate::provider) fn service_exec_private(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        deadline: Instant,
        values: &BTreeMap<String, String>,
    ) -> Result<super::service_exec::ExecOutput, CandidateError> {
        use reqwest::Method;
        use serde_json::json;
        if self.cleanup_only {
            return Err(uncertain());
        }
        self.guest.verify()?;
        self.guest.before_effect()?;
        let socket = self.guest.engine_socket()?;
        let mut body = json!({"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"Tty":false,"Privileged":false,"Cmd":argv});
        if let Some(dir) = workdir {
            body["WorkingDir"] = json!(dir);
        }
        let created = super::Transport::new(&socket, remaining(deadline)?)?.request(
            Method::POST,
            &format!("/v1.53/containers/{container}/exec"),
            Some(&body),
        )?;
        let id = created["Id"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(uncertain)?;
        self.guest.verify()?;
        self.guest.before_effect()?;
        let mut stream =
            crate::provider::agent::connect_until(&socket, deadline).map_err(|_| uncertain())?;
        super::relay_exec::start(&mut stream, id, deadline).map_err(|_| uncertain())?;
        deliver(&mut stream, deadline, values)?;
        // Bound total transport work as well as retained output. Overflow is uncertain.
        let mut raw = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            stream
                .set_read_timeout(Some(remaining(deadline)?))
                .map_err(|_| uncertain())?;
            let n = stream.read(&mut buffer).map_err(|_| uncertain())?;
            if n == 0 {
                break;
            }
            if raw.len() + n > 4 * 1024 * 1024 {
                return Err(uncertain());
            }
            raw.extend_from_slice(&buffer[..n]);
        }
        let (stdout, stderr, truncated) =
            super::service_exec::decode(&raw).map_err(|_| uncertain())?;
        self.guest.verify().map_err(|_| uncertain())?;
        let inspected = super::Transport::new(&socket, remaining(deadline)?)?
            .request(Method::GET, &format!("/v1.53/exec/{id}/json"), None)
            .map_err(|_| uncertain())?;
        if inspected["ID"] != id
            || inspected["ContainerID"] != container
            || inspected["Running"] != false
        {
            return Err(uncertain());
        }
        let exit_code = inspected["ExitCode"]
            .as_i64()
            .filter(|v| (0..=255).contains(v))
            .ok_or_else(uncertain)? as i32;
        Ok(super::service_exec::ExecOutput {
            exit_code,
            stdout,
            stderr,
            truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn send(stream: &mut UnixStream, body: &[u8]) {
        let mut header = [0u8; 8];
        header[0] = 1;
        header[4..].copy_from_slice(&(body.len() as u32).to_be_bytes());
        stream.write_all(&header).unwrap();
        stream.write_all(body).unwrap();
    }
    #[test]
    fn partial_frame_cannot_extend_deadline() {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        let worker = std::thread::spawn(move || {
            for byte in [1, 0, 0, 0, 0, 0, 0, 8] {
                if guest.write_all(&[byte]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let started = Instant::now();
        assert!(frame(&mut host, started + Duration::from_millis(50), 64).is_err());
        assert!(started.elapsed() < Duration::from_millis(140));
        drop(host);
        worker.join().unwrap();
    }
    #[test]
    fn fresh_values_follow_valid_split_hello_and_end_at_eof() {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || {
            guest
                .set_read_timeout(Some(Duration::from_millis(30)))
                .unwrap();
            assert!(guest.read(&mut [0u8; 1]).is_err());
            send(&mut guest, b"HKEE1 ");
            send(&mut guest, b"100\n");
            guest
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            guest.read_to_end(&mut bytes).unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        });
        deliver(
            &mut host,
            Instant::now() + Duration::from_secs(3),
            &BTreeMap::from([("TOKEN".into(), "synthetic-private-value".into())]),
        )
        .unwrap();
        let result = thread.join().unwrap();
        assert_eq!(result["values"]["TOKEN"], "synthetic-private-value");
        assert_eq!(result["version"], 1);
        assert!(result["expires"].as_u64().unwrap() <= 103);
    }
    #[test]
    fn malformed_hello_or_expired_deadline_never_delivers_values() {
        for hello in [
            b"unknown\n".as_slice(),
            b"HKEE1 18446744073709551615\n",
            b"HKEE1 -1\n",
        ] {
            let (mut host, mut guest) = UnixStream::pair().unwrap();
            send(&mut guest, hello);
            assert!(
                deliver(
                    &mut host,
                    Instant::now() + Duration::from_secs(2),
                    &BTreeMap::new()
                )
                .is_err()
            );
            drop(host);
            let mut bytes = Vec::new();
            guest.read_to_end(&mut bytes).unwrap();
            assert!(bytes.is_empty());
        }
        let (mut host, _guest) = UnixStream::pair().unwrap();
        assert!(deliver(&mut host, Instant::now(), &BTreeMap::new()).is_err());
    }
    #[test]
    fn split_hello_cannot_refresh_original_deadline() {
        let (mut host, mut guest) = UnixStream::pair().unwrap();
        send(&mut guest, b"HKEE1 ");
        let started = Instant::now();
        assert!(
            deliver(
                &mut host,
                started + Duration::from_millis(50),
                &BTreeMap::new()
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
