//! Explicit recovery selects VM stop plus owner death before reboot, or a dead
//! ready owner (including a journal-bound one-off) from the immediate predecessor boot.
//! No endpoint-file deletion is treated as a relay retirement acknowledgement.
use super::*;
use crate::provider::{identity, lifecycle, state::Owner};
use sha2::{Digest, Sha256};
const FILE: &str = "dead-owner-cleanup.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    original_sha256: String,
    owner_sha256: String,
    old_boot: String,
    new_boot: Option<String>,
    original: Receipt,
    environment: Option<Value>,
    bridges: Option<bridges::cleanup::Selection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prior_bridges: Option<Value>,
    complete_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    one_off_sha256: Option<String>,
}
fn refused() -> CandidateError {
    error(
        "graph_dead_owner_recovery",
        "Dead-owner cleanup requires an exact stopped selection, ready graph, or validated interrupted one-off from the immediate prior boot, an absent foreground owner, and unchanged verified inventories; evidence retained.",
    )
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
/// Digest of the canonical pretty-encoded state.json written by state::write.
fn selected(receipt: &Receipt) -> Result<String, CandidateError> {
    Ok(digest(
        &serde_json::to_vec_pretty(receipt).map_err(|_| refused())?,
    ))
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
    owner: &str,
) -> Result<(), CandidateError> {
    if intent.version != 1
        || intent.original_sha256 != expected
        || selected(&intent.original)? != expected
        || intent.owner_sha256 != owner
        || !hex(owner, 64)
        || intent.old_boot.is_empty()
        || immutable(&intent.original)? != immutable(receipt)?
    {
        return Err(refused());
    }
    Ok(())
}
fn exists(path: &std::path::Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn no_pending(root: &std::path::Path) -> Result<(), CandidateError> {
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}
fn retain_interrupted_write(root: &std::path::Path) -> Result<(), CandidateError> {
    journal::retain_file(
        root,
        "dead-owner-cleanup.pending",
        "dead-owner-cleanup-recovery",
        2 * 1024 * 1024,
    )?;
    Ok(())
}
/// Normally select while stopped, then call after explicit runtime up. A dead
/// ready owner with exact previous-boot reservations can be selected on the
/// immediate successor boot without another restart.
/// This operation never starts a VM or deletes retained data.
pub fn recover_cleanup(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected, 64) {
        return Err(refused());
    }
    let owner = Owner::load(candidate)?;
    if owner.phase == "stopped" {
        return prepare(candidate, run, expected);
    }
    execute(candidate, run, expected)
}

/// The completed dead-owner cleanup receipt, not missing endpoint names, grants
/// a separate explicit publisher retirement. This never removes graph volumes.
pub fn retire_recovered_publisher(
    candidate: &Candidate,
    run: &str,
    expected_owner: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected_owner, 32) {
        return Err(refused());
    }
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    no_pending(&root)?;
    if receipt.phase != "stopped-data-retained"
        || receipt.owner != expected_owner
        || receipt.normalized_input.is_none()
        || !retained(&root, &receipt)?
    {
        return Err(refused());
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    let complete = selected(&receipt)?;
    validate(
        &intent,
        &receipt,
        &intent.original_sha256,
        &intent.owner_sha256,
    )?;
    if intent.complete_sha256.as_deref() != Some(complete.as_str())
        || intent.new_boot.as_deref() != Some(engine.guest().boot_id())
        || intent.one_off_sha256.is_some()
    {
        return Err(refused());
    }
    initializer_cache::require_resolved(&receipt)?;
    host_relay::cleanup_preflight(&engine, &receipt, &root, false)?;
    for resource in receipt.resources.values() {
        let observed = inspect_resource(&engine, &receipt, resource)?;
        if (resource.kind == Kind::Volume && observed.is_none())
            || (resource.kind != Kind::Volume && (resource.phase != "absent" || observed.is_some()))
        {
            return Err(refused());
        }
    }
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    if intent.environment.as_ref()
        != Some(&serde_json::to_value(&environment).map_err(|_| refused())?)
    {
        return Err(refused());
    }
    let bridges = intent.bridges.as_ref().ok_or_else(refused)?;
    bridges::cleanup::verify_recovery_file(&root, bridges, intent.prior_bridges.as_ref())?;
    host_relay::inspect_cleanup(candidate, &engine, &receipt, false, &environment, bridges)?;
    foreground::retire_publisher_path(candidate, run, &intent.owner_sha256, &complete)?;
    Ok(json!({"run":run,"publisher_retired":true,"data_retained":true}))
}
fn prepare(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    let _lease = state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm"))?;
    let owner = Owner::load(candidate)?;
    let status = lifecycle::status(candidate)?;
    if owner.phase != "stopped"
        || status.process_alive != Some(false)
        || !status.persistent_disks_identified
    {
        return Err(refused());
    }
    if owner
        .process
        .as_ref()
        .is_none_or(|p| identity::alive(p.pid).unwrap_or(true))
    {
        return Err(refused());
    }
    let dead = foreground::DeadOwner::acquire(candidate, run)?;
    let (receipt, root) = load_at(directory(candidate, run)?, run, &owner.token)?;
    no_pending(&root)?;
    initializer_cache::require_resolved(&receipt)?;
    if exists(&root.join("relay-cleanup-bridges.json"))?
        || exists(&root.join("relay-cleanup-bridges.pending"))?
    {
        return Err(refused());
    }
    let old_boot = owner
        .guest_boot_id
        .or(owner.previous_guest_boot_id)
        .filter(|s| !s.is_empty())
        .ok_or_else(refused)?;
    let one_off_sha256 = if exists(&root.join("one-off.json"))? {
        Some(one_off::recovery_selection(&root, &receipt, &old_boot)?)
    } else {
        None
    };
    if receipt.relay_startup.is_none()
        || receipt.relay_cleanup.is_some()
        || (!["failed-retained", "preparing", "cleanup-intent"].contains(&receipt.phase.as_str())
            && one_off_sha256.is_none())
    {
        return Err(refused());
    }
    let path = root.join(FILE);
    if exists(&path)? {
        let intent: Intent = state::read(&path)?;
        validate(&intent, &receipt, expected, &dead.fingerprint())?;
        if intent.one_off_sha256 != one_off_sha256 {
            return Err(refused());
        }
        return Ok(json!({"run":run,"phase":"awaiting-runtime-start","receipt_sha256":expected}));
    }
    if selected(&receipt)? != expected {
        return Err(refused());
    }
    let intent = Intent {
        version: 1,
        original_sha256: expected.into(),
        owner_sha256: dead.fingerprint(),
        old_boot,
        new_boot: None,
        original: receipt,
        environment: None,
        bridges: None,
        prior_bridges: None,
        complete_sha256: None,
        one_off_sha256,
    };
    dead.verify()?;
    retain_interrupted_write(&root)?;
    state::write(&path, &intent)?;
    Ok(json!({"run":run,"phase":"awaiting-runtime-start","receipt_sha256":expected}))
}
fn fresh_boot(
    intent: &Intent,
    previous: Option<&str>,
    current: &str,
) -> Result<(), CandidateError> {
    if previous != Some(intent.old_boot.as_str())
        || current == intent.old_boot
        || current.is_empty()
        || intent.new_boot.as_deref().is_some_and(|b| b != current)
    {
        return Err(refused());
    }
    Ok(())
}
fn execute(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let dead = foreground::DeadOwner::acquire(candidate, run)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    if exists(&root.join("one-off-normalization.json"))? {
        let intent: Intent = state::read(&root.join(FILE))?;
        if intent.original_sha256 != expected || intent.owner_sha256 != dead.fingerprint() {
            return Err(refused());
        }
        dead.verify()?;
        let normalized = normalize_completed(candidate, &engine, &root, &intent)?;
        return Ok(
            json!({"run":run,"phase":normalized.phase,"recovered":true,"data_retained":true,"one_off_normalized":true}),
        );
    }
    no_pending(&root)?;
    let mut intent: Intent = if exists(&root.join(FILE))? {
        state::read(&root.join(FILE))?
    } else {
        // A dead ready owner may be selected after exactly one already audited
        // restart. No additional restart is requested or inferred here.
        let owner = Owner::load(candidate)?;
        let old_boot = owner.previous_guest_boot_id.ok_or_else(refused)?;
        let one_off_sha256 = if exists(&root.join("one-off.json"))? {
            Some(one_off::recovery_selection(&root, &receipt, &old_boot)?)
        } else {
            None
        };
        if (receipt.phase != "ready-observed" && one_off_sha256.is_none())
            || receipt.relay_startup.is_none()
            || receipt.relay_cleanup.is_some()
            || selected(&receipt)? != expected
        {
            return Err(refused());
        }
        initializer_cache::require_resolved(&receipt)?;
        let bridges =
            bridges::cleanup::capture_previous_boot(candidate, &engine, &receipt, &old_boot)?;
        let prior_bridges = bridges::cleanup::capture_prior_generation(&root, &bridges, &receipt)?;
        if prior_bridges.is_some() && !restore_history::confirms_prior_generation(&root, &receipt)?
        {
            return Err(refused());
        }
        let intent = Intent {
            version: 1,
            original_sha256: expected.into(),
            owner_sha256: dead.fingerprint(),
            old_boot,
            new_boot: Some(engine.guest().boot_id().into()),
            original: receipt.clone(),
            environment: None,
            bridges: Some(bridges),
            prior_bridges,
            complete_sha256: None,
            one_off_sha256,
        };
        dead.verify()?;
        retain_interrupted_write(&root)?;
        state::write(&root.join(FILE), &intent)?;
        intent
    };
    validate(&intent, &receipt, expected, &dead.fingerprint())?;
    let owner = Owner::load(candidate)?;
    let boot = engine.guest().boot_id();
    fresh_boot(&intent, owner.previous_guest_boot_id.as_deref(), boot)?;
    if let Some(expected_job) = &intent.one_off_sha256 {
        // Cleanup progress may change receipt phases; pin the original admitted
        // parent/job selection and require the published job journal unchanged.
        if one_off::recovery_selection(&root, &intent.original, &intent.old_boot)? != *expected_job
        {
            return Err(refused());
        }
        dead.verify()?;
        one_off::retain_interrupted_cleanup(&root)?;
    }

    host_relay::cleanup_preflight(&engine, &receipt, &root, false)?;
    for resource in receipt.resources.values() {
        inspect_resource(&engine, &receipt, resource)?;
    }
    if let Some(selection) = &intent.bridges {
        if intent.complete_sha256.is_none() {
            bridges::cleanup::verify_remaining(candidate, &engine, &receipt, selection)?;
        }
    }
    let environment = environment::cleanup_inventory(candidate, &engine, &receipt, &root)?;
    let environment_value = serde_json::to_value(&environment).map_err(|_| refused())?;
    let bridges = match &intent.bridges {
        Some(selection) => selection.clone(),
        None => {
            // A stopped-VM selection cannot capture helpers until its audited
            // successor boot. The retained reservations still belong to the
            // previous boot, so same-boot observation would reject them.
            let selection = bridges::cleanup::capture_previous_boot(
                candidate,
                &engine,
                &receipt,
                &intent.old_boot,
            )?;
            let prior = bridges::cleanup::capture_prior_generation(&root, &selection, &receipt)?;
            if prior.is_some() && !restore_history::confirms_prior_generation(&root, &receipt)? {
                return Err(refused());
            }
            intent.prior_bridges = prior;
            selection
        }
    };
    bridges::cleanup::verify_recovery_file(&root, &bridges, intent.prior_bridges.as_ref())?;
    if intent
        .environment
        .as_ref()
        .is_some_and(|v| v != &environment_value)
    {
        return Err(refused());
    }
    if let Some(hash) = &intent.complete_sha256 {
        if receipt.phase != "stopped-data-retained" || selected(&receipt)? != *hash {
            return Err(refused());
        }
        host_relay::inspect_cleanup(candidate, &engine, &receipt, false, &environment, &bridges)?;
        dead.verify()?;
        if intent.one_off_sha256.is_some() {
            normalize_completed(candidate, &engine, &root, &intent)?;
        }
        return Ok(
            json!({"run":run,"phase":"stopped-data-retained","recovered":true,"data_retained":true}),
        );
    }
    intent.environment = Some(environment_value);
    intent.bridges = Some(bridges.clone());
    intent.new_boot = Some(boot.into());
    dead.verify()?;
    retain_interrupted_write(&root)?;
    state::write(&root.join(FILE), &intent)?;
    bridges::cleanup::recover_persist(&root, &bridges)?;
    let cleaned = cleanup_owned(candidate, &engine, receipt, &root, false)?;
    host_relay::inspect_cleanup(candidate, &engine, &cleaned, false, &environment, &bridges)?;
    dead.verify()?;
    intent.complete_sha256 = Some(selected(&cleaned)?);
    retain_interrupted_write(&root)?;
    state::write(&root.join(FILE), &intent)?;
    if intent.one_off_sha256.is_some() {
        normalize_completed(candidate, &engine, &root, &intent)?;
    }
    Ok(json!({"run":run,"phase":"stopped-data-retained","recovered":true,"data_retained":true}))
}
/// A completed normalization changes only transient metadata. Keep the original
/// completed receipt as the cleanup proof, and bind its projection separately.
fn normalized_proof_receipt(
    root: &std::path::Path,
    receipt: &Receipt,
    intent: &Intent,
) -> Result<Receipt, CandidateError> {
    if !exists(&root.join("one-off-normalization.json"))? {
        return Ok(receipt.clone());
    }
    let normalization = one_off::normalization::Normalization::read(
        root,
        &digest(&serde_json::to_vec(intent).map_err(|_| refused())?),
    )?;
    if intent.one_off_sha256.as_deref()
        != Some(digest(&serde_json::to_vec(&normalization.job).map_err(|_| refused())?).as_str())
        || normalization.phase != one_off::normalization::Phase::Complete
        || immutable(&normalization.after)? != immutable(receipt)?
        || normalization.before.phase != "stopped-data-retained"
        || intent.complete_sha256.as_deref() != Some(selected(&normalization.before)?.as_str())
    {
        return Err(refused());
    }
    Ok(normalization.before)
}

fn normalize_completed(
    candidate: &Candidate,
    engine: &Engine<'_>,
    root: &std::path::Path,
    intent: &Intent,
) -> Result<Receipt, CandidateError> {
    use one_off::normalization::{Normalization, Phase};
    let proof = digest(&serde_json::to_vec(intent).map_err(|_| refused())?);
    let mut normalization = if exists(&root.join("one-off-normalization.json"))? {
        Normalization::load(root, &proof)?
    } else {
        let before: Receipt = state::read(&root.join("state.json"))?;
        validate(
            intent,
            &before,
            &intent.original_sha256,
            &intent.owner_sha256,
        )?;
        if before.phase != "stopped-data-retained"
            || intent.complete_sha256.as_deref() != Some(selected(&before)?.as_str())
        {
            return Err(refused());
        }
        let job: one_off::JobIntent = state::read(&root.join("one-off.json"))?;
        if intent.one_off_sha256.as_deref()
            != Some(one_off::recovery_selection(root, &intent.original, &intent.old_boot)?.as_str())
        {
            return Err(refused());
        }
        Normalization::prepare(root, &before, &job, &proof)?
    };
    validate(
        intent,
        &normalization.before,
        &intent.original_sha256,
        &intent.owner_sha256,
    )?;
    if intent.new_boot.as_deref() != Some(engine.guest().boot_id())
        || intent.complete_sha256.as_deref() != Some(selected(&normalization.before)?.as_str())
        || intent.one_off_sha256.as_deref()
            != Some(
                digest(&serde_json::to_vec(&normalization.job).map_err(|_| refused())?).as_str(),
            )
    {
        return Err(refused());
    }
    let service = format!("job-{}", normalization.job.job);
    // Name absence also refuses a replacement with a different id, without ever
    // authorizing removal of it or any parent resource.
    crate::provider::engine::require_container_absent(
        engine.guest(),
        &normalization.job.container_name,
    )?;
    if normalization.phase == Phase::Prepared {
        crate::provider::environment_recovery::archive_job(
            candidate,
            engine.guest(),
            &normalization.before.run,
            &service,
            &normalization.job.container_name,
            &root.join(format!("job-environment-{}", normalization.job.job)),
        )?;
        normalization.advance(root, Phase::EnvironmentArchived)?;
    }
    if normalization.phase == Phase::EnvironmentArchived {
        normalization.publish_receipt(root)?;
    }
    if normalization.phase == Phase::ReceiptPublished {
        let history = root.join("job-history");
        state::private_directory(&history)?;
        let destination = history.join(format!("{}.json", normalization.job.job));
        if exists(&root.join("one-off.json"))? {
            let job: one_off::JobIntent = state::read(&root.join("one-off.json"))?;
            if serde_json::to_value(&job).map_err(|_| refused())?
                != serde_json::to_value(&normalization.job).map_err(|_| refused())?
                || exists(&destination)?
            {
                return Err(refused());
            }
            one_off::retain_interrupted_cleanup(root)?;
            fs::rename(root.join("one-off.json"), &destination).map_err(state::io)?;
            for path in [root, history.as_path()] {
                fs::File::open(path)
                    .and_then(|f| f.sync_all())
                    .map_err(state::io)?;
            }
        }
        let archived: one_off::JobIntent = state::read(&destination)?;
        if serde_json::to_value(&archived).map_err(|_| refused())?
            != serde_json::to_value(&normalization.job).map_err(|_| refused())?
        {
            return Err(refused());
        }
        normalization.advance(root, Phase::JournalArchived)?;
    }
    if normalization.phase == Phase::JournalArchived {
        normalization.advance(root, Phase::Complete)?;
    }
    Ok(normalization.after)
}

/// Authorize a distinct explicit data-removal operation from a completed recovery.
/// First admission matches the completed receipt exactly; retries additionally pin
/// this immutable recovery proof while permitting only cleanup phase progress.
pub(super) fn removal_proof(
    root: &std::path::Path,
    receipt: &Receipt,
    owner: &str,
    boot: &str,
    expected: Option<&str>,
) -> Result<String, CandidateError> {
    if exists(&root.join("dead-owner-cleanup.pending"))? {
        return Err(refused());
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    let original_receipt = normalized_proof_receipt(root, receipt, &intent)?;
    validate(&intent, &original_receipt, &intent.original_sha256, owner)?;
    let complete = intent
        .complete_sha256
        .as_deref()
        .filter(|v| hex(v, 64))
        .ok_or_else(refused)?;
    if intent.new_boot.as_deref() != Some(boot) {
        return Err(refused());
    }
    let proof = digest(&serde_json::to_vec(&intent).map_err(|_| refused())?);
    match expected {
        None if receipt.phase == "stopped-data-retained"
            && selected(&original_receipt)? == complete => {}
        Some(value)
            if value == proof
                && ["stopped-data-retained", "cleanup-intent", "removed"]
                    .contains(&receipt.phase.as_str()) => {}
        _ => return Err(refused()),
    }
    Ok(proof)
}

/// Only local retained receipts are covered. Exported receipt-only retention still
/// requires the existing relay acknowledgement; recovery does not fabricate one.
pub(super) fn retained(root: &std::path::Path, receipt: &Receipt) -> Result<bool, CandidateError> {
    if !exists(&root.join(FILE))? {
        return Ok(false);
    }
    if exists(&root.join("dead-owner-cleanup.pending"))? {
        return Err(refused());
    }
    let current: Receipt = state::read(&root.join("state.json"))?;
    if selected(&current)? != selected(receipt)? {
        return Err(refused());
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    // A successful restore retains the recovered generation in bounded history.
    // Once a later generation has its own acknowledged ordinary cleanup, the
    // old sidecar is historical evidence rather than current cleanup authority.
    // Interrupted one-off normalization still needs its exact projection below.
    if intent.one_off_sha256.is_none()
        && intent.complete_sha256.as_deref() != Some(selected(receipt)?.as_str())
    {
        validate(
            &intent,
            &intent.original,
            &intent.original_sha256,
            &intent.owner_sha256,
        )?;
        if intent
            .complete_sha256
            .as_deref()
            .is_none_or(|hash| !hex(hash, 64))
            || intent.new_boot.as_deref().is_none_or(str::is_empty)
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
    let original_receipt = normalized_proof_receipt(root, receipt, &intent)?;
    validate(
        &intent,
        &original_receipt,
        &intent.original_sha256,
        &intent.owner_sha256,
    )?;
    if intent.complete_sha256.as_deref() != Some(selected(&original_receipt)?.as_str())
        || receipt.phase != "stopped-data-retained"
        || immutable(&intent.original)? != immutable(&original_receipt)?
    {
        return Err(refused());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn partial() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"failed-retained","readiness":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},"resources":{
          "container:init":{"kind":"container","key":"init","name":"owned-init","id":"f".repeat(64),"image":format!("sha256:{}","a".repeat(64)),"phase":"started"},
          "container:app":{"kind":"container","key":"app","name":"owned-app","id":null,"image":format!("sha256:{}","a".repeat(64)),"phase":"reserved"},
          "volume:data":{"kind":"volume","key":"data","name":"owned-data","id":null,"image":null,"phase":"created"}
        }})).unwrap()
    }
    fn intent(receipt: &Receipt) -> Intent {
        Intent {
            version: 1,
            original_sha256: selected(receipt).unwrap(),
            owner_sha256: "1".repeat(64),
            old_boot: "old-boot".into(),
            new_boot: None,
            original: receipt.clone(),
            environment: None,
            bridges: None,
            prior_bridges: None,
            complete_sha256: None,
            one_off_sha256: None,
        }
    }
    #[test]
    fn normalized_completion_preserves_original_proof_and_rejects_altered_job() {
        use one_off::normalization::{Normalization, Phase};
        let (fixture, original, job) = one_off::tests::interrupted();
        let mut recovered = original.clone();
        recovered.phase = "stopped-data-retained".into();
        for resource in recovered.resources.values_mut() {
            resource.phase = "absent".into();
        }
        let mut proof = intent(&original);
        proof.one_off_sha256 = Some(digest(&serde_json::to_vec(&job).unwrap()));
        proof.new_boot = Some("new-boot".into());
        proof.complete_sha256 = Some(selected(&recovered).unwrap());
        state::write(&fixture.0.join(FILE), &proof).unwrap();
        state::write(&fixture.0.join("state.json"), &recovered).unwrap();
        let proof_hash = digest(&serde_json::to_vec(&proof).unwrap());
        let mut normalization =
            Normalization::prepare(&fixture.0, &recovered, &job, &proof_hash).unwrap();
        normalization
            .advance(&fixture.0, Phase::EnvironmentArchived)
            .unwrap();
        normalization.publish_receipt(&fixture.0).unwrap();
        normalization
            .advance(&fixture.0, Phase::JournalArchived)
            .unwrap();
        normalization.advance(&fixture.0, Phase::Complete).unwrap();
        assert!(retained(&fixture.0, &normalization.after).unwrap());
        let removal = removal_proof(
            &fixture.0,
            &normalization.after,
            &proof.owner_sha256,
            "new-boot",
            None,
        )
        .unwrap();
        let mut removing = normalization.after.clone();
        removing.phase = "cleanup-intent".into();
        assert_eq!(
            removal_proof(
                &fixture.0,
                &removing,
                &proof.owner_sha256,
                "new-boot",
                Some(&removal)
            )
            .unwrap(),
            removal
        );
        // Keep the recovery hash constant while changing a non-projection job
        // field: the independently pinned job hash must still reject it.
        normalization.job.generation = "9".repeat(64);
        state::write(
            &fixture.0.join("one-off-normalization.json"),
            &normalization,
        )
        .unwrap();
        assert!(retained(&fixture.0, &normalization.after).is_err());
        assert!(
            removal_proof(
                &fixture.0,
                &normalization.after,
                &proof.owner_sha256,
                "new-boot",
                None
            )
            .is_err()
        );
    }

    #[test]
    fn completed_recovery_removal_pins_owner_boot_completion_and_resume() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt = partial();
        let mut intent = intent(&receipt);
        receipt.phase = "stopped-data-retained".into();
        for r in receipt
            .resources
            .values_mut()
            .filter(|r| r.kind != Kind::Volume)
        {
            r.phase = "absent".into();
        }
        intent.new_boot = Some("new-boot".into());
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        assert!(
            removal_proof(&fixture.0, &receipt, &intent.owner_sha256, "new-boot", None).is_err()
        );
        intent.complete_sha256 = Some(selected(&receipt).unwrap());
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        let proof =
            removal_proof(&fixture.0, &receipt, &intent.owner_sha256, "new-boot", None).unwrap();
        assert!(removal_proof(&fixture.0, &receipt, &"9".repeat(64), "new-boot", None).is_err());
        assert!(
            removal_proof(
                &fixture.0,
                &receipt,
                &intent.owner_sha256,
                "other-boot",
                None
            )
            .is_err()
        );
        for phase in ["cleanup-intent", "removed"] {
            receipt.phase = phase.into();
            receipt.resources.get_mut("volume:data").unwrap().phase = "absent".into();
            assert_eq!(
                removal_proof(
                    &fixture.0,
                    &receipt,
                    &intent.owner_sha256,
                    "new-boot",
                    Some(&proof)
                )
                .unwrap(),
                proof
            );
            assert!(
                removal_proof(&fixture.0, &receipt, &intent.owner_sha256, "new-boot", None)
                    .is_err()
            );
        }
        intent.complete_sha256 = Some("8".repeat(64));
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        assert!(
            removal_proof(
                &fixture.0,
                &receipt,
                &intent.owner_sha256,
                "new-boot",
                Some(&proof)
            )
            .is_err()
        );
        receipt.phase = "stopped-data-retained".into();
        assert!(
            removal_proof(&fixture.0, &receipt, &intent.owner_sha256, "new-boot", None).is_err()
        );
        receipt.resources.get_mut("volume:data").unwrap().name = "foreign".into();
        assert!(
            removal_proof(
                &fixture.0,
                &receipt,
                &intent.owner_sha256,
                "new-boot",
                Some(&proof)
            )
            .is_err()
        );
    }
    #[test]
    fn partial_provision_cleanup_progress_retains_volume_and_exact_identity() {
        let original = partial();
        let intent = intent(&original);
        let mut progress = original.clone();
        progress.phase = "cleanup-intent".into();
        progress.resources.get_mut("container:init").unwrap().phase = "absent".into();
        assert!(
            validate(
                &intent,
                &progress,
                &intent.original_sha256,
                &intent.owner_sha256
            )
            .is_ok()
        );
        progress.resources.get_mut("container:app").unwrap().phase = "absent".into();
        progress.phase = "stopped-data-retained".into();
        assert!(
            validate(
                &intent,
                &progress,
                &intent.original_sha256,
                &intent.owner_sha256
            )
            .is_ok()
        );
        assert_eq!(progress.resources["volume:data"].phase, "created");
        assert_ne!(selected(&progress).unwrap(), intent.original_sha256);
    }
    #[test]
    fn boot_selection_cannot_roll_over_or_use_same_boot() {
        let mut intent = intent(&partial());
        for (prior, current) in [
            (None, "next"),
            (Some("foreign"), "next"),
            (Some("old-boot"), "old-boot"),
        ] {
            assert!(fresh_boot(&intent, prior, current).is_err());
        }
        assert!(fresh_boot(&intent, Some("old-boot"), "next").is_ok());
        intent.new_boot = Some("next".into());
        assert!(fresh_boot(&intent, Some("old-boot"), "third").is_err());
        assert!(fresh_boot(&intent, Some("old-boot"), "next").is_ok());
    }
    #[test]
    fn stale_pins_and_changed_resource_identity_refuse() {
        let receipt = partial();
        let intent = intent(&receipt);
        assert!(validate(&intent, &receipt, &"2".repeat(64), &intent.owner_sha256).is_err());
        assert!(validate(&intent, &receipt, &intent.original_sha256, &"2".repeat(64)).is_err());
        for field in ["owner", "plan_id", "namespace"] {
            let mut value = serde_json::to_value(&receipt).unwrap();
            value[field] = json!("2".repeat(64));
            let changed: Receipt = serde_json::from_value(value).unwrap();
            assert!(
                validate(
                    &intent,
                    &changed,
                    &intent.original_sha256,
                    &intent.owner_sha256
                )
                .is_err()
            );
        }
        for field in ["id", "name", "image"] {
            let mut value = serde_json::to_value(&receipt).unwrap();
            value["resources"]["container:init"][field] = json!("changed");
            let changed: Receipt = serde_json::from_value(value).unwrap();
            assert!(
                validate(
                    &intent,
                    &changed,
                    &intent.original_sha256,
                    &intent.owner_sha256
                )
                .is_err()
            );
        }
    }
    #[test]
    fn completion_is_receipt_pinned_and_interrupted_bytes_never_become_authority() {
        let fixture = super::super::tests::Fixture::new();
        state::private_directory(&fixture.0).unwrap();
        let mut receipt = partial();
        let mut intent = intent(&receipt);
        receipt.phase = "stopped-data-retained".into();
        state::write(&fixture.0.join("state.json"), &receipt).unwrap();
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        assert!(retained(&fixture.0, &receipt).is_err());
        intent.complete_sha256 = Some(selected(&receipt).unwrap());
        state::write(&fixture.0.join(FILE), &intent).unwrap();
        assert!(retained(&fixture.0, &receipt).unwrap());
        fs::write(
            fixture.0.join("dead-owner-cleanup.pending"),
            b"untrusted partial bytes",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            fixture.0.join("dead-owner-cleanup.pending"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        retain_interrupted_write(&fixture.0).unwrap();
        let saved: Intent = state::read(&fixture.0.join(FILE)).unwrap();
        assert_eq!(saved.complete_sha256, intent.complete_sha256);
        assert!(!fixture.0.join("dead-owner-cleanup.pending").exists());
        receipt.resources.get_mut("volume:data").unwrap().name = "foreign".into();
        state::write(&fixture.0.join("state.json"), &receipt).unwrap();
        assert!(retained(&fixture.0, &receipt).is_err());
    }

    #[test]
    fn later_clean_generation_uses_its_own_retention_after_dead_owner_restore() {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        let original = partial();
        let mut recovered = original.clone();
        recovered.phase = "stopped-data-retained".into();
        for resource in recovered.resources.values_mut() {
            if resource.kind != Kind::Volume {
                resource.phase = "absent".into();
            }
        }
        let mut proof = intent(&original);
        proof.new_boot = Some("new-boot".into());
        proof.complete_sha256 = Some(selected(&recovered).unwrap());
        state::write(&root.join(FILE), &proof).unwrap();
        state::write(&root.join("state.json"), &recovered).unwrap();
        assert!(retained(root, &recovered).unwrap());
        restore_history::retain(root, &recovered).unwrap();

        let mut later = recovered.clone();
        later.relay_startup = None;
        later.resources.get_mut("container:init").unwrap().id = Some("9".repeat(64));
        state::write(&root.join("state.json"), &later).unwrap();
        assert!(!retained(root, &later).unwrap());

        let mut unacknowledged = later.clone();
        unacknowledged.relay_startup = original.relay_startup.clone();
        state::write(&root.join("state.json"), &unacknowledged).unwrap();
        assert!(retained(root, &unacknowledged).is_err());
        state::write(&root.join("state.json"), &later).unwrap();

        for generation in 1..=10 {
            restore_history::retain(root, &later).unwrap();
            later.resources.get_mut("container:init").unwrap().id =
                Some(format!("{generation:064x}"));
            state::write(&root.join("state.json"), &later).unwrap();
            assert!(!retained(root, &later).unwrap());
        }

        let mut foreign: serde_json::Value =
            state::read(&root.join("restore-history.json")).unwrap();
        foreign["entries"][0]["owner"] = json!("f".repeat(32));
        state::write(&root.join("restore-history.json"), &foreign).unwrap();
        assert!(retained(root, &later).is_err());
    }
}
