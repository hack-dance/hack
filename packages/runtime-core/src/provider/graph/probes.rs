use super::super::http_probe::{HttpProbe, HttpProbePolicy};
use super::*;
use crate::{ProbeFinding, ProbeReason};
#[cfg(feature = "native-http-probe")]
use {
    base64::Engine as _,
    sha2::{Digest, Sha256},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub config: HttpProbe,
    pub allocation: String,
    pub generation: String,
    pub binary: String,
    pub uid: u32,
    pub gid: u32,
    pub exec_id: Option<String>,
    pub started_ms: u64,
    pub phase: String,
    /// Whether this probe's mounted binary takes the start interval argument (HACK-2443).
    /// Absent, and so false, in a receipt written by an earlier build: its binary is the
    /// earlier one, mounted by content address, and every launch of it uses the arguments that
    /// binary takes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub start_interval_argv: bool,
}

impl Probe {
    /// The arguments this probe's own binary takes: with the start interval for a binary of
    /// this build, without it for one an earlier build published.
    pub(super) fn launch_arguments(&self) -> Result<Vec<String>, CandidateError> {
        let directory = "/run/hack-http-probe-state";
        if self.start_interval_argv {
            return self.config.arguments(directory, &self.generation);
        }
        self.config
            .legacy_arguments(directory, &self.generation)?
            .ok_or_else(|| {
                error(
                    "graph_probe_plan",
                    "A probe from an earlier build cannot take a start interval.",
                )
            })
    }
}

/// Only an inferred route's unhealthy observation gets route guidance. Explicit
/// healthchecks, exits and deaths keep their existing diagnostic semantics.
#[cfg(any(target_os = "macos", test))]
pub(super) fn service_failure(
    code: &'static str,
    name: &str,
    observation: Observation,
    probe: Option<&HttpProbe>,
) -> CandidateError {
    service_failure_finding(code, name, observation, probe, None)
}

/// [`service_failure`] with what the probe observed, when known (HACK-2416).
pub(super) fn service_failure_finding(
    code: &'static str,
    name: &str,
    observation: Observation,
    probe: Option<&HttpProbe>,
    found: Option<ProbeFinding>,
) -> CandidateError {
    if let Some(probe) = probe.filter(|probe| {
        probe.policy == Some(HttpProbePolicy::Route)
            && matches!(
                observation,
                Observation::Running {
                    health: execution::Health::Unhealthy
                }
            )
    }) {
        let failure = error(
            code,
            format!(
                "Owned graph service {name} is unhealthy on inferred route port {}; no further services will start. Check hack logs {name} in the same project/branch, fix the route port, or declare healthcheck.x-hack-http with a longer start_period_ms and a readiness path, within the 300-second graph budget.",
                probe.port
            ),
        )
        .with_service(name);
        return match found {
            Some(found) => failure.with_route_probe_finding(probe.port, found),
            None => failure.with_route_probe(probe.port),
        };
    }
    execution::failed_service_error(code, name, observation)
}

#[cfg(test)]
mod route_failure_tests {
    use super::*;

    #[test]
    fn only_an_unhealthy_inferred_probe_names_its_route_and_remedies() {
        let inferred = HttpProbe::inferred_route(3000);
        let unhealthy = Observation::Running {
            health: execution::Health::Unhealthy,
        };
        for code in ["graph_service_failed", "graph_startup_application_failed"] {
            let failure = service_failure(code, "web", unhealthy, Some(&inferred));
            assert_eq!(failure.code, code);
            assert_eq!(failure.service.as_deref(), Some("web"));
            assert!(
                failure
                    .message
                    .contains("web is unhealthy on inferred route port 3000")
            );
            assert!(failure.message.contains("hack logs web"));
            assert!(failure.message.contains("healthcheck.x-hack-http"));
            assert!(failure.message.contains("longer start_period_ms"));
            let value = serde_json::to_value(failure).unwrap();
            assert_eq!(value["route_probe"], json!({"version":1,"port":3000}));
            assert!(value.get("message_fixed").is_none());
        }
        let mut explicit = inferred.clone();
        explicit.policy = None;
        for (observation, probe) in [
            (unhealthy, None),
            (unhealthy, Some(&explicit)),
            (Observation::Dead, Some(&inferred)),
            (Observation::Exited { code: 1 }, Some(&inferred)),
        ] {
            let failure = service_failure("graph_service_failed", "web", observation, probe);
            assert!(!failure.message.contains("inferred route"));
            assert!(
                serde_json::to_value(failure)
                    .unwrap()
                    .get("route_probe")
                    .is_none()
            );
        }
    }
}
pub(super) fn token() -> Result<String, CandidateError> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .map_err(state::io)?
        .read_exact(&mut bytes)
        .map_err(state::io)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn now() -> Result<u64, CandidateError> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("probe_clock", "Invalid observation clock."))?
        .as_millis() as u64)
}
pub(super) fn fresh(
    engine: &Engine<'_>,
    configs: &BTreeMap<String, Value>,
    probes: BTreeMap<String, HttpProbe>,
) -> Result<BTreeMap<String, Probe>, CandidateError> {
    if probes.is_empty() {
        return Ok(BTreeMap::new());
    }
    let binary = publish(engine)?;
    probes
        .into_iter()
        .map(|(name, config)| {
            let (uid, gid) = launcher::identity(&configs[&name])?;
            Ok((
                name,
                Probe {
                    config,
                    allocation: token()?,
                    generation: token()?,
                    binary: binary.clone(),
                    uid,
                    gid,
                    exec_id: None,
                    started_ms: 0,
                    phase: "reserved".into(),
                    start_interval_argv: true,
                },
            ))
        })
        .collect()
}
pub(super) fn validate(receipt: &Receipt) -> Result<(), CandidateError> {
    if receipt.probes.len() > MAX_SERVICES {
        return Err(error("graph_probe_receipt", "Probe budget exceeded."));
    }
    let mut allocations = std::collections::BTreeSet::new();
    for (name, p) in &receipt.probes {
        p.config.validate()?;
        if (["starting", "running"].contains(&p.phase.as_str())
            && (p.exec_id.is_none() || p.started_ms == 0))
            || (["reserved", "allocation-intent", "allocated", "exec-intent"]
                .contains(&p.phase.as_str())
                && (p.exec_id.is_some() || p.started_ms != 0))
        {
            return Err(error(
                "graph_probe_receipt",
                "Probe phase and exec intent differ.",
            ));
        }
        if !receipt.resources.contains_key(&format!("container:{name}"))
            || !hex(&p.allocation, 32)
            || !hex(&p.generation, 32)
            || !allocations.insert(&p.allocation)
            || !p
                .binary
                .strip_prefix("/storage/hack-native-http-probe/")
                .is_some_and(|s| hex(s, 64))
            || p.exec_id.as_ref().is_some_and(|id| !hex(id, 64))
            || p.uid > i32::MAX as u32
            || p.gid > i32::MAX as u32
            || ![
                "reserved",
                "allocation-intent",
                "allocated",
                "exec-intent",
                "starting",
                "running",
                "retired",
            ]
            .contains(&p.phase.as_str())
        {
            return Err(error(
                "graph_probe_receipt",
                "Invalid graph probe identity.",
            ));
        }
    }
    Ok(())
}
fn path(p: &Probe) -> String {
    format!("/run/hack-local/http-probes/{}", p.allocation)
}
fn marker(receipt: &Receipt, name: &str, p: &Probe) -> String {
    format!(
        "{}:{}:{}:{}",
        receipt.owner,
        receipt.run,
        receipt.resources[&format!("container:{name}")].name,
        p.allocation
    )
}
fn execute(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
    action: &str,
) -> Result<(), CandidateError> {
    execute_with_generation(engine, receipt, name, action, "")
}

