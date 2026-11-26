//! Re-review only the live owner's admitted selectors. Never replay an uncertain
//! response or admit a caller-selected port, executable, environment or PID.
use super::*;
use std::os::unix::net::UnixStream;
use transport::DependencyRefreshRequest;

/// Both the requesting command and the owner read the selection under the
/// mutation lease. Either waits out a brief holder (the owner itself supervises
/// restarts under it each second) instead of refusing `provider_busy` (HACK-2669),
/// until `deadline`. The owner waits at most `COMMAND_LEASE_WAIT` on its only loop
/// thread, and `check` runs before every attempt: the owner passes its signal and
/// disconnect checks, so a shutdown signal is not held behind another command's
/// lease.
fn selection(
    candidate: &Candidate,
    run: &str,
    deadline: Instant,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<DependencyRefreshRequest, CandidateError> {
    leased_selection(
        candidate,
        &Engine::connect_command(candidate, deadline, check)?,
        run,
    )
}

/// The requesting process's selection, before anything is sent to the owner. It
/// waits at most `COMMAND_REQUEST_LEASE_WAIT`, so it outlasts another project's
/// stop (HACK-2729). Its own `provider_busy` on expiry is the only `provider_busy`
/// that `request` returns as is: every owner refusal is wrapped in `refused()`, so
/// the CLI reads that code alone as "nothing was sent and nothing ran".
fn requested_selection(
    candidate: &Candidate,
    run: &str,
    deadline: Instant,
) -> Result<DependencyRefreshRequest, CandidateError> {
    leased_selection(
        candidate,
        &Engine::connect_command_request(candidate, deadline, &|| Ok(()))?,
        run,
    )
}

fn leased_selection(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<DependencyRefreshRequest, CandidateError> {
    let (receipt, _) = super::super::load(candidate, engine, run)?;
    if receipt.phase != "ready-observed" {
        return Err(refused());
    }
    Ok(DependencyRefreshRequest {
        plan: receipt.plan_id.clone(),
        generation: redelivery::generation(&receipt)?,
        boot: engine.guest().boot_id().to_owned(),
    })
}

/// The owner's lease-wait check: refuse, with nothing admitted, once the owner's
/// own cancellation (a pending signal, a disconnected client, its deadline) holds.
fn owner_lease_check(cancelled: &dyn Fn() -> bool) -> impl Fn() -> Result<(), CandidateError> + '_ {
    move || {
        if cancelled() {
            Err(crate::provider::engine::acquisition_cancelled())
        } else {
            Ok(())
        }
    }
}

pub fn request(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    // The requesting CLI process has no owner loop to keep responsive; an interrupt
    // ends the process, and the frontend bounds the whole request.
    let selected = requested_selection(
        candidate,
        run,
        Instant::now() + crate::provider::lifecycle::COMMAND_REQUEST_LEASE_WAIT,
    )?;
    let expected_plan = selected.plan.clone();
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    transport::write(
        &mut stream,
        &WireRequest {
            cancel_append: false,
            version: 1,
            run: run.into(),
            remove_data: None,
            job: None,
            restore: None,
            refresh_dependencies: Some(selected),
            extend: None,
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
    // The owner's whole answer, lease wait included, stays inside the 175 s the
    // requester reads for: a requester that gives up first disconnects, and a
    // disconnect cancels the rebind.
    let deadline = Instant::now() + Duration::from_secs(170);
    // This runs on the owner's only loop thread. Its lease wait (HACK-2669) checks the
    // same signals and client disconnect as the rebind, so Ctrl-C or `hack down` is
    // handled within one backoff step instead of after the wait.
    let watch = transport::ClientWatch::half_closed(stream)?;
    let cancelled = || signals.pending() || watch.disconnected() || Instant::now() >= deadline;
    let current = selection(candidate, run, deadline, &owner_lease_check(&cancelled))?;
    if selected.plan != current.plan
        || selected.generation != current.generation
        || selected.boot != current.boot
    {
        return Err(refused());
    }
    runtime.refresh_dependencies(candidate, run, &selected.generation, cancelled)
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

/// HACK-2669 review: the owner's refresh answer waits on another command's lease on
/// its only loop thread, so the wait must end once the owner's cancellation holds
/// (a pending signal, a disconnected client) instead of after `COMMAND_LEASE_WAIT`.
#[cfg(test)]
mod owner_lease_tests {
    use super::*;
    use crate::provider::engine::command_lease_tests::{
        PAST_ACQUISITION, PROJECT_STOP_REFUSAL, hold_lease, hold_lease_as_project_stop,
        running_pool,
    };
    use std::cell::Cell;

    /// HACK-2729: the requesting side's selection, before anything is sent to the
    /// owner, outlasts a project stop (scaled: 600 ms against a 700 ms bound), and a
    /// stop past its bound is refused with the raw, uncaused `provider_busy` naming
    /// the stop. That is the refusal the CLI reports as "nothing ran".
    #[test]
    fn the_requested_selection_waits_out_a_project_stop_and_refuses_one_past_its_bound() {
        let (_home, candidate) = running_pool();
        let run = "a".repeat(32);
        let hold = Duration::from_millis(600);
        let (_release, holder) = hold_lease_as_project_stop(&candidate, hold);
        let started = Instant::now();
        let after = requested_selection(&candidate, &run, started + Duration::from_millis(700))
            .err()
            .unwrap();
        assert!(started.elapsed() >= hold - Duration::from_millis(50));
        assert_eq!(after.code, PAST_ACQUISITION, "{}", after.message);
        holder.join().unwrap();

        let (release, holder) = hold_lease_as_project_stop(&candidate, Duration::from_secs(30));
        let refused = requested_selection(
            &candidate,
            &run,
            Instant::now() + Duration::from_millis(300),
        )
        .err()
        .unwrap();
        assert_eq!(refused.code, "provider_busy");
        assert_eq!(refused.message, PROJECT_STOP_REFUSAL);
        assert!(refused.cause_code.is_none());
        release.send(()).unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn a_pending_owner_signal_ends_the_selection_lease_wait() {
        let (_home, candidate) = running_pool();
        let (release, holder) = hold_lease(&candidate, Duration::from_secs(30));
        let started = Instant::now();
        let polls = Cell::new(0_u32);
        // Stands in for `signals.pending()`: a signal arrives 200 ms into the wait.
        let pending = || {
            polls.set(polls.get() + 1);
            started.elapsed() >= Duration::from_millis(200)
        };
        let refused = selection(
            &candidate,
            &"a".repeat(32),
            started + Duration::from_secs(170),
            &owner_lease_check(&pending),
        )
        .err()
        .unwrap();
        assert_eq!(refused.code, "provider_acquisition_cancelled");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the signal was held behind the lease wait: {:?}",
            started.elapsed()
        );
        // Checked on every attempt, not once before the wait.
        assert!(polls.get() > 1, "{}", polls.get());
        release.send(()).unwrap();
        holder.join().unwrap();
    }
}
