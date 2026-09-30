//! One explicit source-device translation for an acknowledged stopped graph.
//!
//! The stopped receipt and its cleanup proofs remain immutable. This witness may
//! project the share device and a proven retained cache scope into the next generation.
use super::{
    Candidate, CandidateError, Engine, Kind, Receipt, cleanup_enrollment, directory, foreground,
    host_pin_recovery, inspect_resource, load, restore, source, state,
};
use crate::provider::{ProjectShareIntent, lifecycle};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const FILE: &str = "source-device-rebind.json";
const LIMIT: u64 = 256 * 1024;
const STATE_LIMIT: u64 = 2 * 1024 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "graph_source_device_rebind",
        "Selected source-device continuity or retained graph identity changed; original receipts and data were preserved.",
    )
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(refused()),
        Ok(_) => Ok(false),
    }
}

pub(super) fn require_no_pending(candidate: &Candidate, run: &str) -> Result<(), CandidateError> {
    if absent(
        &directory(candidate, run)?
            .join(FILE)
            .with_extension("pending"),
    )? {
        Ok(())
    } else {
        Err(refused())
    }
}

fn no_pending(root: &Path) -> Result<(), CandidateError> {
    for name in [
        "state.pending",
        "absent-publication-cleanup.pending",
        "absent-publication-retirement.pending",
        "source-device-rebind.pending",
    ] {
        if !absent(&root.join(name))? {
            return Err(refused());
        }
    }
    Ok(())
}

fn encoded(value: &impl Serialize) -> Result<Vec<u8>, CandidateError> {
    serde_json::to_vec_pretty(value).map_err(|_| refused())
}

struct PinnedRaw {
    file: File,
    bytes: Vec<u8>,
    file_id: (u64, u64),
    parent_id: (u64, u64),
    path: PathBuf,
}

impl PinnedRaw {
    fn reverify(&self) -> Result<(), CandidateError> {
        let parent = self.path.parent().ok_or_else(refused)?;
        state::check_private_directory(parent).map_err(|_| refused())?;
        let parent_meta = fs::symlink_metadata(parent).map_err(|_| refused())?;
        let meta = self.file.metadata().map_err(|_| refused())?;
        let path_meta = fs::symlink_metadata(&self.path).map_err(|_| refused())?;
        // SAFETY: geteuid has no arguments or side effects.
        let uid = unsafe { libc::geteuid() };
        if (parent_meta.dev(), parent_meta.ino()) != self.parent_id
            || (meta.dev(), meta.ino()) != self.file_id
            || (path_meta.dev(), path_meta.ino()) != self.file_id
            || !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != uid
            || path_meta.uid() != uid
            || meta.mode() & 0o7777 != 0o600
            || path_meta.mode() & 0o7777 != 0o600
            || path_meta.nlink() != 1
            || meta.len() != self.bytes.len() as u64
        {
            return Err(refused());
        }
        let mut file = &self.file;
        file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
        let mut bytes = Vec::new();
        file.take(self.bytes.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes != self.bytes {
            return Err(refused());
        }
        Ok(())
    }
}

fn pin_raw(path: &Path, limit: u64, allow_empty: bool) -> Result<PinnedRaw, CandidateError> {
    let parent = path.parent().ok_or_else(refused)?;
    state::check_private_directory(parent).map_err(|_| refused())?;
    let parent_meta = fs::symlink_metadata(parent).map_err(|_| refused())?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let before = file.metadata().map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or side effects.
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o7777 != 0o600
        || before.len() > limit
        || (!allow_empty && before.len() == 0)
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
    let mut confirmation = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut confirmation)
        .map_err(|_| refused())?;
    let after = file.metadata().map_err(|_| refused())?;
    let path_after = fs::symlink_metadata(path).map_err(|_| refused())?;
    let parent_after = fs::symlink_metadata(parent).map_err(|_| refused())?;
    if bytes != confirmation
        || bytes.len() as u64 != before.len()
        || [after.dev(), path_after.dev()] != [before.dev(); 2]
        || [after.ino(), path_after.ino()] != [before.ino(); 2]
        || [after.len(), path_after.len()] != [before.len(); 2]
        || [after.mtime(), path_after.mtime()] != [before.mtime(); 2]
        || [after.mtime_nsec(), path_after.mtime_nsec()] != [before.mtime_nsec(); 2]
        || [after.ctime(), path_after.ctime()] != [before.ctime(); 2]
        || [after.ctime_nsec(), path_after.ctime_nsec()] != [before.ctime_nsec(); 2]
        || path_after.nlink() != 1
        || (parent_after.dev(), parent_after.ino()) != (parent_meta.dev(), parent_meta.ino())
    {
        return Err(refused());
    }
    Ok(PinnedRaw {
        file,
        bytes,
        file_id: (before.dev(), before.ino()),
        parent_id: (parent_meta.dev(), parent_meta.ino()),
        path: path.to_owned(),
    })
}

