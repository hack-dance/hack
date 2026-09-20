//! Noninteractive exec uses one create and one attached start, never replayed.
use super::*;
use serde_json::json;
use std::time::Instant;

pub(in crate::provider) struct ExecOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

fn uncertain() -> CandidateError {
    CandidateError::new(
        "graph_service_exec_uncertain",
        "Service exec completion is uncertain; the command may still be running. No request was replayed. Inspect the service before retrying.",
    )
}

impl Engine<'_> {
    pub(in crate::provider) fn service_exec(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        timeout: Duration,
    ) -> Result<ExecOutput, CandidateError> {
        if self.cleanup_only {
            return Err(failure("A cleanup connection cannot execute commands."));
        }
        let deadline = Instant::now() + timeout;
        execute(container, argv, workdir, |method, path, body| {
            self.guest.verify()?;
            if method == Method::POST {
                self.guest.before_effect()?;
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())
                .ok_or_else(uncertain)?;
            let transport = Transport::new(&self.guest.engine_socket()?, remaining)?;
            let bytes = transport
                .request_bytes(method, path, body)
                .map_err(|_| uncertain())?;
            self.guest.verify().map_err(|_| uncertain())?;
            Ok(bytes)
        })
    }
}

fn execute(
    container: &str,
    argv: &[String],
    workdir: Option<&str>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
) -> Result<ExecOutput, CandidateError> {
    if container.len() != 64 || !container.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(failure("Invalid exec container identity."));
    }
    let mut body = json!({"AttachStdin":false,"AttachStdout":true,"AttachStderr":true,"Tty":false,"Privileged":false,"Cmd":argv});
    if let Some(workdir) = workdir {
        body["WorkingDir"] = json!(workdir);
    }
    let created = request(
        Method::POST,
        &format!("/v1.53/containers/{container}/exec"),
        Some(&body),
    )?;
    let created: Value = serde_json::from_slice(&created).map_err(|_| uncertain())?;
    let id = created["Id"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(uncertain)?;
    let stream = request(
        Method::POST,
        &format!("/v1.53/exec/{id}/start"),
        Some(&json!({"Detach":false,"Tty":false})),
    )?;
    let (stdout, stderr, truncated) = decode(&stream)?;
    let inspected = request(Method::GET, &format!("/v1.53/exec/{id}/json"), None)?;
    let inspected: Value = serde_json::from_slice(&inspected).map_err(|_| uncertain())?;
    if inspected["ID"] != id
        || inspected["ContainerID"] != container
        || inspected["Running"] != false
    {
        return Err(uncertain());
    }
    let exit_code = inspected["ExitCode"]
        .as_i64()
        .filter(|n| (0..=255).contains(n))
        .ok_or_else(uncertain)? as i32;
    Ok(ExecOutput {
        exit_code,
        stdout,
        stderr,
        truncated,
    })
}

