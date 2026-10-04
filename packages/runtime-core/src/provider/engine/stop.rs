//! Cleanup-only stop effects. Workers share transport, never the VM mutation lease.
use super::*;
use crate::error::StopFailureStage;
use std::{collections::BTreeSet, time::Instant};

// Native recovery fixtures may route one immutable stop target to an owned
// test socket. This never exists in a production build or changes the guest
// transport, validation, worker joins, or retry policy.
#[cfg(all(
    test,
    target_os = "macos",
    target_arch = "aarch64",
    feature = "environment-launcher"
))]
mod test_socket {
    use super::*;
    use std::{
        cell::RefCell,
        path::Path,
        sync::{
            Arc, OnceLock,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct Selection {
        id: Arc<OnceLock<String>>,
        client: Client,
        attempts: Arc<AtomicUsize>,
    }
    thread_local! {
        static SELECTED: RefCell<Option<Selection>> = const { RefCell::new(None) };
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            SELECTED.with(|selected| *selected.borrow_mut() = None);
        }
    }
    pub(in crate::provider) fn with_socket<T>(
        id: Arc<OnceLock<String>>,
        socket: &Path,
        attempts: Arc<AtomicUsize>,
        action: impl FnOnce() -> T,
    ) -> Result<T, CandidateError> {
        let client = Transport::new(socket, Duration::from_secs(10))?.client;
        SELECTED.with(|selected| {
            assert!(selected.borrow().is_none(), "nested test stop transport");
            *selected.borrow_mut() = Some(Selection {
                id,
                client,
                attempts,
            });
        });
        let _reset = Reset;
        Ok(action())
    }
    pub(super) fn for_id(id: &str) -> Option<Client> {
        SELECTED.with(|selected| {
            let selected = selected.borrow();
            let selected = selected
                .as_ref()
                .filter(|value| value.id.get().is_some_and(|target| target == id))?;
            selected.attempts.fetch_add(1, Ordering::SeqCst);
            Some(selected.client.clone())
        })
    }
}

#[cfg(all(
    test,
    target_os = "macos",
    target_arch = "aarch64",
    feature = "environment-launcher"
))]
pub(in crate::provider) use test_socket::with_socket as with_test_stop_socket;

pub(in crate::provider) struct StopFailure {
    pub id: String,
    pub stage: StopFailureStage,
}

pub(in crate::provider) struct StopBatchFailure {
    pub error: CandidateError,
    pub failures: Vec<StopFailure>,
}

impl StopBatchFailure {
    fn plain(error: CandidateError) -> Self {
        Self {
            error,
            failures: Vec::new(),
        }
    }
}

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
        self.stop_containers_diagnosed(stops)
            .map_err(|failure| failure.error)
    }

    pub(in crate::provider) fn stop_containers_diagnosed(
        &self,
        stops: &[(String, u64)],
    ) -> Result<(), StopBatchFailure> {
        validate(stops).map_err(StopBatchFailure::plain)?;
        self.guest.verify().map_err(StopBatchFailure::plain)?;
        let result = batch(
            &self.transport.client,
            stops,
            Instant::now() + stop_budget(stops),
        );
        self.guest.verify().map_err(StopBatchFailure::plain)?;
        result
    }
}

/// The guest engine may serialize stop requests even when the host dispatches
/// them together. Account for their declared grace, capped below the foreground
/// cleanup request timeout. Exceeding the bound leaves effects uncertain.
fn stop_budget(stops: &[(String, u64)]) -> Duration {
    let seconds = stops.iter().fold(30_u64, |total, (_, grace)| {
        total.saturating_add((*grace).max(1))
    });
    Duration::from_secs(seconds.clamp(40, 540))
}

fn batch(
    client: &Client,
    stops: &[(String, u64)],
    deadline: Instant,
) -> Result<(), StopBatchFailure> {
    validate(stops).map_err(StopBatchFailure::plain)?;
    std::thread::scope(|scope| {
        let mut workers = Vec::with_capacity(stops.len());
        let mut first_error = None;
        let mut failures = Vec::new();
        for (id, grace) in stops {
            let client = client.clone();
            #[cfg(all(
                test,
                target_os = "macos",
                target_arch = "aarch64",
                feature = "environment-launcher"
            ))]
            let client = test_socket::for_id(id).unwrap_or(client);
            let path = format!("http://hack-local/v1.53/containers/{id}/stop?t={grace}");
            match std::thread::Builder::new().name("hack-container-stop".into()).spawn_scoped(scope, move || {
                let remaining = deadline.checked_duration_since(Instant::now())
                    .filter(|d| !d.is_zero())
                    .ok_or_else(|| (failure("Container stop batch deadline expired; effects may be uncertain."), StopFailureStage::Deadline))?;
                let response = client.post(path).timeout(remaining).send()
                    .map_err(|error| {
                        let stage = if error.is_connect() && error.is_timeout() {
                            StopFailureStage::ConnectTimeout
                        } else if error.is_connect() {
                            StopFailureStage::Connect
                        } else if error.is_timeout() {
                            StopFailureStage::Timeout
                        } else {
                            StopFailureStage::Transport
                        };
                        (failure("Container stop failed or timed out; no stop was replayed and no forced deletion was authorized."), stage)
                    })?;
                // A natural exit can race the preceding running observation. Only
                // subsequent ownership-checked inspection establishes terminal state.
                if response.status().as_u16() == 304 {
                    return Ok(());
                }
                response_bytes(response).map(|_| ()).map_err(|error| (error, StopFailureStage::Response))
            }) {
                Ok(worker) => workers.push((id.clone(), worker)),
                Err(_) => {
                    first_error = Some(failure("Cannot start every container stop worker; partial effects require inspection."));
                    failures.push(StopFailure { id: id.clone(), stage: StopFailureStage::Worker });
                    break;
                }
            }
        }
        for (id, worker) in workers {
            let result = join_worker(worker);
            if let Err((error, stage)) = result {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                failures.push(StopFailure { id, stage });
            }
        }
        if let Some(error) = first_error {
            failures.sort_by_key(|failure| stops.iter().position(|(id, _)| id == &failure.id));
            Err(StopBatchFailure { error, failures })
        } else {
            Ok(())
        }
    })
}

