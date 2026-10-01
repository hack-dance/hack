//! Explicit data-retaining recovery when both ephemeral host publications were
//! lost across a physical host reboot. Missing paths never create ordinary
//! ownership authority: the selected, durable witness is the only admission.
use super::{
    Candidate, CandidateError, Engine, Kind, Receipt, dead_owner_cleanup, dependency_slots,
    directory, foreground, host_pin_recovery, host_relay, initializer_cache, inspect_resource,
    load, startup, state,
};
use crate::provider::{
    ProjectShareIntent, artifact, host_pin::DeviceRebind, identity, lifecycle, state::Owner,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const INTENT: &str = "absent-publication-cleanup.json";
const RETIREMENT: &str = "absent-publication-retirement.json";
const LIMIT: u64 = 2 * 1024 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "graph_absent_publication_recovery",
        "Selected post-reboot publication absence or retained graph identity changed; evidence and data were preserved.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}
fn require_absent(path: &Path) -> Result<(), CandidateError> {
    if !absent(path)? {
        return Err(refused());
    }
    Ok(())
}
fn no_pending(root: &Path) -> Result<(), CandidateError> {
    for name in [
        "state.pending",
        "dead-owner-cleanup.pending",
        "relay-cleanup-bridges.pending",
        "one-off.pending",
        "one-off-normalization.pending",
        "absent-publication-cleanup.pending",
        "absent-publication-retirement.pending",
    ] {
        require_absent(&root.join(name))?;
    }
    Ok(())
}
fn retain_interrupted_publications(root: &Path) -> Result<(), CandidateError> {
    super::journal::retain_file(
        root,
        "absent-publication-cleanup.pending",
        "absent-publication-cleanup-recovery",
        4 * 1024 * 1024,
    )?;
    super::journal::retain_file(
        root,
        "absent-publication-retirement.pending",
        "absent-publication-retirement-recovery",
        65536,
    )?;
    Ok(())
}
fn private_input(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    if !path.is_absolute() || fs::canonicalize(path).map_err(|_| refused())? != path {
        return Err(refused());
    }
    host_pin_recovery::read_raw(path, limit).map_err(|_| refused())
}
fn device_only_share(
    old: Option<&ProjectShareIntent>,
    current: Option<&ProjectShareIntent>,
    old_device: u64,
    new_device: u64,
) -> bool {
    match (old, current) {
        (None, None) => true,
        (Some(previous), Some(current)) => {
            let mut expected = previous.clone();
            expected.device = new_device;
            previous.device == old_device && *current == expected
        }
        _ => false,
    }
}

/// This is the exact serialization shape of the pre-migration inspection. It
/// binds the raw original Owner, one common host-device change and the boot
/// used to approve it; it is not a physical-volume UUID proof.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilesystemInspection {
    schema: String,
    selection_sha256: String,
    owner_sha256: String,
    machine: String,
    host_boot_micros: u64,
    provider_start_micros: u64,
    old_device: u64,
    new_device: u64,
    pool_inode: u64,
    storage: identity::DiskIdentity,
    overlay: identity::DiskIdentity,
    project_share: Option<ProjectShareIntent>,
    qualification: String,
}
impl FilesystemInspection {
    fn verify(&self, owner_bytes: &[u8], old: &Owner) -> Result<(), CandidateError> {
        let mut unsigned = self.clone();
        unsigned.selection_sha256.clear();
        if self.schema != "hack.host-filesystem-recovery/v1"
            || self.qualification != "explicit-legacy-migration-original-volume-continuity-unproven"
            || self.owner_sha256 != digest(owner_bytes)
            || self.selection_sha256
                != digest(&serde_json::to_vec(&unsigned).map_err(|_| refused())?)
            || self.machine != old.machine
            || self.provider_start_micros != old.process.as_ref().ok_or_else(refused)?.start_micros
            || self.old_device == self.new_device
            || self.storage.device != self.new_device
            || self.overlay.device != self.new_device
            || old.storage.as_ref().is_none_or(|disk| {
                disk.device != self.old_device
                    || disk.inode != self.storage.inode
                    || disk.bytes != self.storage.bytes
                    || disk.uuid != self.storage.uuid
            })
            || old.overlay.as_ref().is_none_or(|disk| {
                disk.device != self.old_device
                    || disk.inode != self.overlay.inode
                    || disk.bytes != self.overlay.bytes
                    || disk.uuid != self.overlay.uuid
            })
            || !device_only_share(
                old.project_share.as_ref(),
                self.project_share.as_ref(),
                self.old_device,
                self.new_device,
            )
        {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(all(test, feature = "environment-launcher"))]
pub(in crate::provider::graph) fn fixture_inspection(
    owner_bytes: &[u8],
    current: &Owner,
    old_device: u64,
    host_boot_micros: u64,
    pool_inode: u64,
) -> Vec<u8> {
    let old: Owner = serde_json::from_slice(owner_bytes).unwrap();
    let mut selection = FilesystemInspection {
        schema: "hack.host-filesystem-recovery/v1".into(),
        selection_sha256: String::new(),
        owner_sha256: digest(owner_bytes),
        machine: old.machine.clone(),
        host_boot_micros,
        provider_start_micros: old.process.as_ref().unwrap().start_micros,
        old_device,
        new_device: current.storage.as_ref().unwrap().device,
        pool_inode,
        storage: current.storage.clone().unwrap(),
        overlay: current.overlay.clone().unwrap(),
        project_share: current.project_share.clone(),
        qualification: "explicit-legacy-migration-original-volume-continuity-unproven".into(),
    };
    selection.selection_sha256 = digest(&serde_json::to_vec(&selection).unwrap());
    serde_json::to_vec_pretty(&selection).unwrap()
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    version: u8,
    candidate: PathBuf,
    run: String,
    owner: String,
    namespace: String,
    plan: String,
    original_owner_path: PathBuf,
    original_owner_sha256: String,
    filesystem_inspection_path: PathBuf,
    filesystem_inspection_sha256: String,
    current_owner_sha256: String,
    graph_sha256: String,
    host_boot_micros: u64,
    old_device: u64,
    new_device: u64,
    previous_guest_boot: String,
    current_guest_boot: String,
    foreground_root: PathBuf,
    control_root: PathBuf,
    source_shared: Option<ProjectShareIntent>,
    environment_inventory: Value,
    scoped_bridge_projection: Value,
    retained_volumes: BTreeMap<String, Value>,
    dependency_reservation: Option<dependency_slots::LegacyReservation>,
    qualification: String,
}
impl Selection {
    pub(super) fn digest(&self) -> Result<String, CandidateError> {
        Ok(digest(&serde_json::to_vec(self).map_err(|_| refused())?))
    }
    pub(super) fn matches_graph(&self, receipt: &Receipt) -> bool {
        self.run == receipt.run
            && self.owner == receipt.owner
            && self.namespace == receipt.namespace
            && self.plan == receipt.plan_id
            && self.source_shared == receipt.source.as_ref().and_then(|s| s.shared.clone())
    }
    pub(super) fn previous_boot(&self) -> &str {
        &self.previous_guest_boot
    }
    pub(super) fn control_root(&self) -> &Path {
        &self.control_root
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    selection_sha256: String,
    selection: Selection,
    original: Receipt,
    environment: Value,
    bridges: super::bridges::cleanup::Selection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prior_bridges: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    complete_sha256: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Retirement {
    version: u8,
    selection_sha256: String,
    complete_sha256: String,
    owner: String,
    run: String,
}

fn selected_volumes(
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<BTreeMap<String, Value>, CandidateError> {
    let mut volumes = BTreeMap::new();
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, resource)| resource.kind == Kind::Volume)
    {
        let actual = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
        let created = actual["CreatedAt"]
            .as_str()
            .filter(|value| !value.is_empty());
        if created.is_none() {
            return Err(refused());
        }
        volumes.insert(
            key.clone(),
            json!({
                "expected_name": resource.name,
                "observed_name": actual["Name"],
                "observed_created_at": actual["CreatedAt"],
                "observed_mountpoint": actual["Mountpoint"],
                "observed_driver": actual["Driver"],
                "observed_labels_sha256": digest(
                    &serde_json::to_vec(&actual["Labels"]).map_err(|_| refused())?
                ),
                "labels": super::expected_labels(receipt, resource),
            }),
        );
    }
    Ok(volumes)
}

fn current_owner(
    candidate: &Candidate,
    old: &Owner,
    inspection: &FilesystemInspection,
    engine: &Engine<'_>,
) -> Result<(Owner, String), CandidateError> {
    lifecycle::host_filesystem::no_auxiliary_update(candidate)?;
    if lifecycle::host_filesystem::host_boot_micros()? != inspection.host_boot_micros {
        return Err(refused());
    }
    let old_process = old.process.as_ref().ok_or_else(refused)?;
    // SAFETY: geteuid has no arguments or side effects.
    identity::verify(
        old_process,
        old_process,
        &artifact::root(candidate).join("smolvm-bin"),
        unsafe { libc::geteuid() },
    )
    .map_err(|_| refused())?;
    DeviceRebind {
        old: inspection.old_device,
        current: inspection.new_device,
    }
    .definitely_dead_before_boot(old_process, inspection.host_boot_micros)
    .map_err(|_| refused())?;
    let owner = Owner::load(candidate)?;
    lifecycle::verify_disks(candidate, &owner)?;
    host_pin_recovery::verify_guest_identity(engine)?;
    let pool =
        fs::symlink_metadata(candidate.state_root.join("run/smolvm")).map_err(|_| refused())?;
    if old.phase != "running"
        || owner.phase != "running"
        || old.token != owner.token
        || owner.token != engine.guest().incarnation()
        || old.guest_boot_id.as_deref() != owner.previous_guest_boot_id.as_deref()
        || owner.guest_boot_id.as_deref() != Some(engine.guest().boot_id())
        || old.guest_boot_id.as_deref() == owner.guest_boot_id.as_deref()
        || owner.storage.as_ref() != Some(&inspection.storage)
        || owner.overlay.as_ref() != Some(&inspection.overlay)
        || owner.project_share != inspection.project_share
        || pool.ino() != inspection.pool_inode
        || pool.dev() != inspection.new_device
    {
        return Err(refused());
    }
    let mut expected = old.clone();
    expected.storage = owner.storage.clone();
    expected.overlay = owner.overlay.clone();
    expected.project_share = owner.project_share.clone();
    expected.process = owner.process.clone();
    expected.guest_boot_id = owner.guest_boot_id.clone();
    expected.previous_guest_boot_id = owner.previous_guest_boot_id.clone();
    expected.daemon_pid = owner.daemon_pid;
    expected.daemon_start = owner.daemon_start;
    if expected != owner {
        return Err(refused());
    }
    let owner_bytes = host_pin_recovery::read_raw(
        &candidate.state_root.join("run/smolvm/owner.json"),
        1024 * 1024,
    )?;
    let raw_owner: Owner = serde_json::from_slice(&owner_bytes).map_err(|_| refused())?;
    if raw_owner != owner {
        return Err(refused());
    }
    let owner_sha256 = digest(&owner_bytes);
    Ok((owner, owner_sha256))
}

fn publication_roots(selection: &Selection, allow_lock_only: bool) -> Result<(), CandidateError> {
    require_absent(&selection.control_root)?;
    match fs::symlink_metadata(&selection.foreground_root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !allow_lock_only => Ok(()),
        Ok(_) if allow_lock_only => {
            state::check_private_directory(&selection.foreground_root)?;
            let mut entries = fs::read_dir(&selection.foreground_root).map_err(|_| refused())?;
            let entry = entries.next().ok_or_else(refused)?.map_err(|_| refused())?;
            if entry.file_name() != "operation.lock" || entries.next().is_some() {
                return Err(refused());
            }
            let lock = fs::symlink_metadata(entry.path()).map_err(|_| refused())?;
            // SAFETY: geteuid has no arguments or side effects.
            if !lock.is_file()
                || lock.nlink() != 1
                || lock.mode() & 0o7777 != 0o600
                || lock.uid() != unsafe { libc::geteuid() }
            {
                return Err(refused());
            }
            Ok(())
        }
        _ => Err(refused()),
    }
}

fn select_content(
    candidate: &Candidate,
    run: &str,
    original_owner_path: &Path,
    filesystem_inspection_path: &Path,
    engine: &Engine<'_>,
    allow_lock_only: bool,
) -> Result<(Selection, Receipt), CandidateError> {
    let (receipt, root) = load(candidate, engine, run)?;
    no_pending(&root)?;
    if receipt.phase != "ready-observed"
        || receipt.relay_cleanup.is_some()
        || receipt.relay_startup.is_none()
        || !super::hex(&receipt.owner, 32)
    {
        return Err(refused());
    }
    initializer_cache::require_resolved(&receipt)?;
    startup::require_dependency_rebind_complete(&root, &receipt)?;
    dead_owner_cleanup::require_historical_recovery(&root, &receipt)?;
    let old_bytes = private_input(original_owner_path, 1024 * 1024)?;
    let old: Owner = serde_json::from_slice(&old_bytes).map_err(|_| refused())?;
    let inspection_bytes = private_input(filesystem_inspection_path, 64 * 1024)?;
    let inspection: FilesystemInspection =
        serde_json::from_slice(&inspection_bytes).map_err(|_| refused())?;
    inspection.verify(&old_bytes, &old)?;
    let (owner, current_owner_sha256) = current_owner(candidate, &old, &inspection, engine)?;
    if old.checkout != candidate.checkout
        || old.machine != inspection.machine
        || owner.machine != inspection.machine
        || old
            .project_share
            .as_ref()
            .is_some_and(|share| share.device != inspection.old_device)
        || receipt
            .source
            .as_ref()
            .and_then(|source| source.shared.as_ref())
            != old.project_share.as_ref()
    {
        return Err(refused());
    }
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let foreground_root = foreground::transport::root(candidate, run)?;
    let graph_bytes = host_pin_recovery::read_raw(&root.join("state.json"), LIMIT)?;
    if graph_bytes != serde_json::to_vec_pretty(&receipt).map_err(|_| refused())? {
        return Err(refused());
    }
    let graph_sha256 = digest(&graph_bytes);
    let rebind = DeviceRebind {
        old: inspection.old_device,
        current: inspection.new_device,
    };
    let dependency_reservation =
        dependency_slots::inspect_legacy(candidate, run, rebind, inspection.host_boot_micros)?;
    let previous_guest_boot = old.guest_boot_id.clone().ok_or_else(refused)?;
    let selection = Selection {
        version: 1,
        candidate: candidate.checkout.clone(),
        run: run.into(),
        owner: receipt.owner.clone(),
        namespace: receipt.namespace.clone(),
        plan: receipt.plan_id.clone(),
        original_owner_path: original_owner_path.to_path_buf(),
        original_owner_sha256: digest(&old_bytes),
        filesystem_inspection_path: filesystem_inspection_path.to_path_buf(),
        filesystem_inspection_sha256: digest(&inspection_bytes),
        current_owner_sha256,
        graph_sha256,
        host_boot_micros: inspection.host_boot_micros,
        old_device: inspection.old_device,
        new_device: inspection.new_device,
        previous_guest_boot: previous_guest_boot.clone(),
        current_guest_boot: owner.guest_boot_id.ok_or_else(refused)?,
        foreground_root,
        control_root: startup.control_root.clone(),
        source_shared: receipt
            .source
            .as_ref()
            .and_then(|source| source.shared.clone()),
        environment_inventory: serde_json::to_value(super::environment::cleanup_inventory(
            candidate, engine, &receipt, &root,
        )?)
        .map_err(|_| refused())?,
        scoped_bridge_projection: super::bridges::cleanup::scoped_absence_projection(
            candidate,
            engine,
            &receipt,
            &previous_guest_boot,
        )?,
        retained_volumes: selected_volumes(engine, &receipt)?,
        dependency_reservation,
        qualification: "explicit-unpinned-post-host-reboot-original-volume-continuity-unproven"
            .into(),
    };
    publication_roots(&selection, allow_lock_only)?;
    host_pin_recovery::verify_volume_projections(engine, &receipt, &selection.retained_volumes)?;
    for resource in receipt.resources.values() {
        if resource.kind != Kind::Volume && inspect_resource(engine, &receipt, resource)?.is_none()
        {
            return Err(refused());
        }
    }
    Ok((selection, receipt))
}

pub fn inspect(
    candidate: &Candidate,
    run: &str,
    original_owner_path: &Path,
    filesystem_inspection_path: &Path,
) -> Result<Value, CandidateError> {
    let existing = Reservation::inspect_existing(candidate, run)?;
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let (selected, _) = select_content(
        candidate,
        run,
        original_owner_path,
        filesystem_inspection_path,
        &engine,
        existing.is_some(),
    )?;
    if let Some(reservation) = &existing {
        reservation.verify()?;
    }
    Ok(json!({
        "run": run,
        "selection_sha256": selected.digest()?,
        "host_boot_micros": selected.host_boot_micros,
        "qualification": selected.qualification,
        "data_retained": true,
    }))
}

struct Reservation {
    root: PathBuf,
    identity: (u64, u64),
    lock: state::Lock,
}
impl Reservation {
    fn inspect_existing(candidate: &Candidate, run: &str) -> Result<Option<Self>, CandidateError> {
        let root = foreground::transport::root(candidate, run)?;
        match fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Ok(_) => {
                state::check_private_directory(&root)?;
                let lock = state::Lock::acquire_existing(&root)?;
                let metadata = fs::symlink_metadata(&root).map_err(|_| refused())?;
                let value = Self {
                    root,
                    identity: (metadata.dev(), metadata.ino()),
                    lock,
                };
                value.verify()?;
                Ok(Some(value))
            }
            Err(_) => Err(refused()),
        }
    }
    fn acquire(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = foreground::transport::root(candidate, run)?;
        let lock = match fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                state::Lock::acquire(&root)?
            }
            Ok(_) => {
                state::check_private_directory(&root)?;
                state::Lock::acquire_existing(&root)?
            }
            Err(_) => return Err(refused()),
        };
        let metadata = fs::symlink_metadata(&root).map_err(|_| refused())?;
        let value = Self {
            root,
            identity: (metadata.dev(), metadata.ino()),
            lock,
        };
        value.verify()?;
        Ok(value)
    }
    fn verify(&self) -> Result<(), CandidateError> {
        let metadata = fs::symlink_metadata(&self.root).map_err(|_| refused())?;
        if !metadata.is_dir()
            || (metadata.dev(), metadata.ino()) != self.identity
            || state::check_private_directory(&self.root).is_err()
        {
            return Err(refused());
        }
        host_pin_recovery::exact_lock_path(&self.root, &self.lock).map_err(|_| refused())?;
        let lock = fs::symlink_metadata(self.root.join("operation.lock")).map_err(|_| refused())?;
        // SAFETY: geteuid has no arguments or side effects.
        if lock.mode() & 0o7777 != 0o600
            || lock.uid() != unsafe { libc::geteuid() }
            || lock.nlink() != 1
        {
            return Err(refused());
        }
        // This verifier is intentionally limited to the reserved root; it
        // does not infer control-root or graph ownership from the lock.
        let mut entries = fs::read_dir(&self.root).map_err(|_| refused())?;
        let entry = entries.next().ok_or_else(refused)?.map_err(|_| refused())?;
        if entry.file_name() != "operation.lock" || entries.next().is_some() {
            return Err(refused());
        }
        Ok(())
    }
}