fn execute_with_generation(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
    action: &str,
    previous: &str,
) -> Result<(), CandidateError> {
    let p = &receipt.probes[name];
    let path = path(p);
    let marker = marker(receipt, name, p);
    let uid = p.uid.to_string();
    let gid = p.gid.to_string();
    let args = [
        action,
        path.as_str(),
        marker.as_str(),
        uid.as_str(),
        gid.as_str(),
        p.binary.as_str(),
        previous,
    ];
    let script = STORAGE.replace("# PROBE_REARM_SAMPLES", REARM_SAMPLES);
    let output = if action == "remove" {
        engine.guest().execute_cleanup(&script, &args)?
    } else {
        engine.guest().execute(&script, &args, None)?
    };
    if output != "probe-storage-ready\n" {
        return Err(error(
            "graph_probe_storage",
            "Probe storage operation was not confirmed.",
        ));
    }
    Ok(())
}
fn attach(config: &mut Value, p: &Probe) {
    let mounts = config["HostConfig"]["Mounts"]
        .as_array_mut()
        .expect("prepared mounts");
    mounts.push(
        json!({"Type":"bind","Source":p.binary,"Target":"/run/hack-http-probe","ReadOnly":true}),
    );
    mounts.push(json!({"Type":"bind","Source":format!("{}/state",path(p)),"Target":"/run/hack-http-probe-state","ReadOnly":false}));
}
fn exec(
    engine: &impl super::Inspection,
    receipt: &Receipt,
    name: &str,
) -> Result<Option<Value>, CandidateError> {
    let p = &receipt.probes[name];
    let Some(id) = &p.exec_id else {
        return Ok(None);
    };
    let value = match engine.get(&format!("/v1.53/exec/{id}/json")) {
        Ok(v) => v,
        Err(e) if e.code == "engine_not_found" => return Ok(None),
        Err(e) => return Err(e),
    };
    let container = receipt.resources[&format!("container:{name}")]
        .id
        .as_ref()
        .ok_or_else(|| error("graph_probe_identity", "Probe lacks a container identity."))?;
    // The exec must carry exactly the arguments its probe's binary takes (HACK-2443).
    let arguments = &value["ProcessConfig"]["arguments"];
    let expected = json!(p.launch_arguments()?);
    if value["ContainerID"] != *container
        || value["ProcessConfig"]["entrypoint"] != "/run/hack-http-probe"
        || *arguments != expected
    {
        return Err(error(
            "graph_probe_identity",
            "Probe exec identity differs.",
        ));
    }
    Ok(Some(value))
}
pub(super) fn observe(
    engine: &impl super::Inspection,
    receipt: &Receipt,
    name: &str,
    value: &Value,
) -> Result<Observation, CandidateError> {
    observe_finding(engine, receipt, name, value).map(|(observation, _)| observation)
}

/// [`observe`] with what an unhealthy probe observed, for the failure's diagnostic
/// (HACK-2416).
pub(super) fn observe_finding(
    engine: &impl super::Inspection,
    receipt: &Receipt,
    name: &str,
    value: &Value,
) -> Result<(Observation, Option<ProbeFinding>), CandidateError> {
    let observed = observation(value)?;
    if observed == Observation::Restarting
        && !receipt
            .resources
            .get(&format!("container:{name}"))
            .is_some_and(super::restart_policy::admits_restarting)
    {
        return Err(error(
            "graph_state",
            "Owned service is restarting without an admitted restart policy.",
        ));
    }
    let Some(p) = receipt.probes.get(name) else {
        return Ok((observed, None));
    };
    if !matches!(observed, Observation::Running { .. }) {
        return Ok((observed, None));
    }
    let exec = exec(engine, receipt, name)?;
    let (health, finding) = if exec.as_ref().is_some_and(|v| v["Running"] == true) {
        let id = receipt.resources[&format!("container:{name}")]
            .id
            .as_ref()
            .unwrap();
        observe_sample(p, || engine.probe_status(id), now)?
    } else {
        let since_start_ms = now()?.saturating_sub(p.started_ms);
        // An exec the engine has not started yet, right after a detached start, is not a
        // failure inside the startup grace (HACK-2416). One that exited is.
        let exited = exec.as_ref().is_some_and(|v| v["ExitCode"].is_number());
        if exec.is_some() && !exited && since_start_ms <= p.config.start_period_ms {
            (Health::Starting, None)
        } else {
            let reason = if exited {
                ProbeReason::ExecExited
            } else {
                ProbeReason::ExecNotRunning
            };
            (
                Health::Unhealthy,
                Some(finding(reason, None, since_start_ms)),
            )
        }
    };
    Ok((Observation::Running { health }, finding))
}

