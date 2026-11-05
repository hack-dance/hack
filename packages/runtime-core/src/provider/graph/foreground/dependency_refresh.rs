//! Re-review only the live owner's admitted selectors. Never replay an uncertain
//! response or admit a caller-selected port, executable, environment or PID.
use super::*;
use std::os::unix::net::UnixStream;
use transport::DependencyRefreshRequest;

fn selection(candidate: &Candidate, run: &str) -> Result<DependencyRefreshRequest, CandidateError> {
    let engine = Engine::connect(candidate)?;
    let (receipt, _) = super::super::load(candidate, &engine, run)?;
    if receipt.phase != "ready-observed" {
        return Err(refused());
    }
    Ok(DependencyRefreshRequest {
        plan: receipt.plan_id.clone(),
        generation: redelivery::generation(&receipt)?,
        boot: engine.guest().boot_id().to_owned(),
    })
}

pub fn request(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let selected = selection(candidate, run)?;
    let expected_plan = selected.plan.clone();
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    transport::write(
        &mut stream,
        &WireRequest {
            version: 1,
            run: run.into(),
            remove_data: None,
            job: None,
            restore: None,
            refresh_dependencies: Some(selected),
        },
        Duration::from_secs(5),
    )?;
    let response = validate_owner_response(
        transport::read(&mut stream, Duration::from_secs(175), 256 * 1024)?,
        run,
    )?;
    if response["plan"] != expected_plan
        || !response["generation"]
            .as_str()
            .is_some_and(|value| super::super::hex(value, 64))
    {
        return Err(refused());
    }
    Ok(response)
}

pub(super) fn handle(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    run: &str,
    selected: DependencyRefreshRequest,
    stream: &UnixStream,
    signals: &signals::Events,
) -> Result<Value, CandidateError> {
    let current = selection(candidate, run)?;
    if selected.plan != current.plan
        || selected.generation != current.generation
        || selected.boot != current.boot
    {
        return Err(refused());
    }
    let watch = transport::ClientWatch::new(stream)?;
    let deadline = Instant::now() + Duration::from_secs(170);
    runtime.refresh_dependencies(candidate, run, &selected.generation, || {
        signals.pending() || watch.disconnected() || Instant::now() >= deadline
    })
}

pub(super) fn automatic(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    run: &str,
    signals: &signals::Events,
) -> Result<Value, CandidateError> {
    // An authenticated guest request can still hold the provider lease while its
    // failed stream unwinds. Keep this one notice until bounded acquisition;
    // there is no idle retry loop or replay of the application request.
    let selected = {
        let engine =
            Engine::connect_until(candidate, Instant::now() + Duration::from_secs(15), || {
                signals.pending()
            })?;
        let (receipt, _) = super::super::load(candidate, &engine, run)?;
        if receipt.phase != "ready-observed" {
            return Err(refused());
        }
        DependencyRefreshRequest {
            plan: receipt.plan_id.clone(),
            generation: redelivery::generation(&receipt)?,
            boot: engine.guest().boot_id().to_owned(),
        }
    };
    let deadline = Instant::now() + Duration::from_secs(170);
    runtime.refresh_dependencies(candidate, run, &selected.generation, || {
        signals.pending() || Instant::now() >= deadline
    })
}

/// Bounded retry delays after a refresh that refused before any effect, for
/// example because a replacement listener is not listening yet. About one
/// minute in total; afterwards only a new stale notice re-arms refresh.
pub(super) const AUTOMATIC_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Outcome of one automatic refresh attempt, as the scheduler sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AutomaticOutcome {
    /// The owner verified a refresh or an unchanged graph.
    Refreshed,
    /// Refused before the rebind journal: nothing changed, retry is safe.
    RefusedBeforeEffects,
    /// The rebind journal was written and the attempt did not complete, or the
    /// refusal is not a known pre-effect one: never try again automatically.
    Unconfirmed,
}

/// Classify an automatic attempt. Only refusals whose effects are known not
/// to have started may be retried; everything else closes automatic refresh.
pub(super) fn automatic_outcome(
    result: &Result<Value, CandidateError>,
    rebind_unconfirmed: bool,
) -> AutomaticOutcome {
    match result {
        Ok(_) => AutomaticOutcome::Refreshed,
        Err(_) if rebind_unconfirmed => AutomaticOutcome::Unconfirmed,
        Err(error)
            if matches!(
                error.code,
                "graph_dependency_refresh_refused" | "host_endpoint_identity" | "provider_busy"
            ) =>
        {
            AutomaticOutcome::RefusedBeforeEffects
        }
        Err(_) => AutomaticOutcome::Unconfirmed,
    }
}