fn verify_static_with(
    candidate: &Candidate,
    run: &str,
    engine: &Engine<'_>,
    selected: &Selection,
    original: &Receipt,
    foreground_root: &Path,
    verify_lock: impl Fn() -> Result<(), CandidateError>,
) -> Result<Receipt, CandidateError> {
    if selected.version != 1
        || selected.candidate != candidate.checkout
        || selected.run != run
        || selected.foreground_root != foreground_root
        || selected.qualification
            != "explicit-unpinned-post-host-reboot-original-volume-continuity-unproven"
        || !selected.matches_graph(original)
        || selected.digest()?.len() != 64
    {
        return Err(refused());
    }
    verify_lock()?;
    publication_roots(selected, true)?;
    lifecycle::host_filesystem::no_auxiliary_update(candidate)?;
    if lifecycle::host_filesystem::host_boot_micros()? != selected.host_boot_micros {
        return Err(refused());
    }
    let old_bytes = private_input(&selected.original_owner_path, 1024 * 1024)?;
    let inspection_bytes = private_input(&selected.filesystem_inspection_path, 64 * 1024)?;
    if digest(&old_bytes) != selected.original_owner_sha256
        || digest(&inspection_bytes) != selected.filesystem_inspection_sha256
    {
        return Err(refused());
    }
    let old: Owner = serde_json::from_slice(&old_bytes).map_err(|_| refused())?;
    let inspection: FilesystemInspection =
        serde_json::from_slice(&inspection_bytes).map_err(|_| refused())?;
    inspection.verify(&old_bytes, &old)?;
    let (owner, owner_sha256) = current_owner(candidate, &old, &inspection, engine)?;
    if owner_sha256 != selected.current_owner_sha256
        || owner.token != selected.owner
        || owner.guest_boot_id.as_deref() != Some(&selected.current_guest_boot)
        || owner.previous_guest_boot_id.as_deref() != Some(&selected.previous_guest_boot)
        || inspection.old_device != selected.old_device
        || inspection.new_device != selected.new_device
    {
        return Err(refused());
    }
    let (receipt, root) = load(candidate, engine, run)?;
    no_pending(&root)?;
    let receipt_bytes = host_pin_recovery::read_raw(&root.join("state.json"), LIMIT)?;
    if receipt_bytes != serde_json::to_vec_pretty(&receipt).map_err(|_| refused())? {
        return Err(refused());
    }
    if dead_owner_cleanup::immutable(&receipt)? != dead_owner_cleanup::immutable(original)?
        || !selected.matches_graph(&receipt)
        || !["ready-observed", "cleanup-intent", "stopped-data-retained"]
            .contains(&receipt.phase.as_str())
    {
        return Err(refused());
    }
    if receipt.phase == "ready-observed" && digest(&receipt_bytes) != selected.graph_sha256 {
        return Err(refused());
    }
    if receipt.phase == "ready-observed"
        && (serde_json::to_value(super::environment::cleanup_inventory(
            candidate, engine, &receipt, &root,
        )?)
        .map_err(|_| refused())?
            != selected.environment_inventory
            || super::bridges::cleanup::scoped_absence_projection(
                candidate,
                engine,
                &receipt,
                &selected.previous_guest_boot,
            )? != selected.scoped_bridge_projection)
    {
        return Err(refused());
    }
    host_pin_recovery::verify_volume_projections(engine, &receipt, &selected.retained_volumes)?;
    let rebind = DeviceRebind {
        old: selected.old_device,
        current: selected.new_device,
    };
    if let Some(legacy) = &selected.dependency_reservation {
        dependency_slots::verify_legacy_remaining(
            candidate,
            run,
            rebind,
            legacy,
            receipt.phase != "ready-observed",
        )?;
    } else if dependency_slots::inspect_legacy(candidate, run, rebind, selected.host_boot_micros)?
        .is_some()
    {
        return Err(refused());
    }
    verify_lock()?;
    Ok(receipt)
}

