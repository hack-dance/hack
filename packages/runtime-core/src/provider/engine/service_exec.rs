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
        self.service_exec_until(container, argv, workdir, Instant::now() + timeout, &|| {
            Ok(())
        })
    }
    /// Caller-owned identity checks share the original observation deadline.
    pub(in crate::provider) fn service_exec_until(
        &self,
        container: &str,
        argv: &[String],
        workdir: Option<&str>,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<ExecOutput, CandidateError> {
        if self.cleanup_only {
            return Err(failure("A cleanup connection cannot execute commands."));
        }
        execute_guarded(container, argv, workdir, fresh, |method, path, body| {
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

/// Known completion of one reaped one-off container.
#[cfg(any(feature = "native-config-plan", test))]
pub(in crate::provider) struct OneOffOutput {
    pub container: String,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

#[cfg(any(feature = "native-config-plan", test))]
fn one_off_uncertain() -> CandidateError {
    CandidateError::new(
        "graph_service_one_off_uncertain",
        "One-off service command completion or removal is uncertain; its container may remain. No request was replayed. Inspect the project before retrying.",
    )
}

#[cfg(feature = "native-config-plan")]
impl Engine<'_> {
    /// One create, start, wait, completion inspection, bounded log read and forced
    /// removal of a named one-off container. Caller-owned identity checks share the
    /// original observation deadline; nothing is replayed after an uncertain step.
    pub(in crate::provider) fn service_one_off_until(
        &self,
        name: &str,
        config: &Value,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<OneOffOutput, CandidateError> {
        if self.cleanup_only {
            return Err(failure("A cleanup connection cannot execute commands."));
        }
        one_off_guarded(name, config, fresh, |method, path, body| {
            self.guest.verify()?;
            if method == Method::POST {
                self.guest.before_effect()?;
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())
                .ok_or_else(one_off_uncertain)?;
            let transport = Transport::new(&self.guest.engine_socket()?, remaining)?;
            let bytes = transport
                .request_bytes(method, path, body)
                .map_err(|error| {
                    if error.code == "engine_not_found" {
                        error
                    } else {
                        one_off_uncertain()
                    }
                })?;
            self.guest.verify().map_err(|_| one_off_uncertain())?;
            Ok(bytes)
        })
    }
}

#[cfg(any(feature = "native-config-plan", test))]
fn one_off_guarded(
    name: &str,
    config: &Value,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
) -> Result<OneOffOutput, CandidateError> {
    one_off(name, config, |method, path, body| {
        fresh()?;
        let result = request(method, path, body)?;
        fresh().map_err(|_| one_off_uncertain())?;
        Ok(result)
    })
}

#[cfg(any(feature = "native-config-plan", test))]
fn one_off(
    name: &str,
    config: &Value,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
) -> Result<OneOffOutput, CandidateError> {
    if name.is_empty()
        || name.len() > 128
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || config["HostConfig"]["AutoRemove"] != false
    {
        return Err(failure("Invalid one-off container selection."));
    }
    let created = request(
        Method::POST,
        &format!("/v1.53/containers/create?name={name}"),
        Some(config),
    )?;
    let created: Value = serde_json::from_slice(&created).map_err(|_| one_off_uncertain())?;
    let id = created["Id"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(one_off_uncertain)?
        .to_owned();
    request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
    let waited = request(Method::POST, &format!("/v1.53/containers/{id}/wait"), None)?;
    let waited: Value = serde_json::from_slice(&waited).map_err(|_| one_off_uncertain())?;
    let status = waited["StatusCode"]
        .as_i64()
        .filter(|n| (0..=255).contains(n))
        .ok_or_else(one_off_uncertain)?;
    let inspected = request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    let inspected: Value = serde_json::from_slice(&inspected).map_err(|_| one_off_uncertain())?;
    if inspected["Id"] != id.as_str()
        || inspected["Name"]
            .as_str()
            .is_none_or(|observed| observed.trim_start_matches('/') != name)
        || inspected["State"]["Running"] != false
        || inspected["State"]["ExitCode"] != status
    {
        return Err(one_off_uncertain());
    }
    let stream = request(
        Method::GET,
        &format!("/v1.53/containers/{id}/logs?stdout=true&stderr=true&tail=all"),
        None,
    )?;
    let (stdout, stderr, truncated) = decode(&stream).map_err(|_| one_off_uncertain())?;
    request(
        Method::DELETE,
        &format!("/v1.53/containers/{id}?force=true&v=true"),
        None,
    )?;
    match request(Method::GET, &format!("/v1.53/containers/{id}/json"), None) {
        Err(error) if error.code == "engine_not_found" => {}
        _ => return Err(one_off_uncertain()),
    }
    Ok(OneOffOutput {
        container: id,
        exit_code: status as i32,
        stdout,
        stderr,
        truncated,
    })
}

/// The caller's original selection spans each transport, including create/start.
fn execute_guarded(
    container: &str,
    argv: &[String],
    workdir: Option<&str>,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Vec<u8>, CandidateError>,
) -> Result<ExecOutput, CandidateError> {
    execute(container, argv, workdir, |method, path, body| {
        fresh()?;
        let result = request(method, path, body)?;
        fresh().map_err(|_| uncertain())?;
        Ok(result)
    })
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

pub(super) fn decode(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>, bool), CandidateError> {
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
    fn caller_selection_loss_after_create_never_starts_or_replays() {
        use std::cell::Cell;
        for lose_at in [1, 2, 3] {
            let checks = Cell::new(0);
            let mut calls = 0;
            let result = execute_guarded(
                &"a".repeat(64),
                &["tool".into()],
                None,
                &|| {
                    checks.set(checks.get() + 1);
                    if checks.get() == lose_at {
                        Err(uncertain())
                    } else {
                        Ok(())
                    }
                },
                |_, path, _| {
                    calls += 1;
                    assert!(path.ends_with("/exec"));
                    Ok(serde_json::to_vec(&json!({"Id":"b".repeat(64)})).unwrap())
                },
            );
            assert!(result.is_err());
            assert_eq!(calls, if lose_at == 1 { 0 } else { 1 });
        }
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
    fn one_off_config() -> Value {
        json!({"Image":format!("sha256:{}", "d".repeat(64)),"Cmd":["tool"],"HostConfig":{"NetworkMode":format!("container:{}", "a".repeat(64)),"AutoRemove":false}})
    }
    #[test]
    fn one_off_creates_starts_waits_inspects_reads_and_removes_once_with_nonzero_exit() {
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        let id = "e".repeat(64);
        let config = one_off_config();
        let mut calls = 0;
        let result = one_off(&name, &config, |method, path, body| {
            calls += 1;
            match calls {
                1 => {
                    assert_eq!(method, Method::POST);
                    assert_eq!(path, format!("/v1.53/containers/create?name={name}"));
                    assert_eq!(body.unwrap(), &config);
                    Ok(serde_json::to_vec(&json!({"Id":id})).unwrap())
                }
                2 => {
                    assert_eq!(method, Method::POST);
                    assert_eq!(path, format!("/v1.53/containers/{id}/start"));
                    assert!(body.is_none());
                    Ok(vec![])
                }
                3 => {
                    assert_eq!(method, Method::POST);
                    assert_eq!(path, format!("/v1.53/containers/{id}/wait"));
                    Ok(serde_json::to_vec(&json!({"StatusCode":3,"Error":null})).unwrap())
                }
                4 => {
                    assert_eq!(method, Method::GET);
                    assert_eq!(path, format!("/v1.53/containers/{id}/json"));
                    Ok(serde_json::to_vec(&json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":3}})).unwrap())
                }
                5 => {
                    assert_eq!(method, Method::GET);
                    assert_eq!(
                        path,
                        format!("/v1.53/containers/{id}/logs?stdout=true&stderr=true&tail=all")
                    );
                    Ok([frame(1, b"ok\n\xff"), frame(2, b"\0warn")].concat())
                }
                6 => {
                    assert_eq!(method, Method::DELETE);
                    assert_eq!(path, format!("/v1.53/containers/{id}?force=true&v=true"));
                    Ok(vec![])
                }
                7 => {
                    assert_eq!(method, Method::GET);
                    Err(CandidateError::new("engine_not_found", "absent"))
                }
                _ => panic!("request replayed"),
            }
        })
        .unwrap();
        assert_eq!(calls, 7);
        assert_eq!(result.container, id);
        assert_eq!(result.exit_code, 3);
        assert_eq!(result.stdout, b"ok\n\xff");
        assert_eq!(result.stderr, b"\0warn");
        assert!(!result.truncated);
    }
    #[test]
    fn one_off_caller_selection_loss_never_starts_or_replays() {
        use std::cell::Cell;
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        for lose_at in [1, 2, 3] {
            let checks = Cell::new(0);
            let mut calls = 0;
            let result = one_off_guarded(
                &name,
                &one_off_config(),
                &|| {
                    checks.set(checks.get() + 1);
                    if checks.get() == lose_at {
                        Err(uncertain())
                    } else {
                        Ok(())
                    }
                },
                |_, path, _| {
                    calls += 1;
                    assert!(path.contains("/create?name="));
                    Ok(serde_json::to_vec(&json!({"Id":"e".repeat(64)})).unwrap())
                },
            );
            assert!(result.is_err());
            assert_eq!(calls, if lose_at == 1 { 0 } else { 1 });
        }
    }
    #[test]
    fn one_off_refuses_changed_identity_unfinished_process_unproven_removal_and_auto_remove() {
        let name = format!("hkn-{}-oneoff-{}", "b".repeat(32), "c".repeat(32));
        let id = "e".repeat(64);
        let inspected =
            json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":0}});
        for (stage, changed) in [
            (
                4,
                json!({"Id":"f".repeat(64),"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":0}}),
            ),
            (
                4,
                json!({"Id":id,"Name":"/foreign","State":{"Running":false,"ExitCode":0}}),
            ),
            (
                4,
                json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":true,"ExitCode":0}}),
            ),
            (
                4,
                json!({"Id":id,"Name":format!("/{name}"),"State":{"Running":false,"ExitCode":1}}),
            ),
            (7, inspected.clone()),
        ] {
            let mut calls = 0;
            let error = one_off(&name, &one_off_config(), |_, _, _| {
                calls += 1;
                Ok(match calls {
                    1 => serde_json::to_vec(&json!({"Id":id})).unwrap(),
                    2 | 6 => vec![],
                    3 => serde_json::to_vec(&json!({"StatusCode":0})).unwrap(),
                    4 if stage == 4 => serde_json::to_vec(&changed).unwrap(),
                    4 => serde_json::to_vec(&inspected).unwrap(),
                    5 => vec![],
                    _ => serde_json::to_vec(&changed).unwrap(),
                })
            })
            .err()
            .unwrap();
            assert_eq!(calls, stage);
            assert_eq!(error.code, "graph_service_one_off_uncertain");
        }
        let mut config = one_off_config();
        config["HostConfig"]["AutoRemove"] = json!(true);
        let mut calls = 0;
        assert!(
            one_off(&name, &config, |_, _, _| {
                calls += 1;
                Ok(vec![])
            })
            .is_err()
        );
        assert_eq!(calls, 0);
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
                // macOS may inherit the listener's nonblocking flag on accept.
                socket.set_nonblocking(false).unwrap();
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
