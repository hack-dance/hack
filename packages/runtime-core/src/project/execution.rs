//! Dependency execution core. Drivers own immutable inputs, durable intent and resource identity.
//! A failed or uncertain start is never retried here; reconciliation requires a separate operation.
use super::PlanData;
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    Started,
    Healthy,
    Completed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    None,
    Starting,
    Healthy,
    Unhealthy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Observation {
    Created,
    Running {
        health: Health,
    },
    Exited {
        code: i64,
    },
    Dead,
    /// The engine will start a new incarnation under an admitted restart policy.
    /// It satisfies no readiness goal and is not a failure: an exhausted policy
    /// is observed later as an ordinary exit.
    Restarting,
}
impl Observation {
    pub(crate) fn satisfies(self, condition: Condition) -> bool {
        match condition {
            Condition::Started => matches!(self, Self::Running { .. } | Self::Exited { code: 0 }),
            Condition::Healthy => {
                self == Self::Running {
                    health: Health::Healthy,
                }
            }
            Condition::Completed => self == Self::Exited { code: 0 },
        }
    }
    pub(crate) fn failed(self) -> bool {
        matches!(
            self,
            Self::Dead
                | Self::Running {
                    health: Health::Unhealthy
                }
        ) || matches!(self, Self::Exited { code } if code != 0)
    }
}
#[derive(Clone, Debug)]
pub struct Service {
    pub dependencies: BTreeMap<String, Condition>,
    pub ready: Condition,
}
#[derive(Clone, Debug)]
pub struct Graph {
    pub services: BTreeMap<String, Service>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event<'a> {
    StartIntent {
        service: &'a str,
    },
    Started {
        service: &'a str,
    },
    StartUncertain {
        service: &'a str,
    },
    Observed {
        service: &'a str,
        observation: Observation,
    },
    /// A started service's own readiness goal held on one observation. Emitted at
    /// most once per service per attempt, never before `Started` and never after a
    /// failure; no order among siblings. It is a wake-up for publication, not a
    /// durable state: a later exit is not reported here.
    ServiceReady {
        service: &'a str,
    },
    /// Every service has `Started` recorded and its latest observation satisfies
    /// `Condition::Started` (running, or exited 0), Compose's "started": dependency
    /// edges kept their own conditions, since a dependent starts only once its edge
    /// holds; health and route goals are not part of it. Emitted exactly once per
    /// attempt, behind the same post-observation deadline and cancellation checks
    /// as `ServiceReady`, never after a failure and always before `Ready` (also when
    /// both hold on the same pass). Only for a driver that `reports_started`.
    AllStarted,
    Ready,
}
/// `record(StartIntent)` must durably reserve the service before `start`, rejecting any prior
/// unresolved intent. `start` must verify ownership, perform one attempt, and retain its identity.
/// `observe` must verify the same identity. Implementations must bound every operation's duration.
/// This loop neither adopts resources nor retries a failed driver call, including journal writes.
pub trait Driver {
    /// Check cancellation between operations; never interrupt or retry an in-flight effect.
    fn check_cancelled(&self) -> Result<(), CandidateError> {
        Ok(())
    }

    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError>;
    /// Whether this attempt records `AllStarted` (`--report-started`). When false the
    /// loop neither checks the deadline for it nor records it, exactly as before the
    /// event existed. The default is no.
    fn reports_started(&self) -> bool {
        false
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError>;
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError>;

    /// Add reviewed readiness context to an observed failure, without copying
    /// application output or private configuration into the error.
    fn service_failure(&self, service: &str, state: Observation) -> CandidateError {
        failed_service_error("graph_service_failed", service, state)
    }
}
fn error(code: &'static str, message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new(code, message)
}
impl Graph {
    /// Check an explicitly compiled dependency graph before handing it to a driver.
    /// This validates names, active targets, budgets and cycles, not executable inputs.
    pub fn from_services(services: BTreeMap<String, Service>) -> Result<Self, CandidateError> {
        let graph = Self { services };
        graph.execution_order()?;
        Ok(graph)
    }