fn verify_static(
    candidate: &Candidate,
    run: &str,
    engine: &Engine<'_>,
    selected: &Selection,
    original: &Receipt,
    reservation: &Reservation,
) -> Result<Receipt, CandidateError> {
    verify_static_with(
        candidate,
        run,
        engine,
        selected,
        original,
        &reservation.root,
        || reservation.verify(),
    )
}

fn read_intent(root: &Path) -> Result<Option<Intent>, CandidateError> {
    let path = root.join(INTENT);
    if absent(&path)? {
        return Ok(None);
    }
    let intent: Intent = state::read_bounded(&path, 4 * 1024 * 1024).map_err(|_| refused())?;
    if intent.version != 1
        || intent.selection_sha256 != intent.selection.digest()?
        || intent.selection.graph_sha256
            != digest(&serde_json::to_vec_pretty(&intent.original).map_err(|_| refused())?)
        || !intent.selection.matches_graph(&intent.original)
    {
        return Err(refused());
    }
    Ok(Some(intent))
}
fn completed_receipt(
    candidate: &Candidate,
    engine: &Engine<'_>,
    intent: &Intent,
    current: &Receipt,
    root: &Path,
) -> Result<String, CandidateError> {
    if current.phase != "stopped-data-retained" {
        return Err(refused());
    }
    let environment = super::environment::cleanup_inventory(candidate, engine, current, root)?;
    if serde_json::to_value(&environment).map_err(|_| refused())? != intent.environment {
        return Err(refused());
    }
    super::bridges::cleanup::verify_recovery_file(
        root,
        &intent.bridges,
        intent.prior_bridges.as_ref(),
    )?;
    host_relay::inspect_cleanup_absence(
        candidate,
        engine,
        current,
        &environment,
        &intent.bridges,
        &intent.selection,
    )?;
    Ok(digest(&host_pin_recovery::read_raw(
        &root.join("state.json"),
        LIMIT,
    )?))
}

