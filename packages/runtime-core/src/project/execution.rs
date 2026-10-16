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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    None,
    Starting,
    Healthy,
    Unhealthy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Observation {
    Created,
    Running { health: Health },
    Exited { code: i64 },
    Dead,
}
impl Observation {
    fn satisfies(self, condition: Condition) -> bool {
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
    fn failed(self) -> bool {
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
    fn start(&mut self, service: &str) -> Result<(), CandidateError>;
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError>;
}
fn error(code: &'static str, message: &str) -> CandidateError {
    CandidateError::new(code, message)
}
impl Graph {
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
        let graph = Self { services };
        graph.execution_order()?;
        Ok(graph)
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
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
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
fn inspect(
    driver: &mut impl Driver,
    name: &str,
    observations: &mut BTreeMap<String, Observation>,
) -> Result<Observation, CandidateError> {
    driver.check_cancelled()?;
    let state = driver.observe(name)?;
    if observations.get(name) != Some(&state) {
        driver.record(Event::Observed {
            service: name,
            observation: state,
        })?;
        observations.insert(name.into(), state);
    }
    if state.failed() {
        return Err(error(
            "graph_service_failed",
            "An owned graph service failed; no further services will start.",
        ));
    }
    Ok(state)
}
fn before_deadline(deadline: Instant) -> Result<(), CandidateError> {
    if Instant::now() >= deadline {
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
    mut wait: impl FnMut(Duration),
) -> Result<(), CandidateError> {
    let order = graph.execution_order()?;
    if timeout.is_zero() || timeout > Duration::from_secs(600) {
        return Err(error(
            "graph_timeout_budget",
            "Graph timeout must be greater than zero and at most 600 seconds.",
        ));
    }
    let deadline = Instant::now() + timeout;
    let mut started = BTreeSet::<String>::new();
    let mut observations = BTreeMap::new();
    loop {
        before_deadline(deadline)?;
        driver.check_cancelled()?;
        for name in &started {
            inspect(driver, name, &mut observations)?;
            before_deadline(deadline)?;
            driver.check_cancelled()?;
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
                let state = inspect(driver, dependency, &mut observations)?;
                before_deadline(deadline)?;
                driver.check_cancelled()?;
                if !state.satisfies(*condition) {
                    ready = false;
                    break;
                }
            }
            if !ready {
                continue;
            }
            before_deadline(deadline)?;
            driver.check_cancelled()?;
            driver.record(Event::StartIntent { service: name })?;
            before_deadline(deadline)?;
            driver.check_cancelled()?;
            if let Err(failure) = driver.start(name) {
                driver.record(Event::StartUncertain { service: name })?;
                return Err(failure);
            }
            driver.record(Event::Started { service: name })?;
            started.insert(name.clone());
            inspect(driver, name, &mut observations)?;
            before_deadline(deadline)?;
            driver.check_cancelled()?;
        }
        if started.len() == graph.services.len() {
            let mut ready = true;
            for (name, service) in &graph.services {
                let state = inspect(driver, name, &mut observations)?;
                before_deadline(deadline)?;
                driver.check_cancelled()?;
                ready &= state.satisfies(service.ready);
            }
            if ready {
                driver.record(Event::Ready)?;
                return Ok(());
            }
        }
        wait(Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())));
    }
}

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
    }
    impl Driver for Fake {
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
            assert_eq!(
                run(&graph(), &mut driver, Duration::from_secs(1))
                    .unwrap_err()
                    .code,
                "graph_service_failed"
            );
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