    /// Compile only dependency intent from an already compatible review. Commands and environment
    /// stay redacted; drivers still need a separate verified executable-input compiler.
    pub fn from_plan(
        plan: &PlanData,
        readiness: &BTreeMap<String, Condition>,
    ) -> Result<Self, CandidateError> {
        if !plan.enrollment_compatible || plan.diagnostics.iter().any(|d| d.severity == "error") {
            return Err(error(
                "graph_incompatible",
                "The reviewed graph contains blocking diagnostics.",
            ));
        }
        let mut services = BTreeMap::new();
        for (name, service) in &plan.services {
            if !service.active {
                continue;
            }
            let mut dependencies = BTreeMap::new();
            for (dependency, condition) in &service.dependencies {
                // Review admits only optional edges to inactive targets; an
                // active optional target is enforced like a required one.
                if !condition.required
                    && !plan
                        .services
                        .get(dependency)
                        .is_some_and(|target| target.active)
                {
                    continue;
                }
                dependencies.insert(
                    dependency.clone(),
                    match condition.condition.as_str() {
                        "service_started" => Condition::Started,
                        "service_healthy" => Condition::Healthy,
                        "service_completed_successfully" => Condition::Completed,
                        _ => return Err(error("graph_condition", "Unknown dependency condition.")),
                    },
                );
            }
            let ready = *readiness.get(name).ok_or_else(|| {
                error(
                    "graph_readiness",
                    "Every active service needs an explicit readiness goal.",
                )
            })?;
            if ready == Condition::Healthy
                && !service
                    .healthcheck
                    .as_ref()
                    .is_some_and(|h| !h.disabled && (h.test.is_some() || h.native_http.is_some()))
            {
                return Err(error(
                    "graph_readiness",
                    "Healthy readiness requires an explicit enabled healthcheck.",
                ));
            }
            if ready == Condition::Completed
                && ["always", "unless-stopped"].contains(&service.restart.as_str())
            {
                return Err(error(
                    "graph_readiness",
                    "Completion readiness cannot use an unconditional restart policy.",
                ));
            }
            services.insert(
                name.clone(),
                Service {
                    dependencies,
                    ready,
                },
            );
        }
        if readiness.len() != services.len() {
            return Err(error(
                "graph_readiness",
                "Readiness includes inactive or unknown services.",
            ));
        }
        Self::from_services(services)
    }
    fn execution_order(&self) -> Result<Vec<&String>, CandidateError> {
        if self.services.is_empty() || self.services.len() > 128 {
            return Err(error(
                "graph_budget",
                "Execution requires between 1 and 128 services.",
            ));
        }
        for (name, service) in &self.services {
            if name.is_empty()
                || name.len() > 128
                || !name.bytes().enumerate().all(|(index, b)| {
                    b.is_ascii_alphanumeric() || b"_-".contains(&b) || (index > 0 && b == b'.')
                })
            {
                return Err(error(
                    "graph_service",
                    "Invalid execution service identifier.",
                ));
            }
            if service
                .dependencies
                .keys()
                .any(|d| !self.services.contains_key(d))
            {
                return Err(error(
                    "graph_dependency",
                    "Dependency is missing or inactive.",
                ));
            }
        }
        let mut remaining: BTreeSet<_> = self.services.keys().collect();
        let mut order = Vec::with_capacity(remaining.len());
        while !remaining.is_empty() {
            let ready: Vec<_> = remaining
                .iter()
                .copied()
                .filter(|name| {
                    self.services[*name]
                        .dependencies
                        .keys()
                        .all(|d| !remaining.contains(d))
                })
                .collect();
            if ready.is_empty() {
                return Err(error(
                    "graph_cycle",
                    "Execution dependencies contain a cycle.",
                ));
            }
            for name in ready {
                remaining.remove(name);
                order.push(name);
            }
        }
        Ok(order)
    }
}
/// Per-attempt observation memory: the last state recorded for each service and
/// the services already reported ready.
#[derive(Default)]
struct Seen {
    observations: BTreeMap<String, Observation>,
    ready: BTreeSet<String>,
    all_started: bool,
}
fn inspect(
    driver: &mut impl Driver,
    name: &str,
    seen: &mut Seen,
) -> Result<Observation, CandidateError> {
    driver.check_cancelled()?;
    let state = driver.observe(name)?;
    if seen.observations.get(name) != Some(&state) {
        driver.record(Event::Observed {
            service: name,
            observation: state,
        })?;
        seen.observations.insert(name.into(), state);
    }
    if state.failed() {
        return Err(driver.service_failure(name, state));
    }
    Ok(state)
}
/// Observe a started service, then check the deadline and cancellation. Only an
/// observation that passed both can report the service's own goal: its first one
/// records `ServiceReady`, so a failed, late or cancelled attempt reports nothing more.
/// The cancellation check can wait (a driver may verify guest state there), so the
/// deadline is checked again before the event.
/// Each observation is kept in `pass` for this evaluation pass (see `run_with_clock`).
fn observe_started(
    driver: &mut impl Driver,
    name: &str,
    goal: Condition,
    seen: &mut Seen,
    pass: &mut BTreeMap<String, Observation>,
    deadline: Instant,
    now: &mut impl FnMut() -> Instant,
) -> Result<Observation, CandidateError> {
    let state = inspect(driver, name, seen)?;
    before_deadline(deadline, now())?;
    driver.check_cancelled()?;
    if state.satisfies(goal) && !seen.ready.contains(name) {
        before_deadline(deadline, now())?;
        driver.record(Event::ServiceReady { service: name })?;
        seen.ready.insert(name.into());
    }
    pass.insert(name.into(), state);
    Ok(state)
}
/// The value-free failure for an owned service observed as failed: it names the
/// service and its exit code, death or health, never its output or configuration.
/// Graph startup with host dependency bindings reports an application failure
/// with this text under its own stage code.
pub(crate) fn failed_service_error(
    code: &'static str,
    name: &str,
    state: Observation,
) -> CandidateError {
    error(
        code,
        match state {
            Observation::Exited { code } => format!(
                "Owned graph service {name} exited with code {code}; no further services will start."
            ),
            Observation::Dead => format!(
                "Owned graph service {name} is dead or OOM-killed; no further services will start."
            ),
            _ => format!("Owned graph service {name} is unhealthy; no further services will start."),
        },
    )
    .with_service(name)
}
fn before_deadline(deadline: Instant, now: Instant) -> Result<(), CandidateError> {
    if now >= deadline {
        return Err(error(
            "graph_timeout",
            "Graph readiness deadline exceeded; owned state is retained.",
        ));
    }
    Ok(())
}
/// Run one fresh graph attempt. It returns only after every explicit readiness goal is observed.
/// Failure leaves ownership and cleanup to the driver; it never interprets a failed init as ready.
pub fn run(
    graph: &Graph,
    driver: &mut impl Driver,
    timeout: Duration,
) -> Result<(), CandidateError> {
    run_with_wait(graph, driver, timeout, std::thread::sleep)
}

fn run_with_wait(
    graph: &Graph,
    driver: &mut impl Driver,
    timeout: Duration,
    wait: impl FnMut(Duration),
) -> Result<(), CandidateError> {
    run_with_clock(graph, driver, timeout, wait, Instant::now)
}

fn run_with_clock(
    graph: &Graph,
    driver: &mut impl Driver,
    timeout: Duration,
    mut wait: impl FnMut(Duration),
    mut now: impl FnMut() -> Instant,
) -> Result<(), CandidateError> {
    let order = graph.execution_order()?;
    if timeout.is_zero() || timeout > Duration::from_secs(600) {
        return Err(error(
            "graph_timeout_budget",
            "Graph timeout must be greater than zero and at most 600 seconds.",
        ));
    }
    let deadline = now() + timeout;
    use crate::timings::{self, Outcome, Step};
    let mut started_timing = timings::start(Step::ContainersStarted, None);
    let all_ready = timings::start(Step::ServicesReady, None);
    let mut started = BTreeSet::<String>::new();
    let mut seen = Seen::default();
    loop {
        before_deadline(deadline, now())?;
        driver.check_cancelled()?;
        // This pass's observations. A dependency edge whose dependency was already
        // seen this pass not meeting its condition waits for the next pass without
        // asking the engine again (several dependents often wait on one slow health
        // goal); an edge about to allow a start always observes afresh.
        let mut pass = BTreeMap::new();
        // Every started service is observed on every pass, so its own goal is
        // reported while siblings are still starting.
        for name in &started {
            let goal = graph.services[name].ready;
            observe_started(driver, name, goal, &mut seen, &mut pass, deadline, &mut now)?;
        }
        for name in &order {
            let name = *name;
            let service = &graph.services[name];
            if started.contains(name) {
                continue;
            }
            let mut ready = true;
            for (dependency, condition) in &service.dependencies {
                if !started.contains(dependency) {
                    ready = false;
                    break;
                }
                let goal = graph.services[dependency].ready;
                if pass
                    .get(dependency)
                    .is_some_and(|state: &Observation| !state.satisfies(*condition))
                {
                    ready = false;
                    break;
                }
                let state = observe_started(
                    driver, dependency, goal, &mut seen, &mut pass, deadline, &mut now,
                )?;
                if !state.satisfies(*condition) {
                    ready = false;
                    break;
                }
            }
            if !ready {
                continue;
            }
            before_deadline(deadline, now())?;
            driver.check_cancelled()?;
            driver.record(Event::StartIntent { service: name })?;
            before_deadline(deadline, now())?;
            driver.check_cancelled()?;
            if let Err(failure) = driver.start(name) {
                driver.record(Event::StartUncertain { service: name })?;
                return Err(failure);
            }
            driver.record(Event::Started { service: name })?;
            started.insert(name.clone());
            observe_started(
                driver,
                name,
                service.ready,
                &mut seen,
                &mut pass,
                deadline,
                &mut now,
            )?;
        }
        if started.len() == graph.services.len() {
            let mut ready = true;
            let mut all_started = true;
            for (name, service) in &graph.services {
                let state = observe_started(
                    driver,
                    name,
                    service.ready,
                    &mut seen,
                    &mut pass,
                    deadline,
                    &mut now,
                )?;
                ready &= state.satisfies(service.ready);
                all_started &= state.satisfies(Condition::Started);
            }
            // Every observation above passed the deadline and cancellation checks;
            // the deadline is checked once more right before the event, as for
            // `ServiceReady`.
            if all_started && !seen.all_started && driver.reports_started() {
                before_deadline(deadline, now())?;
                driver.record(Event::AllStarted)?;
                seen.all_started = true;
            }
            if all_started && let Some(span) = started_timing.take() {
                span.finish(Outcome::Ok, false, None, Default::default());
            }
            if ready {
                if let Some(span) = all_ready {
                    span.finish(Outcome::Ok, false, None, Default::default());
                }
                timings::measure(Step::GraphReadyCommit, None, |_| {
                    driver.record(Event::Ready)
                })?;
                return Ok(());
            }
        }
        wait(Duration::from_millis(100).min(deadline.saturating_duration_since(now())));
    }
}

#[cfg(all(test, feature = "native-http-probe"))]
#[path = "route_probe_clock_tests.rs"]
mod route_probe_clock_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        starts: Vec<String>,
        events: Vec<String>,
        states: BTreeMap<String, Observation>,
        fail_journal: bool,
        ambiguous_start: bool,
        /// `--report-started`.
        reports: bool,
    }
    impl Driver for Fake {
        fn reports_started(&self) -> bool {
            self.reports
        }
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            self.events.push(serde_json::to_string(&event).unwrap());
            if self.fail_journal {
                return Err(error("journal_failed", "fixture"));
            }
            Ok(())
        }
        fn start(&mut self, service: &str) -> Result<(), CandidateError> {
            self.starts.push(service.into());
            if self.ambiguous_start {
                return Err(error("uncertain_start", "fixture"));
            }
            Ok(())
        }
        fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
            Ok(self.states[service])
        }
    }
    struct CancelledDriver<'a> {
        inner: Fake,
        pending: &'a std::cell::Cell<bool>,
        cancel_on_observe: bool,
    }
    impl Driver for CancelledDriver<'_> {
        fn reports_started(&self) -> bool {
            self.inner.reports
        }
        fn check_cancelled(&self) -> Result<(), CandidateError> {
            if self.pending.get() {
                Err(error("graph_cancelled", "fixture"))
            } else {
                Ok(())
            }
        }
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            self.inner.record(event)
        }
        fn start(&mut self, service: &str) -> Result<(), CandidateError> {
            self.inner.start(service)
        }
        fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
            let observed = self.inner.observe(service)?;
            if self.cancel_on_observe {
                self.pending.set(true);
            }
            Ok(observed)
        }
    }
    #[test]
    fn timing_records_started_then_ready_from_the_existing_graph_observations() {
        use crate::timings::{self, Clock, Collector, Config, Outcome, Record, Role, Sink, Step};
        use std::sync::{Arc, Mutex};
        struct TestClock;
        impl timings::TimeSource for TestClock {
            fn sample(&self) -> Option<(u64, u64)> {
                Some((1_000_000, 1000))
            }
        }
        #[derive(Default)]
        struct Records(Mutex<Vec<Record>>);
        impl Sink for Records {
            fn write_line(&self, line: &[u8]) -> bool {
                let record = Record::parse_line(std::str::from_utf8(line).unwrap()).unwrap();
                self.0.lock().unwrap().push(record);
                true
            }
        }

        let records = Arc::new(Records::default());
        let collector = Collector::new(
            Config {
                trace: "1".repeat(32),
                parent: None,
                role: Role::Runtime,
                clock: Clock::Host,
                spawn_mono_us: None,
                service_index_stable: false,
            },
            Arc::new(TestClock),
            records.clone(),
        )
        .unwrap();
        timings::observe(Some(&collector), Step::RuntimeDispatch, None, |_| {
            run(&graph(), &mut driver(), Duration::from_secs(1))
        })
        .unwrap();
        let records = records.0.lock().unwrap();
        assert_eq!(records[0].step, "containers.started");
        assert_eq!(records[1].step, "services.ready");
        assert_eq!(records[0].outcome, Outcome::Ok);
        assert_eq!(records[1].outcome, Outcome::Ok);
        assert_eq!(records[2].step, "graph.ready.commit");
    }

    #[test]
    fn cancellation_before_start_has_no_intent_or_effect() {
        let pending = std::cell::Cell::new(true);
        let mut driver = CancelledDriver {
            inner: driver(),
            pending: &pending,
            cancel_on_observe: false,
        };
        assert_eq!(
            run(&graph(), &mut driver, Duration::from_secs(1))
                .unwrap_err()
                .code,
            "graph_cancelled"
        );
        assert!(driver.inner.starts.is_empty());
        assert!(driver.inner.events.is_empty());
    }
    #[test]
    fn cancellation_while_initializer_waits_never_starts_dependent() {
        let pending = std::cell::Cell::new(false);
        let mut inner = driver();
        inner.states.insert("init".into(), Observation::Created);
        let mut driver = CancelledDriver {
            inner,
            pending: &pending,
            cancel_on_observe: false,
        };
        let mut waits = 0;
        let outcome = run_with_wait(&graph(), &mut driver, Duration::from_secs(1), |_| {
            waits += 1;
            pending.set(true);
        });
        assert_eq!(outcome.unwrap_err().code, "graph_cancelled");
        assert_eq!(waits, 1);
        assert_eq!(driver.inner.starts, vec!["init"]);
    }
    #[test]
    fn cancellation_at_successful_observation_cannot_commit_ready() {
        let pending = std::cell::Cell::new(false);
        let graph = Graph {
            services: BTreeMap::from([(
                "init".into(),
                Service {
                    dependencies: BTreeMap::new(),
                    ready: Condition::Completed,
                },
            )]),
        };
        let mut driver = CancelledDriver {
            inner: driver(),
            pending: &pending,
            cancel_on_observe: true,
        };
        assert_eq!(
            run(&graph, &mut driver, Duration::from_secs(1))
                .unwrap_err()
                .code,
            "graph_cancelled"
        );
        assert_eq!(driver.inner.starts, vec!["init"]);
        assert!(
            !driver
                .inner
                .events
                .iter()
                .any(|event| event.contains("ready"))
        );
    }
    fn graph() -> Graph {
        Graph {
            services: BTreeMap::from([
                (
                    "init".into(),
                    Service {
                        dependencies: BTreeMap::new(),
                        ready: Condition::Completed,
                    },
                ),
                (
                    "web".into(),
                    Service {
                        dependencies: BTreeMap::from([("init".into(), Condition::Completed)]),
                        ready: Condition::Healthy,
                    },
                ),
                (
                    "check".into(),
                    Service {
                        dependencies: BTreeMap::from([("web".into(), Condition::Healthy)]),
                        ready: Condition::Completed,
                    },
                ),
            ]),
        }
    }
    fn driver() -> Fake {
        Fake {
            states: BTreeMap::from([
                ("init".into(), Observation::Exited { code: 0 }),
                (
                    "web".into(),
                    Observation::Running {
                        health: Health::Healthy,
                    },
                ),
                ("check".into(), Observation::Exited { code: 0 }),
            ]),
            ..Fake::default()
        }
    }
    /// Counts observations per evaluation pass (a pass ends at each wait). `db`
    /// becomes healthy on its third observation.
    struct Counting {
        inner: Fake,
        db_seen: usize,
        passes: std::rc::Rc<std::cell::RefCell<Vec<BTreeMap<String, usize>>>>,
    }
    impl Driver for Counting {
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            self.inner.record(event)
        }
        fn start(&mut self, service: &str) -> Result<(), CandidateError> {
            self.inner.start(service)
        }
        fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
            *self
                .passes
                .borrow_mut()
                .last_mut()
                .unwrap()
                .entry(service.into())
                .or_default() += 1;
            if service == "db" {
                self.db_seen += 1;
                if self.db_seen < 3 {
                    return Ok(Observation::Running {
                        health: Health::Starting,
                    });
                }
            }
            self.inner.observe(service)
        }
    }
    #[test]
    fn a_dependency_not_ready_yet_is_observed_once_per_pass_whatever_its_dependents() {
        let healthy = Observation::Running {
            health: Health::Healthy,
        };
        let on_db = |ready| Service {
            dependencies: BTreeMap::from([("db".into(), Condition::Healthy)]),
            ready,
        };
        let graph = Graph {
            services: BTreeMap::from([
                (
                    "db".into(),
                    Service {
                        dependencies: BTreeMap::new(),
                        ready: Condition::Healthy,
                    },
                ),
                ("api".into(), on_db(Condition::Started)),
                ("worker".into(), on_db(Condition::Started)),
                ("jobs".into(), on_db(Condition::Started)),
            ]),
        };
        let mut driver = Counting {
            inner: Fake {
                states: ["db", "api", "worker", "jobs"]
                    .into_iter()
                    .map(|name| (name.into(), healthy))
                    .collect(),
                ..Fake::default()
            },
            db_seen: 0,
            passes: std::rc::Rc::default(),
        };
        let passes = driver.passes.clone();
        passes.borrow_mut().push(BTreeMap::new());
        run_with_wait(&graph, &mut driver, Duration::from_secs(5), |_| {
            passes.borrow_mut().push(BTreeMap::new());
        })
        .unwrap_or_else(|error| panic!("{}", error.code));
        // Before this change each waiting pass observed `db` once per dependent
        // edge as well (1 + 3 here). Three dependents wait on `db`'s health. While it is not healthy yet,
        // `db` is observed once per pass, not once per dependency edge. In the pass
        // it becomes healthy, each dependent's edge still observes it afresh right
        // before that dependent starts.
        let passes = passes.borrow();
        let db = |pass: &BTreeMap<String, usize>| pass.get("db").copied().unwrap_or(0);
        assert_eq!(passes.len(), 3, "{passes:?}");
        assert_eq!(db(&passes[0]), 1, "{passes:?}");
        assert_eq!(db(&passes[1]), 1, "{passes:?}");
        // Then the readiness check of that last pass observes every service again.
        assert_eq!(db(&passes[2]), 1 + 3 + 1, "{passes:?}");
        assert_eq!(driver.inner.starts, ["db", "api", "jobs", "worker"]);
    }
    #[test]
    fn dependency_conditions_override_alphabetic_order() {
        let mut driver = driver();
        run_with_wait(&graph(), &mut driver, Duration::from_secs(1), |_| {
            panic!("ready dependencies must not wait for a polling interval")
        })
        .unwrap();
        assert_eq!(driver.starts, ["init", "web", "check"]);
        assert_eq!(driver.events.last().unwrap(), "{\"event\":\"ready\"}");
    }
    /// Two independent services: `fast` is ready once running, `slow` waits on its
    /// health check, which `wait` turns to `later`.
    struct Siblings {
        inner: Fake,
        slow: std::rc::Rc<std::cell::Cell<Observation>>,
        fast_listener: Option<std::net::TcpListener>,
        fast_address: std::rc::Rc<std::cell::Cell<Option<std::net::SocketAddr>>>,
    }
    impl Driver for Siblings {
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            if matches!(&event, Event::ServiceReady { service: "fast" }) {
                let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
                self.fast_address.set(Some(listener.local_addr().unwrap()));
                self.fast_listener = Some(listener);
            }
            self.inner.record(event)
        }
        fn start(&mut self, service: &str) -> Result<(), CandidateError> {
            self.inner.start(service)
        }
        fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
            if service == "slow" {
                Ok(self.slow.get())
            } else {
                self.inner.observe(service)
            }
        }
    }
    fn siblings(later: Observation) -> (Result<(), CandidateError>, Vec<String>) {
        let graph = Graph {
            services: BTreeMap::from([
                (
                    "fast".into(),
                    Service {
                        dependencies: BTreeMap::new(),
                        ready: Condition::Started,
                    },
                ),
                (
                    "slow".into(),
                    Service {
                        dependencies: BTreeMap::new(),
                        ready: Condition::Healthy,
                    },
                ),
            ]),
        };
        let slow = std::rc::Rc::new(std::cell::Cell::new(Observation::Running {
            health: Health::Starting,
        }));
        let fast_address = std::rc::Rc::new(std::cell::Cell::new(None));
        let mut driver = Siblings {
            inner: Fake {
                states: BTreeMap::from([(
                    "fast".into(),
                    Observation::Running {
                        health: Health::None,
                    },
                )]),
                ..Fake::default()
            },
            slow: slow.clone(),
            fast_listener: None,
            fast_address: fast_address.clone(),
        };
        let mut waits = 0;
        let outcome = run_with_wait(&graph, &mut driver, Duration::from_secs(1), |_| {
            waits += 1;
            if waits == 3 {
                let address = fast_address.get().expect("fast publisher admitted");
                std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1))
                    .expect("fast port accepts connections before slow becomes ready");
                slow.set(later);
            }
        });
        (outcome, driver.inner.events)
    }
    fn position(events: &[String], wanted: &str) -> Option<usize> {
        events.iter().position(|event| event == wanted)
    }
    #[test]
    fn a_fast_service_is_reported_ready_once_while_a_sibling_still_starts() {
        let (outcome, events) = siblings(Observation::Running {
            health: Health::Healthy,
        });
        outcome.unwrap();
        let fast = r#"{"event":"service_ready","service":"fast"}"#;
        let slow = r#"{"event":"service_ready","service":"slow"}"#;
        assert_eq!(events.iter().filter(|event| *event == fast).count(), 1);
        assert_eq!(events.iter().filter(|event| *event == slow).count(), 1);
        let healthy = position(
            &events,
            r#"{"event":"observed","service":"slow","observation":{"state":"running","health":"healthy"}}"#,
        )
        .unwrap();
        // Reported before the sibling became healthy, and only after it started.
        assert!(position(&events, fast).unwrap() < healthy);
        assert!(
            position(&events, r#"{"event":"started","service":"fast"}"#).unwrap()
                < position(&events, fast).unwrap()
        );
        assert!(position(&events, slow).unwrap() > healthy);
        assert_eq!(events.last().unwrap(), r#"{"event":"ready"}"#);
    }
    #[test]
    fn no_service_is_reported_ready_after_a_failure() {
        let (outcome, events) = siblings(Observation::Running {
            health: Health::Unhealthy,
        });
        assert_eq!(outcome.unwrap_err().code, "graph_service_failed");
        assert_eq!(
            events.last().unwrap(),
            r#"{"event":"observed","service":"slow","observation":{"state":"running","health":"unhealthy"}}"#
        );
        let reported: Vec<_> = events
            .iter()
            .filter(|event| event.contains("service_ready"))
            .collect();
        assert_eq!(reported, [r#"{"event":"service_ready","service":"fast"}"#]);
        assert!(!events.iter().any(|event| event == r#"{"event":"ready"}"#));
    }
    #[test]
    fn an_observation_that_crosses_the_deadline_reports_nothing_ready() {
        use std::{cell::Cell, rc::Rc};
        /// The healthy answer, or the cancellation check after it, returns after
        /// the deadline.
        struct Late {
            inner: Fake,
            late: Rc<Cell<bool>>,
            in_cancel_check: bool,
            observed: Cell<bool>,
        }
        impl Driver for Late {
            fn reports_started(&self) -> bool {
                self.inner.reports
            }
            fn check_cancelled(&self) -> Result<(), CandidateError> {
                if self.in_cancel_check && self.observed.get() {
                    self.late.set(true);
                }
                Ok(())
            }
            fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
                self.inner.record(event)
            }
            fn start(&mut self, service: &str) -> Result<(), CandidateError> {
                self.inner.start(service)
            }
            fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
                if !self.in_cancel_check {
                    self.late.set(true);
                }
                self.observed.set(true);
                self.inner.observe(service)
            }
        }
        let graph = Graph {
            services: BTreeMap::from([(
                "web".into(),
                Service {
                    dependencies: BTreeMap::new(),
                    ready: Condition::Healthy,
                },
            )]),
        };
        for in_cancel_check in [false, true] {
            let late = Rc::new(Cell::new(false));
            let mut driver = Late {
                inner: Fake {
                    states: BTreeMap::from([(
                        "web".into(),
                        Observation::Running {
                            health: Health::Healthy,
                        },
                    )]),
                    reports: true,
                    ..Fake::default()
                },
                late: late.clone(),
                in_cancel_check,
                observed: Cell::new(false),
            };
            let start = Instant::now();
            let outcome = run_with_clock(
                &graph,
                &mut driver,
                Duration::from_secs(1),
                |_| panic!("no wait before the deadline"),
                || {
                    if late.get() {
                        start + Duration::from_secs(2)
                    } else {
                        start
                    }
                },
            );
            assert_eq!(
                outcome.unwrap_err().code,
                "graph_timeout",
                "{in_cancel_check}"
            );
            assert_eq!(driver.inner.starts, ["web"]);
            let events = &driver.inner.events;
            assert!(
                !events.iter().any(|event| event.contains("ready")),
                "{in_cancel_check}: {events:?}"
            );
            assert!(
                !events.iter().any(|event| event.contains("all_started")),
                "{in_cancel_check}: a late observation reported every service started"
            );
        }
    }
    const ALL_STARTED: &str = r#"{"event":"all_started"}"#;
    /// `db` answers healthy only after `slow` observations; `web` is ready once
    /// running. Neither depends on the other.
    struct SlowHealth {
        inner: Fake,
        observations: usize,
        slow: usize,
    }
    impl Driver for SlowHealth {
        fn reports_started(&self) -> bool {
            self.inner.reports
        }
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            self.inner.record(event)
        }
        fn start(&mut self, service: &str) -> Result<(), CandidateError> {
            self.inner.start(service)
        }
        fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
            if service == "db" {
                self.observations += 1;
                let health = if self.observations > self.slow {
                    Health::Healthy
                } else {
                    Health::Starting
                };
                return Ok(Observation::Running { health });
            }
            self.inner.observe(service)
        }
    }
    fn healthy_and_started_siblings() -> Graph {
        Graph {
            services: BTreeMap::from([
                (
                    "db".into(),
                    Service {
                        dependencies: BTreeMap::new(),
                        ready: Condition::Healthy,
                    },
                ),
                (
                    "web".into(),
                    Service {
                        dependencies: BTreeMap::new(),
                        ready: Condition::Started,
                    },
                ),
            ]),
        }
    }
    fn web_running() -> Fake {
        Fake {
            states: BTreeMap::from([(
                "web".into(),
                Observation::Running {
                    health: Health::None,
                },
            )]),
            ..Fake::default()
        }
    }
    #[test]
    fn every_service_started_is_reported_before_a_slow_health_goal_and_ready() {
        let mut driver = SlowHealth {
            inner: Fake {
                reports: true,
                ..web_running()
            },
            observations: 0,
            slow: 6,
        };
        let mut waits = 0;
        run_with_wait(
            &healthy_and_started_siblings(),
            &mut driver,
            Duration::from_secs(5),
            |_| {
                waits += 1;
            },
        )
        .unwrap();
        assert!(waits > 0, "the health goal never held anything back");
        let events = &driver.inner.events;
        let position = |wanted: &str| {
            events
                .iter()
                .position(|event| event == wanted)
                .unwrap_or_else(|| panic!("{wanted} missing from {events:?}"))
        };
        let started = position(ALL_STARTED);
        let db_ready = position(r#"{"event":"service_ready","service":"db"}"#);
        let ready = position(r#"{"event":"ready"}"#);
        assert!(started < db_ready && db_ready < ready, "{events:?}");
        // After both services started, before db's health passed.
        assert!(started > position(r#"{"event":"started","service":"web"}"#));
        assert_eq!(events.iter().filter(|e| *e == ALL_STARTED).count(), 1);
    }
    #[test]
    fn every_service_started_is_reported_once_and_before_ready_on_the_same_pass() {
        // Every goal already holds on the first full pass: both events, in order.
        let mut driver = reporting();
        run(&graph(), &mut driver, Duration::from_secs(1)).unwrap();
        let events = &driver.events;
        let started = events.iter().position(|e| e == ALL_STARTED).unwrap();
        assert_eq!(started + 1, events.len() - 1, "{events:?}");
        assert_eq!(events.last().unwrap(), r#"{"event":"ready"}"#);
        assert_eq!(events.iter().filter(|e| *e == ALL_STARTED).count(), 1);
    }
    #[test]
    fn a_failure_before_every_service_started_reports_nothing_started() {
        // `check` waits on `web`'s health, which fails first.
        let mut driver = reporting();
        driver.states.insert(
            "web".into(),
            Observation::Running {
                health: Health::Unhealthy,
            },
        );
        let error = run(&graph(), &mut driver, Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.code, "graph_service_failed");
        assert!(!driver.events.iter().any(|e| e == ALL_STARTED));
        // And a start that never got going: nothing either.
        let mut driver = driver_with_ambiguous_start();
        assert!(run(&graph(), &mut driver, Duration::from_secs(1)).is_err());
        assert!(!driver.events.iter().any(|e| e == ALL_STARTED));
    }
    fn driver_with_ambiguous_start() -> Fake {
        Fake {
            ambiguous_start: true,
            ..reporting()
        }
    }
    fn reporting() -> Fake {
        Fake {
            reports: true,
            ..driver()
        }
    }
    #[test]
    fn a_dependency_edge_keeps_its_condition_for_every_service_started() {
        // `check` may start only once `web` is healthy, so "every service started"
        // waits for that edge even though web's own start already counts.
        let mut driver = reporting();
        driver.states.insert(
            "web".into(),
            Observation::Running {
                health: Health::Starting,
            },
        );
        let error = run_with_wait(&graph(), &mut driver, Duration::from_millis(300), |_| {
            std::thread::sleep(Duration::from_millis(50))
        })
        .unwrap_err();
        assert_eq!(error.code, "graph_timeout");
        assert!(!driver.starts.contains(&"check".to_owned()));
        assert!(!driver.events.iter().any(|e| e == ALL_STARTED));
    }
    #[test]
    fn a_dependency_is_reported_ready_before_its_dependent_starts() {
        let mut driver = driver();
        run(&graph(), &mut driver, Duration::from_secs(1)).unwrap();
        let ready = position(
            &driver.events,
            r#"{"event":"service_ready","service":"init"}"#,
        )
        .unwrap();
        assert!(
            ready
                < position(
                    &driver.events,
                    r#"{"event":"start_intent","service":"web"}"#
                )
                .unwrap()
        );
        for service in ["init", "web", "check"] {
            let wanted = format!(r#"{{"event":"service_ready","service":"{service}"}}"#);
            assert_eq!(driver.events.iter().filter(|e| **e == wanted).count(), 1);
        }
    }
    #[test]
    fn stalled_dependencies_back_off_and_are_reobserved_before_start() {
        use std::{cell::Cell, rc::Rc};
        struct Waiting {
            inner: Fake,
            released: Rc<Cell<bool>>,
            observations: usize,
        }
        impl Driver for Waiting {
            fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
                self.inner.record(event)
            }
            fn start(&mut self, service: &str) -> Result<(), CandidateError> {
                assert!(service == "init" || self.released.get());
                self.inner.start(service)
            }
            fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
                self.observations += 1;
                assert!(self.observations < 40, "readiness must not busy poll");
                if service == "init" && !self.released.get() {
                    Ok(Observation::Running {
                        health: Health::None,
                    })
                } else {
                    self.inner.observe(service)
                }
            }
        }
        let released = Rc::new(Cell::new(false));
        let mut driver = Waiting {
            inner: driver(),
            released: released.clone(),
            observations: 0,
        };
        let mut waits = 0;
        run_with_wait(&graph(), &mut driver, Duration::from_secs(1), |duration| {
            assert_eq!(duration, Duration::from_millis(100));
            waits += 1;
            released.set(true);
        })
        .unwrap();
        assert_eq!(waits, 1);
        assert_eq!(driver.inner.starts, ["init", "web", "check"]);
    }

    #[test]
    fn dependency_order_rechecks_health_before_starting_a_dependent() {
        struct Receding {
            inner: Fake,
            web_reads: usize,
        }
        impl Driver for Receding {
            fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
                self.inner.record(event)
            }
            fn start(&mut self, service: &str) -> Result<(), CandidateError> {
                self.inner.start(service)
            }
            fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
                if service == "web" {
                    self.web_reads += 1;
                    if self.web_reads > 1 {
                        return Ok(Observation::Running {
                            health: Health::Unhealthy,
                        });
                    }
                }
                self.inner.observe(service)
            }
        }
        let mut driver = Receding {
            inner: driver(),
            web_reads: 0,
        };
        let error = run_with_wait(&graph(), &mut driver, Duration::from_secs(1), |_| {
            panic!("ready dependency order should not need a polling interval")
        })
        .unwrap_err();
        assert_eq!(error.code, "graph_service_failed");
        assert_eq!(driver.inner.starts, ["init", "web"]);
    }

    #[test]
    fn failed_init_and_unhealthy_web_block_dependents() {
        for (service, state, starts) in [
            ("init", Observation::Exited { code: 23 }, vec!["init"]),
            (
                "web",
                Observation::Running {
                    health: Health::Unhealthy,
                },
                vec!["init", "web"],
            ),
        ] {
            let mut driver = driver();
            driver.states.insert(service.into(), state);
            let failure = run(&graph(), &mut driver, Duration::from_secs(1)).unwrap_err();
            assert_eq!(failure.code, "graph_service_failed");
            assert!(failure.message.contains(service));
            assert!(failure.message.contains(if service == "init" {
                "code 23"
            } else {
                "unhealthy"
            }));
            assert_eq!(driver.starts, starts);
        }
    }
    #[test]
    fn invalid_graphs_have_no_driver_effects() {
        for missing in [false, true] {
            let mut graph = graph();
            graph.services.get_mut("init").unwrap().dependencies.insert(
                if missing { "absent" } else { "check" }.into(),
                Condition::Started,
            );
            let mut driver = driver();
            assert!(run(&graph, &mut driver, Duration::from_secs(1)).is_err());
            assert!(driver.events.is_empty());
            assert!(driver.starts.is_empty());
        }
    }
    #[test]
    fn journal_failure_prevents_start_and_uncertain_start_is_not_replayed() {
        let mut driver = driver();
        driver.fail_journal = true;
        assert_eq!(
            run(&graph(), &mut driver, Duration::from_secs(1))
                .unwrap_err()
                .code,
            "journal_failed"
        );
        assert!(driver.starts.is_empty());
        driver.fail_journal = false;
        driver.ambiguous_start = true;
        assert_eq!(
            run(&graph(), &mut driver, Duration::from_secs(1))
                .unwrap_err()
                .code,
            "uncertain_start"
        );
        assert_eq!(driver.starts, ["init"]);
        assert!(driver.events.last().unwrap().contains("start_uncertain"));
    }
    #[test]
    fn readiness_timeout_never_starts_waiting_dependents() {
        let mut driver = driver();
        driver.states.insert(
            "init".into(),
            Observation::Running {
                health: Health::None,
            },
        );
        assert_eq!(
            run(&graph(), &mut driver, Duration::from_millis(5))
                .unwrap_err()
                .code,
            "graph_timeout"
        );
        assert_eq!(driver.starts, ["init"]);
    }
}

#[cfg(test)]
mod started_deadline_tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    /// One service, running: ready on its first observation. The clock passes the
    /// deadline at the cancellation check that follows the last observation of the
    /// final pass, after every check `Ready` needs and before `AllStarted`'s own.
    struct EdgeOfDeadline {
        reports: bool,
        checks: Cell<u32>,
        late: Rc<Cell<bool>>,
        events: Vec<String>,
    }
    impl Driver for EdgeOfDeadline {
        fn check_cancelled(&self) -> Result<(), CandidateError> {
            self.checks.set(self.checks.get() + 1);
            // 1 loop top, 2-3 before the intent and the start, 4-5 around the first
            // observation, 6-7 around the final pass's observation.
            if self.checks.get() == 7 {
                self.late.set(true);
            }
            Ok(())
        }
        fn reports_started(&self) -> bool {
            self.reports
        }
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            self.events.push(serde_json::to_string(&event).unwrap());
            Ok(())
        }
        fn start(&mut self, _: &str) -> Result<(), CandidateError> {
            Ok(())
        }
        fn observe(&mut self, _: &str) -> Result<Observation, CandidateError> {
            Ok(Observation::Running {
                health: Health::None,
            })
        }
    }
    fn attempt(reports: bool) -> (Result<(), CandidateError>, Vec<String>) {
        let graph = Graph {
            services: BTreeMap::from([(
                "web".into(),
                Service {
                    dependencies: BTreeMap::new(),
                    ready: Condition::Started,
                },
            )]),
        };
        let late = Rc::new(Cell::new(false));
        let mut driver = EdgeOfDeadline {
            reports,
            checks: Cell::new(0),
            late: Rc::clone(&late),
            events: Vec::new(),
        };
        let start = Instant::now();
        let clock = move || {
            if late.get() {
                start + Duration::from_secs(2)
            } else {
                start
            }
        };
        let outcome = run_with_clock(
            &graph,
            &mut driver,
            Duration::from_secs(1),
            |_| panic!("no wait: ready on the first pass"),
            clock,
        );
        (outcome, driver.events)
    }
    #[test]
    fn a_ready_at_the_deadline_still_succeeds_without_report_started() {
        let (outcome, events) = attempt(false);
        outcome.unwrap();
        assert_eq!(events.last().unwrap(), r#"{"event":"ready"}"#);
        assert!(!events.iter().any(|e| e.contains("all_started")));
    }
    #[test]
    fn with_report_started_the_same_edge_refuses_before_recording_it() {
        let (outcome, events) = attempt(true);
        assert_eq!(outcome.unwrap_err().code, "graph_timeout");
        assert!(
            !events
                .iter()
                .any(|e| e.contains("all_started") || e.contains(r#""ready""#))
        );
    }
}

#[cfg(test)]
mod stop_during_publication_tests {
    use super::*;
    use std::cell::Cell;
    /// A stop that arrives while `web`'s publication runs inside its `ServiceReady`
    /// record. Cancellation is only checked between engine operations, so the
    /// publication finishes first and the stop is seen at the next check.
    #[derive(Default)]
    struct StopDuringPublication {
        stop: Cell<bool>,
        published: bool,
        stopped_after_publication: Cell<bool>,
        starts: Vec<String>,
    }
    impl Driver for StopDuringPublication {
        fn check_cancelled(&self) -> Result<(), CandidateError> {
            if self.stop.get() {
                self.stopped_after_publication.set(self.published);
                return Err(CandidateError::new("graph_cancelled", "stopped"));
            }
            Ok(())
        }
        fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
            if matches!(event, Event::ServiceReady { service: "web" }) {
                // The stop arrives mid-publication; the publication still commits.
                self.stop.set(true);
                self.published = true;
            }
            Ok(())
        }
        fn start(&mut self, service: &str) -> Result<(), CandidateError> {
            self.starts.push(service.into());
            Ok(())
        }
        fn observe(&mut self, _: &str) -> Result<Observation, CandidateError> {
            Ok(Observation::Running {
                health: Health::None,
            })
        }
    }
    #[test]
    fn a_stop_during_a_publication_takes_effect_after_it() {
        let started = Service {
            dependencies: BTreeMap::new(),
            ready: Condition::Started,
        };
        let graph = Graph {
            services: BTreeMap::from([
                ("web".into(), started.clone()),
                (
                    "worker".into(),
                    Service {
                        dependencies: BTreeMap::from([("web".into(), Condition::Started)]),
                        ready: Condition::Started,
                    },
                ),
            ]),
        };
        let mut driver = StopDuringPublication::default();
        let outcome = run(&graph, &mut driver, Duration::from_secs(1));
        assert_eq!(outcome.unwrap_err().code, "graph_cancelled");
        assert!(driver.published);
        assert!(driver.stopped_after_publication.get());
        assert_eq!(driver.starts, ["web"]);
    }
}
