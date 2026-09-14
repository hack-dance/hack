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
                    .is_some_and(|h| !h.disabled && h.test.is_some())
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
        graph.validate()?;
        Ok(graph)
    }
    fn validate(&self) -> Result<(), CandidateError> {
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
            }
        }
        Ok(())
    }
}
fn inspect(
    driver: &mut impl Driver,
    name: &str,
    observations: &mut BTreeMap<String, Observation>,
) -> Result<Observation, CandidateError> {
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
    graph.validate()?;
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
        for name in &started {
            inspect(driver, name, &mut observations)?;
            before_deadline(deadline)?;
        }
        for (name, service) in &graph.services {
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
                if !state.satisfies(*condition) {
                    ready = false;
                    break;
                }
            }
            if !ready {
                continue;
            }
            before_deadline(deadline)?;
            driver.record(Event::StartIntent { service: name })?;
            before_deadline(deadline)?;
            if let Err(failure) = driver.start(name) {
                driver.record(Event::StartUncertain { service: name })?;
                return Err(failure);
            }
            driver.record(Event::Started { service: name })?;
            started.insert(name.clone());
            inspect(driver, name, &mut observations)?;
            before_deadline(deadline)?;
        }
        if started.len() == graph.services.len() {
            let mut ready = true;
            for (name, service) in &graph.services {
                let state = inspect(driver, name, &mut observations)?;
                before_deadline(deadline)?;
                ready &= state.satisfies(service.ready);
            }
            if ready {
                driver.record(Event::Ready)?;
                return Ok(());
            }
        }
        std::thread::sleep(
            Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
        );
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
        run(&graph(), &mut driver, Duration::from_secs(1)).unwrap();
        assert_eq!(driver.starts, ["init", "web", "check"]);
        assert_eq!(driver.events.last().unwrap(), "{\"event\":\"ready\"}");
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
