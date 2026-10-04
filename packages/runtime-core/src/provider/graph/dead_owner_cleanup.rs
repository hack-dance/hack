//! Explicit recovery selects VM stop plus owner death before reboot, or a dead
//! ready owner (including a journal-bound one-off) from the immediate predecessor boot.
//! No endpoint-file deletion is treated as a relay retirement acknowledgement.
use super::*;
use crate::provider::{identity, lifecycle, state::Owner};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
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
/// Dispatch only an exact completed recovery generation; history is inert.
pub(super) fn current_completion(
    root: &std::path::Path,
    receipt: &Receipt,
) -> Result<bool, CandidateError> {
    if !exists(&root.join(FILE))? {
        return Ok(false);
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    let complete = selected(receipt)?;
    Ok(intent.complete_sha256.as_deref() == Some(complete.as_str()))
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
pub(super) fn immutable(receipt: &Receipt) -> Result<Value, CandidateError> {
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

/// Supersede only a completed prior recovery whose historical generation is
/// independently validated against bounded history. An atomic rename keeps
/// the old value-free proof if selection or publication is interrupted.
fn archive_completed_prior(
    root: &std::path::Path,
    current: &Receipt,
    expected: &str,
    dead_owner: &str,
    boot: &str,
) -> Result<(), CandidateError> {
    let path = root.join(FILE);
    if !exists(&path)? {
        return Ok(());
    }
    let prior: Intent = state::read(&path)?;
    if prior.original_sha256 == expected && prior.owner_sha256 == dead_owner {
        return Ok(());
    }
    let interrupted_enrollment = current.phase == "cleanup-intent"
        && current.relay_cleanup.as_ref().is_some_and(|marker| {
            marker.valid() && marker.phase == cleanup_enrollment::Phase::Pending
        });
    if (current.phase != "ready-observed" && !interrupted_enrollment)
        || selected(current)? != expected
        || prior.one_off_sha256.is_some()
        || prior
            .complete_sha256
            .as_deref()
            .is_none_or(|hash| !hex(hash, 64))
        || prior
            .new_boot
            .as_deref()
            .is_none_or(|old| old.is_empty() || old == boot)
        || prior.original.run != current.run
        || prior.original.owner != current.owner
        || prior.original.namespace != current.namespace
        || prior.original.plan_id != current.plan_id
        || exists(&root.join("dead-owner-cleanup.pending"))?
    {
        return Err(refused());
    }
    let complete = prior.complete_sha256.as_deref().ok_or_else(refused)?;
    if let Some(stopped) = restore_history::completed_for_recovery(root, current, complete)? {
        validate(
            &prior,
            &stopped,
            &prior.original_sha256,
            &prior.owner_sha256,
        )?;
        if !stopped.resources.iter().any(|(key, resource)| {
            resource.kind == Kind::Container
                && resource.id.as_deref().is_some_and(|old| {
                    current.resources.get(key).and_then(|now| now.id.as_deref()) != Some(old)
                })
        }) {
            return Err(refused());
        }
    } else {
        // Bounded history may evict the exact completion. Its existing strict
        // truncated-history proof must still establish a superseded generation.
        require_historical_recovery(root, current)?;
    }
    let mut archived = 0;
    for entry in fs::read_dir(root).map_err(state::io)? {
        let name = entry.map_err(state::io)?.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.starts_with("dead-owner-cleanup-retired-"))
        {
            archived += 1;
            if archived >= 8 {
                return Err(refused());
            }
        }
    }
    let target = root.join(format!("dead-owner-cleanup-retired-{complete}.json"));
    if exists(&target)? {
        return Err(refused());
    }
    fs::rename(&path, &target).map_err(state::io)?;
    fs::File::open(root)
        .and_then(|file| file.sync_all())
        .map_err(state::io)
}

/// A completed recovery from an older container generation is diagnostic history,
/// not a pending operation. Prefer its exact stopped receipt; after history
/// truncation, validate the superseded original and a newer stopped generation.
/// Neither path supplies current cleanup authority or mutates the old proof.
pub(super) fn require_historical_recovery(
    root: &std::path::Path,
    current: &Receipt,
) -> Result<(), CandidateError> {
    if exists(&root.join("dead-owner-cleanup.pending"))? {
        return Err(refused());
    }
    if !exists(&root.join(FILE))? {
        return Ok(());
    }
    let prior: Intent = state::read(&root.join(FILE))?;
    let complete = prior.complete_sha256.as_deref().ok_or_else(refused)?;
    if !hex(complete, 64)
        || prior.one_off_sha256.is_some()
        || prior
            .new_boot
            .as_deref()
            .is_none_or(|boot| boot.is_empty() || boot == prior.old_boot)
    {
        return Err(refused());
    }
    let stopped = restore_history::completed_for_recovery(root, current, complete)?;
    let historical = stopped.as_ref().unwrap_or(&prior.original);
    validate(
        &prior,
        historical,
        &prior.original_sha256,
        &prior.owner_sha256,
    )?;
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
    if !historical.resources.iter().any(|(key, old)| {
        old.kind == Kind::Container
            && old.id.as_ref().is_some_and(|id| {
                current
                    .resources
                    .get(key)
                    .and_then(|now| now.id.as_ref())
                    .is_some_and(|current_id| current_id != id)
            })
    }) {
        return Err(refused());
    }
    Ok(())
}

/// A bridge sidecar from a restored generation can be superseded only when
/// its exact stopped receipt and selected bridge assignments have a completed,
/// archived dead-owner recovery proof.
pub(super) fn retired_prior_bridges(
    root: &std::path::Path,
    receipt: &Receipt,
    selection: &bridges::cleanup::Selection,
) -> Result<bool, CandidateError> {
    let complete = selected(receipt)?;
    let path = root.join(format!("dead-owner-cleanup-retired-{complete}.json"));
    if !exists(&path)? {
        return Ok(false);
    }
    let intent: Intent = state::read(&path)?;
    validate(
        &intent,
        receipt,
        &intent.original_sha256,
        &intent.owner_sha256,
    )?;
    if receipt.phase != "stopped-data-retained"
        || intent.complete_sha256.as_deref() != Some(complete.as_str())
        || intent.new_boot.as_deref().is_none_or(str::is_empty)
        || intent.bridges.as_ref() != Some(selection)
        || intent.one_off_sha256.is_some()
    {
        return Err(refused());
    }
    Ok(true)
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

/// A current completed dead-owner cleanup outranks only a *validated historical*
/// live-owner sidecar for retention or publisher retirement. This selection
/// does not replace either operation's exact receipt and inventory checks.
pub(super) fn current_completed_precedence(
    root: &std::path::Path,
    receipt: &Receipt,
) -> Result<bool, CandidateError> {
    if !current_completion(root, receipt)? {
        return Ok(false);
    }
    super::live_owner_cleanup::require_historical_recovery(root, receipt)?;
    Ok(true)
}

/// Holds the retired publisher and provider cleanup leases while an exact
/// previous-boot shared HTTPS owner is archived. Neither pathname absence nor
/// a merely stopped graph grants this authority.
pub(in crate::provider) struct HttpsArchiveGuard<'a> {
    retired: foreground::transport::Retired,
    engine: Engine<'a>,
    run: String,
    owner: String,
    namespace: String,
    plan: String,
    old_boot: String,
}

impl<'a> HttpsArchiveGuard<'a> {
    pub(in crate::provider) fn acquire(
        candidate: &'a Candidate,
        run: &str,
        owner: &str,
        namespace: &str,
        plan: &str,
        old_boot: &str,
    ) -> Result<Self, CandidateError> {
        // Admission is held by the caller. The publisher lock precedes the
        // provider lease, matching the existing retained-data recovery order.
        let retired =
            foreground::transport::Retired::acquire(candidate, run)?.ok_or_else(refused)?;
        let engine = Engine::connect_cleanup_wait(candidate)?;
        let guard = Self {
            retired,
            engine,
            run: run.into(),
            owner: owner.into(),
            namespace: namespace.into(),
            plan: plan.into(),
            old_boot: old_boot.into(),
        };
        guard.verify(candidate)?;
        Ok(guard)
    }

    pub(in crate::provider) fn current_boot(&self) -> &str {
        self.engine.guest().boot_id()
    }

    /// Recheck under both held leases immediately before each archive effect.
    pub(in crate::provider) fn verify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        self.retired.verify()?;
        let (receipt, root) = load(candidate, &self.engine, &self.run)?;
        no_pending(&root)?;
        if receipt.phase != "stopped-data-retained"
            || receipt.owner != self.owner
            || receipt.namespace != self.namespace
            || receipt.plan_id != self.plan
            || !current_completed_precedence(&root, &receipt)?
            || !retained(&root, &receipt)?
        {
            return Err(refused());
        }
        initializer_cache::require_resolved(&receipt)?;
        let intent: Intent = state::read(&root.join(FILE))?;
        let complete = selected(&receipt)?;
        validate(
            &intent,
            &receipt,
            &intent.original_sha256,
            &intent.owner_sha256,
        )?;
        let pool = Owner::load(candidate)?;
        if intent.complete_sha256.as_deref() != Some(complete.as_str())
            || intent.old_boot != self.old_boot
            || intent.new_boot.as_deref() != Some(self.engine.guest().boot_id())
            || pool.previous_guest_boot_id.as_deref() != Some(self.old_boot.as_str())
            || pool.guest_boot_id.as_deref() != Some(self.engine.guest().boot_id())
            || pool.token != receipt.owner
            || intent.one_off_sha256.is_some()
        {
            return Err(refused());
        }
        let witness = super::host_pin_recovery::load_witness(candidate, &self.run)?.filter(|w| {
            w.graph_sha256() == intent.original_sha256
                && w.publisher_sha256() == intent.owner_sha256
                && w.matches_graph(&intent.original)
        });
        self.retired.verify_recovery_with_rebind(
            candidate,
            &self.run,
            &intent.owner_sha256,
            &complete,
            witness.as_ref().map(|w| w.rebind()),
        )?;
        for resource in receipt.resources.values() {
            let observed = inspect_resource(&self.engine, &receipt, resource)?;
            if (resource.kind == Kind::Volume && observed.is_none())
                || (resource.kind != Kind::Volume
                    && (resource.phase != "absent" || observed.is_some()))
            {
                return Err(refused());
            }
        }
        let environment = environment::cleanup_inventory(candidate, &self.engine, &receipt, &root)?;
        if intent.environment.as_ref()
            != Some(&serde_json::to_value(&environment).map_err(|_| refused())?)
        {
            return Err(refused());
        }
        let bridges = intent.bridges.as_ref().ok_or_else(refused)?;
        bridges::cleanup::verify_recovery_file(&root, bridges, intent.prior_bridges.as_ref())?;
        let active = bridges::inspect_bridges_using(candidate, &self.engine, &self.run)?;
        if active["slots"]
            .as_object()
            .is_none_or(|slots| !slots.is_empty())
        {
            return Err(refused());
        }
        host_relay::inspect_cleanup_recovery(
            candidate,
            &self.engine,
            &receipt,
            false,
            &environment,
            bridges,
            witness.as_ref(),
        )?;
        super::super::publication::require_no_claims_locked(candidate, &receipt.owner)?;
        let authority = super::super::hostname_authority::managed::inspect(candidate)?;
        if authority["authority"]["present"] != false {
            return Err(refused());
        }
        self.engine.guest().verify()
    }
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
    if let Some(result) =
        super::acknowledged_publisher::confirm_retired(candidate, run, expected_owner)?
    {
        return Ok(result);
    }
    let dead_owner_current = {
        let engine = Engine::connect_cleanup_wait(candidate)?;
        let (receipt, root) = load(candidate, &engine, run)?;
        current_completed_precedence(&root, &receipt)?
    };
    if !dead_owner_current {
        if let Some(result) = super::live_owner_cleanup::retire(candidate, run, expected_owner)? {
            return Ok(result);
        }
    }
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    // Dispatch crossed a cleanup lease boundary. Revalidate the current proof
    // and historical sidecar under the lease that protects retirement effects.
    if dead_owner_current && !current_completed_precedence(&root, &receipt)? {
        return Err(refused());
    }
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
        || intent.new_boot.as_deref().is_none_or(str::is_empty)
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
    let legacy = super::host_pin_recovery::load_witness(candidate, run)?.filter(|witness| {
        witness.graph_sha256() == intent.original_sha256
            && witness.publisher_sha256() == intent.owner_sha256
            && witness.matches_graph(&intent.original)
    });
    if intent.new_boot.as_deref() == Some(engine.guest().boot_id()) {
        if let Some(witness) = legacy {
            if let Some(retired) = foreground::transport::Retired::acquire(candidate, run)? {
                let control_root = witness.control_root().join("relay-control");
                let control_lock = state::Lock::acquire_existing(&control_root)?;
                host_relay::inspect_cleanup_recovery(
                    candidate,
                    &engine,
                    &receipt,
                    false,
                    &environment,
                    bridges,
                    Some(&witness),
                )?;
                let lock_path = fs::symlink_metadata(control_root.join("operation.lock"))
                    .map_err(|_| refused())?;
                if (lock_path.dev(), lock_path.ino()) != control_lock.identity()? {
                    return Err(refused());
                }
                retired.verify_recovery_with_rebind(
                    candidate,
                    run,
                    &intent.owner_sha256,
                    &complete,
                    Some(witness.rebind()),
                )?;
            } else {
                let foreground_root = foreground::transport::root(candidate, run)?;
                let foreground_lock = state::Lock::acquire_existing(&foreground_root)?;
                let guard = super::host_pin_recovery::acquire_for_cleanup(
                    candidate,
                    run,
                    &engine,
                    super::host_pin_recovery::CleanupProof {
                        original: &intent.original,
                        sha256: &intent.original_sha256,
                        current_is_original: false,
                        allow_absent_reservation: true,
                        publisher_may_be_partial: true,
                    },
                    witness,
                )?;
                host_relay::inspect_cleanup_recovery(
                    candidate,
                    &engine,
                    &receipt,
                    false,
                    &environment,
                    bridges,
                    Some(guard.witness()),
                )?;
                guard.verify_lock()?;
                let lock_path = fs::symlink_metadata(foreground_root.join("operation.lock"))
                    .map_err(|_| refused())?;
                if (lock_path.dev(), lock_path.ino()) != foreground_lock.identity()? {
                    return Err(refused());
                }
                foreground::transport::retire_recovered_publisher_locked(
                    candidate,
                    run,
                    &intent.owner_sha256,
                    &complete,
                    Some(guard.witness().rebind()),
                    &foreground_lock,
                )?;
            }
        } else {
            host_relay::inspect_cleanup(
                candidate,
                &engine,
                &receipt,
                false,
                &environment,
                bridges,
            )?;
            foreground::retire_publisher_path(candidate, run, &intent.owner_sha256, &complete)?;
        }
    } else {
        // A later VM boot has a new bridge registry generation. Recheck the
        // retained graph and immutable prior proof, then require the publisher
        // to have been fully retired under the original recovery boot.
        foreground::transport::verify_recovered_publisher_retired_recovery(
            candidate,
            run,
            &intent.owner_sha256,
            &complete,
            legacy.as_ref().map(|witness| witness.rebind()),
        )?;
    }
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
/// `current` must come from the leased previous-boot capture, which verifies the
/// predecessor publication. The interrupted operation's own pre-effect sidecar
/// needs no restore history; superseding a historical generation still does.
fn require_prior_bridge_history(
    root: &std::path::Path,
    current: &bridges::cleanup::Selection,
    receipt: &Receipt,
    prior: Option<&Value>,
) -> Result<(), CandidateError> {
    let Some(prior) = prior else {
        return Ok(());
    };
    let prior: bridges::cleanup::Selection =
        serde_json::from_value(prior.clone()).map_err(|_| refused())?;
    if bridges::cleanup::interrupted_release(&prior, current, receipt)
        || restore_history::confirms_prior_generation(root, receipt)?
    {
        Ok(())
    } else {
        Err(refused())
    }
}

fn execute(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let selected_pin = super::host_pin_recovery::selected_for_old_publisher(candidate, run)?;
    let dead = foreground::DeadOwner::acquire_recovery(
        candidate,
        run,
        selected_pin.as_ref().map(|pin| pin.rebind()),
        selected_pin.as_ref().map(|pin| pin.host_boot_micros()),
    )?;
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
    archive_completed_prior(
        &root,
        &receipt,
        expected,
        &dead.fingerprint(),
        engine.guest().boot_id(),
    )?;
    let existing_intent: Option<Intent> = if exists(&root.join(FILE))? {
        Some(state::read(&root.join(FILE))?)
    } else {
        None
    };
    let pin_guard = if let Some(witness) = selected_pin {
        let original = existing_intent
            .as_ref()
            .map_or(&receipt, |intent| &intent.original);
        let original_sha = existing_intent
            .as_ref()
            .map_or(expected, |intent| intent.original_sha256.as_str());
        Some(super::host_pin_recovery::acquire_for_cleanup(
            candidate,
            run,
            &engine,
            super::host_pin_recovery::CleanupProof {
                original,
                sha256: original_sha,
                current_is_original: existing_intent.is_none(),
                allow_absent_reservation: existing_intent
                    .as_ref()
                    .is_some_and(|intent| intent.complete_sha256.is_some()),
                publisher_may_be_partial: false,
            },
            witness,
        )?)
    } else {
        None
    };
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
        let interrupted_enrollment = receipt.phase == "cleanup-intent"
            && receipt.relay_cleanup.as_ref().is_some_and(|marker| {
                marker.valid()
                    && marker.phase == cleanup_enrollment::Phase::Pending
                    && host_relay::context(&receipt.owner, &old_boot).is_ok_and(|context| {
                        marker.runtime == context.runtime && marker.boot == context.boot
                    })
            })
            && exists(&root.join("relay-cleanup-bridges.json"))?;
        if (receipt.phase != "ready-observed"
            && !interrupted_enrollment
            && one_off_sha256.is_none())
            || receipt.relay_startup.is_none()
            || (receipt.relay_cleanup.is_some() && !interrupted_enrollment)
            || selected(&receipt)? != expected
        {
            return Err(refused());
        }
        initializer_cache::require_resolved(&receipt)?;
        let bridges = bridges::cleanup::capture_previous_boot(
            candidate,
            &engine,
            &receipt,
            &old_boot,
            pin_guard.as_ref().map(|guard| guard.witness()),
        )?;
        let prior_bridges = bridges::cleanup::capture_prior_generation(&root, &bridges, &receipt)?;
        require_prior_bridge_history(&root, &bridges, &receipt, prior_bridges.as_ref())?;
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
    if let Some(guard) = &pin_guard {
        if guard.witness().publisher_sha256() != dead.fingerprint() {
            return Err(refused());
        }
        guard.verify_lock()?;
    }
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
            bridges::cleanup::verify_remaining_recovery(
                candidate,
                &engine,
                &receipt,
                selection,
                pin_guard.as_ref().map(|guard| guard.witness()),
            )?;
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
                pin_guard.as_ref().map(|guard| guard.witness()),
            )?;
            let prior = bridges::cleanup::capture_prior_generation(&root, &selection, &receipt)?;
            require_prior_bridge_history(&root, &selection, &receipt, prior.as_ref())?;
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
        host_relay::inspect_cleanup_recovery(
            candidate,
            &engine,
            &receipt,
            false,
            &environment,
            &bridges,
            pin_guard.as_ref().map(|guard| guard.witness()),
        )?;
        dead.verify()?;
        startup::archive_dependency_rebind_after_cleanup(
            &root,
            &intent.original,
            &receipt,
            &intent.old_boot,
        )?;
        super::dependency_slots::recover_cleaned(
            candidate,
            &receipt,
            pin_guard.as_ref().and_then(|guard| {
                guard
                    .witness()
                    .reservation()
                    .map(|reservation| (guard.witness().rebind(), reservation))
            }),
        )?;
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
    if let Some(guard) = &pin_guard {
        guard.verify_lock()?;
    }
    let cleaned = cleanup_owned(candidate, &engine, receipt, &root, false)?;
    host_relay::inspect_cleanup_recovery(
        candidate,
        &engine,
        &cleaned,
        false,
        &environment,
        &bridges,
        pin_guard.as_ref().map(|guard| guard.witness()),
    )?;
    dead.verify()?;
    startup::archive_dependency_rebind_after_cleanup(
        &root,
        &intent.original,
        &cleaned,
        &intent.old_boot,
    )?;
    intent.complete_sha256 = Some(selected(&cleaned)?);
    retain_interrupted_write(&root)?;
    state::write(&root.join(FILE), &intent)?;
    super::dependency_slots::recover_cleaned(
        candidate,
        &cleaned,
        pin_guard.as_ref().and_then(|guard| {
            guard
                .witness()
                .reservation()
                .map(|reservation| (guard.witness().rebind(), reservation))
        }),
    )?;
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
    let proof = removal_selection(root, receipt, boot, expected)?;
    if proof.owner != owner {
        return Err(refused());
    }
    Ok(proof.digest)
}

/// Immutable recovery pins must also match the archived publisher before a
/// retired-owner guard can authorize removal. Receipt phases may advance on retry.
pub(super) struct RemovalProof {
    pub owner: String,
    pub complete: String,
    pub digest: String,
}
pub(super) fn removal_selection(
    root: &std::path::Path,
    receipt: &Receipt,
    boot: &str,
    expected: Option<&str>,
) -> Result<RemovalProof, CandidateError> {
    if exists(&root.join("dead-owner-cleanup.pending"))? {
        return Err(refused());
    }
    let intent: Intent = state::read(&root.join(FILE))?;
    let original_receipt = normalized_proof_receipt(root, receipt, &intent)?;
    validate(
        &intent,
        &original_receipt,
        &intent.original_sha256,
        &intent.owner_sha256,
    )?;
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
    Ok(RemovalProof {
        owner: intent.owner_sha256.clone(),
        complete: complete.into(),
        digest: proof,
    })
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
    fn interrupted_bridge_selection_does_not_require_a_restored_generation() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt = partial();
        receipt.phase = "cleanup-intent".into();
        let context = host_relay::context(&receipt.owner, "old-boot").unwrap();
        receipt.relay_cleanup = Some(cleanup_enrollment::RelayCleanup {
            version: 1,
            runtime: context.runtime,
            boot: context.boot,
            operation: [1; 16],
            effect: [1; 32],
            control_root: "/private/owned".into(),
            phase: cleanup_enrollment::Phase::Pending,
        });
        let prior = json!({
            "version":1,"owner":receipt.owner,"boot":"old-boot",
            "run":receipt.run,"plan":receipt.plan_id,"capacity":2,
            "serial":1,"selected":{}
        });
        let mut current = prior.clone();
        current["boot"] = json!("new-boot");
        current["previous_boot"] = json!("old-boot");
        current["predecessor_owner"] = json!("1".repeat(64));
        let selection = serde_json::from_value(current.clone()).unwrap();
        assert!(!restore_history::confirms_prior_generation(&fixture.0, &receipt).unwrap());
        assert!(
            require_prior_bridge_history(&fixture.0, &selection, &receipt, Some(&prior)).is_ok()
        );
        assert!(require_prior_bridge_history(&fixture.0, &selection, &receipt, None).is_ok());

        for field in [
            "owner",
            "run",
            "plan",
            "capacity",
            "serial",
            "previous_boot",
            "predecessor_owner",
        ] {
            let mut changed = current.clone();
            changed[field] = match field {
                "capacity" => json!(3),
                "serial" => json!(0),
                "predecessor_owner" => Value::Null,
                "owner" | "run" => json!("9".repeat(32)),
                "plan" => json!("9".repeat(64)),
                _ => json!("foreign-boot"),
            };
            let changed = serde_json::from_value(changed).unwrap();
            assert!(
                require_prior_bridge_history(&fixture.0, &changed, &receipt, Some(&prior)).is_err(),
                "{field}"
            );
        }
        let mut ready = receipt.clone();
        ready.phase = "ready-observed".into();
        assert!(
            require_prior_bridge_history(&fixture.0, &selection, &ready, Some(&prior)).is_err()
        );
        receipt.relay_cleanup.as_mut().unwrap().phase = cleanup_enrollment::Phase::Confirmed;
        assert!(
            require_prior_bridge_history(&fixture.0, &selection, &receipt, Some(&prior)).is_err()
        );
        assert!(
            require_prior_bridge_history(
                &fixture.0,
                &selection,
                &receipt,
                Some(&json!({"foreign":true}))
            )
            .is_err()
        );
        assert!(!fixture.0.join("dead-owner-cleanup.json").exists());
    }
    #[test]
    fn current_recovery_dispatch_does_not_select_historical_completion() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt = partial();
        receipt.phase = "stopped-data-retained".into();
        assert!(!current_completion(&fixture.0, &receipt).unwrap());
        let mut proof = intent(&receipt);
        proof.complete_sha256 = Some(selected(&receipt).unwrap());
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
    fn archived_bridge_proof_requires_exact_stopped_receipt_and_selection() {
        let fixture = super::super::tests::Fixture::new();
        let original = partial();
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        let selection: bridges::cleanup::Selection = serde_json::from_value(json!({
            "version":1,"owner":original.owner,"boot":"prior-boot",
            "run":original.run,"plan":original.plan_id,"capacity":0,
            "serial":1,"selected":{}
        }))
        .unwrap();
        let mut proof = intent(&original);
        proof.new_boot = Some("prior-boot".into());
        proof.complete_sha256 = Some(selected(&stopped).unwrap());
        proof.bridges = Some(selection.clone());
        let path = fixture.0.join(format!(
            "dead-owner-cleanup-retired-{}.json",
            selected(&stopped).unwrap()
        ));
        assert!(!retired_prior_bridges(&fixture.0, &stopped, &selection).unwrap());
        state::write(&path, &proof).unwrap();
        assert!(retired_prior_bridges(&fixture.0, &stopped, &selection).unwrap());
        let changed: bridges::cleanup::Selection = serde_json::from_value(json!({
            "version":1,"owner":original.owner,"boot":"other-boot",
            "run":original.run,"plan":original.plan_id,"capacity":0,
            "serial":1,"selected":{}
        }))
        .unwrap();
        assert!(retired_prior_bridges(&fixture.0, &stopped, &changed).is_err());
        proof.complete_sha256 = Some("f".repeat(64));
        state::write(&path, &proof).unwrap();
        assert!(retired_prior_bridges(&fixture.0, &stopped, &selection).is_err());
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
        let selected = removal_selection(&fixture.0, &receipt, "new-boot", None).unwrap();
        assert_eq!(selected.owner, intent.owner_sha256);
        assert_eq!(Some(&selected.complete), intent.complete_sha256.as_ref());
        assert_eq!(selected.digest, proof);
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
            let retry = removal_selection(&fixture.0, &receipt, "new-boot", Some(&proof)).unwrap();
            assert_eq!(retry.complete, selected.complete);
            assert_eq!(retry.owner, selected.owner);
            assert_eq!(retry.digest, selected.digest);
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

    #[test]
    fn repeated_dead_owner_recovery_archives_only_exact_completed_generation() {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        let original = partial();
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        for resource in stopped.resources.values_mut() {
            if resource.kind != Kind::Volume {
                resource.phase = "absent".into();
            }
        }
        restore_history::retain(root, &stopped).unwrap();
        let mut proof = intent(&original);
        proof.new_boot = Some("prior-boot".into());
        let complete = selected(&stopped).unwrap();
        proof.complete_sha256 = Some(complete.clone());
        state::write(&root.join(FILE), &proof).unwrap();
        let mut current = stopped.clone();
        current.phase = "ready-observed".into();
        current.resources.get_mut("container:init").unwrap().id = Some("9".repeat(64));
        let selected_current = selected(&current).unwrap();
        archive_completed_prior(
            root,
            &current,
            &selected_current,
            &"2".repeat(64),
            "current-boot",
        )
        .unwrap();
        assert!(!root.join(FILE).exists());
        assert!(
            root.join(format!("dead-owner-cleanup-retired-{complete}.json"))
                .exists()
        );
        archive_completed_prior(
            root,
            &current,
            &selected_current,
            &"2".repeat(64),
            "current-boot",
        )
        .unwrap();
        state::write(&root.join(FILE), &proof).unwrap();
        current.resources.get_mut("container:init").unwrap().id =
            stopped.resources["container:init"].id.clone();
        let same_generation = selected(&current).unwrap();
        assert!(
            archive_completed_prior(
                root,
                &current,
                &same_generation,
                &"2".repeat(64),
                "current-boot",
            )
            .is_err()
        );
        assert!(root.join(FILE).exists());
    }

    #[test]
    fn repeated_recovery_refuses_unproven_prior_completion_without_moving_evidence() {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        let original = partial();
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        let mut current = stopped.clone();
        current.phase = "ready-observed".into();
        current.resources.get_mut("container:init").unwrap().id = Some("9".repeat(64));
        let mut proof = intent(&original);
        proof.new_boot = Some("prior-boot".into());
        proof.complete_sha256 = Some(selected(&stopped).unwrap());
        state::write(&root.join(FILE), &proof).unwrap();
        let attempt = || {
            archive_completed_prior(
                root,
                &current,
                &selected(&current).unwrap(),
                &"2".repeat(64),
                "current-boot",
            )
        };
        assert!(attempt().is_err(), "missing durable history must refuse");
        restore_history::retain(root, &stopped).unwrap();
        proof.complete_sha256 = Some("8".repeat(64));
        state::write(&root.join(FILE), &proof).unwrap();
        assert!(attempt().is_err(), "forged completed digest must refuse");
        assert!(root.join(FILE).exists());
        assert_eq!(
            fs::read_dir(root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("dead-owner-cleanup-retired-"))
                .count(),
            0
        );
    }
    fn historical_fixture() -> (super::super::tests::Fixture, Receipt, Receipt, Intent) {
        let fixture = super::super::tests::Fixture::new();
        let original = partial();
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        for resource in stopped.resources.values_mut() {
            if resource.kind != Kind::Volume {
                resource.phase = "absent".into();
            }
        }
        let mut proof = intent(&original);
        proof.new_boot = Some("successor-boot".into());
        proof.complete_sha256 = Some(selected(&stopped).unwrap());
        restore_history::retain(&fixture.0, &stopped).unwrap();
        state::write(&fixture.0.join(FILE), &proof).unwrap();
        let mut current = stopped.clone();
        current.phase = "ready-observed".into();
        current.resources.get_mut("container:init").unwrap().id = Some("9".repeat(64));
        (fixture, current, stopped, proof)
    }

    fn evicted_historical_fixture() -> (super::super::tests::Fixture, Receipt, Receipt, Intent) {
        let (fixture, mut current, stopped, proof) = historical_fixture();
        for generation in 1..=12 {
            let mut newer = stopped.clone();
            newer.resources.get_mut("container:init").unwrap().id =
                Some(format!("{generation:064x}"));
            restore_history::retain(&fixture.0, &newer).unwrap();
        }
        current.resources.get_mut("container:init").unwrap().id = Some(format!("{:064x}", 13));
        (fixture, current, stopped, proof)
    }

    fn retirement_precedence_fixture() -> (super::super::tests::Fixture, Receipt, Value) {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        let mut original = partial();
        original.phase = "ready-observed".into();
        original.resources.get_mut("container:init").unwrap().id = Some(format!("{:064x}", 1));
        let mut prior_stopped = original.clone();
        prior_stopped.phase = "stopped-data-retained".into();
        for resource in prior_stopped.resources.values_mut() {
            if resource.kind != Kind::Volume {
                resource.phase = "absent".into();
            }
        }
        let live = json!({
            "version":1,"boot":"historical-boot","original":original,
            "original_sha256":selected(&original).unwrap(),
            "foreground_sha256":"f".repeat(64),
            "relay":{"bytes":[],"record_id":[1,1]},
            "environment":[],
            "bridges":{"version":1,"owner":original.owner,"boot":"historical-boot",
                "run":original.run,"plan":original.plan_id,"capacity":0,"serial":0,
                "selected":{}},
            "prior_bridges":null,"listeners_retired":true,
            "complete_sha256":selected(&prior_stopped).unwrap()
        });
        state::write(&root.join("live-owner-cleanup.json"), &live).unwrap();
        for generation in 1..=12 {
            let mut stopped = prior_stopped.clone();
            stopped.resources.get_mut("container:init").unwrap().id =
                Some(format!("{generation:064x}"));
            restore_history::retain(root, &stopped).unwrap();
        }
        let mut current = prior_stopped;
        current.resources.get_mut("container:init").unwrap().id = Some(format!("{:064x}", 13));
        let mut dead = intent(&current);
        dead.complete_sha256 = Some(selected(&current).unwrap());
        state::write(&root.join(FILE), &dead).unwrap();
        state::write(&root.join("state.json"), &current).unwrap();
        (fixture, current, live)
    }

    #[test]
    fn current_dead_owner_retirement_precedes_only_valid_historical_live_proof() {
        let (fixture, current, _live) = retirement_precedence_fixture();
        let root = &fixture.0;
        let live_before = fs::read(root.join("live-owner-cleanup.json")).unwrap();
        let dead_before = fs::read(root.join(FILE)).unwrap();
        assert!(current_completed_precedence(root, &current).unwrap());
        super::super::cleanup_enrollment::retention(root, &current).unwrap();
        assert_eq!(
            fs::read(root.join("live-owner-cleanup.json")).unwrap(),
            live_before
        );
        assert_eq!(fs::read(root.join(FILE)).unwrap(), dead_before);

        let mut stale_dead: Intent = state::read(&root.join(FILE)).unwrap();
        stale_dead.complete_sha256 = Some("8".repeat(64));
        state::write(&root.join(FILE), &stale_dead).unwrap();
        assert!(!current_completed_precedence(root, &current).unwrap());
        assert!(super::super::cleanup_enrollment::retention(root, &current).is_err());
        state::write(&root.join(FILE), &intent(&current)).unwrap();
        assert!(!current_completed_precedence(root, &current).unwrap());
        assert!(super::super::cleanup_enrollment::retention(root, &current).is_err());
    }

    #[test]
    fn current_dead_owner_retirement_refuses_pending_incomplete_or_foreign_live_proof() {
        for fault in [
            "pending",
            "incomplete",
            "foreign-owner",
            "current-live",
            "malformed",
        ] {
            let (fixture, current, mut live) = retirement_precedence_fixture();
            let root = &fixture.0;
            match fault {
                "pending" => {
                    fs::write(root.join("live-owner-cleanup.pending"), b"partial proof").unwrap();
                }
                "incomplete" => live["complete_sha256"] = Value::Null,
                "foreign-owner" => {
                    live["original"]["owner"] = json!("e".repeat(32));
                    let changed: Receipt =
                        serde_json::from_value(live["original"].clone()).unwrap();
                    live["original_sha256"] = json!(selected(&changed).unwrap());
                }
                "current-live" => {
                    let mut same = current.clone();
                    same.phase = "ready-observed".into();
                    live["original"] = serde_json::to_value(&same).unwrap();
                    live["original_sha256"] = json!(selected(&same).unwrap());
                    live["complete_sha256"] = json!(selected(&current).unwrap());
                }
                "malformed" => {
                    fs::write(root.join("live-owner-cleanup.json"), b"invalid proof").unwrap();
                }
                _ => unreachable!(),
            }
            if !matches!(fault, "pending" | "malformed") {
                state::write(&root.join("live-owner-cleanup.json"), &live).unwrap();
            }
            let live_before = fs::read(root.join("live-owner-cleanup.json")).unwrap();
            let dead_before = fs::read(root.join(FILE)).unwrap();
            assert!(
                current_completed_precedence(root, &current).is_err(),
                "{fault}"
            );
            assert!(
                super::super::cleanup_enrollment::retention(root, &current).is_err(),
                "{fault}"
            );
            assert_eq!(
                fs::read(root.join("live-owner-cleanup.json")).unwrap(),
                live_before
            );
            assert_eq!(fs::read(root.join(FILE)).unwrap(), dead_before);
        }
    }

    #[test]
    fn repeated_recovery_archives_evicted_completion_without_rewriting_prior_proof() {
        let (fixture, current, _, proof) = evicted_historical_fixture();
        let root = &fixture.0;
        let source = root.join(FILE);
        let before = fs::read(&source).unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let history = fs::read(root.join("restore-history.json")).unwrap();
        let complete = proof.complete_sha256.as_deref().unwrap();
        assert!(
            restore_history::completed_for_recovery(root, &current, complete)
                .unwrap()
                .is_none()
        );

        archive_completed_prior(
            root,
            &current,
            &selected(&current).unwrap(),
            &"2".repeat(64),
            "current-boot",
        )
        .unwrap();

        let archived = root.join(format!("dead-owner-cleanup-retired-{complete}.json"));
        let archived_metadata = fs::metadata(&archived).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(archived).unwrap(), before);
        assert_eq!(archived_metadata.dev(), metadata.dev());
        assert_eq!(archived_metadata.ino(), metadata.ino());
        assert_eq!(
            fs::read(root.join("restore-history.json")).unwrap(),
            history
        );
    }

    #[test]
    fn repeated_recovery_refuses_evicted_proof_with_changed_identity_or_generation() {
        for fault in [
            "owner",
            "run",
            "plan_id",
            "unchanged-generation",
            "pending",
            "incomplete",
            "mutated-resource-id",
        ] {
            let (fixture, mut current, _, mut proof) = evicted_historical_fixture();
            let root = &fixture.0;
            match fault {
                "owner" | "run" | "plan_id" => {
                    let mut original = serde_json::to_value(&proof.original).unwrap();
                    original[fault] = json!("e".repeat(if fault == "plan_id" { 64 } else { 32 }));
                    proof.original = serde_json::from_value(original).unwrap();
                    proof.original_sha256 = selected(&proof.original).unwrap();
                    state::write(&root.join(FILE), &proof).unwrap();
                }
                "unchanged-generation" => {
                    current.resources.get_mut("container:init").unwrap().id =
                        proof.original.resources["container:init"].id.clone();
                }
                "pending" => {
                    fs::write(root.join("dead-owner-cleanup.pending"), b"partial proof").unwrap();
                }
                "incomplete" => {
                    proof.complete_sha256 = None;
                    state::write(&root.join(FILE), &proof).unwrap();
                }
                "mutated-resource-id" => {
                    proof
                        .original
                        .resources
                        .get_mut("container:init")
                        .unwrap()
                        .id = Some("7".repeat(64));
                    state::write(&root.join(FILE), &proof).unwrap();
                }
                _ => unreachable!(),
            }
            let before = fs::read(root.join(FILE)).unwrap();
            let history = fs::read(root.join("restore-history.json")).unwrap();
            assert!(
                archive_completed_prior(
                    root,
                    &current,
                    &selected(&current).unwrap(),
                    &"2".repeat(64),
                    "current-boot",
                )
                .is_err(),
                "{fault}"
            );
            assert_eq!(fs::read(root.join(FILE)).unwrap(), before, "{fault}");
            assert_eq!(
                fs::read(root.join("restore-history.json")).unwrap(),
                history
            );
            assert!(
                !root
                    .join(format!(
                        "dead-owner-cleanup-retired-{}.json",
                        proof.complete_sha256.as_deref().unwrap_or("missing")
                    ))
                    .exists(),
                "{fault}"
            );
        }
    }

    #[test]
    fn evicted_previous_boot_completion_is_read_only_superseded_history() {
        let (fixture, current, _, proof) = evicted_historical_fixture();
        let before = fs::read(fixture.0.join(FILE)).unwrap();
        let history_before = fs::read(fixture.0.join("restore-history.json")).unwrap();
        assert!(
            restore_history::completed_for_recovery(
                &fixture.0,
                &current,
                proof.complete_sha256.as_deref().unwrap()
            )
            .unwrap()
            .is_none()
        );
        require_historical_recovery(&fixture.0, &current).unwrap();
        assert!(!current_completion(&fixture.0, &current).unwrap());
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), before);
        assert_eq!(
            fs::read(fixture.0.join("restore-history.json")).unwrap(),
            history_before
        );
    }

    #[test]
    fn truncated_history_does_not_admit_invalid_or_current_recovery_proof() {
        for (field, value) in [
            ("version", json!(9)),
            ("complete_sha256", Value::Null),
            ("complete_sha256", json!("invalid")),
            ("original_sha256", json!("8".repeat(64))),
            ("owner_sha256", json!("invalid")),
            ("new_boot", Value::Null),
            ("new_boot", json!("")),
            ("old_boot", json!("")),
            ("old_boot", json!("successor-boot")),
            ("one_off_sha256", json!("8".repeat(64))),
        ] {
            let (fixture, current, _, proof) = evicted_historical_fixture();
            let mut changed = serde_json::to_value(proof).unwrap();
            changed[field] = value;
            state::write(&fixture.0.join(FILE), &changed).unwrap();
            let bytes = fs::read(fixture.0.join(FILE)).unwrap();
            let history = fs::read(fixture.0.join("restore-history.json")).unwrap();
            assert!(
                require_historical_recovery(&fixture.0, &current).is_err(),
                "{field}"
            );
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), bytes);
            assert_eq!(
                fs::read(fixture.0.join("restore-history.json")).unwrap(),
                history
            );
        }
        for field in ["version", "owner", "run", "namespace", "plan_id"] {
            let (fixture, current, _, mut proof) = evicted_historical_fixture();
            let mut changed = serde_json::to_value(&proof.original).unwrap();
            changed[field] = if field == "version" {
                json!(9)
            } else {
                json!("e".repeat(64))
            };
            proof.original = serde_json::from_value(changed).unwrap();
            proof.original_sha256 = selected(&proof.original).unwrap();
            state::write(&fixture.0.join(FILE), &proof).unwrap();
            let bytes = fs::read(fixture.0.join(FILE)).unwrap();
            assert!(
                require_historical_recovery(&fixture.0, &current).is_err(),
                "{field}"
            );
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), bytes);
        }
        let (fixture, mut current, _, proof) = evicted_historical_fixture();
        current.resources = proof.original.resources;
        let bytes = fs::read(fixture.0.join(FILE)).unwrap();
        assert!(require_historical_recovery(&fixture.0, &current).is_err());
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), bytes);
    }

    #[test]
    fn evicted_completion_requires_verified_truncation_and_newer_stopped_evidence() {
        for fault in [
            "missing",
            "untruncated",
            "same-generation",
            "foreign",
            "malformed",
            "pending",
        ] {
            let (fixture, current, stopped, _) = evicted_historical_fixture();
            let path = fixture.0.join("restore-history.json");
            let mut history: Value = state::read(&path).unwrap();
            match fault {
                "missing" => fs::remove_file(&path).unwrap(),
                "pending" => fs::write(
                    fixture.0.join("dead-owner-cleanup.pending"),
                    b"partial evidence",
                )
                .unwrap(),
                _ => {
                    match fault {
                        "untruncated" => history["truncated"] = json!(false),
                        "same-generation" => {
                            let mut same_generation = stopped;
                            same_generation
                                .readiness
                                .insert("init".into(), project::execution::Condition::Started);
                            *history["entries"]
                                .as_array_mut()
                                .unwrap()
                                .last_mut()
                                .unwrap() = serde_json::to_value(&same_generation).unwrap()
                        }
                        "foreign" => history["entries"][0]["owner"] = json!("e".repeat(32)),
                        "malformed" => history["version"] = json!(9),
                        _ => unreachable!(),
                    }
                    state::write(&path, &history).unwrap();
                }
            }
            let bytes = fs::read(fixture.0.join(FILE)).unwrap();
            let history = fs::read(&path).ok();
            assert!(
                require_historical_recovery(&fixture.0, &current).is_err(),
                "{fault}"
            );
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), bytes);
            assert_eq!(fs::read(&path).ok(), history);
            if fault == "pending" {
                assert_eq!(
                    fs::read(fixture.0.join("dead-owner-cleanup.pending")).unwrap(),
                    b"partial evidence"
                );
            }
        }
    }

    #[test]
    fn completed_previous_boot_proof_is_read_only_history_for_later_live_recovery() {
        let (fixture, mut current, _, _) = historical_fixture();
        let before = fs::read(fixture.0.join(FILE)).unwrap();
        for phase in ["ready-observed", "cleanup-intent", "stopped-data-retained"] {
            current.phase = phase.into();
            require_historical_recovery(&fixture.0, &current).unwrap();
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), before);
        }
        fs::remove_file(fixture.0.join(FILE)).unwrap();
        require_historical_recovery(&fixture.0, &current).unwrap();
    }

    #[test]
    fn historical_recovery_refuses_unproven_records_without_mutating_them() {
        for (field, value) in [
            ("version", json!(9)),
            ("complete_sha256", Value::Null),
            ("complete_sha256", json!("8".repeat(64))),
            ("original_sha256", json!("8".repeat(64))),
            ("owner_sha256", json!("invalid")),
            ("new_boot", Value::Null),
            ("new_boot", json!("")),
            ("old_boot", json!("")),
            ("old_boot", json!("successor-boot")),
            ("one_off_sha256", json!("8".repeat(64))),
        ] {
            let (fixture, current, _, proof) = historical_fixture();
            let mut changed = serde_json::to_value(proof).unwrap();
            changed[field] = value;
            state::write(&fixture.0.join(FILE), &changed).unwrap();
            let bytes = fs::read(fixture.0.join(FILE)).unwrap();
            assert!(
                require_historical_recovery(&fixture.0, &current).is_err(),
                "{field}"
            );
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), bytes);
        }
        let (fixture, current, stopped, _) = historical_fixture();
        assert!(require_historical_recovery(&fixture.0, &stopped).is_err());
        for field in ["owner", "run", "namespace", "plan_id"] {
            let mut changed = serde_json::to_value(&current).unwrap();
            changed[field] = json!("f".repeat(64));
            let changed: Receipt = serde_json::from_value(changed).unwrap();
            assert!(
                require_historical_recovery(&fixture.0, &changed).is_err(),
                "{field}"
            );
        }
        let pending = fixture.0.join("dead-owner-cleanup.pending");
        fs::write(&pending, b"partial evidence").unwrap();
        assert!(require_historical_recovery(&fixture.0, &current).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"partial evidence");
        fs::remove_file(pending).unwrap();
        fs::remove_file(fixture.0.join("restore-history.json")).unwrap();
        assert!(require_historical_recovery(&fixture.0, &current).is_err());
    }
}
