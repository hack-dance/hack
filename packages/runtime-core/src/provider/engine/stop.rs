//! Cleanup-only stop effects. Workers share transport, never the VM mutation lease.
use super::*;
use crate::error::StopFailureStage;
use std::{
    collections::BTreeSet,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Instant,
};

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
    // Only macOS one-off and interrupted-start recovery use the plain wrapper.
    // Graph shutdown uses the diagnosed batch on every supported host.
    #[cfg(target_os = "macos")]
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

/// Stop requests in flight per batch. Each stop holds one engine connection for
/// up to its grace period. Dispatching all 14 stops of a qualification graph at
/// once failed at the connect stage while the provider host process held most of
/// its descriptor limit in lingering engine connections (HACK-1302).
/// [`stop_budget`] already covers fully serialized grace periods, so bounded
/// dispatch still fits the budget when every stop takes its full grace.
const STOP_CONCURRENCY: usize = 4;
/// A connect that failed or timed out sent no request bytes, so another attempt
/// is not a replay. Retries stay inside the batch deadline and inside this window
/// from a stop's first connect failure, which covers observed descriptor drain.
const CONNECT_RETRY_WINDOW: Duration = Duration::from_secs(30);
const CONNECT_BACKOFF_START: Duration = Duration::from_millis(25);
const CONNECT_BACKOFF_MAX: Duration = Duration::from_millis(500);

#[derive(Clone, Copy)]
struct Policy {
    concurrency: usize,
    connect_window: Duration,
    backoff_start: Duration,
    backoff_max: Duration,
}

const POLICY: Policy = Policy {
    concurrency: STOP_CONCURRENCY,
    connect_window: CONNECT_RETRY_WINDOW,
    backoff_start: CONNECT_BACKOFF_START,
    backoff_max: CONNECT_BACKOFF_MAX,
};

type Attempt = Result<(), (CandidateError, StopFailureStage)>;

fn batch(
    client: &Client,
    stops: &[(String, u64)],
    deadline: Instant,
) -> Result<(), StopBatchFailure> {
    validate(stops).map_err(StopBatchFailure::plain)?;
    // Test transport selection is thread-local to the caller, so resolve every
    // target before any worker starts.
    let targets = stops
        .iter()
        .map(|(id, grace)| {
            let client = client.clone();
            #[cfg(all(
                test,
                target_os = "macos",
                target_arch = "aarch64",
                feature = "environment-launcher"
            ))]
            let client = test_socket::for_id(id).unwrap_or(client);
            (
                client,
                format!("http://hack-local/v1.53/containers/{id}/stop?t={grace}"),
            )
        })
        .collect::<Vec<_>>();
    dispatch(stops, deadline, POLICY, |index, remaining| {
        let (client, path) = &targets[index];
        send(client, path, remaining)
    })
}

/// One HTTP stop. A non-connect failure is never retried: the request may have
/// reached the engine, and only later ownership-checked inspection decides.
fn send(client: &Client, path: &str, remaining: Duration) -> Attempt {
    let response = client.post(path).timeout(remaining).send().map_err(|error| {
        let stage = if error.is_connect() && error.is_timeout() {
            StopFailureStage::ConnectTimeout
        } else if error.is_connect() {
            StopFailureStage::Connect
        } else if error.is_timeout() {
            StopFailureStage::Timeout
        } else {
            StopFailureStage::Transport
        };
        (
            failure(
                "Container stop failed or timed out; no stop was replayed and no forced deletion was authorized.",
            ),
            stage,
        )
    })?;
    // A natural exit can race the preceding running observation. Only
    // subsequent ownership-checked inspection establishes terminal state.
    if response.status().as_u16() == 304 {
        return Ok(());
    }
    response_bytes(response)
        .map(|_| ())
        .map_err(|error| (error, StopFailureStage::Response))
}

