//! Same-boot owner-death recovery. This is deliberately independent of the
//! previous-boot recovery contract and never manufactures a Coordinator ACK.
use super::*;
use crate::provider::relay_owner::publication::dead;
use sha2::{Digest, Sha256};
use std::path::Path;
mod relay;
const FILE: &str = "live-owner-cleanup.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    boot: String,
    original: Receipt,
    original_sha256: String,
    foreground_sha256: String,
    relay: relay::Selection,
    environment: Value,
    bridges: bridges::cleanup::Selection,
    prior_bridges: Option<Value>,
    listeners_retired: bool,
    complete_sha256: Option<String>,
}
/// Dispatch only an exact completed recovery generation; history is inert.
pub(super) fn current_completion(
    root: &std::path::Path,
    receipt: &Receipt,
) -> Result<bool, CandidateError> {
    if !exists(&root.join(FILE))? {
        return Ok(false);
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    let complete = digest(receipt)?;
    Ok(intent.complete_sha256.as_deref() == Some(complete.as_str()))
}

fn refused() -> CandidateError {
    error(
        "graph_live_owner_recovery",
        "Same-boot recovery requires an unchanged fully ready graph, confirmed dead foreground/relay owner, held publication locks, and exact cleanup inventories; evidence retained.",
    )
}
fn digest(value: &impl Serialize) -> Result<String, CandidateError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(value).map_err(|_| refused())?)
    ))
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn no_pending(root: &Path, receipt: &Receipt) -> Result<(), CandidateError> {
    for name in [
        "state.pending",
        "one-off.json",
        "one-off.pending",
        "one-off-normalization.json",
        "dependency-rebind.pending",
        "dead-owner-cleanup.pending",
        "relay-cleanup-bridges.pending",
    ] {
        if exists(&root.join(name))? {
            return Err(refused());
        }
    }
    startup::require_dependency_rebind_complete(root, receipt)?;
    dead_owner_cleanup::require_historical_recovery(root, receipt)
}
fn ready(receipt: &Receipt) -> Result<(), CandidateError> {
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    if receipt.phase != "ready-observed"
        || receipt.relay_cleanup.is_some()
        || !startup.valid(receipt)
        || startup.services.values().any(|s| {
            !matches!(
                s.phase,
                startup::Phase::Released | startup::Phase::Completed
            )
        })
    {
        return Err(refused());
    }
    initializer_cache::require_resolved(receipt)
}
fn immutable(receipt: &Receipt) -> Result<Value, CandidateError> {
    let mut value = serde_json::to_value(receipt).map_err(|_| refused())?;
    value.as_object_mut().ok_or_else(refused)?.remove("phase");
    for group in ["resources", "probes"] {
        if let Some(items) = value.get_mut(group).and_then(Value::as_object_mut) {
            for item in items.values_mut() {
                item.as_object_mut().ok_or_else(refused)?.remove("phase");
            }
        }
    }
    Ok(value)
}
fn validate(
    intent: &Intent,
    receipt: &Receipt,
    expected: &str,
    boot: &str,
) -> Result<(), CandidateError> {
    ready(&intent.original)?;
    intent.relay.validate()?;
    if intent.version != intent.relay.version()
        || intent.boot != boot
        || boot.is_empty()
        || !hex(expected, 64)
        || intent.original_sha256 != expected
        || digest(&intent.original)? != expected
        || !hex(&intent.foreground_sha256, 64)
        || immutable(&intent.original)? != immutable(receipt)?
        || intent
            .complete_sha256
            .as_deref()
            .is_some_and(|v| !hex(v, 64) || !intent.listeners_retired)
    {
        return Err(refused());
    }
    Ok(())
}
fn save(root: &Path, intent: &Intent) -> Result<(), CandidateError> {
    // Interrupted bytes are evidence only; current committed state and held
    // witnesses supply authority for this exact retry.
    journal::retain_file(
        root,
        "live-owner-cleanup.pending",
        "live-owner-cleanup-recovery",
        2 * 1024 * 1024,
    )?;
    state::write(&root.join(FILE), intent)
}
fn stop_listeners(
    engine: &Engine<'_>,
    receipt: &Receipt,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    for (name, service) in &startup.services {
        if service.phase == startup::Phase::Completed {
            continue;
        }
        let resource = receipt
            .resources
            .get(&format!("container:{name}"))
            .ok_or_else(refused)?;
        let value = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
        if value["State"]["StartedAt"].as_str() != service.started_at.as_deref() {
            return Err(refused());
        }
        let (uid, gid) = launcher::identity(&value["Config"])?;
        for binding in service.bindings.values() {
            let process = binding.process.ok_or_else(refused)?;
            verify()?;
            engine.guest().stop_orphan_relay_listener(
                crate::provider::lifecycle::RelayLaunch {
                    container: resource.id.as_deref().ok_or_else(refused)?,
                    uid,
                    gid,
                    slot: binding.slot,
                    port: binding.port,
                    address: dependency_address(binding.slot, &binding.aliases)?,
                },
                process,
                Duration::from_secs(15),
            )?;
        }
    }
    Ok(())
}
fn archive_prior(root: &Path, current: &Receipt, expected: &str) -> Result<(), CandidateError> {
    if !exists(&root.join(FILE))? {
        return Ok(());
    }
    let prior: Intent = state::read(&root.join(FILE))?;
    if prior.original_sha256 == expected {
        return Ok(());
    }
    ready(current)?;
    if digest(current)? != expected || exists(&root.join("live-owner-cleanup.pending"))? {
        return Err(refused());
    }
    validate(&prior, &prior.original, &prior.original_sha256, &prior.boot)?;
    if prior
        .complete_sha256
        .as_deref()
        .is_none_or(|hash| !hex(hash, 64))
        || prior.original.run != current.run
        || prior.original.owner != current.owner
        || prior.original.namespace != current.namespace
        || prior.original.plan_id != current.plan_id
        || !restore_history::confirms_prior_generation(root, current)?
        || !prior.original.resources.iter().any(|(key, r)| {
            r.kind == Kind::Container
                && r.id != current.resources.get(key).and_then(|v| v.id.clone())
        })
    {
        return Err(refused());
    }
    // This is diagnostic history, not current cleanup authority. Keep exactly
    // the immediately prior completed proof, independently of the bounded
    // restore-history window. Atomic replacement cannot strand a new recovery
    // merely because the oldest restored generation was evicted.
    let target = root.join("live-owner-cleanup-previous.json");
    if exists(&target)? {
        let previous: Intent = state::read(&target)?;
        validate(
            &previous,
            &previous.original,
            &previous.original_sha256,
            &previous.boot,
        )?;
        if previous
            .complete_sha256
            .as_deref()
            .is_none_or(|hash| !hex(hash, 64))
            || previous.original.run != current.run
            || previous.original.owner != current.owner
            || previous.original.namespace != current.namespace
            || previous.original.plan_id != current.plan_id
        {
            return Err(refused());
        }
    }
    fs::rename(root.join(FILE), target).map_err(state::io)?;
    fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(state::io)
}
fn prior_bridges(
    engine: &Engine<'_>,
    root: &Path,
    receipt: &Receipt,
) -> Result<Option<Value>, CandidateError> {
    if !exists(&root.join("relay-cleanup-bridges.json"))? {
        return Ok(None);
    }
    let stopped =
        restore_history::latest_for_bridge_recovery(root, receipt)?.ok_or_else(refused)?;
    if stopped.phase != "stopped-data-retained"
        || !stopped.resources.iter().any(|(key, r)| {
            r.kind == Kind::Container
                && r.id != receipt.resources.get(key).and_then(|v| v.id.clone())
        })
    {
        return Err(refused());
    }
    let selected = bridges::cleanup::read(engine, &stopped, root)?;
    Ok(Some(serde_json::to_value(selected).map_err(|_| refused())?))
}
/// Explicitly recover only a fully ready dead owner in the currently running
/// pool. Sibling graphs and persistent data are not selected. Completed recovery
/// retires the selected stale publications before releasing the provider lease.
pub fn recover_live_owner(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<Value, CandidateError> {
    if !hex(run, 32) || !hex(expected, 64) {
        return Err(refused());
    }
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    no_pending(&root, &receipt)?;
    if exists(&root.join(FILE))? {
        let intent: Intent = state::read(&root.join(FILE))?;
        if intent.original_sha256 == expected && intent.complete_sha256.is_some() {
            validate(&intent, &receipt, expected, engine.guest().boot_id())?;
            finish_retirement(candidate, &engine, &receipt, &root, &intent)?;
            return Ok(
                json!({"run":run,"phase":receipt.phase,"recovered":true,"data_retained":true,"same_boot":true,"publisher_retired":true}),
            );
        }
    }
    let foreground = foreground::DeadOwner::acquire(candidate, run)?;
    foreground.verify_retirement_ready()?;
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let context = host_relay::context(&receipt.owner, engine.guest().boot_id())?;
    let relay =
        dead::CleanupWitness::acquire(&startup.control_root, context, foreground.process())?;
    if matches!(relay, dead::CleanupWitness::Absent(_)) {
        relay::require_scoped_root(candidate, &receipt, engine.guest().boot_id())?;
        relay::verify_receipt(&root, &receipt)?;
    }
    archive_prior(&root, &receipt, expected)?;
    let mut intent = if exists(&root.join(FILE))? {
        state::read::<Intent>(&root.join(FILE))?
    } else {
        ready(&receipt)?;
        if digest(&receipt)? != expected {
            return Err(refused());
        }
        host_relay::cleanup_preflight(&engine, &receipt, &root, false)?;
        for resource in receipt.resources.values() {
            inspect_resource(&engine, &receipt, resource)?;
        }
        let selected = relay::Selection::capture(&relay, foreground.process())?;
        Intent {
            version: selected.version(),
            boot: engine.guest().boot_id().into(),
            original: receipt.clone(),
            original_sha256: expected.into(),
            foreground_sha256: foreground.fingerprint(),
            relay: selected,
            environment: serde_json::to_value(environment::cleanup_inventory(
                candidate, &engine, &receipt, &root,
            )?)
            .map_err(|_| refused())?,
            bridges: bridges::cleanup::capture(candidate, &engine, &receipt)?,
            prior_bridges: prior_bridges(&engine, &root, &receipt)?,
            listeners_retired: false,
            complete_sha256: None,
        }
    };
    validate(&intent, &receipt, expected, engine.guest().boot_id())?;
    if intent.foreground_sha256 != foreground.fingerprint() {
        return Err(refused());
    }
    intent.relay.verify(&relay, foreground.process())?;
    startup::require_dependency_rebind_recovery_complete(&root, &intent.original, &intent.boot)?;
    foreground.verify_retirement_ready()?;
    relay.verify()?;
    host_relay::cleanup_preflight(&engine, &receipt, &root, false)?;
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    if serde_json::to_value(&environment).map_err(|_| refused())? != intent.environment {
        return Err(refused());
    }
    bridges::cleanup::verify_live_remaining(candidate, &engine, &receipt, &intent.bridges)?;
    save(&root, &intent)?;
    #[cfg(test)]
    fault_pause(&root, run, "live-owner-after-intent")?;
    let verify = || {
        engine.guest().verify()?;
        foreground.verify_retirement_ready()?;
        relay.verify()?;
        if matches!(relay, dead::CleanupWitness::Absent(_)) {
            relay::verify_receipt(&root, &intent.original)?;
        }
        Ok(())
    };
    if !intent.listeners_retired {
        stop_listeners(&engine, &receipt, &verify)?;
        verify()?;
        intent.listeners_retired = true;
        save(&root, &intent)?;
    }
    bridges::cleanup::verify_recovery_file(&root, &intent.bridges, intent.prior_bridges.as_ref())?;
    verify()?;
    bridges::cleanup::recover_persist(&root, &intent.bridges)?;
    let cleaned = cleanup_owned_fenced(
        candidate,
        &engine,
        receipt,
        &root,
        false,
        matches!(relay, dead::CleanupWitness::Absent(_)),
        verify,
    )?;
    host_relay::inspect_cleanup(
        candidate,
        &engine,
        &cleaned,
        false,
        &environment,
        &intent.bridges,
    )?;
    verify()?;
    intent.complete_sha256 = Some(digest(&cleaned)?);
    save(&root, &intent)?;
    #[cfg(test)]
    fault_pause(&root, run, "live-owner-after-completion")?;
    // Commit independently verified owned absence before archival. A crash during
    // a rename resumes through the completed intent, never through host adoption.
    drop(relay);
    drop(foreground);
    finish_retirement(candidate, &engine, &cleaned, &root, &intent)?;
    Ok(
        json!({"run":run,"phase":cleaned.phase,"recovered":true,"data_retained":true,"same_boot":true,"publisher_retired":true}),
    )
}

/// A committed completion digest follows independent guest/helper/namespace
/// confirmation. It is not invalidated by a sibling reusing a released bridge
/// slot. Reinspect this graph's resources; never touch a later slot generation.
fn finish_retirement(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &Path,
    intent: &Intent,
) -> Result<(), CandidateError> {
    if receipt.phase != "stopped-data-retained"
        || intent.complete_sha256.as_deref() != Some(digest(receipt)?.as_str())
    {
        return Err(refused());
    }
    host_relay::cleanup_preflight(engine, receipt, root, false)?;
    for resource in receipt.resources.values() {
        let observed = inspect_resource(engine, receipt, resource)?;
        if resource.kind == Kind::Volume {
            if observed.is_none() {
                return Err(refused());
            }
        } else {
            let mut by_name = resource.clone();
            by_name.id = None;
            if resource.phase != "absent"
                || observed.is_some()
                || inspect_resource(engine, receipt, &by_name)?.is_some()
            {
                return Err(refused());
            }
        }
    }
    startup::verify_cleanup(engine, receipt)?;
    probes::verify_cleanup(engine, receipt)?;
    let publisher = foreground::transport::root(candidate, &receipt.run)?;
    acknowledged_publisher::require_no_pending_missing_lock(candidate, &receipt.run)?;
    let publisher_lock = state::Lock::acquire_existing(&publisher)?;
    acknowledged_publisher::require_no_pending_missing_lock(candidate, &receipt.run)?;
    let process = foreground::transport::selected_retirement_process(
        candidate,
        &receipt.run,
        &intent.foreground_sha256,
        &digest(receipt)?,
        &publisher_lock,
    )?;
    let absent = intent
        .relay
        .absent_witness(candidate, receipt, &intent.boot, &process)?;
    let verify = || {
        engine.guest().verify()?;
        if let Some(witness) = &absent {
            let current = foreground::transport::selected_retirement_process(
                candidate,
                &receipt.run,
                &intent.foreground_sha256,
                &digest(receipt)?,
                &publisher_lock,
            )?;
            intent.relay.verify(witness, &current)?;
            relay::verify_receipt(root, &intent.original)?;
        }
        Ok(())
    };
    archive_completed_refresh(root, &intent.original, receipt, &intent.boot, &verify)?;
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    if let relay::Selection::Present(selected) = &intent.relay {
        dead::retire(
            &startup.control_root,
            host_relay::context(&receipt.owner, &intent.boot)?,
            selected,
        )?;
    }
    foreground::transport::retire_recovered_publisher_locked_fenced(
        candidate,
        &receipt.run,
        &intent.foreground_sha256,
        &digest(receipt)?,
        None,
        &publisher_lock,
        &verify,
    )?;
    verify()?;
    dependency_slots::recover_cleaned(candidate, receipt, None)?;
    verify()
}

/// Completed cleanup grants archival, not refresh replay. The same exact ready
/// generation is checked again on retry, including a journal already moved by
/// an interrupted owned rename.
fn archive_completed_refresh(
    root: &Path,
    original: &Receipt,
    cleaned: &Receipt,
    boot: &str,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let generation = service_exec_generation(original)?;
    if exists(&root.join("dependency-rebind.json"))?
        || exists(&root.join(format!("dependency-rebind-history-{generation}")))?
    {
        startup::archive_retired_dependency_rebind(root, original, cleaned, boot, verify)
    } else {
        startup::require_dependency_rebind_recovery_complete(root, original, boot)
    }
}

/// A superseded cleanup is inert history. Prefer its exact stopped generation;
/// verified truncation may establish replacement of a validated original after
/// that completion is evicted. Neither path supplies current cleanup authority.
pub(super) fn require_historical_recovery(
    root: &Path,
    current: &Receipt,
) -> Result<(), CandidateError> {
    if exists(&root.join("live-owner-cleanup.pending"))? {
        return Err(refused());
    }
    if !exists(&root.join(FILE))? {
        return Ok(());
    }
    let prior: Intent = state::read(&root.join(FILE))?;
    let complete = prior.complete_sha256.as_deref().ok_or_else(refused)?;
    let stopped = restore_history::completed_for_recovery(root, current, complete)?;
    let historical = stopped.as_ref().unwrap_or(&prior.original);
    validate(&prior, historical, &prior.original_sha256, &prior.boot)?;
    if stopped.is_none()
        && (prior.original.version != current.version
            || prior.original.run != current.run
            || prior.original.owner != current.owner
            || prior.original.namespace != current.namespace
            || prior.original.plan_id != current.plan_id
            || !restore_history::confirms_truncated_newer_generation(
                root,
                current,
                &prior.original,
            )?)
    {
        return Err(refused());
    }
    if !prior.listeners_retired
        || !historical.resources.iter().any(|(key, old)| {
            old.kind == Kind::Container
                && old.id.as_ref().is_some_and(|id| {
                    current
                        .resources
                        .get(key)
                        .and_then(|now| now.id.as_ref())
                        .is_some_and(|current_id| current_id != id)
                })
        })
    {
        return Err(refused());
    }
    Ok(())
}

pub(super) fn retained(root: &Path, receipt: &Receipt) -> Result<bool, CandidateError> {
    if !exists(&root.join(FILE))? {
        return Ok(false);
    }
    if exists(&root.join("live-owner-cleanup.pending"))? {
        return Err(refused());
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    if digest(&state::read::<Receipt>(&root.join("state.json"))?)? != digest(receipt)? {
        return Err(refused());
    }
    if intent.complete_sha256.as_deref() != Some(digest(receipt)?.as_str()) {
        validate(
            &intent,
            &intent.original,
            &intent.original_sha256,
            &intent.boot,
        )?;
        if intent
            .complete_sha256
            .as_deref()
            .is_none_or(|hash| !hex(hash, 64))
            || intent.original.run != receipt.run
            || intent.original.owner != receipt.owner
            || intent.original.namespace != receipt.namespace
            || intent.original.plan_id != receipt.plan_id
            || receipt.phase != "stopped-data-retained"
            || !restore_history::confirms_prior_generation(root, receipt)?
        {
            return Err(refused());
        }
        cleanup_enrollment::retention_receipt(receipt, false)?;
        return Ok(false);
    }
    validate(&intent, receipt, &intent.original_sha256, &intent.boot)?;
    if receipt.phase != "stopped-data-retained"
        || intent.complete_sha256.as_deref() != Some(digest(receipt)?.as_str())
        || digest(&state::read::<Receipt>(&root.join("state.json"))?)? != digest(receipt)?
    {
        return Err(refused());
    }
    Ok(true)
}
pub(super) fn retire(
    candidate: &Candidate,
    run: &str,
    expected_owner: &str,
) -> Result<Option<Value>, CandidateError> {
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    if !exists(&root.join(FILE))? {
        return Ok(None);
    }
    no_pending(&root, &receipt)?;
    if receipt.owner != expected_owner || !retained(&root, &receipt)? {
        return Err(refused());
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    validate(
        &intent,
        &receipt,
        &intent.original_sha256,
        engine.guest().boot_id(),
    )?;
    finish_retirement(candidate, &engine, &receipt, &root, &intent)?;
    Ok(Some(
        json!({"run":run,"publisher_retired":true,"data_retained":true,"same_boot":true}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}}})).unwrap()
    }
    #[test]
    fn current_recovery_dispatch_does_not_select_historical_completion() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt = receipt();
        receipt.phase = "stopped-data-retained".into();
        assert!(!current_completion(&fixture.0, &receipt).unwrap());
        let mut proof = completed(receipt.clone());
        proof.complete_sha256 = Some(digest(&receipt).unwrap());
        let path = fixture.0.join(FILE);
        state::write(&path, &proof).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(current_completion(&fixture.0, &receipt).unwrap());
        receipt.owner = "9".repeat(32);
        assert!(!current_completion(&fixture.0, &receipt).unwrap());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, b"unconfirmed").unwrap();
        assert!(current_completion(&fixture.0, &receipt).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unconfirmed");
    }

    #[test]
    fn only_fully_ready_receipts_are_admitted() {
        let mut value = receipt();
        ready(&value).unwrap();
        for phase in [
            "preparing",
            "failed-retained",
            "cleanup-intent",
            "stopped-data-retained",
        ] {
            value.phase = phase.into();
            assert!(ready(&value).is_err());
        }
        value = receipt();
        value.relay_startup = None;
        assert!(ready(&value).is_err());
    }
    #[test]
    fn ambiguous_mutations_are_preserved_without_effect() {
        let fixture = super::super::tests::Fixture::new();
        no_pending(&fixture.0, &receipt()).unwrap();
        for name in [
            "state.pending",
            "one-off.json",
            "one-off.pending",
            "dependency-rebind.json",
            "dependency-rebind.pending",
            "relay-cleanup-bridges.pending",
        ] {
            let path = fixture.0.join(name);
            fs::write(&path, b"retained").unwrap();
            assert!(no_pending(&fixture.0, &receipt()).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"retained");
            fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn completed_terminal_refresh_is_not_a_pending_mutation() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt = receipt();
        receipt
            .readiness
            .insert("init".into(), Condition::Completed);
        receipt.relay_startup.as_mut().unwrap().services.insert(
            "init".into(),
            serde_json::from_value(json!({"generation":"f".repeat(32),
                "phase":"completed","started_at":null,"bindings":{}}))
            .unwrap(),
        );
        let journal = json!({"version":1,"operation":"e".repeat(32),
            "run":receipt.run,"owner":receipt.owner,"boot":"fixture-boot",
            "expected_generation":"a".repeat(64),"phase":"completed",
            "slots":{},"processes":{},"completed_services":["init"],
            "completed_generation":service_exec_generation(&receipt).unwrap()});
        let path = fixture.0.join("dependency-rebind.json");
        state::write(&path, &journal).unwrap();
        let before = fs::read(&path).unwrap();
        no_pending(&fixture.0, &receipt).unwrap();
        startup::require_dependency_rebind_recovery_complete(&fixture.0, &receipt, "fixture-boot")
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut partial = journal.clone();
        partial["phase"] = json!("provisioning");
        state::write(&path, &partial).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(no_pending(&fixture.0, &receipt).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut cleaned = receipt.clone();
        cleaned.phase = "stopped-data-retained".into();
        let generation = service_exec_generation(&receipt).unwrap();
        let history = fixture
            .0
            .join(format!("dependency-rebind-history-{generation}"));
        let mut replaced = journal.clone();
        replaced["completed_generation"] = json!("9".repeat(64));
        state::write(&path, &replaced).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(
            archive_completed_refresh(&fixture.0, &receipt, &cleaned, "fixture-boot", &|| Ok(()),)
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!history.exists());
        state::write(&path, &journal).unwrap();
        let before = fs::read(&path).unwrap();
        let interrupted = || {
            if history.join("proof.json").exists() && path.exists() {
                Err(refused())
            } else {
                Ok(())
            }
        };
        assert!(archive_completed_refresh(
            &fixture.0, &receipt, &cleaned, "fixture-boot", &interrupted,
        ).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::rename(&path, history.join("dependency-rebind.json")).unwrap();
        for _ in 0..2 {
            archive_completed_refresh(&fixture.0, &receipt, &cleaned, "fixture-boot", &|| Ok(()))
                .unwrap();
        }
        assert_eq!(
            fs::read(history.join("dependency-rebind.json")).unwrap(),
            before
        );
        assert_eq!(
            state::read::<Value>(&history.join("proof.json")).unwrap()["complete"],
            true
        );
    }
    #[test]
    fn immutable_selection_allows_cleanup_progress_but_not_resource_replacement() {
        let value = receipt();
        let mut changed = value.clone();
        changed.phase = "cleanup-intent".into();
        assert_eq!(immutable(&value).unwrap(), immutable(&changed).unwrap());
        changed.owner = "f".repeat(32);
        assert_ne!(immutable(&value).unwrap(), immutable(&changed).unwrap());
        changed = value.clone();
        changed.relay_startup.as_mut().unwrap().control_root = "/private/foreign".into();
        assert_ne!(immutable(&value).unwrap(), immutable(&changed).unwrap());
    }
    fn generation(number: u64, phase: &str) -> Receipt {
        let mut value = receipt();
        value.phase = phase.into();
        value.resources.insert(
            "container:web".into(),
            serde_json::from_value(json!({
                "kind":"container","key":"web","name":"owned-web",
                "id":format!("{number:064x}"),"image":null,
                "phase": if phase == "ready-observed" { "started" } else { "absent" }
            }))
            .unwrap(),
        );
        value
    }
    fn completed(original: Receipt) -> Intent {
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        for resource in stopped.resources.values_mut() {
            resource.phase = "absent".into();
        }
        Intent {
            version: 1, boot: "boot".into(), original_sha256: digest(&original).unwrap(),
            foreground_sha256: "f".repeat(64),
            relay: serde_json::from_value(json!({"bytes":[],"record_id":[1,1]})).unwrap(),
            environment: json!([]),
            bridges: serde_json::from_value(json!({"version":1,"owner":original.owner,"boot":"boot","run":original.run,"plan":original.plan_id,"capacity":0,"serial":0,"selected":{}})).unwrap(),
            prior_bridges: None, listeners_retired: true, complete_sha256: Some(digest(&stopped).unwrap()), original,
        }
    }
    #[test]
    fn recovery_versions_distinguish_absence_from_legacy_publication() {
        let original = receipt();
        let legacy = completed(original.clone());
        let value = serde_json::to_value(&legacy).unwrap();
        assert!(value["relay"]["bytes"].is_array());
        assert!(value["relay"].get("absent").is_none());
        let restored: Intent = serde_json::from_value(value.clone()).unwrap();
        validate(&restored, &original, &digest(&original).unwrap(), "boot").unwrap();
        let mut absent = value;
        absent["relay"] = json!({"absent": {
            "process": {"pid":999999, "start_micros":1, "uid":unsafe {libc::geteuid()}, "executable":"/bin/sleep"},
            "witness_sha256":"a".repeat(64)
        }});
        let old_version: Intent = serde_json::from_value(absent.clone()).unwrap();
        assert!(validate(&old_version, &original, &digest(&original).unwrap(), "boot").is_err());
        absent["version"] = json!(2);
        let selected: Intent = serde_json::from_value(absent.clone()).unwrap();
        validate(&selected, &original, &digest(&original).unwrap(), "boot").unwrap();
        assert!(
            validate(
                &selected,
                &original,
                &digest(&original).unwrap(),
                "changed-boot"
            )
            .is_err()
        );
        absent["relay"]["absent"]["witness_sha256"] = json!("malformed");
        let malformed: Intent = serde_json::from_value(absent.clone()).unwrap();
        assert!(validate(&malformed, &original, &digest(&original).unwrap(), "boot").is_err());
        absent["relay"]["unexpected"] = json!(true);
        assert!(serde_json::from_value::<Intent>(absent).is_err());
    }
    #[test]
    fn absence_receipt_fence_rejects_changed_bytes_and_resources() {
        let fixture = super::super::tests::Fixture::new();
        let original = receipt();
        let path = fixture.0.join("state.json");
        state::write(&path, &original).unwrap();
        relay::verify_receipt(&fixture.0, &original).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        bytes.push(b'\n');
        fs::write(&path, &bytes).unwrap();
        assert!(relay::verify_receipt(&fixture.0, &original).is_err());
        let mut changed = original.clone();
        changed.phase = "cleanup-intent".into();
        state::write(&path, &changed).unwrap();
        relay::verify_receipt(&fixture.0, &original).unwrap();
        changed.owner = "f".repeat(32);
        state::write(&path, &changed).unwrap();
        assert!(relay::verify_receipt(&fixture.0, &original).is_err());
        changed = original.clone();
        changed.relay_startup.as_mut().unwrap().control_root = "/private/foreign".into();
        state::write(&path, &changed).unwrap();
        assert!(relay::verify_receipt(&fixture.0, &original).is_err());
        changed = original.clone();
        changed.phase = "removed".into();
        state::write(&path, &changed).unwrap();
        assert!(relay::verify_receipt(&fixture.0, &original).is_err());
    }
    #[test]
    fn historical_recovery_survives_eviction_without_lending_current_authority() {
        let fixture = super::super::tests::Fixture::new();
        let prior = completed(generation(1, "ready-observed"));
        state::write(&fixture.0.join(FILE), &prior).unwrap();
        for number in 1..=12 {
            restore_history::retain(&fixture.0, &generation(number, "stopped-data-retained"))
                .unwrap();
        }
        let current = generation(13, "ready-observed");
        assert!(
            restore_history::completed_for_recovery(
                &fixture.0,
                &current,
                prior.complete_sha256.as_deref().unwrap(),
            )
            .unwrap()
            .is_none()
        );
        let before = fs::read(fixture.0.join(FILE)).unwrap();
        require_historical_recovery(&fixture.0, &current).unwrap();
        assert!(!current_completion(&fixture.0, &current).unwrap());
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), before);
        let stopped = generation(13, "stopped-data-retained");
        state::write(&fixture.0.join("state.json"), &stopped).unwrap();
        assert!(retained(&fixture.0, &stopped).is_err());
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), before);
    }
    #[test]
    fn evicted_historical_recovery_requires_valid_retired_original_and_newer_history() {
        let fixture = super::super::tests::Fixture::new();
        let prior = completed(generation(1, "ready-observed"));
        let current = generation(13, "ready-observed");
        state::write(&fixture.0.join(FILE), &prior).unwrap();
        assert!(require_historical_recovery(&fixture.0, &current).is_err());
        restore_history::retain(&fixture.0, &generation(2, "stopped-data-retained")).unwrap();
        assert!(require_historical_recovery(&fixture.0, &current).is_err());
        for number in 3..=12 {
            restore_history::retain(&fixture.0, &generation(number, "stopped-data-retained"))
                .unwrap();
        }
        for case in 0..7 {
            let mut bad = completed(generation(1, "ready-observed"));
            match case {
                0 => bad.complete_sha256 = None,
                1 => bad.complete_sha256 = Some("invalid".into()),
                2 => bad.listeners_retired = false,
                3 => bad.original_sha256 = "0".repeat(64),
                4 => {
                    bad.original.owner = "0".repeat(32);
                    bad.original_sha256 = digest(&bad.original).unwrap();
                }
                5 => bad.boot.clear(),
                6 => bad = completed(current.clone()),
                _ => unreachable!(),
            }
            state::write(&fixture.0.join(FILE), &bad).unwrap();
            let before = fs::read(fixture.0.join(FILE)).unwrap();
            assert!(require_historical_recovery(&fixture.0, &current).is_err());
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), before);
        }
        state::write(&fixture.0.join(FILE), &prior).unwrap();
        state::write(&fixture.0.join("live-owner-cleanup.pending"), &json!({})).unwrap();
        assert!(require_historical_recovery(&fixture.0, &current).is_err());
    }
    #[test]
    fn repeated_recovery_does_not_depend_on_evicted_restore_history_or_grow_archives() {
        let fixture = super::super::tests::Fixture::new();
        for cycle in 0..20u64 {
            let original = generation(cycle * 20 + 1, "ready-observed");
            let prior = completed(original.clone());
            state::write(&fixture.0.join(FILE), &prior).unwrap();
            // More ordinary restore generations than the eight-entry window:
            // the exact old completed recovery is intentionally no longer kept.
            for offset in 1..=12 {
                restore_history::retain(
                    &fixture.0,
                    &generation(cycle * 20 + offset, "stopped-data-retained"),
                )
                .unwrap();
            }
            let current = generation(cycle * 20 + 14, "ready-observed");
            assert!(
                restore_history::completed_for_recovery(
                    &fixture.0,
                    &current,
                    prior.complete_sha256.as_deref().unwrap()
                )
                .unwrap()
                .is_none()
            );
            archive_prior(&fixture.0, &current, &digest(&current).unwrap()).unwrap();
            assert!(!fixture.0.join(FILE).exists());
            let kept: Intent =
                state::read(&fixture.0.join("live-owner-cleanup-previous.json")).unwrap();
            assert_eq!(kept.original_sha256, prior.original_sha256);
            assert_eq!(
                fs::read_dir(&fixture.0)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|entry| entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| name.starts_with("live-owner-cleanup-")))
                    .count(),
                1
            );
        }
    }
    #[test]
    fn incomplete_or_foreign_previous_proof_cannot_be_replaced() {
        let fixture = super::super::tests::Fixture::new();
        let current = generation(3, "ready-observed");
        restore_history::retain(&fixture.0, &generation(1, "stopped-data-retained")).unwrap();
        let mut prior = completed(generation(1, "ready-observed"));
        prior.complete_sha256 = None;
        state::write(&fixture.0.join(FILE), &prior).unwrap();
        let bytes = fs::read(fixture.0.join(FILE)).unwrap();
        assert!(archive_prior(&fixture.0, &current, &digest(&current).unwrap()).is_err());
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), bytes);
        prior = completed(generation(1, "ready-observed"));
        state::write(&fixture.0.join(FILE), &prior).unwrap();
        let mut foreign = completed(generation(1, "ready-observed"));
        foreign.original.owner = "1".repeat(32);
        foreign.original_sha256 = digest(&foreign.original).unwrap();
        state::write(
            &fixture.0.join("live-owner-cleanup-previous.json"),
            &foreign,
        )
        .unwrap();
        assert!(archive_prior(&fixture.0, &current, &digest(&current).unwrap()).is_err());
        assert!(fixture.0.join(FILE).exists());
    }
}