fn finding(
    reason: ProbeReason,
    assessment: Option<&super::super::http_probe::Assessment>,
    since_start_ms: u64,
) -> ProbeFinding {
    ProbeFinding {
        reason,
        sequence: assessment.map(|a| a.sequence),
        failures: assessment.map(|a| a.failures),
        last_elapsed_ms: assessment.map(|a| a.elapsed_ms),
        since_start_ms,
    }
}

// Read the sample before observing wall time: a slow archive RPC can return a
// sample newer than its request time. Existing skew/freshness limits remain exact.
// Inside the startup grace, a sample that cannot be read and a missing one are not failures
// (HACK-2416); outside it they are.
fn observe_sample(
    probe: &Probe,
    read: impl FnOnce() -> Result<Option<String>, CandidateError>,
    clock: impl FnOnce() -> Result<u64, CandidateError>,
) -> Result<(Health, Option<ProbeFinding>), CandidateError> {
    let sample = read()?;
    let now = clock()?;
    let since_start_ms = now.saturating_sub(probe.started_ms);
    let starting = since_start_ms <= probe.config.start_period_ms;
    Ok(match sample {
        Some(raw) => match probe.config.assess(&raw, &probe.generation, true, now) {
            // The sample's own timestamp is the guest's; the host decides when "starting"
            // can no longer be true (see `starting_bound_ms`).
            Ok(assessment)
                if assessment.health == Health::Starting
                    && since_start_ms > probe.config.starting_bound_ms() =>
            {
                (
                    Health::Unhealthy,
                    Some(finding(
                        ProbeReason::SampleStale,
                        Some(&assessment),
                        since_start_ms,
                    )),
                )
            }
            Ok(assessment) => (
                assessment.health,
                assessment
                    .reason
                    .map(|reason| finding(reason, Some(&assessment), since_start_ms)),
            ),
            Err(_) if starting => (Health::Starting, None),
            Err(_) => (
                Health::Unhealthy,
                Some(finding(ProbeReason::SampleInvalid, None, since_start_ms)),
            ),
        },
        None if starting
            || since_start_ms <= probe.config.interval_ms + probe.config.timeout_ms + 1000 =>
        {
            (Health::Starting, None)
        }
        None => (
            Health::Unhealthy,
            Some(finding(ProbeReason::SampleMissing, None, since_start_ms)),
        ),
    })
}

#[cfg(test)]
mod observation_clock_tests {
    use super::*;
    /// HACK-2443: a probe from an earlier build's receipt launches its own binary with the
    /// arguments that binary takes; one created by this build adds the start interval.
    #[test]
    fn a_probe_launches_with_the_arguments_its_own_binary_takes() {
        let mut probe: Probe = serde_json::from_value(serde_json::json!({
            "config":{"port":8080,"path":"/","interval_ms":30000,"timeout_ms":1000,
                "retries":3,"start_period_ms":240000,"policy":"route"},
            "allocation":"a".repeat(32),"generation":"b".repeat(32),
            "binary":format!("/storage/hack-native-http-probe/{}", "c".repeat(64)),
            "uid":0,"gid":0,"exec_id":null,"started_ms":0,"phase":"running"
        }))
        .unwrap();
        // A receipt written before the field: the earlier binary's arguments.
        assert!(!probe.start_interval_argv);
        let legacy = probe.launch_arguments().unwrap();
        assert_eq!(legacy.len(), 9);
        assert_eq!(legacy.last().unwrap(), "route");
        assert!(
            serde_json::to_value(&probe)
                .unwrap()
                .get("start_interval_argv")
                .is_none()
        );
        // A probe this build created: the start interval before `route`.
        probe.start_interval_argv = true;
        let current = probe.launch_arguments().unwrap();
        assert_eq!(current.len(), 10);
        assert_eq!(current[8], "250");
        assert_eq!(current[9], "route");
        // An earlier binary cannot be given a declared start interval.
        probe.start_interval_argv = false;
        probe.config.start_interval_ms = Some(100);
        assert_eq!(
            probe.launch_arguments().unwrap_err().code,
            "graph_probe_plan"
        );
    }

    #[test]
    fn slow_sample_read_uses_response_time_without_extending_freshness() {
        let probe = Probe {
            config: HttpProbe {
                port: 8080,
                path: "/health".into(),
                interval_ms: 100,
                timeout_ms: 40,
                retries: 3,
                start_period_ms: 0,
                start_interval_ms: None,
                policy: None,
            },
            allocation: "a".repeat(32),
            generation: "b".repeat(32),
            binary: String::new(),
            uid: 0,
            gid: 0,
            exec_id: None,
            started_ms: 10000,
            phase: "started".into(),
            start_interval_argv: true,
        };
        let clock = std::cell::Cell::new(10000);
        let raw = format!("v1 {} 5 1 0 12000 2\n", probe.generation);
        assert_eq!(
            probe
                .config
                .health(&raw, &probe.generation, true, clock.get())
                .unwrap(),
            Health::Unhealthy
        );
        assert_eq!(
            observe_sample(
                &probe,
                || {
                    clock.set(12010);
                    Ok(Some(raw.clone()))
                },
                || Ok(clock.get())
            )
            .unwrap()
            .0,
            Health::Healthy
        );
        let (health, found) =
            observe_sample(&probe, || Ok(Some(raw.clone())), || Ok(13141)).unwrap();
        assert_eq!(health, Health::Unhealthy);
        let found = found.unwrap();
        assert_eq!(found.reason, ProbeReason::SampleStale);
        assert_eq!(
            (found.sequence, found.failures, found.last_elapsed_ms),
            (Some(5), Some(0), Some(2))
        );
        assert_eq!(found.since_start_ms, 3141);
        let (health, found) = observe_sample(
            &probe,
            || {
                clock.set(12000);
                Ok(None)
            },
            || Ok(clock.get()),
        )
        .unwrap();
        assert_eq!(health, Health::Unhealthy);
        assert_eq!(found.unwrap().reason, ProbeReason::SampleMissing);
    }

