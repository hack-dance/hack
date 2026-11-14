//! One non-replayed TTY start. The caller retains mutation authority only until
//! upgrade; streaming and exact exec inspection use a lease-free connection.
#[cfg(target_os = "macos")]
use super::*;
use crate::CandidateError;
#[cfg(target_os = "macos")]
use crate::provider::interactive_session::{self, Binding, Receipt};
use base64::Engine as _;
use std::{
    collections::BTreeMap,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

fn uncertain() -> CandidateError {
    CandidateError::new(
        "session_cleanup_uncertain",
        "Interactive session completion or cleanup is unconfirmed; its durable receipt was retained. No request was replayed.",
    )
}
fn remaining(deadline: Instant) -> Result<Duration, CandidateError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or_else(uncertain)
}

#[cfg(target_os = "macos")]
pub(in crate::provider) struct Attached {
    pub receipt: Receipt,
    pub stream: UnixStream,
}

#[cfg(target_os = "macos")]
pub(in crate::provider) struct Command<'a> {
    pub session: &'a str,
    pub argv: &'a [String],
    pub workdir: Option<&'a str>,
    pub console_size: [u16; 2],
}

#[cfg(target_os = "macos")]
impl Engine<'_> {
    pub(in crate::provider) fn interactive_start(
        &self,
        candidate: &Candidate,
        binding: Binding,
        command: Command<'_>,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<Attached, CandidateError> {
        if self.cleanup_only || !binding.valid() || command.console_size.contains(&0) {
            return Err(uncertain());
        }
        fresh()?;
        self.guest.verify()?;
        self.guest.before_effect()?;
        let intent = interactive_session::admit(candidate, binding.clone(), command.session)?;
        let session = intent.receipt().session.clone();
        let mut intent = Some(intent);
        let mut dispatched = false;
        let effect = || -> Result<(), CandidateError> {
            fresh()?;
            self.guest.verify()?;
            self.guest.before_effect()?;
            remaining(deadline)?;
            Ok(())
        };
        let result: Result<Attached, CandidateError> = (|| {
            effect()?;
            let mut body = serde_json::json!({"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"Tty":true,"ConsoleSize":command.console_size,"Privileged":false,"DetachKeys":"ctrl-p,ctrl-q","Cmd":command.argv});
            if let Some(path) = command.workdir {
                body["WorkingDir"] = Value::String(path.into());
            }
            let transport = Transport::new(&self.guest.engine_socket()?, remaining(deadline)?)?;
            effect()?;
            dispatched = true;
            let created = transport.request(
                Method::POST,
                &format!("/v1.53/containers/{}/exec", binding.container),
                Some(&body),
            )?;
            let id = created["Id"]
                .as_str()
                .filter(|id| {
                    id.len() == 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(uncertain)?;
            let receipt = intent
                .take()
                .ok_or_else(uncertain)?
                .record_exec(candidate, id)?;
            effect()?;
            let mut stream =
                crate::provider::agent::connect_until(&self.guest.engine_socket()?, deadline)
                    .map_err(|_| uncertain())?;
            // Recheck after connect, immediately before the non-replayed start.
            effect()?;
            super::relay_exec::start_mode(&mut stream, id, deadline, Some(command.console_size))?;
            fresh()?;
            self.guest.verify()?;
            Ok(Attached { receipt, stream })
        })();
        match result {
            Err(error) if !dispatched => {
                if intent.ok_or_else(uncertain)?.withdraw(candidate).is_err() {
                    Err(uncertain().with_session(&session))
                } else {
                    Err(error)
                }
            }
            Err(_) => Err(uncertain().with_session(&session)),
            Ok(attached) => Ok(attached),
        }
    }
}

/// Values never enter Engine create configuration. Both markers are stripped
/// byte-by-byte, preserving any command output coalesced with the ACK.
pub(in crate::provider) fn deliver(
    stream: &mut UnixStream,
    values: &BTreeMap<String, String>,
    deadline: Instant,
    live: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(5));
    let marker = line(stream, deadline, live)?;
    let now = std::str::from_utf8(&marker)
        .ok()
        .and_then(|s| s.strip_prefix("HKEE2 "))
        .and_then(|s| s.strip_suffix('\n'))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(uncertain)?;
    let expires = now
        .checked_add(remaining(deadline)?.as_secs().max(1))
        .ok_or_else(uncertain)?;
    #[derive(serde::Serialize)]
    struct Envelope<'a> {
        version: u8,
        expires: u64,
        values: &'a BTreeMap<String, String>,
    }
    // Fixed storage avoids leaving private bytes in abandoned Vec allocations.
    let mut json = Zeroizing::new(vec![0u8; 65536]);
    let mut writer = std::io::Cursor::new(json.as_mut_slice());
    serde_json::to_writer(
        &mut writer,
        &Envelope {
            version: 1,
            expires,
            values,
        },
    )
    .map_err(|_| uncertain())?;
    let length = writer.position() as usize;
    json.truncate(length);
    let encoded = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*json));
    let header = format!("HKEE2 {}\n", encoded.len());
    for mut bytes in [header.as_bytes(), encoded.as_bytes()] {
        while !bytes.is_empty() {
            live()?;
            match super::exec_io::write(stream, bytes, deadline) {
                Ok(0) => return Err(uncertain()),
                Ok(n) => bytes = &bytes[n..],
                Err(e) if super::exec_io::retry(&e) => {}
                Err(_) => return Err(uncertain()),
            }
        }
    }
    let ack = line(stream, deadline, live)?;
    if ack != b"HKEE2 OK\n" && ack != b"HKEE2 OK\r\n" {
        return Err(uncertain());
    }
    live()?;
    remaining(deadline)?;
    Ok(())
}
fn line(
    stream: &mut UnixStream,
    deadline: Instant,
    live: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<Vec<u8>, CandidateError> {
    let mut bytes = Vec::with_capacity(64);
    loop {
        live()?;
        if bytes.len() == 64 {
            return Err(uncertain());
        }
        let mut byte = [0];
        match super::exec_io::read(stream, &mut byte, deadline) {
            Ok(0) => return Err(uncertain()),
            Ok(_) => {
                bytes.push(byte[0]);
                if byte[0] == b'\n' {
                    return Ok(bytes);
                }
            }
            Err(e) if super::exec_io::retry(&e) => {}
            Err(_) => return Err(uncertain()),
        }
    }
}

#[cfg(target_os = "macos")]
impl Observer<'_> {
    /// Narrow capability: resize only an already-created exec in this exact
    /// running container generation. No arbitrary lease-free Engine POST.
    pub(in crate::provider) fn interactive_resize(
        &self,
        receipt: &Receipt,
        rows: u16,
        cols: u16,
    ) -> Result<(), CandidateError> {
        let deadline = Instant::now() + Duration::from_millis(750);
        self.interactive_binding(receipt, deadline)?;
        let id = receipt.exec.as_deref().ok_or_else(uncertain)?;
        let transport = Transport::new(&self.guest.engine_socket()?, Duration::from_millis(750))?;
        transport.request_bytes_until(
            Method::POST,
            &format!("/v1.53/exec/{id}/resize?h={rows}&w={cols}"),
            None,
            Some(deadline),
        )?;
        self.guest.verify()?;
        Ok(())
    }
    fn interactive_binding(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<Value, CandidateError> {
        let b = &receipt.binding;
        if !receipt.valid() || self.incarnation() != b.owner || self.guest.boot_id()? != b.boot {
            return Err(uncertain());
        }
        let value = self.get_until(&format!("/v1.53/containers/{}/json", b.container), deadline)?;
        if value["Id"] != b.container
            || value["State"]["StartedAt"] != b.generation
            || value["State"]["Running"] != true
        {
            return Err(uncertain());
        }
        let id = receipt.exec.as_deref().ok_or_else(uncertain)?;
        let exec = self.get_until(&format!("/v1.53/exec/{id}/json"), deadline)?;
        if exec["ID"] != id || exec["ContainerID"] != b.container {
            return Err(uncertain());
        }
        Ok(exec)
    }
    pub(in crate::provider) fn interactive_finished(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<Option<i32>, CandidateError> {
        let value = self.interactive_binding(receipt, deadline)?;
        self.guest.verify()?;
        exit_status(&value)
    }
    pub(in crate::provider) fn interactive_exit(
        &self,
        receipt: &Receipt,
    ) -> Result<i32, CandidateError> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let exit = wait_exit(deadline, &mut || {
            self.interactive_binding(receipt, deadline)
        })?;
        self.guest.verify()?;
        Ok(exit)
    }
}

fn wait_exit(
    deadline: Instant,
    inspect: &mut dyn FnMut() -> Result<serde_json::Value, CandidateError>,
) -> Result<i32, CandidateError> {
    loop {
        remaining(deadline)?;
        let value = inspect()?;
        remaining(deadline)?;
        if let Some(code) = exit_status(&value)? {
            return Ok(code);
        }
        std::thread::sleep(remaining(deadline)?.min(Duration::from_millis(50)));
    }
}

fn exit_status(value: &serde_json::Value) -> Result<Option<i32>, CandidateError> {
    match value["Running"].as_bool() {
        Some(true) => Ok(None),
        Some(false) => value["ExitCode"]
            .as_i64()
            .filter(|code| (0..=255).contains(code))
            .map(|code| Some(code as i32))
            .ok_or_else(uncertain),
        None => Err(uncertain()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    #[test]
    fn eof_can_precede_exit_publication_but_polling_is_bounded_and_fail_closed() {
        let mut calls = 0;
        assert_eq!(
            wait_exit(Instant::now() + Duration::from_secs(1), &mut || {
                calls += 1;
                Ok(serde_json::json!({"Running":calls < 3,"ExitCode":17}))
            })
            .unwrap(),
            17
        );
        assert_eq!(calls, 3);
        assert_eq!(
            wait_exit(Instant::now() + Duration::from_millis(10), &mut || Ok(
                serde_json::json!({"Running":true})
            ))
            .unwrap_err()
            .code,
            "session_cleanup_uncertain"
        );
        let mut calls = 0;
        assert_eq!(
            wait_exit(Instant::now() + Duration::from_secs(1), &mut || {
                calls += 1;
                Err(CandidateError::new("selection_changed", "Fixed refusal."))
            })
            .unwrap_err()
            .code,
            "selection_changed"
        );
        assert_eq!(calls, 1);
    }
    #[test]
    fn exit_inspection_requires_a_known_status() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"Running":false}),
            serde_json::json!({"Running":false,"ExitCode":-1}),
            serde_json::json!({"Running":false,"ExitCode":256}),
            serde_json::json!({"Running":false,"ExitCode":"0"}),
        ] {
            assert!(exit_status(&value).is_err());
        }
        assert_eq!(
            exit_status(&serde_json::json!({"Running":true})).unwrap(),
            None
        );
        assert_eq!(
            exit_status(&serde_json::json!({"Running":false,"ExitCode":7})).unwrap(),
            Some(7)
        );
    }
    #[test]
    fn cancellation_during_large_envelope_write_is_bounded() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let capacity: libc::c_int = 4096;
        use std::os::fd::AsRawFd;
        // SAFETY: live socket, initialized integer and matching length.
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    client.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_SNDBUF,
                    (&capacity as *const libc::c_int).cast(),
                    std::mem::size_of_val(&capacity) as _,
                )
            },
            0
        );
        server.write_all(b"HKEE2 123\n").unwrap();
        let checks = std::cell::Cell::new(0);
        let start = Instant::now();
        let flags = unsafe { libc::fcntl(client.as_raw_fd(), libc::F_GETFL) };
        let error = deliver(
            &mut client,
            &BTreeMap::from([("TOKEN".into(), "x".repeat(60000))]),
            start + Duration::from_secs(3),
            &|| {
                checks.set(checks.get() + 1);
                if start.elapsed() > Duration::from_millis(150) {
                    Err(CandidateError::new("cancelled", "Cancelled."))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(checks.get() > 1);
        assert_eq!(
            unsafe { libc::fcntl(client.as_raw_fd(), libc::F_GETFL) },
            flags
        );
    }

    #[test]
    fn private_handshake_preserves_coalesced_command_output() {
        for ack in [b"HKEE2 OK\n".as_slice(), b"HKEE2 OK\r\n"] {
            let (mut client, mut server) = UnixStream::pair().unwrap();
            let ack = ack.to_vec();
            let worker = std::thread::spawn(move || {
                server.write_all(b"HKEE2 123\n").unwrap();
                let header = line(
                    &mut server,
                    Instant::now() + Duration::from_secs(2),
                    &|| Ok(()),
                )
                .unwrap();
                let length: usize = std::str::from_utf8(&header)
                    .unwrap()
                    .trim()
                    .strip_prefix("HKEE2 ")
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut encoded = vec![0; length];
                server.read_exact(&mut encoded).unwrap();
                assert!(!encoded.contains(&0x10) && !encoded.contains(&0x11));
                let json = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap();
                let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
                assert_eq!(value["values"]["TOKEN"], "synthetic\u{10}\u{11}");
                server
                    .write_all(&[ack, b"early-output".to_vec()].concat())
                    .unwrap();
            });
            deliver(
                &mut client,
                &BTreeMap::from([("TOKEN".into(), "synthetic\u{10}\u{11}".into())]),
                Instant::now() + Duration::from_secs(2),
                &|| Ok(()),
            )
            .unwrap();
            let mut output = [0; 12];
            client.read_exact(&mut output).unwrap();
            assert_eq!(&output, b"early-output");
            worker.join().unwrap();
        }
    }
    #[test]
    fn cancellation_while_waiting_for_marker_sends_no_private_bytes() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let checks = std::cell::Cell::new(0);
        let started = Instant::now();
        let error = deliver(
            &mut client,
            &BTreeMap::from([("TOKEN".into(), "synthetic-canary".into())]),
            started + Duration::from_secs(2),
            &|| {
                checks.set(checks.get() + 1);
                if checks.get() > 1 {
                    Err(CandidateError::new("cancelled", "Cancelled."))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert_eq!(checks.get(), 2);
        assert!(started.elapsed() < Duration::from_secs(1));
        server.set_nonblocking(true).unwrap();
        assert_eq!(
            server.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn old_or_malformed_launcher_receives_no_private_bytes() {
        for marker in [
            b"HKEE1 123\n".as_slice(),
            b"bad\n",
            b"HKEE2 private-canary\n",
        ] {
            let (mut client, mut server) = UnixStream::pair().unwrap();
            server.write_all(marker).unwrap();
            let error = deliver(
                &mut client,
                &BTreeMap::new(),
                Instant::now() + Duration::from_secs(1),
                &|| Ok(()),
            )
            .unwrap_err();
            assert!(!error.message.contains("canary"));
            client.shutdown(std::net::Shutdown::Both).unwrap();
            assert_eq!(server.read(&mut [0]).unwrap(), 0);
        }
    }
}