fn retire(
    candidate: &Candidate,
    engine: &Engine<'_>,
    intent: &Intent,
    current: &Receipt,
    root: &Path,
    reservation: &Reservation,
) -> Result<(), CandidateError> {
    reservation.verify()?;
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    if completed_receipt(candidate, engine, intent, current, root)? != complete {
        return Err(refused());
    }
    let retirement = Retirement {
        version: 1,
        selection_sha256: intent.selection_sha256.clone(),
        complete_sha256: complete.into(),
        owner: intent.selection.owner.clone(),
        run: intent.selection.run.clone(),
    };
    let path = root.join(RETIREMENT);
    if absent(&path)? {
        verify_static(
            candidate,
            &intent.selection.run,
            engine,
            &intent.selection,
            &intent.original,
            reservation,
        )?;
        state::write(&path, &retirement)?;
    } else {
        let recorded: Retirement = state::read_bounded(&path, 65536).map_err(|_| refused())?;
        if recorded.version != retirement.version
            || recorded.selection_sha256 != retirement.selection_sha256
            || recorded.complete_sha256 != retirement.complete_sha256
            || recorded.owner != retirement.owner
            || recorded.run != retirement.run
        {
            return Err(refused());
        }
    }
    reservation.verify()
}

/// A pending absence intent blocks ordinary publication. Completed retirement
/// permits only the explicit restored-generation bind; it is not a Pin.
pub(super) fn publication_allowed(
    candidate: &Candidate,
    run: &str,
    retired: bool,
) -> Result<(), CandidateError> {
    let root = directory(candidate, run)?;
    require_absent(&root.join("absent-publication-cleanup.pending"))?;
    require_absent(&root.join("absent-publication-retirement.pending"))?;
    if absent(&root.join(INTENT))? {
        return Ok(());
    }
    if !retired {
        return Err(refused());
    }
    let intent = read_intent(&root)?.ok_or_else(refused)?;
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    let retirement: Retirement =
        state::read_bounded(&root.join(RETIREMENT), 65536).map_err(|_| refused())?;
    let current: Receipt = state::read_bounded(&root.join("state.json"), LIMIT)?;
    if retirement.version != 1
        || retirement.selection_sha256 != intent.selection_sha256
        || retirement.complete_sha256 != complete
        || retirement.owner != current.owner
        || retirement.run != run
        || current.phase != "stopped-data-retained"
    {
        return Err(refused());
    }
    let current_sha256 = digest(&host_pin_recovery::read_raw(
        &root.join("state.json"),
        LIMIT,
    )?);
    if current_sha256 != complete && retained(&root, &current)? {
        return Err(refused());
    }
    Ok(())
}