    /// HACK-2416: inside the startup grace, one doubtful observation is not a failure. A
    /// sample that cannot be read, a missing one, and a starting sample from a guest clock
    /// ahead of the host's all read as still starting; after the grace they fail, and say why.
    #[test]
    /// The host's reading, branch by branch, as `V(read)` in
    /// tests/models/tla/probe-readiness/ProbeReadiness.tla decides it, with the model's own
    /// constants at one tick = 1000 ms. If a bound here drifts from the model, this fails.
    fn the_probe_readiness_model_verdicts_match_observe_sample() {
        let tick = 1000;
        let (grace, timeout, interval, retries) = (3, 1, 2, 2u32);
        let fresh = interval + timeout + 1;
        let patient_age = grace.max(fresh) + timeout + 1;
        let limit =
            grace + timeout + u64::from(retries) * (interval + timeout) + (interval + timeout) + 1;
        let started = 100_000;
        let probe: Probe = serde_json::from_value(serde_json::json!({
            "config":{"port":8080,"path":"/","interval_ms":interval * tick,
                "timeout_ms":timeout * tick,"retries":retries,"start_period_ms":grace * tick},
            "allocation":"a".repeat(32),"generation":"b".repeat(32),"binary":"",
            "uid":0,"gid":0,"exec_id":null,"started_ms":started,"phase":"running",
            "start_interval_argv":true
        }))
        .unwrap();
        assert_eq!(probe.config.starting_bound_ms(), limit * tick, "Limit");
        let at = |t: u64| started + t * tick;
        let sample = |health: u8, published: u64| {
            let failures = if health == 0 { retries } else { 0 };
            format!(
                "v1 {} 5 {health} {failures} {published} 0\n",
                probe.generation
            )
        };
        let future = u64::MAX;
        use Health::{Healthy, Starting, Unhealthy};
        use ProbeReason::{SampleInvalid, SampleMissing, SampleStale};
        let rows = [
            ("none, t <= Grace", None, grace, Starting, None),
            ("none, Grace < t <= Fresh", None, fresh, Starting, None),
            (
                "none, t > Fresh",
                None,
                fresh + 1,
                Unhealthy,
                Some(SampleMissing),
            ),
            (
                "garbage, t <= Grace",
                Some("torn".into()),
                grace,
                Starting,
                None,
            ),
            (
                "garbage, t > Grace",
                Some("torn".into()),
                grace + 1,
                Unhealthy,
                Some(SampleInvalid),
            ),
            (
                "starting, age <= PatientAge",
                Some(sample(2, at(1))),
                1 + patient_age,
                Starting,
                None,
            ),
            (
                "starting, age > PatientAge",
                Some(sample(2, at(1))),
                2 + patient_age,
                Unhealthy,
                Some(SampleStale),
            ),
            (
                "skewed starting, t <= Limit",
                Some(sample(2, future)),
                limit,
                Starting,
                None,
            ),
            (
                "skewed starting, t > Limit",
                Some(sample(2, future)),
                limit + 1,
                Unhealthy,
                Some(SampleStale),
            ),
            (
                "healthy, age <= Fresh",
                Some(sample(1, at(5))),
                5 + fresh,
                Healthy,
                None,
            ),
            (
                "healthy, age > Fresh",
                Some(sample(1, at(5))),
                6 + fresh,
                Unhealthy,
                Some(SampleStale),
            ),
            (
                "unhealthy",
                Some(sample(0, at(5))),
                5,
                Unhealthy,
                Some(ProbeReason::FailuresExhausted),
            ),
        ];
        for (branch, raw, t, health, reason) in rows {
            let (observed, found) =
                observe_sample(&probe, || Ok(raw.clone()), || Ok(at(t))).unwrap();
            assert_eq!(observed, health, "{branch}");
            assert_eq!(found.map(|found| found.reason), reason, "{branch}");
        }
    }
    #[test]
    fn inside_the_startup_grace_a_doubtful_sample_is_not_a_failure() {
        let mut probe: Probe = serde_json::from_value(serde_json::json!({
            "config":{"port":8080,"path":"/","interval_ms":30000,"timeout_ms":1000,
                "retries":3,"start_period_ms":60000},
            "allocation":"a".repeat(32),"generation":"b".repeat(32),"binary":"",
            "uid":0,"gid":0,"exec_id":null,"started_ms":10000,"phase":"running",
            "start_interval_argv":true
        }))
        .unwrap();
        let inside = 10000 + 30_000;
        let after = 10000 + 61_000;
        let garbage = "not a sample\n".to_owned();
        let starting_ahead = format!("v1 {} 0 2 0 {} 0\n", probe.generation, inside + 5_000);
        for (raw, at, expected, reason) in [
            (Some(garbage.clone()), inside, Health::Starting, None),
            (None, inside, Health::Starting, None),
            (Some(starting_ahead), inside, Health::Starting, None),
            (
                Some(garbage),
                after,
                Health::Unhealthy,
                Some(ProbeReason::SampleInvalid),
            ),
            (
                None,
                after,
                Health::Unhealthy,
                Some(ProbeReason::SampleMissing),
            ),
        ] {
            let (health, found) = observe_sample(&probe, || Ok(raw.clone()), || Ok(at)).unwrap();
            assert_eq!(health, expected, "{raw:?} at {at}");
            assert_eq!(found.map(|found| found.reason), reason, "{raw:?} at {at}");
        }
        // A frozen "starting" sample dated far in the future reads as starting only until
        // the host-side bound from the probe's start; after it, it is stale.
        let bound = probe.config.starting_bound_ms();
        assert_eq!(bound, 60_000 + 1_000 + 3 * 31_000 + 31_000 + 1_000);
        let frozen = format!("v1 {} 4 2 2 {} 0\n", probe.generation, u64::MAX);
        let at_bound = 10000 + bound;
        let (health, _) =
            observe_sample(&probe, || Ok(Some(frozen.clone())), || Ok(at_bound)).unwrap();
        assert_eq!(health, Health::Starting);
        let (health, found) =
            observe_sample(&probe, || Ok(Some(frozen)), || Ok(at_bound + 1)).unwrap();
        assert_eq!(health, Health::Unhealthy);
        let found = found.unwrap();
        assert_eq!(found.reason, ProbeReason::SampleStale);
        assert_eq!(found.sequence, Some(4));
        // A sample that has already been healthy or unhealthy keeps the strict clock check.
        probe.config.start_period_ms = 0;
        let healthy_ahead = format!("v1 {} 1 1 0 {} 0\n", probe.generation, inside + 5_000);
        let (health, found) =
            observe_sample(&probe, || Ok(Some(healthy_ahead)), || Ok(inside)).unwrap();
        assert_eq!(health, Health::Unhealthy);
        assert_eq!(found.unwrap().reason, ProbeReason::SampleClockAhead);
    }
}

