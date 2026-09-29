//! Value-free validation around the caller-owned, bounded Docker stop phase.
//!
//! The caller must independently verify graph ownership before preparing and
//! after stopping. These helpers never infer guest death from transport success,
//! delete resources, retry a stop, or convert a missing observation into success.
use super::{CandidateError, Engine, Kind, Receipt, Resource, error, hex, inspect_resource, state};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Prepared {
    pub(super) id: String,
    pub(super) grace_seconds: u32,
    pub(super) running: bool,
}

/// Terminal evidence is an observation, not proof of graceful application exit.
/// Nonzero exit and OOM are retained so the caller cannot report them as success.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Terminal {
    pub(super) id: String,
    pub(super) exit_code: u8,
    pub(super) oom_killed: bool,
    pub(super) stop_requested: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    version: u8,
    run: String,
    owner: String,
    plan: String,
    containers: BTreeMap<String, Terminal>,
}

/// Stop all preflighted containers in one bounded transport phase. The receipt
/// lacks dependency topology, so this does not promise reverse dependency order.
/// Terminal records are descriptive only: later cleanup always inspects live
/// ownership again. A record can describe a prior container generation until a
/// new observation replaces it; readers must match immutable IDs.
pub(super) fn stop_owned(
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &Path,
) -> Result<(), CandidateError> {
    super::journal::retain_file(root, "shutdown.pending", "shutdown-recovery", 64 * 1024)?;
    let path = root.join("shutdown.json");
    let mut evidence: Evidence = if path.exists() || path.is_symlink() {
        state::read(&path)?
    } else {
        Evidence {
            version: 1,
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            plan: receipt.plan_id.clone(),
            containers: BTreeMap::new(),
        }
    };
    if evidence.version != 1
        || evidence.run != receipt.run
        || evidence.owner != receipt.owner
        || evidence.plan != receipt.plan_id
        || evidence.containers.len() > super::MAX_SERVICES
        || evidence.containers.iter().any(|(key, value)| {
            !hex(&value.id, 64)
                || !receipt
                    .resources
                    .get(key)
                    .is_some_and(|r| r.kind == Kind::Container)
        })
    {
        return Err(refused());
    }
    let mut selected = Vec::new();
    for resource in receipt
        .resources
        .values()
        .filter(|r| r.kind == Kind::Container)
    {
        if let Some(value) = inspect_resource(engine, receipt, resource)? {
            selected.push((resource, prepare(resource, &value)?));
        }
    }
    let stops = selected
        .iter()
        .filter(|(_, p)| p.running)
        .map(|(_, p)| (p.id.clone(), u64::from(p.grace_seconds)))
        .collect::<Vec<_>>();
    engine.stop_containers(&stops)?;
    // No container deletion is authorized until every selected instance has a
    // fresh matching terminal observation and that evidence is durable.
    for (resource, prepared) in selected {
        let value = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
        let terminal = terminal(resource, &value, prepared.running)?;
        if terminal.id != prepared.id {
            return Err(refused());
        }
        record(
            &mut evidence,
            format!("container:{}", resource.key),
            terminal,
        );
    }
    state::write(&path, &evidence)
}

// Preserve a committed stop observation across cleanup retries, but never carry
// that claim into a different immutable container generation.
fn record(evidence: &mut Evidence, key: String, mut observed: Terminal) {
    if let Some(previous) = evidence.containers.get(&key) {
        observed.stop_requested |= previous.id == observed.id && previous.stop_requested;
    }
    evidence.containers.insert(key, observed);
}

#[cfg(test)]
mod native_test;

fn refused() -> CandidateError {
    error(
        "graph_shutdown_uncertain",
        "Container shutdown identity, state or bounded stop policy is uncertain.",
    )
}

fn signal_valid(value: &Value) -> bool {
    let Some(signal) = value.as_str() else {
        return value.is_null();
    };
    // Absent/empty means Docker's default SIGTERM; an image can specify a signal.
    if signal.is_empty() {
        return true;
    }
    if let Ok(number) = signal.parse::<u8>() {
        return (1..=64).contains(&number) && number.to_string() == signal;
    }
    let name = signal.strip_prefix("SIG").unwrap_or(signal);
    matches!(
        name,
        "HUP"
            | "INT"
            | "QUIT"
            | "ILL"
            | "TRAP"
            | "ABRT"
            | "IOT"
            | "BUS"
            | "FPE"
            | "KILL"
            | "USR1"
            | "SEGV"
            | "USR2"
            | "PIPE"
            | "ALRM"
            | "TERM"
            | "STKFLT"
            | "CHLD"
            | "CLD"
            | "CONT"
            | "STOP"
            | "TSTP"
            | "TTIN"
            | "TTOU"
            | "URG"
            | "XCPU"
            | "XFSZ"
            | "VTALRM"
            | "PROF"
            | "WINCH"
            | "IO"
            | "POLL"
            | "PWR"
            | "SYS"
            | "UNUSED"
    )
}

