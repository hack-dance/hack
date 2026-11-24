//! Explicit recovery selects VM stop plus owner death before reboot, or a dead
//! ready owner (including a journal-bound one-off) from an earlier boot of the same
//! pool: the one boot its receipt's evidence names (`boot_match`), never the current one.
//! No endpoint-file deletion is treated as a relay retirement acknowledgement.
pub(super) use super::cleanup_enrollment::immutable;
use super::*;
use crate::provider::{identity, lifecycle, state::Owner};
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
mod dependencies;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enrollment: Option<super::legacy_cleanup_enrollment::Selection>,
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
        "Dead-owner cleanup requires an exact stopped selection, ready graph, or validated interrupted one-off from an earlier boot of the pool, an absent foreground owner, and unchanged verified inventories; evidence retained.",
    )
}
fn digest(value: &[u8]) -> String {
    format!("{:x}", crate::Hex(Sha256::digest(value)))
}
/// Digest of the canonical pretty-encoded state.json written by state::write.
fn selected(receipt: &Receipt) -> Result<String, CandidateError> {
    Ok(digest(
        &serde_json::to_vec_pretty(receipt).map_err(|_| refused())?,
    ))
}
/// A graph whose start completed: ready, or (with `--report-started`) every service
/// started. Both are live runs a dead owner may leave behind across a boot.
fn live(phase: &str) -> bool {
    matches!(phase, "ready-observed" | STARTED_OBSERVED)
}