pub(super) fn cleanup(engine: &Engine<'_>, receipt: &mut Receipt) -> Result<(), CandidateError> {
    validate(receipt)?;
    for name in receipt.probes.keys().cloned().collect::<Vec<_>>() {
        if inspect_resource(
            engine,
            receipt,
            &receipt.resources[&format!("container:{name}")],
        )?
        .is_some()
            || exec(engine, receipt, &name)?.is_some_and(|v| v["Running"] == true)
        {
            return Err(error(
                "graph_probe_running",
                "Probe storage remains reserved while a container or exec exists.",
            ));
        }
        execute(engine, receipt, &name, "remove")?;
        receipt.probes.get_mut(&name).unwrap().phase = "retired".into();
    }
    Ok(())
}

/// One selected probe effect for interrupted-start recovery. The caller journals
/// the step before calling and must verify absence before advancing that journal.
#[cfg(target_os = "macos")]
fn inactive_exec(value: Option<&Value>) -> bool {
    value.is_none_or(|observed| observed["Running"].as_bool() == Some(false))
}

#[cfg(target_os = "macos")]
pub(super) fn retire_one(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
) -> Result<(), CandidateError> {
    validate(receipt)?;
    if !receipt.probes.contains_key(name)
        || inspect_resource(
            engine,
            receipt,
            &receipt.resources[&format!("container:{name}")],
        )?
        .is_some()
        || !inactive_exec(exec(engine, receipt, name)?.as_ref())
    {
        return Err(error(
            "graph_probe_running",
            "Selected probe still has an owned consumer.",
        ));
    }
    execute(engine, receipt, name, "remove")
}

/// An interrupted probe removal advances only from fresh guest absence.
#[cfg(target_os = "macos")]
pub(super) fn verify_one_absent(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
) -> Result<(), CandidateError> {
    validate(receipt)?;
    let probe = receipt.probes.get(name).ok_or_else(|| {
        error(
            "graph_probe_receipt",
            "Selected probe is missing from the graph receipt.",
        )
    })?;
    if inspect_resource(
        engine,
        receipt,
        &receipt.resources[&format!("container:{name}")],
    )?
    .is_some()
        || !inactive_exec(exec(engine, receipt, name)?.as_ref())
    {
        return Err(error(
            "graph_probe_cleanup_uncertain",
            "Selected probe remains active.",
        ));
    }
    let output = engine
        .guest()
        .execute_cleanup(PROBE_ABSENT, &[&path(probe)])?;
    if output != "probe-storage-absent\n" {
        return Err(error(
            "graph_probe_cleanup_uncertain",
            "Selected probe storage remains.",
        ));
    }
    Ok(())
}

/// Immutable probe selection for a cleanup effect. Retirement changes only phase;
/// every other field remains bound so lost/replaced probe records cannot look empty.
#[cfg(target_os = "macos")]
pub(super) fn cleanup_identity(receipt: &Receipt) -> Result<Value, CandidateError> {
    validate(receipt)?;
    let mut identity = serde_json::to_value(&receipt.probes).map_err(|_| {
        error(
            "graph_probe_receipt",
            "Probe cleanup identity could not be encoded.",
        )
    })?;
    for binding in identity
        .as_object_mut()
        .ok_or_else(|| error("graph_probe_receipt", "Invalid probe inventory."))?
        .values_mut()
    {
        binding
            .as_object_mut()
            .ok_or_else(|| error("graph_probe_receipt", "Invalid probe binding."))?
            .remove("phase");
    }
    Ok(identity)
}