/// Runs every stop through at most `policy.concurrency` workers that share one
/// queue, then joins them all, even after failures. Every stop gets exactly one
/// recorded outcome: a stop whose worker panicked, or that no worker could take,
/// is reported with the `worker` stage, because its effect is unknown.
fn dispatch<S>(
    stops: &[(String, u64)],
    deadline: Instant,
    policy: Policy,
    send: S,
) -> Result<(), StopBatchFailure>
where
    S: Fn(usize, Duration) -> Attempt + Sync,
{
    let next = AtomicUsize::new(0);
    let unreachable = AtomicBool::new(false);
    let outcomes = stops.iter().map(|_| Mutex::new(None)).collect::<Vec<_>>();
    std::thread::scope(|scope| {
        let workers = (0..policy.concurrency.clamp(1, stops.len().max(1)))
            .map_while(|_| {
                std::thread::Builder::new()
                    .name("hack-container-stop".into())
                    .spawn_scoped(scope, || {
                        loop {
                            let index = next.fetch_add(1, Ordering::SeqCst);
                            let Some(slot) = outcomes.get(index) else {
                                break;
                            };
                            let outcome = attempt(index, deadline, policy, &unreachable, &send);
                            *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(outcome);
                        }
                    })
                    .ok()
            })
            .collect::<Vec<_>>();
        // A panicked worker leaves its current stop unrecorded; its siblings
        // keep draining the queue.
        for worker in workers {
            let _ = worker.join();
        }
    });
    let mut first_error = None;
    let mut failures = Vec::new();
    for ((id, _), slot) in stops.iter().zip(outcomes) {
        let outcome = slot.into_inner().unwrap_or_else(PoisonError::into_inner);
        let (error, stage) = match outcome {
            Some(Ok(())) => continue,
            Some(Err(failed)) => failed,
            None => (
                failure(
                    "Container stop worker failed or did not start; effects require inspection.",
                ),
                StopFailureStage::Worker,
            ),
        };
        first_error.get_or_insert(error);
        failures.push(StopFailure {
            id: id.clone(),
            stage,
        });
    }
    match first_error {
        Some(error) => Err(StopBatchFailure { error, failures }),
        None => Ok(()),
    }
}

