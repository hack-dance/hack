//! Exact same-boot cleanup after a failed container start and an interrupted
//! enrolled cleanup. The old coordinator effect is observed, never executed again.
use super::*;
use crate::provider::{
    environment_recovery::GraphInventory,
    relay_owner::{
        lifecycle_intent::{Inspection, Phase},
        publication::dead,
    },
};
use sha2::{Digest, Sha256};
use std::path::Path;

mod recovery;
#[cfg(test)]
mod tests;

const JOURNAL: &str = "interrupted-start-cleanup.json";
const LIMIT: u64 = 2 * 1024 * 1024;

fn refused() -> CandidateError {
    error(
        "graph_interrupted_start_cleanup",
        "Interrupted start cleanup selection, owner or resource state changed; no effect was replayed.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn no_pending(root: &Path) -> Result<(), CandidateError> {
    state::check_private_directory(root)?;
    for entry in fs::read_dir(root).map_err(state::io)? {
        let name = entry.map_err(state::io)?.file_name();
        if name
            .to_str()
            .is_none_or(|value| value.ends_with(".pending"))
        {
            return Err(refused());
        }
    }
    for name in [
        "one-off.json",
        "one-off-normalization.json",
        "retired-data-removal.json",
    ] {
        match fs::symlink_metadata(root.join(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
    }
    Ok(())
}
fn journal(root: &Path) -> Result<Option<recovery::Journal>, CandidateError> {
    let path = root.join(JOURNAL);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(state::io(e)),
        Ok(_) => state::read_bounded(&path, LIMIT).map(Some),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u8,
    run: String,
    owner: String,
    boot: String,
    receipt_sha256: String,
    coordinator_sha256: String,
    coordinator_identity_sha256: String,
    foreground_sha256: String,
    relay_sha256: String,
    bridge_sha256: String,
    environment_sha256: String,
    reservation_sha256: String,
    failed_key: String,
    failed_id: String,
}
impl Selection {
    fn digest(&self) -> Result<String, CandidateError> {
        Ok(digest(&serde_json::to_vec(self).map_err(|_| refused())?))
    }
}

struct Proof<'a> {
    candidate: &'a Candidate,
    owner: foreground::transport::DeadOwner,
    engine: Engine<'a>,
    relay: dead::CleanupWitness,
    relay_owner: [u8; 16],
    relay_publication: [u8; 32],
    root: PathBuf,
    current: Receipt,
    original: Receipt,
    bridges: bridges::cleanup::Selection,
    environment: GraphInventory,
    selected: Selection,
}
impl Proof<'_> {
    fn verify(&self) -> Result<(), CandidateError> {
        self.owner.verify_retirement_ready()?;
        self.relay.verify()?;
        if self.relay.selection_sha256()? != self.selected.relay_sha256 {
            return Err(refused());
        }
        self.engine.guest().verify()?;
        no_pending(&self.root)?;
        let (current, root) = load(self.candidate, &self.engine, &self.selected.run)?;
        let context = host_relay::context(&self.selected.owner, &self.selected.boot)?;
        let marker = current.relay_cleanup.as_ref().ok_or_else(refused)?;
        if root != self.root
            || !["cleanup-intent", "stopped-data-retained"].contains(&current.phase.as_str())
            || dead_owner_cleanup::immutable(&current)?
                != dead_owner_cleanup::immutable(&self.original)?
            || current.owner != self.selected.owner
            || self.engine.guest().boot_id() != self.selected.boot
            || marker.phase != cleanup_enrollment::Phase::Pending
            || !marker.valid()
            || marker.runtime != context.runtime
            || marker.boot != context.boot
            || marker.control_root
                != self
                    .original
                    .relay_cleanup
                    .as_ref()
                    .ok_or_else(refused)?
                    .control_root
            || marker.operation
                != self
                    .original
                    .relay_cleanup
                    .as_ref()
                    .ok_or_else(refused)?
                    .operation
            || marker.effect
                != self
                    .original
                    .relay_cleanup
                    .as_ref()
                    .ok_or_else(refused)?
                    .effect
        {
            return Err(refused());
        }
        startup::require_dependency_rebind_complete(&root, &current)?;
        initializer_cache::require_resolved(&current)?;
        if serde_json::to_value(environment::cleanup_inventory(
            self.candidate,
            &self.engine,
            &current,
            &root,
        )?)
        .map_err(|_| refused())?
            != serde_json::to_value(&self.environment).map_err(|_| refused())?
        {
            return Err(refused());
        }
        if digest(&host_pin_recovery::read_raw(
            &root.join("relay-cleanup-bridges.json"),
            65536,
        )?) != self.selected.bridge_sha256
        {
            return Err(refused());
        }
        bridges::cleanup::verify_recovery(
            self.candidate,
            &self.engine,
            &current,
            &self.bridges,
            None,
        )?;
        verify_retained_volumes(&self.engine, &current)?;
        let failed = current
            .resources
            .get(&self.selected.failed_key)
            .ok_or_else(refused)?;
        if let Some(value) = inspect_resource(&self.engine, &current, failed)? {
            failed_created(failed, &value)?;
        }
        Ok(())
    }
}

fn retained_volume_observation(
    receipt: &Receipt,
    resource: &Resource,
    observed: Option<&Value>,
) -> Result<(), CandidateError> {
    let value = observed.ok_or_else(refused)?;
    if resource.kind != Kind::Volume
        || resource.phase != "created"
        || value["CreatedAt"].as_str().is_none_or(str::is_empty)
    {
        return Err(refused());
    }
    match (&resource.cache, &resource.cache_provenance) {
        (None, None) => Ok(()),
        (Some(cache), Some(provenance))
            if cache.valid()
                && resource.name == cache.name()
                && provenance.valid(receipt, resource) =>
        {
            Ok(())
        }
        _ => Err(refused()),
    }
}

fn verify_retained_volume(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<(), CandidateError> {
    let observed = inspect_resource(engine, receipt, resource)?;
    retained_volume_observation(receipt, resource, observed.as_ref())?;
    cache_provenance::verify(engine, receipt, resource)
}

pub(super) fn verify_retained_volumes(
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    for resource in receipt
        .resources
        .values()
        .filter(|resource| resource.kind == Kind::Volume)
    {
        verify_retained_volume(engine, receipt, resource)?;
    }
    Ok(())
}

fn failed_created(resource: &Resource, value: &Value) -> Result<(), CandidateError> {
    let state = &value["State"];
    let prepared = shutdown::prepare(resource, value)?;
    if resource.kind != Kind::Container
        || resource.id.as_deref() != Some(prepared.id.as_str())
        || prepared.running
        || state["Status"] != "created"
        || !state["ExitCode"]
            .as_u64()
            .is_some_and(|n| (1..=255).contains(&n))
        || state["Pid"] != 0
        || state["OOMKilled"] != false
        || value["RestartCount"] != 0
        || !state["StartedAt"]
            .as_str()
            .is_some_and(|s| s.starts_with("0001-"))
    {
        return Err(refused());
    }
    Ok(())
}

fn failed_start(
    receipt: &Receipt,
    engine: &Engine<'_>,
) -> Result<(String, String), CandidateError> {
    let mut failed = None;
    for (key, resource) in &receipt.resources {
        if resource.kind != Kind::Container {
            continue;
        }
        let observed = inspect_resource(engine, receipt, resource)?;
        let Some(value) = observed else {
            if resource.id.is_some() || resource.phase != "reserved" {
                return Err(refused());
            }
            continue;
        };
        if resource.id.as_deref() != value["Id"].as_str() {
            return Err(refused());
        }
        let state = &value["State"];
        let prepared = shutdown::prepare(resource, &value)?;
        let restart_count = value["RestartCount"].as_u64().ok_or_else(refused)?;
        if restart_count != 0 {
            return Err(refused());
        }
        if state["Status"] == "created"
            && state["ExitCode"]
                .as_u64()
                .is_some_and(|n| (1..=255).contains(&n))
        {
            if failed.is_some()
                || resource.phase != "uncertain"
                || failed_created(resource, &value).is_err()
            {
                return Err(refused());
            }
            failed = Some((key.clone(), resource.id.clone().ok_or_else(refused)?));
        } else if prepared.running {
            if resource.phase != "started"
                || !state["FinishedAt"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("0001-"))
            {
                return Err(refused());
            }
        } else if state["Status"] != "exited"
            || state["ExitCode"] != 0
            || receipt.readiness.get(&resource.key) != Some(&Condition::Completed)
        {
            return Err(refused());
        }
    }
    failed.ok_or_else(refused)
}

fn no_current_shutdown(root: &Path, receipt: &Receipt) -> Result<(), CandidateError> {
    let path = root.join("shutdown.json");
    if !path.exists() && !path.is_symlink() {
        return Ok(());
    }
    let value: Value = state::read_bounded(&path, 64 * 1024)?;
    if value["version"] != 1
        || value["run"] != receipt.run
        || value["owner"] != receipt.owner
        || value["plan"] != receipt.plan_id
    {
        return Err(refused());
    }
    let records = value["containers"].as_object().ok_or_else(refused)?;
    if records.len() > MAX_SERVICES
        || records.iter().any(|(key, terminal)| {
            !receipt
                .resources
                .get(key)
                .is_some_and(|r| r.kind == Kind::Container)
                || !terminal["id"].as_str().is_some_and(|id| hex(id, 64))
                || receipt.resources[key].id.as_deref() == terminal["id"].as_str()
        })
    {
        return Err(refused());
    }
    Ok(())
}

fn select<'a>(candidate: &'a Candidate, run: &str) -> Result<Proof<'a>, CandidateError> {
    let prior_root = directory(candidate, run)?;
    let existing = journal(&prior_root)?;
    let reservation_sha256 = if let Some(prior) = &existing {
        prior.selection.reservation_sha256.clone()
    } else {
        let inventory = dependency_slots::inspect(candidate)?;
        let records = inventory["reservations"].as_array().ok_or_else(refused)?;
        let matches = records
            .iter()
            .filter(|value| value["run"] == run)
            .collect::<Vec<_>>();
        if matches.len() != 1 || matches[0]["owner_alive"] != false {
            return Err(refused());
        }
        matches[0]["reservation"]
            .as_str()
            .filter(|value| hex(value, 64))
            .ok_or_else(refused)?
            .to_owned()
    };
    let owner = foreground::transport::DeadOwner::acquire(candidate, run)?;
    owner.verify_retirement_ready()?;
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (current, root) = load(candidate, &engine, run)?;
    no_pending(&root)?;
    let prior = journal(&root)?;
    if serde_json::to_value(&prior).map_err(|_| refused())?
        != serde_json::to_value(&existing).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let original = prior
        .as_ref()
        .map_or_else(|| current.clone(), |j| j.original.clone());
    if let Some(record) = &prior {
        record.validate_phase(&current)?;
    }
    if current.relay_startup.is_none()
        || current.normalized_input.is_none()
        || current
            .relay_cleanup
            .as_ref()
            .is_none_or(|m| m.phase != cleanup_enrollment::Phase::Pending)
        || !["cleanup-intent", "stopped-data-retained"].contains(&current.phase.as_str())
        || (prior.is_none() && current.phase != "cleanup-intent")
        || dead_owner_cleanup::immutable(&current)? != dead_owner_cleanup::immutable(&original)?
    {
        return Err(refused());
    }
    let receipt_bytes = host_pin_recovery::read_raw(&root.join("state.json"), LIMIT)?;
    let original_sha256 = digest(&serde_json::to_vec_pretty(&original).map_err(|_| refused())?);
    if prior.is_none() && digest(&receipt_bytes) != original_sha256 {
        return Err(refused());
    }
    let marker = current.relay_cleanup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(&current.owner, engine.guest().boot_id())?;
    let relay = dead::CleanupWitness::acquire(&marker.control_root, context, owner.process())?;
    let relay_sha256 = relay.selection_sha256()?;
    let inspected = Inspection::load(&marker.control_root, context)?;
    let present_identity = relay.present_identity();
    if inspected.phase != Phase::EffectStarted
        || !inspected.acknowledgement_pending
        || !inspected.selection_observed
        || inspected.graph != Some(host_relay::graph_scope(context, run)?)
        || inspected.selection.operation != marker.operation
        || inspected.selection.effect != marker.effect
        || inspected.selection.context != context
        || inspected.owner == [0; 16]
        || &inspected.process != owner.process()
        || inspected.publication == [0; 32]
        || present_identity.is_some_and(|(relay_owner, relay_publication)| {
            inspected.owner != relay_owner || inspected.publication != relay_publication
        })
    {
        return Err(refused());
    }
    let coordinator_sha256 = digest(&host_pin_recovery::read_raw(
        &marker.control_root.join("relay-lifecycle/state.json"),
        128 * 1024,
    )?);
    let bridges = bridges::cleanup::read(&engine, &original, &root)?;
    bridges::cleanup::verify_recovery(candidate, &engine, &current, &bridges, None)?;
    let bridge_sha256 = digest(&host_pin_recovery::read_raw(
        &root.join("relay-cleanup-bridges.json"),
        65536,
    )?);
    let environment = environment::cleanup_inventory(candidate, &engine, &original, &root)?;
    let environment_sha256 = digest(&serde_json::to_vec(&environment).map_err(|_| refused())?);
    if host_relay::cleanup_effect(
        &original,
        engine.guest().boot_id(),
        false,
        &(&environment, &bridges),
    )? != marker.effect
    {
        return Err(refused());
    }
    let (failed_key, failed_id) = if let Some(j) = &prior {
        (
            j.selection.failed_key.clone(),
            j.selection.failed_id.clone(),
        )
    } else {
        no_current_shutdown(&root, &original)?;
        failed_start(&original, &engine)?
    };
    let selected = Selection {
        version: 1,
        run: run.into(),
        owner: current.owner.clone(),
        boot: engine.guest().boot_id().into(),
        receipt_sha256: original_sha256,
        coordinator_sha256,
        coordinator_identity_sha256: inspected.recovery_fingerprint,
        foreground_sha256: owner.fingerprint(),
        relay_sha256,
        bridge_sha256,
        environment_sha256,
        reservation_sha256,
        failed_key,
        failed_id,
    };
    if prior.as_ref().is_some_and(|j| {
        j.selection != selected || j.selection.digest().ok() != Some(j.selection_sha256.clone())
    }) {
        return Err(refused());
    }
    let proof = Proof {
        candidate,
        owner,
        engine,
        relay,
        relay_owner: inspected.owner,
        relay_publication: inspected.publication,
        root,
        current,
        original,
        bridges,
        environment,
        selected,
    };
    proof.verify()?;
    Ok(proof)
}

/// Read-only, value-free selection for exactly one interrupted failed start.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let root = directory(candidate, run)?;
    if let Some(record) = journal(&root)? {
        record.validate_basic(run, &record.selection_sha256)?;
        if record.graph_complete {
            return recovery::inspect_completed(candidate, run, &record);
        }
    }
    let proof = select(candidate, run)?;
    if let Some(journal) = journal(&proof.root)? {
        recovery::validate_retry(&proof, &journal)?;
    }
    Ok(
        json!({"run":run,"phase":proof.current.phase,"eligible":true,
        "selection_sha256":proof.selected.digest()?,"data_retained":true,"same_boot":true}),
    )
}

/// Presentation hint only. The exact selected recovery still performs every
/// native proof before any effect; a malformed journal blocks inspection.
pub(super) fn incomplete(root: &Path, run: &str) -> Result<bool, CandidateError> {
    let Some(record) = journal(root)? else {
        return Ok(false);
    };
    record.validate_basic(run, &record.selection_sha256)?;
    Ok(!record.reservation_released)
}

/// Recover only a selected same-boot failed start, retaining every named volume.
pub fn recover(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    if !hex(expected, 64) {
        return Err(refused());
    }
    recovery::recover(candidate, run, expected)
}