fn raw(
    path: &Path,
    limit: u64,
    allow_empty: bool,
) -> Result<(Vec<u8>, (u64, u64)), CandidateError> {
    let pin = pin_raw(path, limit, allow_empty)?;
    Ok((pin.bytes, pin.file_id))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Witness {
    version: u8,
    run: String,
    owner: String,
    namespace: String,
    plan: String,
    original_ready_sha256: String,
    stopped_raw_sha256: String,
    absent_intent_raw_sha256: String,
    retirement_raw_sha256: String,
    original_owner_raw_sha256: String,
    current_owner_raw_sha256: String,
    host_boot_micros: u64,
    previous_guest_boot: String,
    current_guest_boot: String,
    old_share: ProjectShareIntent,
    current_share: ProjectShareIntent,
    retained_volume_projections: BTreeMap<String, Value>,
    retained_volumes: BTreeMap<String, (String, String, String)>,
}

impl Witness {
    fn project(&self, receipt: &Receipt) -> Result<Receipt, CandidateError> {
        let mut projected = receipt.clone();
        let shared = projected
            .source
            .as_mut()
            .and_then(|source| source.shared.as_mut())
            .ok_or_else(refused)?;
        if *shared != self.old_share {
            return Err(refused());
        }
        shared.device = self.current_share.device;
        if *shared != self.current_share {
            return Err(refused());
        }
        let scopes = receipt
            .resources
            .values()
            .filter_map(|resource| resource.cache.as_ref().map(|cache| cache.scope.as_str()))
            .collect::<Vec<_>>();
        let binding = projected.source.as_mut().ok_or_else(refused)?;
        binding.cache_scope = super::dependency_cache::ReplayScope::project(
            &self.old_share,
            &self.current_share,
            binding.cache_scope.as_ref(),
            &scopes,
            &sha256(&encoded(self)?),
        )?;
        Ok(projected)
    }

    fn unchanged_identity(&self, receipt: &Receipt) -> bool {
        self.version == 1
            && self.run == receipt.run
            && self.owner == receipt.owner
            && self.namespace == receipt.namespace
            && self.plan == receipt.plan_id
            && self.old_share.device != self.current_share.device
            && self.old_share.project == self.current_share.project
            && self.old_share.guest_path == self.current_share.guest_path
            && self.old_share.inode == self.current_share.inode
            && self.old_share.unfiltered_source == self.current_share.unfiltered_source
            && receipt.source.as_ref().and_then(|s| s.shared.as_ref()) == Some(&self.old_share)
    }
}

/// Corroborate an explicitly selected legacy HTTPS device translation. This
/// witness does not establish original host-volume continuity or authorize any
/// HTTPS effect; the caller must independently select and pin both current inodes.
pub(in crate::provider) fn https_devices(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<(u64, u64), CandidateError> {
    if !super::hex(run, 32) || !super::hex(expected, 64) {
        return Err(refused());
    }
    let root = directory(candidate, run)?;
    no_pending(&root)?;
    for entry in fs::read_dir(&root).map_err(|_| refused())? {
        let name = entry.map_err(|_| refused())?.file_name();
        if name.to_str().is_none_or(|s| s.ends_with(".pending")) {
            return Err(refused());
        }
    }
    let pin = pin_raw(&root.join(FILE), LIMIT, false)?;
    let witness: Witness = serde_json::from_slice(&pin.bytes).map_err(|_| refused())?;
    let owner_root = candidate.state_root.join("run/smolvm");
    let owner_pin = pin_raw(&owner_root.join("owner.json"), STATE_LIMIT, false)?;
    let owner: state::Owner = serde_json::from_slice(&owner_pin.bytes).map_err(|_| refused())?;
    let receipt_pin = pin_raw(&root.join("state.json"), STATE_LIMIT, false)?;
    let receipt: Receipt = serde_json::from_slice(&receipt_pin.bytes).map_err(|_| refused())?;
    if sha256(&pin.bytes) != expected
        || pin.bytes != encoded(&witness)?
        || witness.version != 1
        || witness.run != run
        || witness.owner != owner.token
        || sha256(&owner_pin.bytes) != witness.current_owner_raw_sha256
        || owner.project_share.as_ref() != Some(&witness.current_share)
        || owner.guest_boot_id.as_deref() != Some(witness.current_guest_boot.as_str())
        || lifecycle::host_filesystem::host_boot_micros()? != witness.host_boot_micros
        || witness.old_share.device == witness.current_share.device
        || witness.old_share.project != witness.current_share.project
        || witness.old_share.guest_path != witness.current_share.guest_path
        || witness.old_share.inode != witness.current_share.inode
        || witness.old_share.unfiltered_source != witness.current_share.unfiltered_source
        || receipt.run != witness.run
        || receipt.owner != witness.owner
        || receipt.namespace != witness.namespace
        || receipt.plan_id != witness.plan
        || receipt.phase != "stopped-data-retained"
        || receipt.source.as_ref().and_then(|s| s.shared.as_ref()) != Some(&witness.current_share)
        || receipt
            .resources
            .values()
            .any(|r| r.kind != Kind::Volume && r.phase != "absent")
    {
        return Err(refused());
    }
    witness.current_share.validate().map_err(|_| refused())?;
    pin.reverify()?;
    owner_pin.reverify()?;
    receipt_pin.reverify()?;
    Ok((witness.old_share.device, witness.current_share.device))
}

#[cfg(test)]
pub(in crate::provider) fn fixture_https_witness(
    candidate: &Candidate,
    receipt: &Receipt,
    old_device: u64,
) -> Vec<u8> {
    let owner = state::Owner::load(candidate).unwrap();
    let current_share = owner.project_share.clone().unwrap();
    let mut old_share = current_share.clone();
    old_share.device = old_device;
    encoded(&Witness {
        version: 1,
        run: receipt.run.clone(),
        owner: owner.token,
        namespace: receipt.namespace.clone(),
        plan: receipt.plan_id.clone(),
        original_ready_sha256: "1".repeat(64),
        stopped_raw_sha256: sha256(&encoded(receipt).unwrap()),
        absent_intent_raw_sha256: "3".repeat(64),
        retirement_raw_sha256: "4".repeat(64),
        original_owner_raw_sha256: "5".repeat(64),
        current_owner_raw_sha256: sha256(
            &fs::read(candidate.state_root.join("run/smolvm/owner.json")).unwrap(),
        ),
        host_boot_micros: lifecycle::host_filesystem::host_boot_micros().unwrap(),
        previous_guest_boot: "old".into(),
        current_guest_boot: owner.guest_boot_id.unwrap(),
        old_share,
        current_share,
        retained_volume_projections: BTreeMap::new(),
        retained_volumes: BTreeMap::new(),
    })
    .unwrap()
}

/// A later ordinary replay uses the original witness as immutable provenance,
/// never as authority to change the current Owner, guest boot or source device.
pub(super) fn verify_cache_scope_origin(
    candidate: &Candidate,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    let Some(binding) = &receipt.source else {
        return Ok(());
    };
    let Some(scope) = &binding.cache_scope else {
        return Ok(());
    };
    let root = directory(candidate, &receipt.run)?;
    no_pending(&root)?;
    let pin = pin_raw(&root.join(FILE), LIMIT, false)?;
    let witness: Witness = serde_json::from_slice(&pin.bytes).map_err(|_| refused())?;
    if encoded(&witness)? != pin.bytes
        || witness.version != 1
        || witness.run != receipt.run
        || witness.owner != receipt.owner
        || witness.namespace != receipt.namespace
        || witness.plan != receipt.plan_id
        || binding.shared.as_ref() != Some(&witness.current_share)
        || !scope.matches_origin(
            &sha256(&pin.bytes),
            &witness.old_share,
            &witness.current_share,
        )
    {
        return Err(refused());
    }
    let expected = scope.scope(&witness.current_share.project)?;
    if receipt
        .resources
        .values()
        .filter_map(|resource| resource.cache.as_ref())
        .any(|cache| cache.scope != expected)
    {
        return Err(refused());
    }
    pin.reverify()
}

/// Historical cache provenance also pins the exact cleanup/retirement bytes
/// used to archive its old journal; another same-schema proof is insufficient.
pub(super) fn verify_cache_scope_cleanup_origin(
    candidate: &Candidate,
    receipt: &Receipt,
    intent_sha256: &str,
    retirement_sha256: &str,
) -> Result<(), CandidateError> {
    verify_cache_scope_origin(candidate, receipt)?;
    let Some(scope) = receipt
        .source
        .as_ref()
        .and_then(|source| source.cache_scope.as_ref())
    else {
        return Ok(());
    };
    let root = directory(candidate, &receipt.run)?;
    let pin = pin_raw(&root.join(FILE), LIMIT, false)?;
    let witness: Witness = serde_json::from_slice(&pin.bytes).map_err(|_| refused())?;
    if encoded(&witness)? != pin.bytes
        || !scope.matches_origin(
            &sha256(&pin.bytes),
            &witness.old_share,
            &witness.current_share,
        )
        || witness.absent_intent_raw_sha256 != intent_sha256
        || witness.retirement_raw_sha256 != retirement_sha256
    {
        return Err(refused());
    }
    pin.reverify()
}

/// Pinned complete witness for the original stopped receipt only. A subsequent
/// graph generation cannot use this object as cleanup or source authority.
pub(super) struct Selected {
    witness: Witness,
    pin: PinnedRaw,
    original: Receipt,
    projected: Receipt,
    root: PathBuf,
}

impl Selected {
    pub(super) fn raw_sha256(&self) -> String {
        sha256(&self.pin.bytes)
    }

    pub(super) fn source_receipt(&self) -> &Receipt {
        &self.projected
    }

    pub(super) fn apply_to_new_attempt(&self, receipt: &mut Receipt) -> Result<(), CandidateError> {
        if encoded(receipt)? != encoded(&self.original)? {
            return Err(refused());
        }
        receipt.source = self.projected.source.clone();
        Ok(())
    }

    /// Recheck raw bytes, pathname identity, Owner, guest and volumes before the
    /// first new-attempt effect/write. The caller still holds the Engine lease.
    pub(super) fn reverify(&self, engine: &Engine<'_>) -> Result<(), CandidateError> {
        self.pin.reverify()?;
        validate_current(engine, &self.root, &self.original, &self.witness)?;
        let current: Receipt = state::read(&self.root.join("state.json"))?;
        if encoded(&current)? != encoded(&self.original)?
            || encoded(&self.witness.project(&current)?)? != encoded(&self.projected)?
        {
            return Err(refused());
        }
        Ok(())
    }
}

fn validate_current(
    engine: &Engine<'_>,
    root: &Path,
    receipt: &Receipt,
    witness: &Witness,
) -> Result<(), CandidateError> {
    no_pending(root)?;
    if receipt.phase != "stopped-data-retained" || !witness.unchanged_identity(receipt) {
        return Err(refused());
    }
    let state_bytes = raw(&root.join("state.json"), STATE_LIMIT, false)?.0;
    if state_bytes != encoded(receipt)? || sha256(&state_bytes) != witness.stopped_raw_sha256 {
        return Err(refused());
    }
    for (name, expected) in [
        (
            "absent-publication-cleanup.json",
            &witness.absent_intent_raw_sha256,
        ),
        (
            "absent-publication-retirement.json",
            &witness.retirement_raw_sha256,
        ),
    ] {
        if sha256(&raw(&root.join(name), STATE_LIMIT, false)?.0) != *expected {
            return Err(refused());
        }
    }
    let candidate = engine.guest().candidate();
    let owner_root = candidate.state_root.join("run/smolvm");
    if sha256(&raw(&owner_root.join("owner.json"), STATE_LIMIT, false)?.0)
        != witness.current_owner_raw_sha256
        || lifecycle::host_filesystem::host_boot_micros()? != witness.host_boot_micros
        || engine.guest().boot_id() != witness.current_guest_boot
        || engine.guest().project_share() != Some(&witness.current_share)
    {
        return Err(refused());
    }
    witness.current_share.validate().map_err(|_| refused())?;
    source::verify_shared_mount(engine, &witness.current_share).map_err(|_| refused())?;
    if restore::observed_volumes(engine, receipt)? != witness.retained_volumes {
        return Err(refused());
    }
    host_pin_recovery::verify_volume_projections(
        engine,
        receipt,
        &witness.retained_volume_projections,
    )
    .map_err(|_| refused())?;
    for resource in receipt.resources.values() {
        if resource.kind != Kind::Volume {
            let observed = inspect_resource(engine, receipt, resource)?;
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
    cleanup_enrollment::retention(root, receipt)?;
    Ok(())
}

/// A committed witness applies only to its original stopped state. Once the
/// next generation has a current share it remains audit data, never authority.
pub(super) fn select(
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &Path,
) -> Result<Option<Selected>, CandidateError> {
    if !absent(&root.join(FILE).with_extension("pending"))? {
        return Err(refused());
    }
    let path = root.join(FILE);
    if absent(&path)? {
        return Ok(None);
    }
    let pin = pin_raw(&path, LIMIT, false)?;
    let witness: Witness = serde_json::from_slice(&pin.bytes).map_err(|_| refused())?;
    if pin.bytes != encoded(&witness)? {
        return Err(refused());
    }
    let state_sha = sha256(&raw(&root.join("state.json"), STATE_LIMIT, false)?.0);
    if state_sha != witness.stopped_raw_sha256 {
        // The witness is historical only when normal source ownership has moved on.
        if receipt.owner == witness.owner
            && receipt.run == witness.run
            && receipt.namespace == witness.namespace
            && receipt.source.as_ref().and_then(|s| s.shared.as_ref())
                == engine.guest().project_share()
        {
            return Ok(None);
        }
        return Err(refused());
    }
    validate_current(engine, root, receipt, &witness)?;
    let projected = witness.project(receipt)?;
    Ok(Some(Selected {
        witness,
        pin,
        original: receipt.clone(),
        projected,
        root: root.to_owned(),
    }))
}

fn selected_witness(
    candidate: &Candidate,
    run: &str,
    retired: &foreground::transport::Retired,
    engine: &Engine<'_>,
) -> Result<(Witness, Receipt, PathBuf), CandidateError> {
    let (receipt, root) = load(candidate, engine, run)?;
    let proof = super::absent_publication_cleanup::verify_completed_under(
        candidate, engine, run, &receipt, retired,
    )?
    .ok_or_else(refused)?;
    let old_share = proof.old_share.ok_or_else(refused)?;
    let current_share = proof.current_share.ok_or_else(refused)?;
    let state_bytes = raw(&root.join("state.json"), STATE_LIMIT, false)?.0;
    if state_bytes != encoded(&receipt)?
        || receipt.phase != "stopped-data-retained"
        || sha256(&state_bytes) != proof.completed_stopped_sha256
        || engine.guest().project_share() != Some(&current_share)
        || lifecycle::host_filesystem::host_boot_micros()? != proof.host_boot_micros
        || engine.guest().boot_id() != proof.current_guest_boot
    {
        return Err(refused());
    }
    let witness = Witness {
        version: 1,
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        namespace: receipt.namespace.clone(),
        plan: receipt.plan_id.clone(),
        original_ready_sha256: proof.original_ready_sha256,
        stopped_raw_sha256: proof.completed_stopped_sha256,
        absent_intent_raw_sha256: proof.intent_raw_sha256,
        retirement_raw_sha256: proof.retirement_raw_sha256,
        original_owner_raw_sha256: proof.original_owner_sha256,
        current_owner_raw_sha256: proof.current_owner_sha256,
        host_boot_micros: proof.host_boot_micros,
        previous_guest_boot: proof.previous_guest_boot,
        current_guest_boot: proof.current_guest_boot,
        old_share,
        current_share,
        retained_volume_projections: proof.retained_volumes,
        retained_volumes: restore::observed_volumes(engine, &receipt)?,
    };
    validate_current(engine, &root, &receipt, &witness)?;
    retired.verify()?;
    Ok((witness, receipt, root))
}

fn selected_output(witness: &Witness, committed: bool) -> Result<Value, CandidateError> {
    Ok(json!({
        "run": witness.run,
        "owner": witness.owner,
        "namespace": witness.namespace,
        "plan": witness.plan,
        "stopped_receipt_sha256": witness.stopped_raw_sha256,
        "selection_sha256": sha256(&encoded(witness)?),
        "committed": committed,
        "qualification": "explicit-legacy-migration-original-volume-continuity-unproven",
    }))
}

/// Read-only selection holds the retired publisher lock before the Engine lease.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let retired = foreground::transport::Retired::acquire(candidate, run)?.ok_or_else(refused)?;
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (witness, receipt, root) = selected_witness(candidate, run, &retired, &engine)?;
    let committed = if absent(&root.join(FILE))? {
        false
    } else {
        let selected = select(&engine, &receipt, &root)?.ok_or_else(refused)?;
        selected.witness == witness
    };
    if !absent(&root.join(FILE).with_extension("pending"))?
        || !committed && !absent(&root.join(FILE))?
    {
        return Err(refused());
    }
    retired.verify()?;
    selected_output(&witness, committed)
}

/// Publish one immutable selected device-only source witness; no graph receipt
/// or cleanup/retirement digest is rewritten.
pub fn recover(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    if !super::hex(expected, 64) {
        return Err(refused());
    }
    let retired = foreground::transport::Retired::acquire(candidate, run)?.ok_or_else(refused)?;
    let engine = Engine::connect_cleanup_wait(candidate)?;
    require_no_pending(candidate, run)?;
    let (witness, receipt, root) = selected_witness(candidate, run, &retired, &engine)?;
    let bytes = encoded(&witness)?;
    if bytes.len() as u64 > LIMIT || sha256(&bytes) != expected {
        return Err(refused());
    }
    let path = root.join(FILE);
    if !absent(&path)? {
        let selected = select(&engine, &receipt, &root)?.ok_or_else(refused)?;
        if selected.pin.bytes != bytes {
            return Err(refused());
        }
        return selected_output(&witness, true);
    }
    retired.verify()?;
    validate_current(&engine, &root, &receipt, &witness)?;
    state::write(&path, &witness)?;
    let selected = select(&engine, &receipt, &root)?.ok_or_else(refused)?;
    if selected.pin.bytes != bytes {
        return Err(refused());
    }
    retired.verify()?;
    selected_output(&witness, true)
}

#[cfg(all(test, feature = "environment-launcher"))]
pub(in crate::provider::graph) fn fixture_wrong_volume_projection(bytes: &[u8]) -> Vec<u8> {
    let mut witness: Witness = serde_json::from_slice(bytes).unwrap();
    witness
        .retained_volume_projections
        .get_mut("volume:data")
        .unwrap()["observed_created_at"] = json!("foreign");
    encoded(&witness).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn https_translation_requires_selected_witness_current_owner_boot_share_and_scope() {
        let fixture = super::super::tests::Fixture::new();
        fs::write(fixture.0.join("compose.yaml"), "services: {}\n").unwrap();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let share = ProjectShareIntent::approve(&fixture.0, true).unwrap();
        let mut owner = state::Owner::create(
            &candidate,
            crate::provider::Profile::Research,
            None,
            crate::provider::NetworkIntent::Isolated,
        )
        .unwrap();
        owner.project_share = Some(share.clone());
        owner.guest_boot_id = Some("new".into());
        owner.save(&candidate).unwrap();
        struct Alias(PathBuf, PathBuf);
        impl Drop for Alias {
            fn drop(&mut self) {
                if fs::read_link(&self.0).ok().as_ref() == Some(&self.1) {
                    let _ = fs::remove_file(&self.0);
                }
            }
        }
        let _alias = Alias(
            owner.short_home.clone(),
            candidate.state_root.join("run/smolvm/home"),
        );
        let mut old_share = share.clone();
        old_share.device += 7;
        let run = "a".repeat(32);
        let parent = candidate.state_root.join("run/graphs");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let root = parent.join(&run);
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":run,"owner":owner.token,"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},
            "source":{"shared":share,"revision":"e".repeat(64),"archive_sha256":"f".repeat(64),"selection_sha256":"0".repeat(64)},
            "resources":{}
        })).unwrap();
        private_file(&root.join("state.json"), &encoded(&receipt).unwrap());
        let witness = Witness {
            version: 1,
            run: run.clone(),
            owner: owner.token.clone(),
            namespace: receipt.namespace.clone(),
            plan: receipt.plan_id.clone(),
            original_ready_sha256: "1".repeat(64),
            stopped_raw_sha256: "2".repeat(64),
            absent_intent_raw_sha256: "3".repeat(64),
            retirement_raw_sha256: "4".repeat(64),
            original_owner_raw_sha256: "5".repeat(64),
            current_owner_raw_sha256: sha256(
                &fs::read(candidate.state_root.join("run/smolvm/owner.json")).unwrap(),
            ),
            host_boot_micros: lifecycle::host_filesystem::host_boot_micros().unwrap(),
            previous_guest_boot: "old".into(),
            current_guest_boot: "new".into(),
            old_share,
            current_share: share.clone(),
            retained_volume_projections: BTreeMap::new(),
            retained_volumes: BTreeMap::new(),
        };
        let path = root.join(FILE);
        let bytes = encoded(&witness).unwrap();
        private_file(&path, &bytes);
        let expected = sha256(&bytes);
        assert_eq!(
            https_devices(&candidate, &run, &expected).unwrap(),
            (share.device + 7, share.device)
        );
        assert!(https_devices(&candidate, &run, &"f".repeat(64)).is_err());
        private_file(&root.join("unknown.pending"), b"retained pending intent");
        assert!(https_devices(&candidate, &run, &expected).is_err());
        fs::remove_file(root.join("unknown.pending")).unwrap();
        for control in ["namespace", "owner", "boot", "share", "one_device"] {
            let mut changed = witness.clone();
            match control {
                "namespace" => changed.namespace = "9".repeat(64),
                "owner" => changed.current_owner_raw_sha256 = "9".repeat(64),
                "boot" => changed.host_boot_micros += 1,
                "share" => changed.current_share.inode += 1,
                _ => changed.old_share.device = changed.current_share.device,
            }
            let changed = encoded(&changed).unwrap();
            fs::write(&path, &changed).unwrap();
            assert!(
                https_devices(&candidate, &run, &sha256(&changed)).is_err(),
                "{control}"
            );
        }
    }

    fn private_file(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        use std::io::Write;
        file.write_all(bytes).unwrap();
    }

    #[test]
    fn cached_projection_adds_continuity_only_to_the_new_attempt() {
        let fixture = super::super::tests::Fixture::new();
        fs::write(fixture.0.join("compose.yaml"), "services: {}\n").unwrap();
        let current_share = ProjectShareIntent::approve(&fixture.0, true).unwrap();
        let mut old_share = current_share.clone();
        old_share.device += 7;
        let legacy_scope = sha256(
            &serde_json::to_vec(&(
                "hack-dependency-cache-scope-v1",
                &fixture.0,
                old_share.device,
                old_share.inode,
            ))
            .unwrap(),
        );
        let receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},
            "source":{"shared":old_share,"revision":"e".repeat(64),"archive_sha256":"f".repeat(64),"selection_sha256":"0".repeat(64)},
            "resources":{"volume:deps":{"kind":"volume","key":"deps","name":format!("hack-cache-v5-{}","9".repeat(64)),"phase":"present","id":null,"image":null,"cache":{"scope":legacy_scope,"fingerprint":"9".repeat(64),"image":format!("sha256:{}","8".repeat(64))}}}
        })).unwrap();
        let original = encoded(&receipt).unwrap();
        let witness = Witness {
            version: 1,
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            namespace: receipt.namespace.clone(),
            plan: receipt.plan_id.clone(),
            original_ready_sha256: "1".repeat(64),
            stopped_raw_sha256: "2".repeat(64),
            absent_intent_raw_sha256: "3".repeat(64),
            retirement_raw_sha256: "4".repeat(64),
            original_owner_raw_sha256: "5".repeat(64),
            current_owner_raw_sha256: "6".repeat(64),
            host_boot_micros: 7,
            previous_guest_boot: "old".into(),
            current_guest_boot: "new".into(),
            old_share,
            current_share,
            retained_volume_projections: BTreeMap::new(),
            retained_volumes: BTreeMap::new(),
        };
        let projected = witness.project(&receipt).unwrap();
        let scope = projected
            .source
            .as_ref()
            .unwrap()
            .cache_scope
            .as_ref()
            .unwrap();
        assert_eq!(scope.scope(&fixture.0).unwrap(), legacy_scope);
        assert_eq!(
            projected.source.as_ref().unwrap().shared,
            Some(witness.current_share.clone())
        );
        assert!(super::super::same_resource_bindings(
            &projected.resources,
            &receipt.resources
        ));
        assert_eq!(encoded(&receipt).unwrap(), original);
        let decoded: Receipt = serde_json::from_slice(&encoded(&projected).unwrap()).unwrap();
        assert_eq!(decoded.source, projected.source);

        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        let root = directory(&candidate, &receipt.run).unwrap();
        state::private_directory(&root).unwrap();
        assert!(verify_cache_scope_origin(&candidate, &projected).is_err());
        private_file(&root.join(FILE), &encoded(&witness).unwrap());
        verify_cache_scope_origin(&candidate, &projected).unwrap();
        verify_cache_scope_cleanup_origin(
            &candidate,
            &projected,
            &witness.absent_intent_raw_sha256,
            &witness.retirement_raw_sha256,
        )
        .unwrap();
        assert!(
            verify_cache_scope_cleanup_origin(
                &candidate,
                &projected,
                &"7".repeat(64),
                &witness.retirement_raw_sha256
            )
            .is_err()
        );
        assert!(
            verify_cache_scope_cleanup_origin(
                &candidate,
                &projected,
                &witness.absent_intent_raw_sha256,
                &"7".repeat(64)
            )
            .is_err()
        );
        let mut changed_plan = projected.clone();
        changed_plan.plan_id = "7".repeat(64);
        assert!(verify_cache_scope_origin(&candidate, &changed_plan).is_err());
        let mut foreign_origin = witness.clone();
        foreign_origin.owner = "7".repeat(32);
        fs::remove_file(root.join(FILE)).unwrap();
        private_file(&root.join(FILE), &encoded(&foreign_origin).unwrap());
        assert!(verify_cache_scope_origin(&candidate, &projected).is_err());
        fs::remove_file(root.join(FILE)).unwrap();
        private_file(&root.join(FILE), &encoded(&witness).unwrap());
        let mut foreign_cache = projected.clone();
        foreign_cache
            .resources
            .get_mut("volume:deps")
            .unwrap()
            .cache
            .as_mut()
            .unwrap()
            .scope = "0".repeat(64);
        assert!(verify_cache_scope_origin(&candidate, &foreign_cache).is_err());
        private_file(&root.join(FILE).with_extension("pending"), b"partial");
        assert!(verify_cache_scope_origin(&candidate, &projected).is_err());
        assert_eq!(
            fs::read(root.join(FILE).with_extension("pending")).unwrap(),
            b"partial"
        );

        let mut foreign = receipt.clone();
        foreign
            .resources
            .get_mut("volume:deps")
            .unwrap()
            .cache
            .as_mut()
            .unwrap()
            .scope = "0".repeat(64);
        assert!(witness.project(&foreign).is_err());
        assert_eq!(encoded(&receipt).unwrap(), original);
    }

    #[test]
    fn pinned_witness_refuses_equal_bytes_at_a_replacement_path_or_parent() {
        let fixture = super::super::tests::Fixture::new();
        let parent = fixture.0.join("witness");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let path = parent.join(FILE);
        private_file(&path, b"proof");
        let pin = pin_raw(&path, LIMIT, false).unwrap();
        pin.reverify().unwrap();

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(pin.reverify().is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        pin.reverify().unwrap();

        fs::rename(&path, parent.join("archived")).unwrap();
        private_file(&path, b"proof");
        assert!(pin.reverify().is_err());

        fs::rename(&parent, fixture.0.join("old-witness")).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        private_file(&path, b"proof");
        assert!(pin.reverify().is_err());
    }

    #[test]
    fn pending_witness_is_preserved_and_refuses_publication() {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let run = "a".repeat(32);
        let root = directory(&candidate, &run).unwrap();
        state::private_directory(&root).unwrap();
        let pending = root.join(FILE).with_extension("pending");
        private_file(&pending, b"");
        assert!(require_no_pending(&candidate, &run).is_err());
        assert!(no_pending(&root).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"");
        fs::remove_file(&pending).unwrap();
        private_file(&pending, b"foreign");
        assert!(require_no_pending(&candidate, &run).is_err());
        assert!(no_pending(&root).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"foreign");
    }

    #[test]
    fn source_projection_changes_only_the_selected_device() {
        let old_share = ProjectShareIntent {
            project: PathBuf::from("/private/tmp/example-project"),
            guest_path: "/mnt/hack-projects/exact".into(),
            device: 17,
            inode: 23,
            unfiltered_source: true,
        };
        let mut current_share = old_share.clone();
        current_share.device = 19;
        let receipt: Receipt = serde_json::from_value(json!({
            "version": 1,
            "run": "a".repeat(32),
            "owner": "b".repeat(32),
            "namespace": "c".repeat(64),
            "plan_id": "d".repeat(64),
            "phase": "stopped-data-retained",
            "readiness": {},
            "resources": {},
            "source": {
                "shared": old_share,
                "revision": "e".repeat(64),
                "archive_sha256": "f".repeat(64),
                "selection_sha256": "0".repeat(64),
            },
        }))
        .unwrap();
        let witness = Witness {
            version: 1,
            run: receipt.run.clone(),
            owner: receipt.owner.clone(),
            namespace: receipt.namespace.clone(),
            plan: receipt.plan_id.clone(),
            original_ready_sha256: "1".repeat(64),
            stopped_raw_sha256: "2".repeat(64),
            absent_intent_raw_sha256: "3".repeat(64),
            retirement_raw_sha256: "4".repeat(64),
            original_owner_raw_sha256: "5".repeat(64),
            current_owner_raw_sha256: "6".repeat(64),
            host_boot_micros: 7,
            previous_guest_boot: "old".into(),
            current_guest_boot: "new".into(),
            old_share,
            current_share,
            retained_volume_projections: BTreeMap::new(),
            retained_volumes: BTreeMap::new(),
        };
        assert!(witness.unchanged_identity(&receipt));
        let projected = witness.project(&receipt).unwrap();
        let mut expected = receipt.clone();
        expected
            .source
            .as_mut()
            .unwrap()
            .shared
            .as_mut()
            .unwrap()
            .device = 19;
        assert_eq!(encoded(&projected).unwrap(), encoded(&expected).unwrap());
        assert_eq!(receipt.source.unwrap().shared.unwrap().device, 17);

        let mut foreign = witness.clone();
        foreign.current_share.inode += 1;
        assert!(!foreign.unchanged_identity(&expected));
        assert!(foreign.project(&expected).is_err());
    }
}
