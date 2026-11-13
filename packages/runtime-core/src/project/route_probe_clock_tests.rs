//! Fake time drives both the production probe transition and graph deadline.
//! Socket/HTTP parsing, live exec identity and publication are tested separately.
use super::*;
use crate::provider::http_probe::HttpProbe;
use std::{cell::Cell, process::Command};

struct Probed<'a> {
    clock: &'a Cell<Duration>,
    config: HttpProbe,
    samples: Vec<(u64, u64, u64)>,
    started: bool,
    ready: bool,
}
impl Driver for Probed<'_> {
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        if matches!(event, Event::Ready) {
            self.ready = true;
        }
        Ok(())
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        assert_eq!(service, "web");
        assert!(!self.started, "a service must never be replayed");
        self.started = true;
        Ok(())
    }
    fn observe(&mut self, _: &str) -> Result<Observation, CandidateError> {
        let elapsed = self.clock.get().as_millis() as u64;
        let (sequence, &(observed, health, failures)) = self
            .samples
            .iter()
            .enumerate()
            .rev()
            .find(|(_, (time, _, _))| *time <= elapsed)
            .unwrap();
        let generation = "0".repeat(32);
        let raw = format!(
            "v1 {generation} {sequence} {health} {failures} {} 0\n",
            observed + 100_000
        );
        Ok(Observation::Running {
            health: self
                .config
                .health(&raw, &generation, true, elapsed + 100_000)?,
        })
    }
}

#[test]
fn a_route_first_answering_at_120_seconds_starts_under_the_graph_budget() {
    let graph = Graph::from_services(BTreeMap::from([(
        "web".into(),
        Service {
            dependencies: BTreeMap::new(),
            ready: Condition::Healthy,
        },
    )]))
    .unwrap();
    // The old grace is a negative control: the same delayed success must fail
    // early with it. The reviewed default must reach graph readiness at 120 s.
    for grace in [60_000, HttpProbe::inferred_route(3000).start_period_ms] {
        let mut config = HttpProbe::inferred_route(3000);
        config.start_period_ms = grace;
        let output = Command::new(concat!(env!("OUT_DIR"), "/http-probe-clock-host"))
            .args([
                grace.to_string(),
                config.interval_ms.to_string(),
                config.timeout_ms.to_string(),
                config.retries.to_string(),
                "120000".into(),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let samples = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| {
                let fields: Vec<u64> = line
                    .split(' ')
                    .map(|field| field.parse().unwrap())
                    .collect();
                (fields[0], fields[1], fields[2])
            })
            .collect();
        let clock = Cell::new(Duration::ZERO);
        let base = Instant::now();
        let mut driver = Probed {
            clock: &clock,
            config,
            samples,
            started: false,
            ready: false,
        };
        let result = run_with_clock(
            &graph,
            &mut driver,
            Duration::from_secs(300),
            |delay| clock.set(clock.get() + delay),
            || base + clock.get(),
        );
        assert!(driver.started);
        if grace == 60_000 {
            assert_eq!(result.unwrap_err().code, "graph_service_failed");
            assert!(!driver.ready);
            assert!(clock.get() < Duration::from_secs(120));
        } else {
            result.unwrap();
            assert!(driver.ready);
            assert_eq!(clock.get(), Duration::from_secs(120));
        }
    }
}