/// Observe actual absence without repeating storage removal or changing the receipt.
#[cfg(target_os = "macos")]
pub(super) fn verify_cleanup(engine: &Engine<'_>, receipt: &Receipt) -> Result<(), CandidateError> {
    validate(receipt)?;
    for (name, probe) in &receipt.probes {
        if probe.phase != "retired"
            || inspect_resource(
                engine,
                receipt,
                &receipt.resources[&format!("container:{name}")],
            )?
            .is_some()
            || exec(engine, receipt, name)?
                .is_some_and(|value| value["Running"].as_bool() != Some(false))
        {
            return Err(error(
                "graph_probe_cleanup_uncertain",
                "Probe retirement is not independently confirmed.",
            ));
        }
        let output = engine
            .guest()
            .execute_cleanup(PROBE_ABSENT, &[&path(probe)])?;
        if output != "probe-storage-absent\n" {
            return Err(error(
                "graph_probe_cleanup_uncertain",
                "Probe allocation absence was not confirmed.",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
const PROBE_ABSENT: &str = r#"
test ! -L /run/hack-local
test ! -L /run/hack-local/http-probes
test ! -e "$1"
test ! -L "$1"
printf 'probe-storage-absent\n'
"#;

impl Session<'_, '_> {
    pub(super) fn prepare_probe(&mut self, name: &str) -> Result<(), CandidateError> {
        if !self.receipt.probes.contains_key(name) {
            return Ok(());
        }
        attach(
            self.configs.get_mut(name).unwrap(),
            &self.receipt.probes[name],
        );
        if self.restarting {
            let resource = &self.receipt.resources[&format!("container:{name}")];
            let value = inspect_resource(&self.engine, &self.receipt, resource)?
                .ok_or_else(|| error("graph_probe_identity", "Restart container disappeared."))?;
            Self::verify_config(
                &self.receipt,
                name,
                &self.configs[name],
                &self.expected_environment[name],
                &value,
            )?;
            if !matches!(observation(&value)?, Observation::Exited { .. }) {
                return Err(error(
                    "graph_probe_running",
                    "Restart container is not stopped.",
                ));
            }
        }
        self.reset_probe(name, if self.restarting { "reset" } else { "create" })
    }

    pub(super) fn reset_probe(&mut self, name: &str, action: &str) -> Result<(), CandidateError> {
        if !self.receipt.probes.contains_key(name) {
            return Ok(());
        }
        if action == "reset" {
            if exec(&self.engine, &self.receipt, name)?.is_some_and(|v| v["Running"] == true) {
                return Err(error(
                    "graph_probe_running",
                    "Prior probe is still running.",
                ));
            }
            let p = self.receipt.probes.get_mut(name).unwrap();
            p.generation = token()?;
            p.exec_id = None;
            p.started_ms = 0;
        }
        self.receipt.probes.get_mut(name).unwrap().phase = "allocation-intent".into();
        self.save()?;
        execute(&self.engine, &self.receipt, name, action)?;
        #[cfg(test)]
        self.fault_pause("probe-after-allocation")?;
        self.receipt.probes.get_mut(name).unwrap().phase = "allocated".into();
        self.save()
    }
    pub(super) fn start_probe(&mut self, name: &str, id: &str) -> Result<(), CandidateError> {
        let Some(p) = self.receipt.probes.get_mut(name) else {
            return Ok(());
        };
        if p.phase != "allocated" || p.exec_id.is_some() {
            return Err(error(
                "graph_probe_replay",
                "Probe start cannot be replayed.",
            ));
        }
        p.phase = "exec-intent".into();
        self.save()?;
        let p = &self.receipt.probes[name];
        let mut args = vec!["/run/hack-http-probe".to_owned()];
        args.extend(p.launch_arguments()?);
        let value=self.engine.request(Method::POST,&format!("/v1.53/containers/{id}/exec"),Some(&json!({"AttachStdout":false,"AttachStderr":false,"User":format!("{}:{}",p.uid,p.gid),"Cmd":args})))?;
        #[cfg(test)]
        self.fault_pause("probe-after-exec-create")?;
        let exec_id = value["Id"]
            .as_str()
            .filter(|v| hex(v, 64))
            .ok_or_else(|| error("graph_probe_identity", "Missing created probe identity."))?
            .to_owned();
        let p = self.receipt.probes.get_mut(name).unwrap();
        p.exec_id = Some(exec_id.clone());
        p.started_ms = now()?;
        p.phase = "starting".into();
        self.save()?;
        self.engine.request(
            Method::POST,
            &format!("/v1.53/exec/{exec_id}/start"),
            Some(&json!({"Detach":true,"Tty":false})),
        )?;
        #[cfg(test)]
        self.fault_pause("probe-after-exec-start")?;
        self.receipt.probes.get_mut(name).unwrap().phase = "running".into();
        self.save()
    }
}
const STORAGE: &str = r#"
(
set -eu
umask 077
action="$1"; root="$2"; marker="$3"; uid="$4"; gid="$5"; binary="$6"
parent=/run/hack-local/http-probes
test ! -L "$parent"
if test ! -e "$parent"; then mkdir -m 700 "$parent"; fi
test "$(stat -c %u:%g:%a "$parent")" = 0:0:700
test ! -L "$root"
# Restart has already verified the recorded container is stopped and no prior probe runs.
# Only reconstructible tmpfs state may be recreated; existing paths still need exact ownership.
if test "$action" = create || { test "$action" = reset && test ! -e "$root"; }; then
 test ! -e "$root"
 mkdir -m 700 "$root"
 printf %s "$marker" > "$root/owner"
 chmod 400 "$root/owner"
 mkdir -m 700 "$root/state"
else
 if test ! -e "$root"; then test "$action" = remove; exit 0; fi
fi
test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -L "$root/owner"
test "$(stat -c %u:%g:%a:%h "$root/owner")" = 0:0:400:1
test "$(cat "$root/owner")" = "$marker"
test ! -L "$root/state"
if test "$action" = rearm; then
 test "$(findmnt -n -o FSTYPE --mountpoint "$root/state")" = tmpfs
 state="$root/state"; previous="$7"
 # PROBE_REARM_SAMPLES
 # Fall through to the common confirmation outside this redirected subshell.
else
if findmnt -n --mountpoint "$root/state" >/dev/null; then
 test "$(findmnt -n -o FSTYPE --mountpoint "$root/state")" = tmpfs
 test "$action" != create
 umount "$root/state"
fi
if test "$action" = remove; then
 rmdir "$root/state"
 rm "$root/owner"
 rmdir "$root"
else
 test "$(stat -c %u:%g:%a "$root/state")" = 0:0:700
 test ! -L "$binary"
 test "$(stat -c %u:%g:%a:%h "$binary")" = 0:0:555:1
 test "$(sha256sum "$binary" | cut -d' ' -f1)" = "${binary##*/}"
 mount -t tmpfs -o "size=65536,mode=0700,uid=$uid,gid=$gid,nosuid,nodev,noexec" tmpfs "$root/state"
fi
fi
) >/dev/null 2>&1
printf 'probe-storage-ready
'
"#;
const REARM_SAMPLES: &str = include_str!("probe-rearm-samples.sh");
#[cfg(feature = "native-http-probe")]
pub(super) fn publish(engine: &Engine<'_>) -> Result<String, CandidateError> {
    let bytes = super::super::http_probe::guest_binary();
    let hash = format!("{:x}", crate::Hex(Sha256::digest(bytes)));
    use std::io::Write;
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    compressed.write_all(bytes).map_err(state::io)?;
    let input =
        base64::engine::general_purpose::STANDARD.encode(compressed.finish().map_err(state::io)?);
    if input.len() > 56 * 1024 {
        return Err(error(
            "native_http_probe_budget",
            "Compressed launcher exceeds the bounded transport profile.",
        ));
    }
    let output = engine.guest().execute(PUBLISH, &[&hash], Some(&input))?;
    if output != "launcher-ready-v1\n" {
        return Err(error(
            "native_http_probe",
            "Launcher publication was not confirmed.",
        ));
    }
    Ok(format!("/storage/hack-native-http-probe/{hash}"))
}
#[cfg(feature = "native-http-probe")]
const PUBLISH: &str = r#"
(
set -eu
umask 077
root=/storage/hack-native-http-probe
test ! -L "$root"
if test ! -e "$root"; then mkdir -m 755 "$root"; fi
test "$(stat -c %u:%g:%a "$root")" = 0:0:755
file="$root/$1"
test ! -L "$file"
if test ! -e "$file"; then
 test ! -L "$file.pending"
 if test ! -e "$file.pending"; then base64 -d | gzip -d > "$file.pending"; else cat >/dev/null; fi
 test -f "$file.pending"
 test "$(stat -c %u:%g:%h "$file.pending")" = 0:0:1
 test "$(sha256sum "$file.pending" | cut -d' ' -f1)" = "$1"
 chmod 555 "$file.pending"
 mv "$file.pending" "$file"
else
 cat >/dev/null
fi
test -f "$file"
test "$(stat -c %u:%g:%a:%h "$file")" = 0:0:555:1
test "$(sha256sum "$file" | cut -d' ' -f1)" = "$1"
) >/dev/null 2>&1
printf 'launcher-ready-v1\n'
"#;

#[cfg(not(feature = "native-http-probe"))]
fn publish(_: &Engine<'_>) -> Result<String, CandidateError> {
    Err(error(
        "native_http_unavailable",
        "Native HTTP binary was not built.",
    ))
}

pub(super) fn unchanged(
    configs: &BTreeMap<String, Value>,
    planned: &BTreeMap<String, HttpProbe>,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    if planned.len() != receipt.probes.len() {
        return Err(error(
            "graph_probe_plan",
            "Probe declarations differ from the reviewed plan.",
        ));
    }
    for (name, p) in &receipt.probes {
        if planned.get(name) != Some(&p.config)
            || launcher::identity(&configs[name])? != (p.uid, p.gid)
        {
            return Err(error(
                "graph_probe_plan",
                "Probe configuration differs from the reviewed plan.",
            ));
        }
    }
    Ok(())
}

/// Rearm an admitted route probe after an independently observed container
/// incarnation change. Keep the existing mounted state: reset would unmount it
/// while the running container still holds the old mount. A new random probe
/// generation rejects every old sample. An uncertain exec intent is never replayed.
#[cfg(target_os = "macos")]
pub(super) fn rearm_route(
    engine: &Engine<'_>,
    receipt: &mut Receipt,
    root: &std::path::Path,
    name: &str,
    fence: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    fence()?;
    let resource = receipt
        .resources
        .get(&format!("container:{name}"))
        .ok_or_else(|| error("graph_probe_identity", "Missing owned route container."))?;
    let probe = receipt
        .probes
        .get(name)
        .ok_or_else(|| error("graph_probe_identity", "Missing owned route probe."))?;
    if resource.restart_policy.is_none()
        || resource.routing.is_none()
        || probe.phase != "running"
        || !inactive_exec(exec(engine, receipt, name)?.as_ref())
    {
        return Err(error(
            "graph_probe_replay",
            "Prior route probe is live or uncertain; no rearm was attempted.",
        ));
    }
    rearm_after_inactive(
        receipt,
        root,
        name,
        fence,
        |receipt, previous| execute_with_generation(engine, receipt, name, "rearm", previous),
        |method, path, body| engine.request(method, path, body),
    )
}

/// One non-replayable preparation/create/start protocol after inactive-exec proof.
/// Request dispatch is injected so the actual connection-mode guard is tested.
#[cfg(any(test, target_os = "macos"))]
pub(super) fn rearm_after_inactive(
    receipt: &mut Receipt,
    root: &std::path::Path,
    name: &str,
    fence: &dyn Fn() -> Result<(), CandidateError>,
    prepare: impl FnOnce(&Receipt, &str) -> Result<(), CandidateError>,
    mut request: impl FnMut(Method, &str, Option<&Value>) -> Result<Value, CandidateError>,
) -> Result<(), CandidateError> {
    let id = receipt
        .resources
        .get(&format!("container:{name}"))
        .and_then(|r| r.id.clone())
        .ok_or_else(|| error("graph_probe_identity", "Missing owned route container."))?;
    if receipt
        .probes
        .get(name)
        .is_none_or(|p| p.phase != "running")
    {
        return Err(error(
            "graph_probe_replay",
            "Probe rearm cannot replay an uncertain intent.",
        ));
    }
    fence()?;
    let probe = receipt
        .probes
        .get_mut(name)
        .ok_or_else(|| error("graph_probe_identity", "Missing owned route probe."))?;
    let previous = probe.generation.clone();
    probe.generation = token()?;
    probe.exec_id = None;
    probe.started_ms = 0;
    probe.phase = "exec-intent".into();
    state::write(&root.join("state.json"), receipt)?;
    fence()?;
    prepare(receipt, &previous)?;
    fence()?;
    let probe = &receipt.probes[name];
    let mut args = vec!["/run/hack-http-probe".to_owned()];
    args.extend(probe.launch_arguments()?);
    let value = request(
        Method::POST,
        &format!("/v1.53/containers/{id}/exec"),
        Some(
            &json!({"AttachStdout":false,"AttachStderr":false,"User":format!("{}:{}",probe.uid,probe.gid),"Cmd":args}),
        ),
    )?;
    let exec_id = value["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(|| error("graph_probe_identity", "Missing created probe identity."))?
        .to_owned();
    fence()?;
    let probe = receipt
        .probes
        .get_mut(name)
        .ok_or_else(|| error("graph_probe_identity", "Missing owned route probe."))?;
    probe.exec_id = Some(exec_id.clone());
    probe.started_ms = now()?;
    probe.phase = "starting".into();
    state::write(&root.join("state.json"), receipt)?;
    fence()?;
    request(
        Method::POST,
        &format!("/v1.53/exec/{exec_id}/start"),
        Some(&json!({"Detach":true,"Tty":false})),
    )?;
    fence()?;
    receipt
        .probes
        .get_mut(name)
        .ok_or_else(|| error("graph_probe_identity", "Missing owned route probe."))?
        .phase = "running".into();
    state::write(&root.join("state.json"), receipt)
}

#[cfg(test)]
mod storage_tests {
    use super::STORAGE;
    use std::{fs, process::Command};

    #[cfg(target_os = "linux")]
    #[test]
    fn complete_rearm_storage_script_confirms_success_once_and_never_confirms_refusal() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let fixture = super::super::tests::Fixture::new();
        let parent = fixture.0.join("http-probes");
        let root = parent.join("allocation");
        let state = root.join("state");
        let tools = fixture.0.join("tools");
        for path in [&parent, &root, &state, &tools] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(root.join("owner"), "synthetic-probe-owner").unwrap();
        fs::set_permissions(root.join("owner"), fs::Permissions::from_mode(0o400)).unwrap();
        fs::write(state.join("lock"), "").unwrap();
        fs::set_permissions(state.join("lock"), fs::Permissions::from_mode(0o600)).unwrap();
        let findmnt = r#"#!/bin/sh
set -eu
test "$#" = 5
test "$1" = -n; test "$2" = -o; test "$3" = FSTYPE
test "$4" = --mountpoint; test "$5" = "$HACK_TEST_PROBE_STATE"
printf 'tmpfs\n'
"#;
        for (name, program) in [
            ("findmnt", findmnt),
            ("mount", "#!/bin/sh\nexit 99\n"),
            ("umount", "#!/bin/sh\nexit 99\n"),
        ] {
            let path = tools.join(name);
            fs::write(&path, program).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let metadata = fs::metadata(&root).unwrap();
        let uid = metadata.uid();
        let gid = metadata.gid();
        // Run the complete production template and fragment, including its
        // subshell/redirection/footer. Only guest root UID and mount observation
        // are adapted; this test performs no mount and claims no VM proof.
        let script = STORAGE
            .replace("# PROBE_REARM_SAMPLES", super::REARM_SAMPLES)
            .replace("parent=/run/hack-local/http-probes", "parent=\"$8\"")
            .replace("= 0:0:700", &format!("= {uid}:{gid}:700"))
            .replace("= 0:0:400:1", &format!("= {uid}:{gid}:400:1"));
        let previous = "a".repeat(32);
        let invoke = || {
            Command::new("/bin/sh")
                .args(["-eu", "-c", &script, "probe-storage-contract", "rearm"])
                .arg(&root)
                .arg("synthetic-probe-owner")
                .arg(uid.to_string())
                .arg(gid.to_string())
                .arg("/nonexistent/probe")
                .arg(&previous)
                .arg(&parent)
                .env("PATH", format!("{}:/usr/bin:/bin", tools.display()))
                .env("HACK_TEST_PROBE_STATE", &state)
                .output()
                .unwrap()
        };
        let inode = fs::metadata(&state).unwrap().ino();
        for pending in ["", "v1 partial sample"] {
            for (name, value) in [
                ("status", format!("v1 {previous} 1 1 0 1000 1\n")),
                ("first-sample", format!("v1 {previous} 1 1 0 1000 1\n")),
                ("status.pending", pending.into()),
            ] {
                let path = state.join(name);
                fs::write(&path, value).unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            let result = invoke();
            assert!(result.status.success(), "{result:?}");
            assert_eq!(result.stdout, b"probe-storage-ready\n");
            assert!(result.stderr.is_empty());
            assert_eq!(fs::metadata(&state).unwrap().ino(), inode);
            for name in ["status", "first-sample", "status.pending"] {
                assert!(!state.join(name).exists());
            }
            let refused = invoke();
            assert!(!refused.status.success());
            assert!(refused.stdout.is_empty());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recovery_probe_exec_requires_explicit_nonrunning_observation() {
        use serde_json::json;
        assert!(super::inactive_exec(None));
        assert!(super::inactive_exec(Some(&json!({"Running":false}))));
        for observed in [
            json!({}),
            json!({"Running":null}),
            json!({"Running":"false"}),
            json!({"Running":true}),
        ] {
            assert!(!super::inactive_exec(Some(&observed)));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn absence_observation_refuses_live_and_dangling_allocations_without_writes() {
        use std::os::unix::fs::{MetadataExt, symlink};
        let parent = crate::unique_test_root(&std::env::temp_dir(), "probe-absence");
        let allocation = parent.join("allocation");
        let invoke = || {
            Command::new("/bin/sh")
                .args(["-eu", "-c", super::PROBE_ABSENT, "probe-observation"])
                .arg(&allocation)
                .output()
                .unwrap()
        };
        let absent = invoke();
        assert!(absent.status.success());
        assert_eq!(absent.stdout, b"probe-storage-absent\n");
        assert!(!allocation.exists());
        fs::create_dir(&allocation).unwrap();
        fs::write(allocation.join("sentinel"), b"preserved").unwrap();
        let before = fs::metadata(&allocation).unwrap();
        let present = invoke();
        assert!(!present.status.success());
        assert!(present.stdout.is_empty());
        let after = fs::metadata(&allocation).unwrap();
        assert_eq!(
            (before.ino(), before.mtime(), before.mtime_nsec()),
            (after.ino(), after.mtime(), after.mtime_nsec())
        );
        assert_eq!(fs::read(allocation.join("sentinel")).unwrap(), b"preserved");
        fs::remove_file(allocation.join("sentinel")).unwrap();
        fs::remove_dir(&allocation).unwrap();
        symlink(parent.join("missing"), &allocation).unwrap();
        assert!(!invoke().status.success());
        assert!(
            fs::symlink_metadata(&allocation)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_file(&allocation).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn reset_recreates_missing_probe_storage_without_overwriting_existing_state() {
        let branch = STORAGE
            .split("if test \"$action\" = create ||")
            .nth(1)
            .unwrap()
            .split("test \"$(stat -c %u:%g:%a \"$root\")\"")
            .next()
            .unwrap();
        let script = format!(
            "set -eu\numask 077\nroot=$1; action=$2; marker=probe-fixture\nif test \"$action\" = create ||{branch}"
        );
        let parent = crate::unique_test_root(&std::env::temp_dir(), "probe-reset");
        let root = parent.join("allocation");
        let invoke = |action: &str| {
            Command::new("/bin/sh")
                .args(["-c", &script, "probe-storage-test"])
                .arg(&root)
                .arg(action)
                .output()
                .unwrap()
                .status
                .success()
        };
        assert!(invoke("reset"));
        assert!(root.join("state").is_dir());
        assert_eq!(
            fs::read_to_string(root.join("owner")).unwrap(),
            "probe-fixture"
        );
        fs::write(root.join("state/sentinel"), "retained").unwrap();
        assert!(invoke("reset"));
        assert!(!invoke("create"));
        assert_eq!(
            fs::read_to_string(root.join("state/sentinel")).unwrap(),
            "retained"
        );
        // This test covers the allocation branch; the full guest path additionally checks
        // ownership and mount identity before reset can touch an existing allocation.
        fs::remove_dir_all(parent).unwrap();
    }
}