/// Retention is bound to the completed stopped receipt, not to missing paths.
pub(super) fn retained(root: &Path, receipt: &Receipt) -> Result<bool, CandidateError> {
    let Some(intent) = read_intent(root)? else {
        return Ok(false);
    };
    let Some(complete) = intent.complete_sha256.as_deref() else {
        return Err(refused());
    };
    let retirement: Retirement =
        state::read_bounded(&root.join(RETIREMENT), 65536).map_err(|_| refused())?;
    let current: Receipt = state::read_bounded(&root.join("state.json"), LIMIT)?;
    let current_sha256 = digest(&host_pin_recovery::read_raw(
        &root.join("state.json"),
        LIMIT,
    )?);
    let requested_sha256 = digest(&serde_json::to_vec_pretty(receipt).map_err(|_| refused())?);
    if current_sha256 != requested_sha256
        || receipt.phase != "stopped-data-retained"
        || retirement.version != 1
        || retirement.selection_sha256 != intent.selection_sha256
        || retirement.complete_sha256 != complete
        || retirement.run != receipt.run
        || retirement.owner != receipt.owner
        || serde_json::to_vec_pretty(&current).map_err(|_| refused())?
            != serde_json::to_vec_pretty(receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    if requested_sha256 != complete {
        if intent.original.run != receipt.run
            || intent.original.owner != receipt.owner
            || intent.original.namespace != receipt.namespace
            || !super::restore_history::confirms_prior_generation(root, receipt)?
        {
            return Err(refused());
        }
        super::cleanup_enrollment::retention_receipt(receipt, false)?;
        return Ok(false);
    }
    Ok(true)
}

/// Exact completed, retired first-generation proof for a later independently
/// selected source-continuity transition. The proof grants no authority for a
/// subsequent graph generation and does not change the original graph source.
#[derive(Clone, Serialize)]
#[allow(dead_code)] // Consumed by the independently selected source-continuity unit.
pub(super) struct CompletedSourceProof {
    pub original_ready_sha256: String,
    pub completed_stopped_sha256: String,
    pub intent_raw_sha256: String,
    pub retirement_raw_sha256: String,
    pub original_owner_sha256: String,
    pub current_owner_sha256: String,
    pub host_boot_micros: u64,
    pub previous_guest_boot: String,
    pub current_guest_boot: String,
    pub old_share: Option<ProjectShareIntent>,
    pub current_share: Option<ProjectShareIntent>,
    pub retained_volumes: BTreeMap<String, Value>,
}

/// The caller holds the foreground retirement lock before its Engine lease and
/// must recheck this proof at the final publication boundary. A historical
/// sidecar with a different stopped receipt cannot lend authority.
#[allow(dead_code)] // Exposed for the subsequent source-continuity unit.
pub(super) fn verify_completed_under(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
    receipt: &Receipt,
    retired: &foreground::transport::Retired,
) -> Result<Option<CompletedSourceProof>, CandidateError> {
    let root = directory(candidate, run)?;
    if absent(&root.join(INTENT))? {
        return Ok(None);
    }
    retired.verify()?;
    let intent = read_intent(&root)?.ok_or_else(refused)?;
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    let (current, _) = load(candidate, engine, run)?;
    if current.phase != "stopped-data-retained"
        || digest(&host_pin_recovery::read_raw(
            &root.join("state.json"),
            LIMIT,
        )?) != complete
        || serde_json::to_vec_pretty(&current).map_err(|_| refused())?
            != serde_json::to_vec_pretty(receipt).map_err(|_| refused())?
    {
        return Err(refused());
    }
    let foreground_root = foreground::transport::root(candidate, run)?;
    verify_static_with(
        candidate,
        run,
        engine,
        &intent.selection,
        &intent.original,
        &foreground_root,
        || retired.verify(),
    )?;
    if completed_receipt(candidate, engine, &intent, &current, &root)? != complete {
        return Err(refused());
    }
    let retirement_bytes = host_pin_recovery::read_raw(&root.join(RETIREMENT), 65536)?;
    let retirement: Retirement =
        serde_json::from_slice(&retirement_bytes).map_err(|_| refused())?;
    if retirement.version != 1
        || retirement.selection_sha256 != intent.selection_sha256
        || retirement.complete_sha256 != complete
        || retirement.run != run
        || retirement.owner != current.owner
    {
        return Err(refused());
    }
    let old_bytes = private_input(&intent.selection.original_owner_path, 1024 * 1024)?;
    let old: Owner = serde_json::from_slice(&old_bytes).map_err(|_| refused())?;
    let inspection_bytes = private_input(&intent.selection.filesystem_inspection_path, 64 * 1024)?;
    let inspection: FilesystemInspection =
        serde_json::from_slice(&inspection_bytes).map_err(|_| refused())?;
    inspection.verify(&old_bytes, &old)?;
    retired.verify()?;
    Ok(Some(CompletedSourceProof {
        original_ready_sha256: intent.selection.graph_sha256.clone(),
        completed_stopped_sha256: complete.into(),
        intent_raw_sha256: digest(&host_pin_recovery::read_raw(
            &root.join(INTENT),
            4 * 1024 * 1024,
        )?),
        retirement_raw_sha256: digest(&retirement_bytes),
        original_owner_sha256: intent.selection.original_owner_sha256.clone(),
        current_owner_sha256: intent.selection.current_owner_sha256.clone(),
        host_boot_micros: intent.selection.host_boot_micros,
        previous_guest_boot: intent.selection.previous_guest_boot.clone(),
        current_guest_boot: intent.selection.current_guest_boot.clone(),
        old_share: old.project_share,
        current_share: inspection.project_share,
        retained_volumes: intent.selection.retained_volumes.clone(),
    }))
}

/// Explicit, hash-selected cleanup and separate durable absent-publisher
/// retirement. This command never removes a selected graph volume.
pub fn recover(
    candidate: &Candidate,
    run: &str,
    expected: &str,
    original_owner_path: &Path,
    filesystem_inspection_path: &Path,
) -> Result<Value, CandidateError> {
    if !super::hex(expected, 64) {
        return Err(refused());
    }
    // Foreground publication takes this lock before the VM operation lease.
    // Following the same order prevents a new publisher from racing admission.
    let reservation = Reservation::acquire(candidate, run)?;
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let root = directory(candidate, run)?;
    retain_interrupted_publications(&root)?;
    let mut intent = if let Some(existing) = read_intent(&root)? {
        if existing.selection_sha256 != expected
            || existing.selection.original_owner_path != original_owner_path
            || existing.selection.filesystem_inspection_path != filesystem_inspection_path
        {
            return Err(refused());
        }
        existing
    } else {
        let (selection, original) = select_content(
            candidate,
            run,
            original_owner_path,
            filesystem_inspection_path,
            &engine,
            true,
        )?;
        if selection.digest()? != expected {
            return Err(refused());
        }
        let environment =
            super::environment::cleanup_inventory(candidate, &engine, &original, &root)?;
        let environment_value = serde_json::to_value(&environment).map_err(|_| refused())?;
        if environment_value != selection.environment_inventory {
            return Err(refused());
        }
        host_relay::cleanup_preflight(&engine, &original, &root, false)?;
        let bridges = super::bridges::cleanup::capture_previous_boot_absence(
            candidate, &engine, &original, &selection,
        )?;
        if super::bridges::cleanup::selection_absence_projection(&bridges)?
            != selection.scoped_bridge_projection
        {
            return Err(refused());
        }
        let prior_bridges =
            super::bridges::cleanup::capture_prior_generation(&root, &bridges, &original)?;
        if prior_bridges.is_some()
            && !super::restore_history::confirms_prior_generation(&root, &original)?
        {
            return Err(refused());
        }
        let selected = Intent {
            version: 1,
            selection_sha256: expected.into(),
            selection,
            original,
            environment: environment_value,
            bridges,
            prior_bridges,
            complete_sha256: None,
        };
        reservation.verify()?;
        state::write(&root.join(INTENT), &selected)?;
        #[cfg(test)]
        super::fault_pause(&root, run, "absent-after-intent")?;
        selected
    };
    let current = verify_static(
        candidate,
        run,
        &engine,
        &intent.selection,
        &intent.original,
        &reservation,
    )?;
    if intent.complete_sha256.is_none() {
        if current.phase == "stopped-data-retained" {
            // Cleanup may have completed immediately before the intent's final
            // commit. Exact confirmation permits a deterministic retry.
            intent.complete_sha256 = Some(completed_receipt(
                candidate, &engine, &intent, &current, &root,
            )?);
            state::write(&root.join(INTENT), &intent)?;
        } else {
            super::bridges::cleanup::verify_remaining_absence(
                candidate,
                &engine,
                &current,
                &intent.bridges,
                &intent.selection,
            )?;
            super::bridges::cleanup::verify_recovery_file(
                &root,
                &intent.bridges,
                intent.prior_bridges.as_ref(),
            )?;
            super::bridges::cleanup::recover_persist(&root, &intent.bridges)?;
            reservation.verify()?;
            let cleaned = super::cleanup_owned_fenced(
                candidate,
                &engine,
                current,
                &root,
                false,
                true,
                || {
                    verify_static(
                        candidate,
                        run,
                        &engine,
                        &intent.selection,
                        &intent.original,
                        &reservation,
                    )
                    .map(|_| ())
                },
            )?;
            reservation.verify()?;
            intent.complete_sha256 = Some(completed_receipt(
                candidate, &engine, &intent, &cleaned, &root,
            )?);
            state::write(&root.join(INTENT), &intent)?;
        }
    }
    let (current, _) = load(candidate, &engine, run)?;
    let complete = completed_receipt(candidate, &engine, &intent, &current, &root)?;
    if intent.complete_sha256.as_deref() != Some(complete.as_str()) {
        return Err(refused());
    }
    if let Some(reservation_record) = &intent.selection.dependency_reservation {
        dependency_slots::recover_cleaned(
            candidate,
            &current,
            Some((
                DeviceRebind {
                    old: intent.selection.old_device,
                    current: intent.selection.new_device,
                },
                reservation_record,
            )),
        )?;
    } else {
        dependency_slots::recover_cleaned(candidate, &current, None)?;
    }
    retire(candidate, &engine, &intent, &current, &root, &reservation)?;
    Ok(json!({
        "run": run,
        "phase": "stopped-data-retained",
        "publisher_retired": true,
        "data_retained": true,
        "selection_sha256": expected,
        "qualification": intent.selection.qualification,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn candidate() -> (super::super::tests::Fixture, Candidate) {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        (fixture, candidate)
    }

    #[test]
    fn read_only_inspection_of_existing_reservation_never_creates_a_root() {
        let (_fixture, candidate) = candidate();
        let run = "a".repeat(32);
        let root = foreground::transport::root(&candidate, &run).unwrap();
        assert!(
            Reservation::inspect_existing(&candidate, &run)
                .unwrap()
                .is_none()
        );
        assert!(absent(&root).unwrap());
        let acquired = Reservation::acquire(&candidate, &run).unwrap();
        acquired.verify().unwrap();
        drop(acquired);
        let inspected = Reservation::inspect_existing(&candidate, &run)
            .unwrap()
            .unwrap();
        inspected.verify().unwrap();
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            1,
            "only the lock-only reservation is present"
        );
        drop(inspected);
        fs::remove_file(root.join("operation.lock")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn substituted_foreground_lock_path_refuses_without_deleting_replacement() {
        let (_fixture, candidate) = candidate();
        let run = "b".repeat(32);
        let acquired = Reservation::acquire(&candidate, &run).unwrap();
        let root = acquired.root.clone();
        let path = acquired.root.join("operation.lock");
        let saved = acquired.root.join("operation.held");
        fs::rename(&path, &saved).unwrap();
        fs::write(&path, b"foreign replacement").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let replacement = fs::symlink_metadata(&path).unwrap();
        assert!(acquired.verify().is_err());
        let after = fs::symlink_metadata(&path).unwrap();
        assert_eq!(
            (after.dev(), after.ino()),
            (replacement.dev(), replacement.ino())
        );
        assert_eq!(fs::read(&path).unwrap(), b"foreign replacement");
        drop(acquired);
        fs::remove_file(&path).unwrap();
        fs::rename(saved, &path).unwrap();
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn interrupted_intent_blocks_every_ordinary_publisher_mode() {
        let (_fixture, candidate) = candidate();
        let run = "c".repeat(32);
        let root = directory(&candidate, &run).unwrap();
        state::private_directory(&root).unwrap();
        fs::write(root.join("absent-publication-cleanup.pending"), b"partial").unwrap();
        assert!(publication_allowed(&candidate, &run, false).is_err());
        assert!(publication_allowed(&candidate, &run, true).is_err());
        assert!(absent(&root.join(INTENT)).unwrap());
    }

    #[test]
    fn legacy_share_rebind_refuses_every_non_device_change() {
        let old = ProjectShareIntent {
            project: PathBuf::from("/private/tmp/selected"),
            guest_path: "/workspace".into(),
            device: 10,
            inode: 92,
            unfiltered_source: true,
        };
        let mut current = old.clone();
        current.device = 11;
        assert!(device_only_share(Some(&old), Some(&current), 10, 11));
        assert!(!device_only_share(None, Some(&current), 10, 11));
        assert!(!device_only_share(Some(&old), None, 10, 11));
        assert!(!device_only_share(Some(&old), Some(&current), 9, 11));
        for changed in [
            {
                let mut value = current.clone();
                value.project = PathBuf::from("/private/tmp/other");
                value
            },
            {
                let mut value = current.clone();
                value.guest_path = "/different".into();
                value
            },
            {
                let mut value = current.clone();
                value.inode += 1;
                value
            },
            {
                let mut value = current.clone();
                value.unfiltered_source = false;
                value
            },
        ] {
            assert!(!device_only_share(Some(&old), Some(&changed), 10, 11));
        }
    }
}
