//! Cleanup-only stop effects. Workers share transport, never the VM mutation lease.
use super::*;
use std::{collections::BTreeSet, time::Instant};

fn validate(stops: &[(String, u64)]) -> Result<(), CandidateError> {
    let mut ids = BTreeSet::new();
    if stops.len() > super::super::environment::MAX_MANAGED_SERVICES
        || stops.iter().any(|(id, grace)| {
            id.len() != 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || *grace > 30
                || !ids.insert(id)
        })
    {
        return Err(failure(
            "Container stop requires distinct immutable IDs and bounded grace.",
        ));
    }
    Ok(())
}

impl Engine<'_> {
    /// The caller has inspected ownership under this engine's retained mutation lease.
    /// This grants stop only, including on cleanup connections without allocation admission.
    /// All workers are joined before returning, even after a partial failure.
    pub(in crate::provider) fn stop_containers(
        &self,
        stops: &[(String, u64)],
    ) -> Result<(), CandidateError> {
        validate(stops)?;
        self.guest.verify()?;
        let result = batch(
            &self.transport.client,
            stops,
            Instant::now() + Duration::from_secs(40),
        );
        self.guest.verify()?;
        result
    }
}

fn batch(
    client: &Client,
    stops: &[(String, u64)],
    deadline: Instant,
) -> Result<(), CandidateError> {
    validate(stops)?;
    std::thread::scope(|scope| {
        let mut workers = Vec::with_capacity(stops.len());
        let mut first_error = None;
        for (id, grace) in stops {
            let client = client.clone();
            let path = format!("http://hack-local/v1.53/containers/{id}/stop?t={grace}");
            match std::thread::Builder::new().name("hack-container-stop".into()).spawn_scoped(scope, move || {
                let remaining = deadline.checked_duration_since(Instant::now())
                    .filter(|d| !d.is_zero())
                    .ok_or_else(|| failure("Container stop batch deadline expired; effects may be uncertain."))?;
                let response = client.post(path).timeout(remaining).send()
                    .map_err(|_| failure("Container stop failed or timed out; no stop was replayed and no forced deletion was authorized."))?;
                // A natural exit can race the preceding running observation. Only
                // subsequent ownership-checked inspection establishes terminal state.
                if response.status().as_u16() == 304 {
                    return Ok(());
                }
                response_bytes(response).map(|_| ())
            }) {
                Ok(worker) => workers.push(worker),
                Err(_) => {
                    first_error = Some(failure("Cannot start every container stop worker; partial effects require inspection."));
                    break;
                }
            }
        }
        for worker in workers {
            let result = worker.join().unwrap_or_else(|_| {
                Err(failure(
                    "Container stop worker failed; effects require inspection.",
                ))
            });
            if let Err(error) = result {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::net::UnixListener};

    #[test]
    fn stops_reject_unbounded_aliased_or_mutable_targets_before_transport() {
        assert!(validate(&[("name".into(), 10)]).is_err());
        assert!(validate(&[("a".repeat(64), 31)]).is_err());
        assert!(validate(&[("a".repeat(64), 1), ("a".repeat(64), 2)]).is_err());
        assert!(
            validate(
                &(0..33)
                    .map(|n| (format!("{n:064x}"), 0))
                    .collect::<Vec<_>>()
            )
            .is_err()
        );
        assert!(validate(&[("a".repeat(64), 0), ("b".repeat(64), 30)]).is_ok());
    }

    #[test]
    fn all_32_stops_arrive_before_replies_and_failure_joins_every_worker_without_retry() {
        for fail in [false, true] {
            let path = std::env::temp_dir().join(format!(
                "hs-{}-{}-{fail}.sock",
                std::process::id(),
                crate::node::now()
            ));
            let listener = UnixListener::bind(&path).unwrap();
            listener.set_nonblocking(true).unwrap();
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut sockets = Vec::new();
                let mut targets = BTreeSet::new();
                while sockets.len() < 32 {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            socket.set_nonblocking(false).unwrap();
                            socket
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = Vec::new();
                            while !request.ends_with(b"\r\n\r\n") {
                                let mut byte = [0];
                                socket.read_exact(&mut byte).unwrap();
                                request.push(byte[0]);
                                assert!(request.len() <= 8192);
                            }
                            let line = std::str::from_utf8(&request)
                                .unwrap()
                                .lines()
                                .next()
                                .unwrap()
                                .to_owned();
                            assert!(
                                line.starts_with("POST /v1.53/containers/")
                                    && line.ends_with("/stop?t=1 HTTP/1.1")
                            );
                            assert!(targets.insert(line));
                            sockets.push(socket);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "Stop dispatch became sequential");
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
                for (index, socket) in sockets.iter_mut().enumerate() {
                    let status = if fail && index == 0 {
                        "500 Failed"
                    } else if index == 1 {
                        "304 Not Modified"
                    } else {
                        "204 No Content"
                    };
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
                }
                32
            });
            let transport = Transport::new(&path, Duration::from_secs(10)).unwrap();
            let stops = (0..32)
                .map(|n| (format!("{n:064x}"), 1))
                .collect::<Vec<_>>();
            let result = batch(
                &transport.client,
                &stops,
                Instant::now() + Duration::from_secs(10),
            );
            assert_eq!(result.is_err(), fail);
            assert_eq!(server.join().unwrap(), 32);
            std::fs::remove_file(path).unwrap();
        }
    }
}