fn join_worker(
    worker: std::thread::ScopedJoinHandle<'_, Result<(), (CandidateError, StopFailureStage)>>,
) -> Result<(), (CandidateError, StopFailureStage)> {
    worker.join().unwrap_or_else(|_| {
        Err((
            failure("Container stop worker failed; effects require inspection."),
            StopFailureStage::Worker,
        ))
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
    fn stop_budget_covers_guest_serialization_without_exceeding_request_bound() {
        let stops = (0..14)
            .map(|n| (format!("{n:064x}"), 10))
            .collect::<Vec<_>>();
        assert_eq!(stop_budget(&stops), Duration::from_secs(170));
        let largest = (0..32)
            .map(|n| (format!("{n:064x}"), 30))
            .collect::<Vec<_>>();
        assert_eq!(stop_budget(&largest), Duration::from_secs(540));
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
                    let status = if fail && (index == 0 || index == 31) {
                        "500 Failed"
                    } else if index == 1 {
                        "304 Not Modified"
                    } else {
                        "204 No Content"
                    };
                    let body = if status == "500 Failed" {
                        "private-stop-canary"
                    } else {
                        ""
                    };
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
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
            if fail {
                let failure = result.err().unwrap();
                assert_eq!(failure.failures.len(), 2);
                assert!(
                    failure
                        .failures
                        .iter()
                        .all(|item| item.stage == StopFailureStage::Response)
                );
                assert!(
                    failure
                        .failures
                        .iter()
                        .all(|item| stops.iter().any(|(id, _)| id == &item.id))
                );
                assert_eq!(failure.error.code, "engine_rejected");
                assert!(
                    !serde_json::to_string(&failure.error)
                        .unwrap()
                        .contains("private-stop-canary")
                );
            }
            assert_eq!(server.join().unwrap(), 32);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn unavailable_socket_reports_connect_without_replaying() {
        let path = std::env::temp_dir().join(format!("hs-missing-{}.sock", std::process::id()));
        let transport = Transport::new(&path, Duration::from_secs(1)).unwrap();
        let id = "a".repeat(64);
        let failure = batch(
            &transport.client,
            &[(id.clone(), 0)],
            Instant::now() + Duration::from_secs(1),
        )
        .err()
        .unwrap();
        assert_eq!(failure.error.code, "engine_protocol");
        assert_eq!(failure.failures.len(), 1);
        assert_eq!(failure.failures[0].id, id);
        assert_eq!(failure.failures[0].stage, StopFailureStage::Connect);
    }

    #[test]
    fn expired_batch_and_failed_worker_keep_fixed_stages() {
        let path = std::env::temp_dir().join(format!("hs-deadline-{}.sock", std::process::id()));
        let transport = Transport::new(&path, Duration::from_secs(1)).unwrap();
        let failure = batch(
            &transport.client,
            &[("a".repeat(64), 0)],
            Instant::now() - Duration::from_secs(1),
        )
        .err()
        .unwrap();
        assert_eq!(failure.failures[0].stage, StopFailureStage::Deadline);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| -> Result<(), (CandidateError, StopFailureStage)> {
                panic!("private worker panic");
            });
            let (error, stage) = join_worker(worker).unwrap_err();
            assert_eq!(error.code, "engine_protocol");
            assert_eq!(stage, StopFailureStage::Worker);
            assert!(
                !serde_json::to_string(&error)
                    .unwrap()
                    .contains("private worker panic")
            );
        });
    }

    #[test]
    fn accepted_stop_without_reply_reports_timeout_without_replay() {
        let path = std::env::temp_dir().join(format!(
            "hs-timeout-{}-{}.sock",
            std::process::id(),
            crate::node::now()
        ));
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(250));
        });
        let transport = Transport::new(&path, Duration::from_secs(1)).unwrap();
        let id = "b".repeat(64);
        let failure = batch(
            &transport.client,
            &[(id.clone(), 0)],
            Instant::now() + Duration::from_millis(80),
        )
        .err()
        .unwrap();
        assert_eq!(failure.failures.len(), 1);
        assert_eq!(failure.failures[0].id, id);
        assert_eq!(failure.failures[0].stage, StopFailureStage::Timeout);
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