/// Sends one stop, retrying only connect-stage failures with capped backoff.
/// Once any stop exhausts its connect window, the engine is treated as
/// unreachable for this batch and later connect failures return at once.
fn attempt<S>(
    index: usize,
    deadline: Instant,
    policy: Policy,
    unreachable: &AtomicBool,
    send: &S,
) -> Attempt
where
    S: Fn(usize, Duration) -> Attempt,
{
    let mut window = None;
    let mut backoff = policy.backoff_start;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                (
                    failure("Container stop batch deadline expired; effects may be uncertain."),
                    StopFailureStage::Deadline,
                )
            })?;
        match send(index, remaining) {
            Err((error, stage))
                if matches!(
                    stage,
                    StopFailureStage::Connect | StopFailureStage::ConnectTimeout
                ) =>
            {
                let now = Instant::now();
                let until = (*window.get_or_insert(now + policy.connect_window)).min(deadline);
                if unreachable.load(Ordering::SeqCst) || now + backoff >= until {
                    unreachable.store(true, Ordering::SeqCst);
                    return Err((error, stage));
                }
                std::thread::sleep(backoff);
                backoff = backoff.saturating_mul(2).min(policy.backoff_max);
            }
            outcome => return outcome,
        }
    }
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

    fn ids(count: usize) -> Vec<(String, u64)> {
        (0..count).map(|n| (format!("{n:064x}"), 1)).collect()
    }

    fn socket_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "hs-{label}-{}-{}.sock",
            std::process::id(),
            crate::node::now()
        ))
    }

    /// Reads one request head and returns the stop target index from its path.
    fn read_stop(socket: &mut std::os::unix::net::UnixStream) -> usize {
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
        let target = line
            .strip_prefix("POST /v1.53/containers/")
            .and_then(|rest| rest.strip_suffix("/stop?t=1 HTTP/1.1"))
            .unwrap_or_else(|| panic!("unexpected stop request {line}"));
        usize::from_str_radix(target, 16).unwrap()
    }

    fn reply(socket: &mut std::os::unix::net::UnixStream, status: &str, body: &str) {
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .unwrap();
    }

    fn quick(window: Duration) -> Policy {
        Policy {
            concurrency: STOP_CONCURRENCY,
            connect_window: window,
            backoff_start: Duration::from_millis(1),
            backoff_max: Duration::from_millis(4),
        }
    }

    fn connect_failure(stage: StopFailureStage) -> Attempt {
        Err((failure("value-free connect failure"), stage))
    }

    #[test]
    fn socket_batch_bounds_in_flight_stops_and_joins_every_worker_without_response_retry() {
        for fail in [false, true] {
            let path = socket_path(&format!("bound-{fail}"));
            let listener = UnixListener::bind(&path).unwrap();
            listener.set_nonblocking(true).unwrap();
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                let mut seen = BTreeSet::new();
                let mut held = Vec::new();
                let mut peak = 0;
                let mut last_accept = Instant::now();
                while seen.len() < 32 || !held.is_empty() {
                    assert!(Instant::now() < deadline, "stop batch stalled");
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            let index = read_stop(&mut socket);
                            assert!(seen.insert(index), "stop {index} was replayed");
                            held.push((index, socket));
                            peak = peak.max(held.len());
                            last_accept = Instant::now();
                            if held.len() < STOP_CONCURRENCY {
                                continue;
                            }
                            // A bounded client cannot open another stop before
                            // one of the held stops is answered.
                            std::thread::sleep(Duration::from_millis(100));
                            if let Ok((mut extra, _)) = listener.accept() {
                                let index = read_stop(&mut extra);
                                held.push((index, extra));
                                peak = peak.max(held.len());
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            if held.is_empty() || last_accept.elapsed() < Duration::from_millis(300)
                            {
                                std::thread::sleep(Duration::from_millis(2));
                                continue;
                            }
                        }
                        Err(e) => panic!("{e}"),
                    }
                    for (index, mut socket) in held.drain(..) {
                        if fail && (index == 0 || index == 31) {
                            reply(&mut socket, "500 Failed", "private-stop-canary");
                        } else if index == 1 {
                            reply(&mut socket, "304 Not Modified", "");
                        } else {
                            reply(&mut socket, "204 No Content", "");
                        }
                    }
                }
                (seen.len(), peak)
            });
            let transport = Transport::new(&path, Duration::from_secs(10)).unwrap();
            let stops = ids(32);
            let result = batch(
                &transport.client,
                &stops,
                Instant::now() + Duration::from_secs(20),
            );
            assert_eq!(result.is_err(), fail);
            if fail {
                let failure = result.err().unwrap();
                let failed = failure
                    .failures
                    .iter()
                    .map(|item| (item.id.clone(), item.stage))
                    .collect::<Vec<_>>();
                assert_eq!(
                    failed,
                    vec![
                        (stops[0].0.clone(), StopFailureStage::Response),
                        (stops[31].0.clone(), StopFailureStage::Response),
                    ]
                );
                assert_eq!(failure.error.code, "engine_rejected");
                assert!(
                    !serde_json::to_string(&failure.error)
                        .unwrap()
                        .contains("private-stop-canary")
                );
            }
            assert_eq!(server.join().unwrap(), (32, STOP_CONCURRENCY));
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn refused_connects_retry_until_the_engine_listens_and_each_stop_arrives_once() {
        let path = socket_path("late");
        let bound = path.clone();
        let server = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let listener = UnixListener::bind(&bound).unwrap();
            let mut seen = BTreeSet::new();
            while seen.len() < 14 {
                let (mut socket, _) = listener.accept().unwrap();
                let index = read_stop(&mut socket);
                assert!(seen.insert(index), "stop {index} was replayed");
                reply(&mut socket, "204 No Content", "");
            }
            seen.len()
        });
        let transport = Transport::new(&path, Duration::from_secs(10)).unwrap();
        batch(
            &transport.client,
            &ids(14),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap_or_else(|failure| panic!("{:?}", failure.error));
        assert_eq!(server.join().unwrap(), 14);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unavailable_socket_reports_connect_after_retrying_only_within_the_deadline() {
        let path = socket_path("missing");
        let transport = Transport::new(&path, Duration::from_secs(1)).unwrap();
        let id = "a".repeat(64);
        let started = Instant::now();
        let failure = batch(
            &transport.client,
            &[(id.clone(), 0)],
            Instant::now() + Duration::from_millis(400),
        )
        .err()
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(failure.error.code, "engine_protocol");
        assert_eq!(failure.failures.len(), 1);
        assert_eq!(failure.failures[0].id, id);
        assert_eq!(failure.failures[0].stage, StopFailureStage::Connect);
    }

    #[test]
    fn connect_failures_for_some_of_fourteen_stops_retry_within_the_bound_without_replay() {
        let stops = ids(14);
        let attempts = (0..14).map(|_| AtomicUsize::new(0)).collect::<Vec<_>>();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        dispatch(
            &stops,
            Instant::now() + Duration::from_secs(10),
            quick(Duration::from_secs(5)),
            |index, _| {
                let attempt = attempts[index].fetch_add(1, Ordering::SeqCst);
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(5));
                active.fetch_sub(1, Ordering::SeqCst);
                match index {
                    2 | 5 | 9 if attempt < 3 => connect_failure(StopFailureStage::Connect),
                    11 if attempt == 0 => connect_failure(StopFailureStage::ConnectTimeout),
                    _ => Ok(()),
                }
            },
        )
        .unwrap_or_else(|failure| panic!("{:?}", failure.error));
        let attempts = attempts
            .iter()
            .map(|count| count.load(Ordering::SeqCst))
            .collect::<Vec<_>>();
        assert_eq!(attempts, vec![1, 1, 4, 1, 1, 4, 1, 1, 1, 4, 1, 2, 1, 1]);
        assert!(peak.load(Ordering::SeqCst) <= STOP_CONCURRENCY);
        assert!(peak.load(Ordering::SeqCst) > 1, "stops became sequential");
    }

    #[test]
    fn persistent_connect_failures_record_only_unreachable_stops_as_resumable_progress() {
        let stops = ids(14);
        let attempts = (0..14).map(|_| AtomicUsize::new(0)).collect::<Vec<_>>();
        let failure = dispatch(
            &stops,
            Instant::now() + Duration::from_secs(10),
            quick(Duration::from_millis(50)),
            |index, _| {
                attempts[index].fetch_add(1, Ordering::SeqCst);
                if index == 3 || index == 8 {
                    connect_failure(StopFailureStage::Connect)
                } else {
                    Ok(())
                }
            },
        )
        .err()
        .unwrap();
        assert_eq!(failure.error.code, "engine_protocol");
        let failed = failure
            .failures
            .iter()
            .map(|item| (item.id.clone(), item.stage))
            .collect::<Vec<_>>();
        assert_eq!(
            failed,
            vec![
                (stops[3].0.clone(), StopFailureStage::Connect),
                (stops[8].0.clone(), StopFailureStage::Connect),
            ]
        );
        for (index, count) in attempts.iter().enumerate() {
            let count = count.load(Ordering::SeqCst);
            if index == 3 || index == 8 {
                assert!(count >= 1);
            } else {
                assert_eq!(count, 1, "stop {index} was replayed");
            }
        }
    }

    #[test]
    fn non_connect_failures_are_never_retried_and_keep_their_stage() {
        let stops = ids(6);
        let attempts = (0..6).map(|_| AtomicUsize::new(0)).collect::<Vec<_>>();
        let failure = dispatch(
            &stops,
            Instant::now() + Duration::from_secs(10),
            quick(Duration::from_secs(5)),
            |index, _| {
                attempts[index].fetch_add(1, Ordering::SeqCst);
                match index {
                    1 => connect_failure(StopFailureStage::Timeout),
                    2 => connect_failure(StopFailureStage::Transport),
                    4 => connect_failure(StopFailureStage::Response),
                    _ => Ok(()),
                }
            },
        )
        .err()
        .unwrap();
        assert!(
            attempts
                .iter()
                .all(|count| count.load(Ordering::SeqCst) == 1)
        );
        let stages = failure
            .failures
            .iter()
            .map(|item| item.stage)
            .collect::<Vec<_>>();
        assert_eq!(
            stages,
            vec![
                StopFailureStage::Timeout,
                StopFailureStage::Transport,
                StopFailureStage::Response,
            ]
        );
    }

    #[test]
    fn expired_batch_and_panicked_worker_keep_fixed_stages() {
        let path = socket_path("deadline");
        let transport = Transport::new(&path, Duration::from_secs(1)).unwrap();
        let failure = batch(
            &transport.client,
            &[("a".repeat(64), 0)],
            Instant::now() - Duration::from_secs(1),
        )
        .err()
        .unwrap();
        assert_eq!(failure.failures[0].stage, StopFailureStage::Deadline);
        let stops = ids(8);
        let failure = dispatch(
            &stops,
            Instant::now() + Duration::from_secs(10),
            quick(Duration::from_secs(5)),
            |index, _| {
                assert!(index != 4, "private worker panic");
                Ok(())
            },
        )
        .err()
        .unwrap();
        assert_eq!(failure.error.code, "engine_protocol");
        assert_eq!(failure.failures.len(), 1);
        assert_eq!(failure.failures[0].id, stops[4].0);
        assert_eq!(failure.failures[0].stage, StopFailureStage::Worker);
        assert!(
            !serde_json::to_string(&failure.error)
                .unwrap()
                .contains("private worker panic")
        );
    }

    #[test]
    fn accepted_stop_without_reply_reports_timeout_without_replay() {
        let path = socket_path("timeout");
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