fn decode(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>, bool), CandidateError> {
    const LIMIT: usize = 1024 * 1024;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut remaining = bytes;
    while !remaining.is_empty() {
        if remaining.len() < 8 || ![1, 2].contains(&remaining[0]) || remaining[1..4] != [0, 0, 0] {
            return Err(uncertain());
        }
        let stream = remaining[0];
        let size =
            u32::from_be_bytes(remaining[4..8].try_into().map_err(|_| uncertain())?) as usize;
        remaining = &remaining[8..];
        if size > remaining.len() {
            return Err(uncertain());
        }
        let target = if stream == 1 {
            &mut stdout
        } else {
            &mut stderr
        };
        let keep = size.min(LIMIT - target.len());
        target.extend_from_slice(&remaining[..keep]);
        truncated |= keep < size;
        remaining = &remaining[size..];
    }
    Ok((stdout, stderr, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(stream: u8, bytes: &[u8]) -> Vec<u8> {
        let mut result = vec![stream, 0, 0, 0];
        result.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        result.extend_from_slice(bytes);
        result
    }
    #[test]
    fn preserves_binary_streams_and_bounds_retained_output() {
        let stream = [
            frame(1, b"\0\xffout"),
            frame(2, b"\x1berr"),
            frame(1, b"more"),
        ]
        .concat();
        let (out, err, truncated) = decode(&stream).unwrap();
        assert_eq!(out, b"\0\xffoutmore");
        assert_eq!(err, b"\x1berr");
        assert!(!truncated);
        let (out, err, truncated) = decode(&frame(1, &vec![b'x'; 1024 * 1024 + 1])).unwrap();
        assert_eq!(out.len(), 1024 * 1024);
        assert!(err.is_empty());
        assert!(truncated);
        for bad in [
            vec![1],
            vec![3, 0, 0, 0, 0, 0, 0, 0],
            vec![1, 0, 0, 0, 0, 0, 0, 1],
        ] {
            assert!(decode(&bad).is_err());
        }
    }
    #[test]
    fn creates_and_starts_once_with_eof_and_returns_nonzero_exit() {
        let container = "a".repeat(64);
        let id = "b".repeat(64);
        let argv = vec!["tool".into(), "$literal; value".into()];
        let mut calls = 0;
        let result = execute(&container, &argv, Some("/app"), |method, path, body| {
            calls += 1;
            match calls {
                1 => {
                    assert_eq!(method, Method::POST);
                    assert_eq!(path, format!("/v1.53/containers/{container}/exec"));
                    let body = body.unwrap();
                    assert_eq!(body["Cmd"], json!(argv));
                    assert_eq!(body["AttachStdin"], false);
                    assert_eq!(body["Tty"], false);
                    assert_eq!(body["Privileged"], false);
                    assert!(body.get("Env").is_none());
                    assert!(body.get("User").is_none());
                    assert_eq!(body["WorkingDir"], "/app");
                    Ok(serde_json::to_vec(&json!({"Id":id})).unwrap())
                }
                2 => {
                    assert_eq!(path, format!("/v1.53/exec/{id}/start"));
                    assert_eq!(body.unwrap(), &json!({"Detach":false,"Tty":false}));
                    Ok(frame(2, b"failed"))
                }
                3 => {
                    assert_eq!(method, Method::GET);
                    Ok(serde_json::to_vec(
                        &json!({"ID":id,"ContainerID":container,"Running":false,"ExitCode":23}),
                    )
                    .unwrap())
                }
                _ => panic!("request replayed"),
            }
        })
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(result.exit_code, 23);
        assert_eq!(result.stderr, b"failed");
    }
    #[test]
    fn interrupted_start_never_replays_or_claims_completion() {
        let mut calls = 0;
        let error = execute(&"a".repeat(64), &["tool".into()], None, |_, _, _| {
            calls += 1;
            if calls == 1 {
                Ok(serde_json::to_vec(&json!({"Id":"b".repeat(64)})).unwrap())
            } else {
                Err(uncertain())
            }
        })
        .err()
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(error.code, "graph_service_exec_uncertain");
    }
    #[test]
    fn refuses_changed_exec_identity_or_unfinished_process() {
        for changed in [
            json!({"ID":"c".repeat(64),"ContainerID":"a".repeat(64),"Running":false,"ExitCode":0}),
            json!({"ID":"b".repeat(64),"ContainerID":"c".repeat(64),"Running":false,"ExitCode":0}),
            json!({"ID":"b".repeat(64),"ContainerID":"a".repeat(64),"Running":true,"ExitCode":0}),
        ] {
            let mut calls = 0;
            assert!(
                execute(&"a".repeat(64), &["true".into()], None, |_, _, _| {
                    calls += 1;
                    Ok(match calls {
                        1 => serde_json::to_vec(&json!({"Id":"b".repeat(64)})).unwrap(),
                        2 => vec![],
                        _ => serde_json::to_vec(&changed).unwrap(),
                    })
                })
                .is_err()
            );
            assert_eq!(calls, 3);
        }
    }
    #[test]
    fn real_unix_transport_delivers_multiplexed_binary_command_output() {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixListener;
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "hce-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let container = "a".repeat(64);
        let id = "b".repeat(64);
        let responses = [
            serde_json::to_vec(&json!({"Id":id})).unwrap(),
            [frame(1, b"out\xff"), frame(2, b"err\0")].concat(),
            serde_json::to_vec(
                &json!({"ID":id,"ContainerID":container,"Running":false,"ExitCode":7}),
            )
            .unwrap(),
        ];
        let worker = std::thread::spawn(move || {
            for (index, response) in responses.into_iter().enumerate() {
                let deadline = Instant::now() + Duration::from_secs(3);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let headers = String::from_utf8(request).unwrap();
                assert!(headers.starts_with(if index == 2 { "GET " } else { "POST " }));
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(|v| v.parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                socket.write_all(&response).unwrap();
            }
        });
        let transport = Transport::new(&path, Duration::from_secs(2)).unwrap();
        let result = execute(&container, &["tool".into()], None, |method, path, body| {
            transport.request_bytes(method, path, body)
        });
        worker.join().unwrap();
        std::fs::remove_file(path).unwrap();
        let result = result.unwrap();
        assert_eq!(result.exit_code, 7);
        assert_eq!(result.stdout, b"out\xff");
        assert_eq!(result.stderr, b"err\0");
    }
}