fn validate(
    intent: &Intent,
    receipt: &Receipt,
    expected: &str,
    owner: &str,
) -> Result<(), CandidateError> {
    if let Some(enrollment) = &intent.enrollment {
        enrollment.validate(&intent.original)?;
        if !live(&intent.original.phase) {
            return Err(refused());
        }
    }
    if intent.version != if intent.enrollment.is_some() { 2 } else { 1 }
        || (live(&intent.original.phase)
            && intent.original.relay_cleanup.is_some()
            && intent.enrollment.is_none())
        || intent.original_sha256 != expected
        || selected(&intent.original)? != expected
        || intent.owner_sha256 != owner
        || !hex(owner, 64)
        || intent.old_boot.is_empty()
        || !cleanup_enrollment::matches_cleanup_progress(&intent.original, receipt)?
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

/// Read-only dispatch hint. Execution re-admits the exact earlier boot,
/// dead process, publication and inventories under their original locks.
pub(super) fn recovery_hint(
    candidate: &Candidate,
    root: &std::path::Path,
    receipt: &Receipt,
    owner: &Owner,
    publication: foreground::transport::PublishedOwner,
) -> Result<Option<String>, CandidateError> {
    if publication == foreground::transport::PublishedOwner::Running {
        return Ok(None);
    }
    recovery_selection(
        candidate,
        root,
        receipt,
        owner,
        publication != foreground::transport::PublishedOwner::Absent,
    )
}

pub(super) fn recovery_selection(
    candidate: &Candidate,
    root: &std::path::Path,
    receipt: &Receipt,
    owner: &Owner,
    publication_present: bool,
) -> Result<Option<String>, CandidateError> {
    let Some(current) = &owner.guest_boot_id else {
        return Ok(None);
    };
    if owner.phase != "running" {
        return Ok(None);
    }
    // Hints grant no authority: an unreadable bridge registry only drops its boots.
    let earlier = candidate_boots(candidate, owner, &receipt.run, false)?;
    if earlier.is_empty() {
        return Ok(None);
    }
    if exists(&root.join(FILE))? {
        let intent: Intent = state::read(&root.join(FILE))?;
        let matches = cleanup_enrollment::matches_cleanup_progress(&intent.original, receipt)?;
        if intent.complete_sha256.is_none() && !matches {
            return Err(refused());
        }
        if matches
            && earlier.contains(&intent.old_boot)
            && intent.new_boot.as_ref() == Some(current)
        {
            validate(
                &intent,
                receipt,
                &intent.original_sha256,
                &intent.owner_sha256,
            )?;
            let remaining = publication_present
                || dependency_slots::reservation_recorded(candidate, &receipt.run)?;
            if intent.complete_sha256.is_none()
                || (remaining
                    && intent.complete_sha256.as_deref() == Some(selected(receipt)?.as_str()))
            {
                return Ok(Some(intent.original_sha256));
            }
            return Ok(None);
        }
    }
    // A new selection may recover only the phases admitted by execute. Retained
    // stops without an intent keep their existing unadmitted/ordinary path.
    if !publication_present
        || (!(live(&receipt.phase) || receipt.phase == "cleanup-intent")
            && !exists(&root.join("one-off.json"))?)
    {
        return Ok(None);
    }
    super::boot_match::receipt_boot(candidate, root, receipt, &earlier, current)?
        .map(|_| selected(receipt))
        .transpose()
}
/// The boots a dead owner's run may belong to: the pool's earlier boots, then the boots
/// its own bridge slots record (a run stranded before boot history was installed; seen
/// on a real VM, HACK-2456). The current boot is never a candidate. `strict` makes an
/// unreadable bridge registry an error, as recovery itself requires.
fn candidate_boots(
    candidate: &Candidate,
    owner: &Owner,
    run: &str,
    strict: bool,
) -> Result<Vec<String>, CandidateError> {
    let mut boots = crate::provider::boot_history::earlier_boots(candidate, owner)?;
    let slots = match super::bridges::run_boots(candidate, owner, run) {
        Ok(slots) => slots,
        Err(error) if strict => return Err(error),
        Err(_) => Vec::new(),
    };
    for boot in slots {
        if owner.guest_boot_id.as_deref() != Some(boot.as_str()) && !boots.contains(&boot) {
            boots.push(boot);
        }
    }
    Ok(boots)
}

/// Whether a completed dead-owner recovery admits the previous-boot HTTPS archive in
/// the `current` boot. The recovery ran in `new_boot` and recovered the run of
/// `old_boot`. After its HTTPS step failed, the pool may have booted any number of
/// times, and the run may predate the boot history (HACK-2550, seen on a real VM:
/// z338, z282). What is left is host-side, and the guard proves it from current
/// observations: the receipt matches the intent's completion, every resource is
/// absent in this boot, the publisher is retired, no bridge slot or claim remains.
/// The recorded boots must only be distinct, and the run's own boot never the live one.
fn archive_after_completed_recovery(new_boot: Option<&str>, old_boot: &str, current: &str) -> bool {
    new_boot.is_some_and(|boot| !boot.is_empty() && boot != old_boot)
        && !old_boot.is_empty()
        && old_boot != current
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
    if (!live(&current.phase) && !interrupted_enrollment)
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
    // HACK-2576: the history keeps the newest finished records; the oldest proven
    // finished make room instead of refusing this recovery for ever.
    super::retired_history::make_room(root, RETIRED_PREFIX, RETIRED_LIMIT, finished_archive)?;
    let target = root.join(format!("{RETIRED_PREFIX}{complete}.json"));
    if exists(&target)? {
        return Err(refused());
    }
    fs::rename(&path, &target).map_err(state::io)?;
    fs::File::open(root)
        .and_then(|file| file.sync_all())
        .map_err(state::io)
}

const RETIRED_PREFIX: &str = "dead-owner-cleanup-retired-";
/// Archived completed recoveries kept per run (HACK-2576).
const RETIRED_LIMIT: usize = 8;

/// An archived recovery that is proven finished: it parses as an intent, it is
/// completed (a digest and the boot it completed in), it carries no one-off, and
/// its file is named for its own completion digest.
fn finished_archive(name: &str, bytes: &[u8]) -> bool {
    serde_json::from_slice::<Intent>(bytes).is_ok_and(|intent| {
        intent.one_off_sha256.is_none()
            && intent
                .new_boot
                .as_deref()
                .is_some_and(|boot| !boot.is_empty())
            && intent.complete_sha256.as_deref().is_some_and(|complete| {
                hex(complete, 64) && name == format!("{RETIRED_PREFIX}{complete}.json")
            })
    })
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
/// ready owner with exact reservations from an earlier boot of the pool can be
/// selected on any later boot without another restart.
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
/// earlier-boot shared HTTPS owner is archived. Neither pathname absence nor
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
        let current = self.engine.guest().boot_id();
        if intent.complete_sha256.as_deref() != Some(complete.as_str())
            || intent.old_boot != self.old_boot
            || !archive_after_completed_recovery(
                intent.new_boot.as_deref(),
                &self.old_boot,
                current,
            )
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
        if intent.new_boot.as_deref() == Some(current) {
            host_relay::inspect_cleanup_recovery(
                candidate,
                &self.engine,
                &receipt,
                false,
                &environment,
                bridges,
                witness.as_ref(),
            )?;
        } else {
            // The recovery's boot has ended: its bridge selection is admitted by the
            // run's own evidence, everything else is re-observed now (HACK-2550).
            host_relay::inspect_cleanup_completed(
                candidate,
                &self.engine,
                &receipt,
                &environment,
                bridges,
            )?;
        }
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
    if let Some(enrollment) = &intent.enrollment {
        enrollment.verify_raw(&intent.original)?;
    }
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
    crate::provider::publication::require_run_absent(candidate, &receipt.owner, run)?;
    bridges::cleanup::verify_recovery_file(&root, bridges, intent.prior_bridges.as_ref())?;
    let legacy = super::host_pin_recovery::load_witness(candidate, run)?.filter(|witness| {
        witness.graph_sha256() == intent.original_sha256
            && witness.publisher_sha256() == intent.owner_sha256
            && witness.matches_graph(&intent.original)
    });
    if intent.new_boot.as_deref() == Some(engine.guest().boot_id()) {
        if let Some(witness) = legacy.clone() {
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
                super::acknowledged_publisher::require_no_pending_missing_lock(candidate, run)?;
                let foreground_lock = state::Lock::acquire_existing(&foreground_root)?;
                super::acknowledged_publisher::require_no_pending_missing_lock(candidate, run)?;
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
    dependencies::finish(candidate, &engine, &receipt, &intent, legacy.as_ref())?;
    Ok(json!({"run":run,"publisher_retired":true,"data_retained":true}))
}
/// The receipt phases a dead-owner `prepare` admits: a failed or interrupted fresh
/// start (also once every service started: `started-observed` from `preparing`) or a
/// cleanup in progress. A restore or restart in progress is refused, as before.
fn prepare_admits(receipt: &Receipt) -> bool {
    ["failed-retained", "preparing", "cleanup-intent"].contains(&start_phase(receipt))
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
    // The last boot that ran, unchanged: a `prepare` intent stays strict at `execute`
    // (`fresh_boot`), so matching an older boot here could only refuse earlier.
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
        || (!prepare_admits(&receipt) && one_off_sha256.is_none())
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
        enrollment: None,
    };
    dead.verify()?;
    retain_interrupted_write(&root)?;
    state::write(&path, &intent)?;
    Ok(json!({"run":run,"phase":"awaiting-runtime-start","receipt_sha256":expected}))
}
/// An intent selected on a running pool (`new_boot` recorded) may name any earlier
/// boot of the pool. A stopped-pool `prepare` intent (`new_boot: None`) stays strict:
/// its old boot must be the immediate predecessor. Boots between `prepare` and
/// `execute` would have started the engine, whose restart policies may have restarted
/// the run's containers, and nothing proves they did not. The stopped-pool flow of
/// `hack up` / `hack down --recover` boots first and selects with `execute`, never
/// `prepare`.
fn fresh_boot(
    intent: &Intent,
    previous: Option<&str>,
    earlier: &[String],
    current: &str,
) -> Result<(), CandidateError> {
    let admitted = match intent.new_boot {
        None => previous == Some(intent.old_boot.as_str()),
        Some(_) => earlier.contains(&intent.old_boot),
    };
    if !admitted
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
        // A dead ready owner may be selected on any later audited boot: the run's
        // boot is the one earlier boot its receipt evidence names. No additional
        // restart is requested or inferred here.
        let owner = Owner::load(candidate)?;
        let earlier = candidate_boots(candidate, &owner, &receipt.run, true)?;
        let old_boot = super::boot_match::receipt_boot(
            candidate,
            &root,
            &receipt,
            &earlier,
            engine.guest().boot_id(),
        )?
        .ok_or_else(refused)?;
        // A boot proven only through the run's bridge slots joins the history before
        // the intent, so every later step sees the same earlier boot.
        if !crate::provider::boot_history::earlier_boots(candidate, &owner)?.contains(&old_boot) {
            crate::provider::boot_history::adopt(candidate, &owner, &old_boot)?;
        }
        let one_off_sha256 = if exists(&root.join("one-off.json"))? {
            Some(one_off::recovery_selection(&root, &receipt, &old_boot)?)
        } else {
            None
        };
        let interrupted_enrollment = (live(&receipt.phase) || receipt.phase == "cleanup-intent")
            && receipt.relay_cleanup.as_ref().is_some_and(|marker| {
                marker.valid()
                    && marker.phase == cleanup_enrollment::Phase::Pending
                    && host_relay::context(&receipt.owner, &old_boot).is_ok_and(|context| {
                        marker.runtime == context.runtime && marker.boot == context.boot
                    })
            })
            && exists(&root.join("relay-cleanup-bridges.json"))?;
        if (!live(&receipt.phase) && !interrupted_enrollment && one_off_sha256.is_none())
            || receipt.relay_startup.is_none()
            || (receipt.relay_cleanup.is_some() && !interrupted_enrollment)
            || selected(&receipt)? != expected
        {
            return Err(refused());
        }
        initializer_cache::require_resolved(&receipt)?;
        let enrollment = if live(&receipt.phase) && receipt.relay_cleanup.is_some() {
            Some(
                super::legacy_cleanup_enrollment::Selection::capture_previous(
                    &receipt,
                    &old_boot,
                    dead.process(),
                )?,
            )
        } else {
            None
        };
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
            version: if enrollment.is_some() { 2 } else { 1 },
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
            enrollment,
        };
        dead.verify()?;
        retain_interrupted_write(&root)?;
        state::write(&root.join(FILE), &intent)?;
        intent
    };
    validate(&intent, &receipt, expected, &dead.fingerprint())?;
    if let Some(enrollment) = &intent.enrollment {
        enrollment.verify_raw(&intent.original)?;
    }
    if let Some(guard) = &pin_guard {
        if guard.witness().publisher_sha256() != dead.fingerprint() {
            return Err(refused());
        }
        guard.verify_lock()?;
    }
    let owner = Owner::load(candidate)?;
    let boot = engine.guest().boot_id();
    let earlier = crate::provider::boot_history::earlier_boots(candidate, &owner)?;
    fresh_boot(
        &intent,
        owner.previous_guest_boot_id.as_deref(),
        &earlier,
        boot,
    )?;
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
    let fence = || {
        engine.guest().verify()?;
        dead.verify_retirement_ready()?;
        if let Some(guard) = &pin_guard {
            guard.verify_lock()?;
        }
        if let Some(enrollment) = &intent.enrollment {
            enrollment.verify_raw(&intent.original)?;
        }
        Ok(())
    };
    crate::provider::publication::retire_run(candidate, &receipt.owner, run, &fence)?;
    let cleaned = cleanup_owned_fenced(candidate, &engine, receipt, &root, false, false, || {
        fence()?;
        crate::provider::publication::require_run_absent(candidate, &intent.original.owner, run)
    })?;
    #[cfg(test)]
    fault_pause(&root, run, "dead-owner-after-stop")?;
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
    #[cfg(test)]
    fault_pause(&root, run, "dead-owner-after-completion")?;
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
    {
        return Err(refused());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn predecessor_dispatch_selects_only_audited_boot_and_resumes_original_receipt() {
        let fixture = super::super::retained_startup::tests::Fixture::new();
        let mut owner = Owner::load(&fixture.candidate).unwrap();
        let previous = owner.guest_boot_id.clone().unwrap();
        owner.previous_guest_boot_id = Some(previous.clone());
        owner.guest_boot_id = Some("22222222-2222-2222-2222-222222222222".into());
        owner.phase = "running".into();
        let mut receipt = fixture.receipt();
        receipt.phase = "ready-observed".into();
        receipt.relay_startup = Some(serde_json::from_value(json!({"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}})).unwrap());
        let context = host_relay::context(&receipt.owner, &previous).unwrap();
        receipt.relay_cleanup = Some(
            serde_json::from_value(json!({
                "version":1,"runtime":context.runtime,"boot":context.boot,"operation":([3;16]),
                "effect":([4;32]),"control_root":"/private/owned","phase":"pending"
            }))
            .unwrap(),
        );
        let expected = selected(&receipt).unwrap();
        let hint =
            || recovery_selection(&fixture.candidate, &fixture.graph(), &receipt, &owner, true);
        assert_eq!(hint().unwrap(), Some(expected.clone()));
        assert!(
            recovery_selection(
                &fixture.candidate,
                &fixture.graph(),
                &receipt,
                &owner,
                false
            )
            .unwrap()
            .is_none()
        );
        for phase in [
            "stopped-data-retained",
            "removed",
            "preparing",
            "failed-retained",
        ] {
            let mut old = receipt.clone();
            old.phase = phase.into();
            assert!(
                recovery_selection(&fixture.candidate, &fixture.graph(), &old, &owner, true)
                    .unwrap()
                    .is_none()
            );
        }
        // Another boot came between the run's boot and this one: the run's boot is
        // no longer the previous one, and without a boot history it is unknown.
        owner.previous_guest_boot_id = Some("33333333-3333-3333-3333-333333333333".into());
        assert!(
            recovery_selection(&fixture.candidate, &fixture.graph(), &receipt, &owner, true)
                .unwrap()
                .is_none()
        );
        // The boot history recorded the run's older boot when it was superseded.
        let mut superseded = owner.clone();
        superseded.guest_boot_id = Some(previous.clone());
        superseded.previous_guest_boot_id = None;
        crate::provider::boot_history::record(&fixture.candidate, &superseded).unwrap();
        assert_eq!(
            recovery_selection(&fixture.candidate, &fixture.graph(), &receipt, &owner, true)
                .unwrap(),
            Some(expected.clone())
        );
        // The current boot is never an earlier boot, even when the evidence names it.
        let mut current = owner.clone();
        current.guest_boot_id = Some(previous.clone());
        assert!(
            recovery_selection(
                &fixture.candidate,
                &fixture.graph(),
                &receipt,
                &current,
                true
            )
            .unwrap()
            .is_none()
        );
        owner.previous_guest_boot_id = Some(previous.clone());
        let mut intent = intent(&receipt);
        intent.version = 2;
        intent.enrollment = Some(
            serde_json::from_value(
                json!({"coordinator_sha256":"1".repeat(64),"fingerprint":"2".repeat(64)}),
            )
            .unwrap(),
        );
        intent.old_boot = previous;
        intent.new_boot = owner.guest_boot_id.clone();
        state::write(&fixture.graph().join(FILE), &intent).unwrap();
        let mut progress = receipt.clone();
        progress.phase = "cleanup-intent".into();
        assert_eq!(
            recovery_selection(
                &fixture.candidate,
                &fixture.graph(),
                &progress,
                &owner,
                true
            )
            .unwrap(),
            Some(expected)
        );
        progress.owner = "f".repeat(32);
        assert!(
            recovery_selection(
                &fixture.candidate,
                &fixture.graph(),
                &progress,
                &owner,
                true
            )
            .is_err()
        );
        state::write(&fixture.graph().join(FILE), &json!({"malformed":true})).unwrap();
        assert!(
            recovery_selection(&fixture.candidate, &fixture.graph(), &receipt, &owner, true)
                .is_err()
        );
        assert!(
            recovery_hint(
                &fixture.candidate,
                &fixture.graph(),
                &receipt,
                &owner,
                foreground::transport::PublishedOwner::Running
            )
            .unwrap()
            .is_none()
        );
        assert!(
            recovery_hint(
                &fixture.candidate,
                &fixture.graph(),
                &receipt,
                &owner,
                foreground::transport::PublishedOwner::Exited
            )
            .is_err()
        );
    }
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
            enrollment: None,
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
        let path = fixture.0.join(FILE);
        state::write(&path, &proof).unwrap();
        // Guest cleanup may commit this stopped receipt before the recovery
        // intent commits completion. Dispatch must resume execute in that gap.
        let pending = fs::read(&path).unwrap();
        assert!(!current_completion(&fixture.0, &receipt).unwrap());
        assert_eq!(fs::read(&path).unwrap(), pending);
        proof.complete_sha256 = Some(selected(&receipt).unwrap());
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
    /// HACK-2550, seen on a real VM: `hack up` recovered a run whose pool had stopped
    /// (recovery of generation 1 from boot A, run in boot B) and restored it in boot B;
    /// the pool then stopped again. The second recovery, in boot C, finds the first
    /// recovery's own bridge selection, which records both boots. It is a completed
    /// earlier generation only with that recovery's retired intent naming exactly these
    /// bridges for the stopped receipt, and never when a boot it names is the live one.
    #[test]
    fn a_completed_recovery_selection_is_a_prior_generation_of_a_restored_run() {
        let fixture = super::super::tests::Fixture::new();
        let (a, b, c) = (
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
            "33333333-3333-3333-3333-333333333333",
        );
        let receipt = |phase: &str, container: &str, network: &str, resource: &str| -> Receipt {
            serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":phase,
            "readiness":{},"resources":{
                "container:web":{"kind":"container","key":"web","name":"owned-web",
                    "id":container,"image":null,"phase":resource},
                "network:default":{"kind":"network","key":"default","name":"owned-net",
                    "id":network,"image":null,"phase":resource}
            }}))
            .unwrap()
        };
        let slot = |boot: &str, container: &str, network: &str, serial: u64| {
            json!({"assignment":{
                "reservation":"e".repeat(32),"run":"a".repeat(32),"service":"web",
                "generation":"f".repeat(64),"container_id":container,"network_id":network,
                "boot_id":boot,"phase":"running",
                "relay":{"transport":"reservation-v1","launch_serial":serial,
                    "binary_sha256":"2".repeat(64),"target_pid":10,"target_start":10,"port":8080}}})
        };
        let (old_container, old_network) = ("3".repeat(64), "4".repeat(64));
        let (new_container, new_network) = ("5".repeat(64), "6".repeat(64));
        let stopped = receipt(
            "stopped-data-retained",
            &old_container,
            &old_network,
            "absent",
        );
        let original = receipt("ready-observed", &old_container, &old_network, "started");
        let selection = |boot: &str, previous: &str, serial: u64, slot: Value| -> Value {
            json!({"version":1,"owner":"b".repeat(32),"boot":boot,"previous_boot":previous,
                "run":"a".repeat(32),"plan":"d".repeat(64),"capacity":1,"serial":serial,
                "selected":{"0":slot}})
        };
        let prior_value = selection(b, a, 1, slot(a, &old_container, &old_network, 1));
        let prior: bridges::cleanup::Selection =
            serde_json::from_value(prior_value.clone()).unwrap();
        let current: bridges::cleanup::Selection =
            serde_json::from_value(selection(c, b, 2, slot(b, &new_container, &new_network, 2)))
                .unwrap();
        let active = receipt("ready-observed", &new_container, &new_network, "started");
        state::write(&fixture.0.join("relay-cleanup-bridges.json"), &prior).unwrap();
        restore_history::retain(&fixture.0, &stopped).unwrap();
        let capture = || bridges::cleanup::capture_prior_generation(&fixture.0, &current, &active);
        // Without the first recovery's retired intent nothing proves it complete.
        assert!(capture().is_err());
        let mut proof = intent(&original);
        proof.old_boot = a.into();
        proof.new_boot = Some(b.into());
        proof.complete_sha256 = Some(selected(&stopped).unwrap());
        proof.bridges = Some(prior.clone());
        let retired = fixture.0.join(format!(
            "dead-owner-cleanup-retired-{}.json",
            selected(&stopped).unwrap()
        ));
        state::write(&retired, &proof).unwrap();
        assert_eq!(capture().unwrap(), Some(prior_value.clone()));
        // A retired intent naming other bridges does not prove this selection.
        let mut changed = prior_value.clone();
        changed["selected"]["0"]["assignment"]["relay"]["port"] = json!(8081);
        let changed: bridges::cleanup::Selection = serde_json::from_value(changed).unwrap();
        state::write(&fixture.0.join("relay-cleanup-bridges.json"), &changed).unwrap();
        assert!(capture().is_err());
        // A recovery selection naming the live boot is never an earlier generation.
        let live: bridges::cleanup::Selection =
            serde_json::from_value(selection(b, c, 1, slot(c, &old_container, &old_network, 1)))
                .unwrap();
        state::write(&fixture.0.join("relay-cleanup-bridges.json"), &live).unwrap();
        assert!(capture().is_err());
    }
    /// HACK-2550, seen on a real VM: `hack up`'s recovery completed in boot B, its
    /// HTTPS archive then refused, and the pool booted again (C). The archive must
    /// still be admissible in C, but never for the run's own boot A.
    #[test]
    fn the_https_archive_follows_a_completed_recovery_into_later_boots() {
        // The recovery ran in this boot, or in any earlier one, recorded or not (z282
        // predates the boot history).
        assert!(archive_after_completed_recovery(Some("c"), "a", "c"));
        assert!(archive_after_completed_recovery(Some("b"), "a", "c"));
        assert!(archive_after_completed_recovery(Some("x"), "a", "c"));
        // Never the run's own boot for the recovery, nor the live boot for the run.
        assert!(!archive_after_completed_recovery(Some("a"), "a", "c"));
        assert!(!archive_after_completed_recovery(Some("c"), "c", "c"));
        assert!(!archive_after_completed_recovery(Some(""), "a", "c"));
        assert!(!archive_after_completed_recovery(Some("b"), "", "c"));
        assert!(!archive_after_completed_recovery(None, "a", "c"));
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
        let older = ["foreign".to_owned(), "old-boot".to_owned()];
        // A stopped-pool `prepare` intent stays strict: only the immediate predecessor,
        // even when the boot history names its old boot.
        for (prior, current) in [
            (None, "next"),
            (Some("foreign"), "next"),
            (Some("old-boot"), "old-boot"),
        ] {
            assert!(fresh_boot(&intent, prior, &older, current).is_err());
        }
        assert!(fresh_boot(&intent, Some("old-boot"), &[], "next").is_ok());
        // An intent selected on a running pool accepts any earlier boot of the pool.
        intent.new_boot = Some("next".into());
        assert!(fresh_boot(&intent, Some("old-boot"), &older, "third").is_err());
        assert!(fresh_boot(&intent, Some("old-boot"), &older, "next").is_ok());
        assert!(fresh_boot(&intent, Some("foreign"), &older, "next").is_ok());
        assert!(fresh_boot(&intent, Some("foreign"), &older[..1], "next").is_err());
        assert!(fresh_boot(&intent, None, &[], "next").is_err());
        intent.new_boot = Some("old-boot".into());
        assert!(fresh_boot(&intent, Some("foreign"), &older, "old-boot").is_err());
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
    fn a_started_run_is_recovered_across_boots_like_a_ready_one() {
        assert!(live("ready-observed") && live("started-observed"));
        assert!(!live("preparing") && !live("cleanup-intent"));
        // `prepare` admits the same starts as before the phase existed.
        let started_from = |start: &str| {
            let mut receipt = partial();
            receipt.phase = start.into();
            mark_started(&mut receipt).unwrap();
            receipt
        };
        assert!(prepare_admits(&started_from("preparing")));
        assert!(!prepare_admits(&started_from("restoring")));
        assert!(!prepare_admits(&started_from("restarting")));
        // A new cross-boot selection accepts a started run like a ready one.
        let fixture = super::super::retained_startup::tests::Fixture::new();
        let mut owner = Owner::load(&fixture.candidate).unwrap();
        let previous = owner.guest_boot_id.clone().unwrap();
        owner.previous_guest_boot_id = Some(previous.clone());
        owner.guest_boot_id = Some("22222222-2222-2222-2222-222222222222".into());
        owner.phase = "running".into();
        let mut receipt = fixture.receipt();
        receipt.phase = "preparing".into();
        mark_started(&mut receipt).unwrap();
        receipt.relay_startup = Some(serde_json::from_value(json!({"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}})).unwrap());
        let context = host_relay::context(&receipt.owner, &previous).unwrap();
        receipt.relay_cleanup = Some(
            serde_json::from_value(json!({
                "version":1,"runtime":context.runtime,"boot":context.boot,"operation":([3;16]),
                "effect":([4;32]),"control_root":"/private/owned","phase":"pending"
            }))
            .unwrap(),
        );
        assert_eq!(
            recovery_selection(&fixture.candidate, &fixture.graph(), &receipt, &owner, true)
                .unwrap(),
            Some(selected(&receipt).unwrap())
        );
        // And a completed prior recovery is archived when the current run is started.
        let history = super::super::tests::Fixture::new();
        let root = &history.0;
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
        current.phase = "restoring".into();
        mark_started(&mut current).unwrap();
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

    /// One completed recovery per generation, as each pool stop under a running
    /// project leaves (HACK-2576): stopped generation `index`, then a ready one.
    fn recover_generation(root: &std::path::Path, base: &Receipt, index: usize) -> String {
        // Each generation is its own container generation of the same run.
        let mut original = base.clone();
        original.resources.get_mut("container:init").unwrap().id = Some(format!("{index:064x}"));
        let original = &original;
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        for resource in stopped.resources.values_mut() {
            if resource.kind != Kind::Volume {
                resource.phase = "absent".into();
            }
        }
        restore_history::retain(root, &stopped).unwrap();
        let mut proof = intent(original);
        proof.new_boot = Some(format!("boot-{index}"));
        let complete = selected(&stopped).unwrap();
        proof.complete_sha256 = Some(complete.clone());
        state::write(&root.join(FILE), &proof).unwrap();
        let mut current = stopped.clone();
        current.phase = "ready-observed".into();
        current.resources.get_mut("container:init").unwrap().id =
            Some(format!("{:064x}", index + 1000));
        let selected_current = selected(&current).unwrap();
        archive_completed_prior(
            root,
            &current,
            &selected_current,
            &"2".repeat(64),
            &format!("boot-{}", index + 1),
        )
        .unwrap_or_else(|error| panic!("recovery {index} refused: {}", error.message));
        assert!(!root.join(FILE).exists());
        complete
    }
    fn archives(root: &std::path::Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(RETIRED_PREFIX))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn twelve_recoveries_of_one_run_keep_the_newest_archives_and_never_refuse() {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        let original = partial();
        // A foreign file and an unprovable record share the directory: never removed,
        // never counted, never a reason to refuse.
        fs::write(root.join(format!("{RETIRED_PREFIX}foreign.json")), b"{").unwrap();
        fs::write(root.join(format!("{RETIRED_PREFIX}notes.txt")), b"notes").unwrap();
        let mut newest = String::new();
        for index in 0..12 {
            newest = recover_generation(root, &original, index);
            // Distinct modification times keep "oldest" well defined.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let left = archives(root);
        let proven: Vec<_> = left
            .iter()
            .filter(|name| finished_archive(name, &fs::read(root.join(name)).unwrap()))
            .collect();
        assert_eq!(proven.len(), RETIRED_LIMIT, "{left:?}");
        assert!(left.contains(&format!("{RETIRED_PREFIX}{newest}.json")));
        assert!(left.contains(&format!("{RETIRED_PREFIX}foreign.json")));
        assert!(left.contains(&format!("{RETIRED_PREFIX}notes.txt")));
    }

    #[test]
    fn a_home_stuck_at_eight_archives_from_an_older_build_recovers() {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        let original = partial();
        // Eight finished archives, as an older build left them before it refused.
        let mut oldest = String::new();
        for index in 0..8 {
            let complete = recover_generation(root, &original, 100 + index);
            if index == 0 {
                oldest = complete;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(archives(root).len(), RETIRED_LIMIT);
        // The ninth recovery, which the older build refused, now goes through.
        let ninth = recover_generation(root, &original, 200);
        let left = archives(root);
        assert_eq!(left.len(), RETIRED_LIMIT);
        assert!(left.contains(&format!("{RETIRED_PREFIX}{ninth}.json")));
        assert!(!left.contains(&format!("{RETIRED_PREFIX}{oldest}.json")));
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
