//! Explicit, selected legacy host-pin migration for one retained graph run.
//!
//! The private witness precedes dead-owner cleanup. It never edits historical graph,
//! publisher, control, or dependency receipts and grants no ordinary replay authority.
use super::{Candidate, CandidateError, Engine, Kind, Receipt, directory, foreground, load, state};
use crate::provider::{
    ProjectShareIntent,
    host_pin::DeviceRebind,
    lifecycle,
    relay_owner::publication::{LegacyControl, PinnedEndpoint},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use super::{dependency_slots::LegacyReservation, foreground::transport::LegacyPublisher};

const FILE: &str = "host-pin-recovery.json";
const LIMIT: u64 = 64 * 1024;
const GUEST_IDENTITY_ACK: &str = "host-pin-guest-identity-v1\n";

fn refused() -> CandidateError {
    CandidateError::new(
        "graph_host_pin_recovery",
        "Legacy host pin selection is incomplete or changed; receipts and data were preserved.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Guest::boot_id is sourced from the host Owner receipt. Execute a read-only
/// guest check so a changed receipt cannot impersonate the running kernel boot.
/// execute_cleanup itself compares /proc boot ID and /storage owner under the
/// held Engine/Guest lease before this fixed acknowledgement is emitted.
pub(super) fn verify_guest_identity(engine: &Engine<'_>) -> Result<(), CandidateError> {
    let acknowledged = engine
        .guest()
        .execute_cleanup("printf 'host-pin-guest-identity-v1\\n'", &[])
        .map_err(|_| refused())?;
    if acknowledged != GUEST_IDENTITY_ACK {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn read_raw(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    read_raw_with(path, limit, || {})
}
fn read_raw_with(
    path: &Path,
    limit: u64,
    after_read: impl FnOnce(),
) -> Result<Vec<u8>, CandidateError> {
    let parent = path.parent().ok_or_else(refused)?;
    state::check_private_directory(parent)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let metadata = file.metadata().map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or side effects.
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() == 0
        || metadata.len() > limit
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    after_read();
    file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
    let mut confirmation = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut confirmation)
        .map_err(|_| refused())?;
    let retained = file.metadata().map_err(|_| refused())?;
    let pathname = fs::symlink_metadata(path).map_err(|_| refused())?;
    if bytes != confirmation
        || bytes.len() as u64 != metadata.len()
        || [retained.dev(), pathname.dev()] != [metadata.dev(); 2]
        || [retained.ino(), pathname.ino()] != [metadata.ino(); 2]
        || [retained.len(), pathname.len()] != [metadata.len(); 2]
        || [retained.uid(), pathname.uid()] != [metadata.uid(); 2]
        || [retained.mode(), pathname.mode()] != [metadata.mode(); 2]
        || [retained.nlink(), pathname.nlink()] != [metadata.nlink(); 2]
        || [retained.mtime(), pathname.mtime()] != [metadata.mtime(); 2]
        || [retained.mtime_nsec(), pathname.mtime_nsec()] != [metadata.mtime_nsec(); 2]
        || [retained.ctime(), pathname.ctime()] != [metadata.ctime(); 2]
        || [retained.ctime_nsec(), pathname.ctime_nsec()] != [metadata.ctime_nsec(); 2]
    {
        return Err(refused());
    }
    Ok(bytes)
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        _ => Err(refused()),
    }
}

pub(super) fn exact_lock_path(root: &Path, held: &state::Lock) -> Result<(), CandidateError> {
    let pathname = fs::symlink_metadata(root.join("operation.lock")).map_err(|_| refused())?;
    if !pathname.is_file()
        || pathname.nlink() != 1
        || (pathname.dev(), pathname.ino()) != held.identity()?
    {
        return Err(refused());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Witness {
    version: u8,
    candidate: PathBuf,
    run: String,
    owner: String,
    namespace: String,
    plan: String,
    graph_sha256: String,
    provider_sha256: String,
    host_boot_micros: u64,
    previous_guest_boot: String,
    current_guest_boot: String,
    rebind: DeviceRebind,
    publisher: LegacyPublisher,
    control_root: PathBuf,
    control: LegacyControl,
    reservation: Option<LegacyReservation>,
    source_shared: Option<ProjectShareIntent>,
    retained_volumes: BTreeMap<String, Value>,
    qualification: String,
}

impl Witness {
    pub(super) fn rebind(&self) -> DeviceRebind {
        self.rebind
    }
    pub(super) fn host_boot_micros(&self) -> u64 {
        self.host_boot_micros
    }
    pub(super) fn publisher_sha256(&self) -> &str {
        &self.publisher.owner_sha256
    }
    pub(super) fn reservation(&self) -> Option<&LegacyReservation> {
        self.reservation.as_ref()
    }
    pub(super) fn control(&self) -> &LegacyControl {
        &self.control
    }
    pub(super) fn control_root(&self) -> &Path {
        &self.control_root
    }
    pub(super) fn graph_sha256(&self) -> &str {
        &self.graph_sha256
    }
    pub(super) fn matches_graph(&self, receipt: &Receipt) -> bool {
        self.run == receipt.run
            && self.owner == receipt.owner
            && self.namespace == receipt.namespace
            && self.plan == receipt.plan_id
            && self.source_shared == receipt.source.as_ref().and_then(|s| s.shared.clone())
    }
}

pub(super) struct Guard {
    witness: Witness,
    witness_path: PathBuf,
    control_root: PathBuf,
    control_lock: state::Lock,
}

pub(super) struct CleanupProof<'a> {
    pub original: &'a Receipt,
    pub sha256: &'a str,
    pub current_is_original: bool,
    pub allow_absent_reservation: bool,
    pub publisher_may_be_partial: bool,
}
impl Guard {
    pub(super) fn witness(&self) -> &Witness {
        &self.witness
    }
    pub(super) fn verify_lock(&self) -> Result<(), CandidateError> {
        let retained: Witness =
            serde_json::from_slice(&read_raw(&self.witness_path, LIMIT)?).map_err(|_| refused())?;
        if retained != self.witness {
            return Err(refused());
        }
        let context =
            super::host_relay::context(&self.witness.owner, &self.witness.previous_guest_boot)?;
        let control = PinnedEndpoint::load_legacy_recovery(
            &self.witness.control_root,
            context,
            self.witness.rebind,
            self.witness.host_boot_micros,
        )?;
        if control.legacy_summary() != self.witness.control {
            return Err(refused());
        }
        exact_lock_path(&self.control_root, &self.control_lock)
    }
}

fn path(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    Ok(directory(candidate, run)?.join(FILE))
}
pub(super) fn load_witness(
    candidate: &Candidate,
    run: &str,
) -> Result<Option<Witness>, CandidateError> {
    let file = path(candidate, run)?;
    absent(&file.with_extension("pending"))?;
    if absent(&file).is_ok() {
        return Ok(None);
    }
    let bytes = read_raw(&file, LIMIT)?;
    let witness: Witness = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if witness.version != 1 || witness.candidate != candidate.checkout || witness.run != run {
        return Err(refused());
    }
    Ok(Some(witness))
}

/// Only the exact old publisher may select the historical overlay. A successor
/// with current-device pins uses ordinary strict recovery despite retained history.
pub(super) fn selected_for_old_publisher(
    candidate: &Candidate,
    run: &str,
) -> Result<Option<Witness>, CandidateError> {
    let Some(witness) = load_witness(candidate, run)? else {
        return Ok(None);
    };
    let recorded = foreground::transport::Pin::legacy_recorded_device(candidate, run)?;
    if recorded == witness.rebind.current {
        return Ok(None);
    }
    if recorded != witness.rebind.old {
        return Err(refused());
    }
    Ok(Some(witness))
}

pub(super) fn verify_volume_projections(
    engine: &Engine<'_>,
    receipt: &Receipt,
    selected: &BTreeMap<String, Value>,
) -> Result<(), CandidateError> {
    let keys = receipt
        .resources
        .iter()
        .filter(|(_, value)| value.kind == Kind::Volume)
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    if keys.len() != selected.len() || keys.iter().any(|key| !selected.contains_key(key)) {
        return Err(refused());
    }
    for key in keys {
        let resource = &receipt.resources[&key];
        let actual = super::inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
        let expected = selected.get(&key).ok_or_else(refused)?;
        if expected["expected_name"] != resource.name
            || expected["observed_name"] != actual["Name"]
            || expected["observed_created_at"] != actual["CreatedAt"]
            || expected["observed_mountpoint"] != actual["Mountpoint"]
            || expected["observed_driver"] != actual["Driver"]
            || expected["observed_labels_sha256"]
                != digest(&serde_json::to_vec(&actual["Labels"]).map_err(|_| refused())?)
        {
            return Err(refused());
        }
        let labels = expected["labels"].as_object().ok_or_else(refused)?;
        if labels
            .iter()
            .any(|(name, value)| actual["Labels"].get(name) != Some(value))
        {
            return Err(refused());
        }
    }
    Ok(())
}

/// Caller already holds the Engine lease and exact foreground owner lock.
/// The returned control lock remains held across graph cleanup effects.
pub(super) fn acquire_for_cleanup(
    candidate: &Candidate,
    run: &str,
    engine: &Engine<'_>,
    proof: CleanupProof<'_>,
    witness: Witness,
) -> Result<Guard, CandidateError> {
    lifecycle::host_filesystem::no_auxiliary_update(candidate)?;
    if witness.graph_sha256 != proof.sha256
        || !witness.matches_graph(proof.original)
        || witness.candidate != candidate.checkout
        || witness.run != run
        || witness.qualification
            != "explicit-legacy-device-rebind-original-volume-continuity-unproven"
        || lifecycle::host_filesystem::host_boot_micros()? != witness.host_boot_micros
    {
        return Err(refused());
    }
    witness
        .rebind
        .definitely_dead_before_boot(&witness.publisher.process, witness.host_boot_micros)?;
    if proof.current_is_original
        && digest(&read_raw(
            &directory(candidate, run)?.join("state.json"),
            2 * 1024 * 1024,
        )?) != witness.graph_sha256
    {
        return Err(refused());
    }
    let owner = state::Owner::load(candidate)?;
    lifecycle::verify_disks(candidate, &owner)?;
    verify_guest_identity(engine)?;
    let bytes = read_raw(
        &candidate.state_root.join("run/smolvm/owner.json"),
        1024 * 1024,
    )?;
    if digest(&bytes) != witness.provider_sha256
        || owner.token != witness.owner
        || owner.guest_boot_id.as_deref() != Some(&witness.current_guest_boot)
        || owner.previous_guest_boot_id.as_deref() != Some(&witness.previous_guest_boot)
        || engine.guest().incarnation() != witness.owner
        || engine.guest().boot_id() != witness.current_guest_boot
        || owner
            .storage
            .as_ref()
            .is_none_or(|disk| disk.device != witness.rebind.current)
        || owner
            .overlay
            .as_ref()
            .is_none_or(|disk| disk.device != witness.rebind.current)
    {
        return Err(refused());
    }
    if !proof.publisher_may_be_partial {
        let publisher = foreground::transport::Pin::legacy_summary(
            candidate,
            run,
            witness.rebind,
            witness.host_boot_micros,
        )?;
        if publisher != witness.publisher {
            return Err(refused());
        }
    }
    let control_root = witness.control_root.join("relay-control");
    let control_lock = state::Lock::acquire_existing(&control_root)?;
    absent(&foreground::transport::root(candidate, run)?.join("owner.pending"))?;
    absent(&control_root.join("owner.pending"))?;
    let context = super::host_relay::context(&witness.owner, &witness.previous_guest_boot)?;
    let control = PinnedEndpoint::load_legacy_recovery(
        &witness.control_root,
        context,
        witness.rebind,
        witness.host_boot_micros,
    )?
    .legacy_summary();
    if control != witness.control {
        return Err(refused());
    }
    if let Some(selected) = &witness.reservation {
        super::dependency_slots::verify_legacy_remaining(
            candidate,
            run,
            witness.rebind,
            selected,
            proof.allow_absent_reservation,
        )?;
    } else if super::dependency_slots::inspect_legacy(
        candidate,
        run,
        witness.rebind,
        witness.host_boot_micros,
    )?
    .is_some()
    {
        return Err(refused());
    }
    verify_volume_projections(engine, proof.original, &witness.retained_volumes)?;
    let guard = Guard {
        witness_path: path(candidate, run)?,
        witness,
        control_root,
        control_lock,
    };
    guard.verify_lock()?;
    Ok(guard)
}

struct Selected {
    witness: Witness,
    foreground_root: PathBuf,
    foreground_lock: state::Lock,
    control_lock_root: PathBuf,
    control_lock: state::Lock,
}

impl Selected {
    fn verify(
        &self,
        candidate: &Candidate,
        run: &str,
        engine: &Engine<'_>,
    ) -> Result<(), CandidateError> {
        for (root, lock) in [
            (&self.foreground_root, &self.foreground_lock),
            (&self.control_lock_root, &self.control_lock),
        ] {
            exact_lock_path(root, lock)?;
        }
        if self.foreground_root != foreground::transport::root(candidate, run)?
            || self.control_lock_root != self.witness.control_root.join("relay-control")
            || self.witness != select_content(candidate, run, engine)?
        {
            return Err(refused());
        }
        Ok(())
    }
}

fn select(
    candidate: &Candidate,
    run: &str,
    engine: &Engine<'_>,
) -> Result<Selected, CandidateError> {
    let (receipt, _) = load(candidate, engine, run)?;
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let foreground_root = foreground::transport::root(candidate, run)?;
    super::acknowledged_publisher::require_no_pending_missing_lock(candidate, run)?;
    let foreground_lock = state::Lock::acquire_existing(&foreground_root)?;
    super::acknowledged_publisher::require_no_pending_missing_lock(candidate, run)?;
    let control_lock_root = startup.control_root.join("relay-control");
    let control_lock = state::Lock::acquire_existing(&control_lock_root)?;
    let selected = Selected {
        witness: select_content(candidate, run, engine)?,
        foreground_root,
        foreground_lock,
        control_lock_root,
        control_lock,
    };
    selected.verify(candidate, run, engine)?;
    Ok(selected)
}

fn select_content(
    candidate: &Candidate,
    run: &str,
    engine: &Engine<'_>,
) -> Result<Witness, CandidateError> {
    lifecycle::host_filesystem::no_auxiliary_update(candidate)?;
    let owner = state::Owner::load(candidate)?;
    lifecycle::verify_disks(candidate, &owner)?;
    verify_guest_identity(engine)?;
    let host_boot_micros = lifecycle::host_filesystem::host_boot_micros()?;
    let current_guest_boot = owner.guest_boot_id.clone().ok_or_else(refused)?;
    let previous_guest_boot = owner.previous_guest_boot_id.clone().ok_or_else(refused)?;
    if current_guest_boot == previous_guest_boot
        || current_guest_boot != engine.guest().boot_id()
        || owner.token != engine.guest().incarnation()
    {
        return Err(refused());
    }
    let (receipt, root) = load(candidate, engine, run)?;
    for name in [
        "state.pending",
        "dead-owner-cleanup.pending",
        "relay-cleanup-bridges.pending",
    ] {
        absent(&root.join(name))?;
    }
    if receipt.phase != "ready-observed" || receipt.relay_cleanup.is_some() {
        return Err(refused());
    }
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    let graph_sha256 = digest(&read_raw(&root.join("state.json"), 2 * 1024 * 1024)?);
    let provider_sha256 = digest(&read_raw(
        &candidate.state_root.join("run/smolvm/owner.json"),
        1024 * 1024,
    )?);
    let publisher_root = foreground::transport::root(candidate, run)?;
    absent(&publisher_root.join("owner.pending"))?;
    absent(&startup.control_root.join("relay-control/owner.pending"))?;
    let current_device = fs::symlink_metadata(&publisher_root)
        .map_err(|_| refused())?
        .dev();
    let rebind = DeviceRebind {
        old: foreground::transport::Pin::legacy_recorded_device(candidate, run)?,
        current: current_device,
    };
    if rebind.old == rebind.current {
        return Err(refused());
    }
    if owner
        .storage
        .as_ref()
        .is_none_or(|disk| disk.device != rebind.current)
        || owner
            .overlay
            .as_ref()
            .is_none_or(|disk| disk.device != rebind.current)
    {
        return Err(refused());
    }
    let publisher =
        foreground::transport::Pin::legacy_summary(candidate, run, rebind, host_boot_micros)?;
    let context = super::host_relay::context(&receipt.owner, &previous_guest_boot)?;
    let control = PinnedEndpoint::load_legacy_recovery(
        &startup.control_root,
        context,
        rebind,
        host_boot_micros,
    )?
    .legacy_summary();
    let reservation =
        super::dependency_slots::inspect_legacy(candidate, run, rebind, host_boot_micros)?;
    if receipt
        .source
        .as_ref()
        .and_then(|source| source.shared.as_ref())
        .is_some_and(|shared| shared.device != rebind.old)
        || owner.project_share.as_ref()
            != receipt
                .source
                .as_ref()
                .and_then(|s| s.shared.as_ref())
                .map(|shared| {
                    // Historical shared source is pinned to the old host device. Only the
                    // selected device may differ from the currently approved project share.
                    let mut expected = shared.clone();
                    expected.device = rebind.current;
                    expected
                })
                .as_ref()
    {
        return Err(refused());
    }
    if let Some(share) = &owner.project_share {
        share.validate()?;
    }
    let mut retained_volumes = BTreeMap::new();
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, value)| value.kind == Kind::Volume)
    {
        let actual = super::inspect_resource(engine, &receipt, resource)?.ok_or_else(refused)?;
        let labels = super::expected_labels(&receipt, resource)
            .as_object()
            .ok_or_else(refused)?
            .keys()
            .map(|label| (label.clone(), actual["Labels"][label].clone()))
            .collect::<BTreeMap<_, _>>();
        retained_volumes.insert(
            key.clone(),
            json!({"expected_name":resource.name,"observed_name":actual["Name"],
                "observed_created_at":actual["CreatedAt"],
                "observed_mountpoint":actual["Mountpoint"],
                "observed_driver":actual["Driver"],
                "observed_labels_sha256":digest(&serde_json::to_vec(&actual["Labels"]).map_err(|_| refused())?),
                "labels":labels}),
        );
    }
    Ok(Witness {
        version: 1,
        candidate: candidate.checkout.clone(),
        run: run.into(),
        owner: receipt.owner,
        namespace: receipt.namespace,
        plan: receipt.plan_id,
        graph_sha256,
        provider_sha256,
        host_boot_micros,
        previous_guest_boot,
        current_guest_boot,
        rebind,
        publisher,
        control_root: startup.control_root.clone(),
        control,
        reservation,
        source_shared: receipt.source.and_then(|s| s.shared),
        retained_volumes,
        qualification: "explicit-legacy-device-rebind-original-volume-continuity-unproven".into(),
    })
}

fn selected_sha256(witness: &Witness) -> Result<String, CandidateError> {
    Ok(digest(&serde_json::to_vec(witness).map_err(|_| refused())?))
}

/// Read-only exact selection. Existing completed recovery history is retained.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let selected = select(candidate, run, &engine)?;
    Ok(
        json!({"run":run,"selection_sha256":selected_sha256(&selected.witness)?,"old_device":selected.witness.rebind.old,"new_device":selected.witness.rebind.current,"qualification":selected.witness.qualification}),
    )
}

/// Explicitly publish one private immutable witness before cleanup can consume an overlay.
pub fn recover(candidate: &Candidate, run: &str, expected: &str) -> Result<Value, CandidateError> {
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(refused());
    }
    let engine = Engine::connect_cleanup_wait(candidate)?;
    let selected = select(candidate, run, &engine)?;
    if selected_sha256(&selected.witness)? != expected {
        return Err(refused());
    }
    if let Some(existing) = load_witness(candidate, run)? {
        if existing == selected.witness {
            return Ok(
                json!({"run":run,"selection_sha256":expected,"witness_published":true,"already_published":true,"qualification":selected.witness.qualification}),
            );
        }
        return Err(refused());
    }
    selected.verify(candidate, run, &engine)?;
    state::write(&path(candidate, run)?, &selected.witness)?;
    Ok(
        json!({"run":run,"selection_sha256":expected,"witness_published":true,"qualification":selected.witness.qualification}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::PermissionsExt};

    #[test]
    fn raw_selection_refuses_same_inode_in_place_substitution() {
        let fixture = super::super::tests::Fixture::new();
        let path = fixture.0.join("selected.json");
        fs::write(&path, b"first").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        let result = read_raw_with(&path, 64, || {
            let mut file = OpenOptions::new().write(true).open(&path).unwrap();
            file.write_all(b"other").unwrap();
            file.sync_all().unwrap();
        });
        assert!(result.is_err());
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), before.ino());
    }

    #[test]
    fn device_overlay_requires_only_one_number_change_and_exact_inode() {
        let translated = DeviceRebind {
            old: 10,
            current: 20,
        };
        assert!(translated.matches((10, 77), (20, 77)));
        for (old, current) in [
            ((20, 77), (20, 77)),
            ((10, 77), (10, 77)),
            ((10, 77), (20, 78)),
            ((10, 0), (20, 0)),
        ] {
            assert!(!translated.matches(old, current));
        }
    }

    #[test]
    fn held_lock_path_replacement_refuses_and_preserves_foreign_replacement() {
        let fixture = super::super::tests::Fixture::new();
        let lock = state::Lock::acquire(&fixture.0).unwrap();
        exact_lock_path(&fixture.0, &lock).unwrap();
        let pathname = fixture.0.join("operation.lock");
        let saved = fixture.0.join("held-operation.lock");
        fs::rename(&pathname, &saved).unwrap();
        fs::write(&pathname, b"foreign replacement").unwrap();
        fs::set_permissions(&pathname, fs::Permissions::from_mode(0o600)).unwrap();
        let replacement = fs::symlink_metadata(&pathname).unwrap();
        assert!(exact_lock_path(&fixture.0, &lock).is_err());
        let after = fs::symlink_metadata(&pathname).unwrap();
        assert_eq!(
            (after.dev(), after.ino()),
            (replacement.dev(), replacement.ino())
        );
        assert_eq!(fs::read(&pathname).unwrap(), b"foreign replacement");
        drop(lock);
        // The fixture is private and isolated; restore the original pathname
        // before its directory is torn down.
        fs::remove_file(&pathname).unwrap();
        fs::rename(&saved, &pathname).unwrap();
    }
}