/// Parse an ownership-verified observation before any stop requests are issued.
/// All selected containers should pass this preflight before the first effect.
/// A missing journal ID is recoverable only after the caller verifies the observed
/// labels/name/image; retain the returned ID across the effect and reinspection.
pub(super) fn prepare(resource: &Resource, inspected: &Value) -> Result<Prepared, CandidateError> {
    let id = inspected["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(refused)?;
    if resource.kind != Kind::Container
        || resource
            .id
            .as_deref()
            .is_some_and(|recorded| recorded != id)
    {
        return Err(refused());
    }
    let grace_seconds = inspected["Config"]["StopTimeout"]
        .as_u64()
        .filter(|value| *value <= 30)
        .ok_or_else(refused)? as u32;
    if !signal_valid(&inspected["Config"]["StopSignal"]) {
        return Err(refused());
    }
    let state = &inspected["State"];
    if state["Paused"].as_bool() != Some(false)
        || state["Restarting"].as_bool() != Some(false)
        || state["Dead"].as_bool() != Some(false)
        || state["OOMKilled"].as_bool().is_none()
        || state["ExitCode"]
            .as_u64()
            .filter(|code| *code <= 255)
            .is_none()
    {
        return Err(refused());
    }
    let running = state["Running"].as_bool().ok_or_else(refused)?;
    let pid = state["Pid"]
        .as_u64()
        .filter(|pid| *pid <= i32::MAX as u64)
        .ok_or_else(refused)?;
    match (running, state["Status"].as_str(), pid) {
        (true, Some("running"), 1..) => {}
        (false, Some("exited"), 0) => {}
        (false, Some("created"), 0) if state["ExitCode"] == 0 && state["OOMKilled"] == false => {}
        _ => return Err(refused()),
    }
    Ok(Prepared {
        id: id.into(),
        grace_seconds,
        running,
    })
}

/// Require a fresh ownership-verified terminal observation after the stop phase.
/// `stop_requested` is supplied from this operation, never inferred from exit code.
/// The caller must also compare the returned ID to its retained `Prepared.id`,
/// including when a pre-create journal did not yet contain the resource ID.
pub(super) fn terminal(
    resource: &Resource,
    inspected: &Value,
    stop_requested: bool,
) -> Result<Terminal, CandidateError> {
    let prepared = prepare(resource, inspected)?;
    if prepared.running || (stop_requested && inspected["State"]["Status"] == "created") {
        return Err(refused());
    }
    Ok(Terminal {
        id: prepared.id,
        exit_code: inspected["State"]["ExitCode"]
            .as_u64()
            .ok_or_else(refused)? as u8,
        oom_killed: inspected["State"]["OOMKilled"]
            .as_bool()
            .ok_or_else(refused)?,
        stop_requested,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interrupted_evidence_is_retained_and_retry_preserves_only_matching_stop_identity() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let fixture = super::super::tests::Fixture::new();
        let path = fixture.0.join("shutdown.json");
        let mut evidence = Evidence {
            version: 1,
            run: "run".into(),
            owner: "owner".into(),
            plan: "plan".into(),
            containers: BTreeMap::new(),
        };
        let observed = Terminal {
            id: "a".repeat(64),
            exit_code: 0,
            oom_killed: false,
            stop_requested: true,
        };
        record(&mut evidence, "container:service".into(), observed.clone());
        state::write(&path, &evidence).unwrap();
        // A committed observation survives a crash before deletion and an
        // interrupted replacement. Pending bytes are retained, never decoded.
        let pending = fixture.0.join("shutdown.pending");
        fs::write(&pending, b"{torn").unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        let retained = super::super::journal::retain_file(
            &fixture.0,
            "shutdown.pending",
            "shutdown-recovery",
            64 * 1024,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            fs::read(retained.join("interrupted.pending")).unwrap(),
            b"{torn"
        );
        let mut recovered: Evidence = state::read(&path).unwrap();
        let mut fresh = observed;
        fresh.stop_requested = false;
        fresh.exit_code = 137;
        fresh.oom_killed = true;
        record(&mut recovered, "container:service".into(), fresh.clone());
        state::write(&path, &recovered).unwrap();
        let committed: Evidence = state::read(&path).unwrap();
        let terminal = &committed.containers["container:service"];
        assert!(terminal.stop_requested);
        assert_eq!(terminal.exit_code, 137);
        assert!(terminal.oom_killed);
        fresh.id = "b".repeat(64);
        record(&mut recovered, "container:service".into(), fresh);
        assert!(!recovered.containers["container:service"].stop_requested);
        assert_eq!(recovered.containers.len(), 1);
    }

    fn fixture() -> (Resource, Value) {
        let resource = Resource {
            routing: None,
            networks: None,
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind: Kind::Container,
            key: "service".into(),
            name: "owned-service".into(),
            id: Some("a".repeat(64)),
            image: Some(format!("sha256:{}", "b".repeat(64))),
            phase: "started".into(),
        };
        let value = json!({"Id":resource.id,"Config":{"StopTimeout":10,"StopSignal":"SIGTERM"},
            "State":{"Running":true,"Status":"running","Pid":42,"Paused":false,
            "Restarting":false,"Dead":false,"OOMKilled":false,"ExitCode":0}});
        (resource, value)
    }

    #[test]
    fn validates_policy_boundaries_and_exact_immutable_identity() {
        let (mut resource, mut value) = fixture();
        for grace in [0, 30] {
            value["Config"]["StopTimeout"] = json!(grace);
            assert_eq!(prepare(&resource, &value).unwrap().grace_seconds, grace);
        }
        for invalid in [json!(-1), json!(31), json!(null), json!("10"), json!(1.5)] {
            value["Config"]["StopTimeout"] = invalid;
            assert!(prepare(&resource, &value).is_err());
        }
        value["Config"]["StopTimeout"] = json!(10);
        value["Id"] = json!("c".repeat(64));
        assert!(prepare(&resource, &value).is_err());
        value["Id"] = json!("a".repeat(64));
        resource.id = None;
        assert_eq!(prepare(&resource, &value).unwrap().id, "a".repeat(64));
        value["Id"] = json!("invalid");
        assert!(prepare(&resource, &value).is_err());
    }

    #[test]
    fn refuses_uncertain_or_contradictory_process_state() {
        let (resource, value) = fixture();
        for (field, invalid) in [
            ("Paused", json!(true)),
            ("Restarting", json!(true)),
            ("Dead", json!(true)),
            ("Pid", json!(0)),
            ("Pid", json!(-1)),
            ("Status", json!("exited")),
            ("Running", json!(null)),
            ("OOMKilled", json!(null)),
            ("ExitCode", json!(256)),
        ] {
            let mut changed = value.clone();
            changed["State"][field] = invalid;
            assert!(prepare(&resource, &changed).is_err(), "{field}");
        }
        assert!(terminal(&resource, &value, true).is_err());
    }

    #[test]
    fn retains_exit_and_oom_evidence_without_claiming_graceful_exit() {
        let (resource, mut value) = fixture();
        value["State"]["Running"] = json!(false);
        value["State"]["Status"] = json!("exited");
        value["State"]["Pid"] = json!(0);
        value["State"]["ExitCode"] = json!(137);
        value["State"]["OOMKilled"] = json!(true);
        let evidence = terminal(&resource, &value, true).unwrap();
        assert_eq!(evidence.exit_code, 137);
        assert!(evidence.oom_killed && evidence.stop_requested);
        assert!(!terminal(&resource, &value, false).unwrap().stop_requested);
    }

    #[test]
    fn created_is_terminal_only_without_a_claimed_stop() {
        let (resource, mut value) = fixture();
        value["State"]["Running"] = json!(false);
        value["State"]["Status"] = json!("created");
        value["State"]["Pid"] = json!(0);
        assert!(!prepare(&resource, &value).unwrap().running);
        assert_eq!(terminal(&resource, &value, false).unwrap().exit_code, 0);
        assert!(terminal(&resource, &value, true).is_err());
        value["State"]["Pid"] = json!(42);
        assert!(terminal(&resource, &value, false).is_err());
    }

    #[test]
    fn accepts_docker_defaults_and_known_signals_rejects_malformed_policy() {
        for signal in [
            json!(null),
            json!(""),
            json!("SIGTERM"),
            json!("WINCH"),
            json!("64"),
        ] {
            assert!(signal_valid(&signal));
        }
        for signal in [
            json!(false),
            json!(9),
            json!("0"),
            json!("65"),
            json!("09"),
            json!("TERM\n"),
            json!("INVALID"),
        ] {
            assert!(!signal_valid(&signal));
        }
    }
}