/// Single-flight schedule for owner-side automatic dependency refresh.
///
/// A stale notice (authenticated traffic drift or a watched listener's exit)
/// arms one attempt now. A pre-effect refusal re-arms it after a bounded
/// backoff; a verified refresh clears the backoff; an unconfirmed outcome
/// closes the schedule for this owner's lifetime, so no rebind is replayed.
/// Notices during a pending backoff do not reset or shorten it. The foreground
/// loop runs at most one attempt at a time and never polls without a notice.
#[derive(Debug, Default)]
pub(super) struct AutomaticRefresh {
    due: Option<Instant>,
    retries: usize,
    closed: bool,
}
impl AutomaticRefresh {
    pub(super) fn stale(&mut self, now: Instant) {
        if !self.closed && self.due.is_none() {
            self.due = Some(now);
        }
    }
    pub(super) fn deadline(&self) -> Option<Instant> {
        self.due
    }
    /// Consume a due attempt. The caller must run exactly one attempt and then
    /// report it with [`Self::finish`].
    pub(super) fn take_due(&mut self, now: Instant) -> bool {
        if self.due.is_some_and(|due| due <= now) {
            self.due = None;
            return true;
        }
        false
    }
    pub(super) fn finish(&mut self, outcome: AutomaticOutcome, now: Instant) {
        match outcome {
            AutomaticOutcome::Refreshed => self.retries = 0,
            AutomaticOutcome::RefusedBeforeEffects => {
                if let Some(delay) = AUTOMATIC_RETRY_DELAYS.get(self.retries) {
                    self.due = Some(now + *delay);
                    self.retries += 1;
                } else {
                    self.retries = 0;
                }
            }
            AutomaticOutcome::Unconfirmed => {
                self.closed = true;
                self.due = None;
            }
        }
    }
    #[cfg(test)]
    pub(super) fn closed(&self) -> bool {
        self.closed
    }
}

/// Exit watches for the admitted refreshable listeners. Watches follow the
/// current admitted endpoints after every verified refresh; a listener that is
/// already gone when watched counts as a stale notice. A watch is only a
/// trigger: failing to register one never fails the owner, because
/// authenticated traffic still reports drift.
#[derive(Default)]
pub(super) struct ListenerWatches {
    watched: BTreeSet<i32>,
}
impl ListenerWatches {
    pub(super) fn sync(&mut self, signals: &signals::Events, runtime: &HostRelayRuntime) -> bool {
        let current = runtime.refreshable_listener_identities();
        let pids: BTreeSet<i32> = current.iter().map(|identity| identity.pid).collect();
        for stale in self.watched.difference(&pids) {
            let _ = signals.unwatch_listener_exit(*stale);
        }
        let mut gone = false;
        for identity in &current {
            if matches!(signals.watch_listener_exit(identity), Ok(false)) {
                gone = true;
            }
        }
        self.watched = pids;
        gone
    }
}

#[cfg(test)]
mod automatic_tests {
    use super::*;

    fn refused(code: &'static str) -> Result<Value, CandidateError> {
        Err(CandidateError::new(code, "synthetic refusal"))
    }

    #[test]
    fn only_pre_effect_refusals_are_retryable() {
        assert_eq!(
            automatic_outcome(&Ok(json!({"ok": true})), false),
            AutomaticOutcome::Refreshed
        );
        for code in [
            "graph_dependency_refresh_refused",
            "host_endpoint_identity",
            "provider_busy",
        ] {
            assert_eq!(
                automatic_outcome(&refused(code), false),
                AutomaticOutcome::RefusedBeforeEffects,
                "{code}"
            );
            // Once the rebind journal exists, the same code is not pre-effect.
            assert_eq!(
                automatic_outcome(&refused(code), true),
                AutomaticOutcome::Unconfirmed,
                "{code}"
            );
        }
        for code in [
            "graph_dependency_rebind_launch",
            "graph_dependency_rebind_cleanup",
            "graph_owner_recovery",
            "graph_cancelled",
        ] {
            assert_eq!(
                automatic_outcome(&refused(code), false),
                AutomaticOutcome::Unconfirmed,
                "{code}"
            );
        }
    }

    #[test]
    fn schedule_is_single_flight_bounded_and_never_replays_unconfirmed() {
        let start = Instant::now();
        let mut schedule = AutomaticRefresh::default();
        assert!(!schedule.take_due(start));
        schedule.stale(start);
        assert!(schedule.take_due(start));
        // While an attempt runs no second attempt is due, even with new notices.
        schedule.stale(start);
        assert_eq!(schedule.deadline(), Some(start));
        assert!(schedule.take_due(start));
        let mut now = start;
        let mut attempts = 1;
        schedule.finish(AutomaticOutcome::RefusedBeforeEffects, now);
        for delay in AUTOMATIC_RETRY_DELAYS.iter().skip(1) {
            let due = schedule.deadline().unwrap();
            // A notice during backoff neither resets nor shortens it.
            schedule.stale(now);
            assert_eq!(schedule.deadline(), Some(due));
            assert!(!schedule.take_due(due - Duration::from_millis(1)));
            now = due;
            assert!(schedule.take_due(now));
            attempts += 1;
            schedule.finish(AutomaticOutcome::RefusedBeforeEffects, now);
            assert_eq!(schedule.deadline(), Some(now + *delay));
        }
        now = schedule.deadline().unwrap();
        assert!(schedule.take_due(now));
        attempts += 1;
        schedule.finish(AutomaticOutcome::RefusedBeforeEffects, now);
        // Exhausted: bounded, and nothing is scheduled without a new notice.
        assert_eq!(attempts, AUTOMATIC_RETRY_DELAYS.len() + 1);
        assert_eq!(schedule.deadline(), None);
        schedule.stale(now);
        assert!(schedule.take_due(now));
        schedule.finish(AutomaticOutcome::Refreshed, now);
        assert_eq!(schedule.deadline(), None);
        schedule.stale(now);
        assert!(schedule.take_due(now));
        schedule.finish(AutomaticOutcome::Unconfirmed, now);
        assert!(schedule.closed());
        schedule.stale(now);
        assert_eq!(schedule.deadline(), None);
        assert!(!schedule.take_due(now + Duration::from_secs(3600)));
    }
}
