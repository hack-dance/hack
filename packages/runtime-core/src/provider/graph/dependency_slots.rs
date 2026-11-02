//! Pool-wide dependency transport reservations. Logical dependency-plan slots are
//! mapped only under the provider lease. Receipts survive owner death; absence of
//! a listener is never permission to steal a recorded or foreign transport.
use super::{Candidate, CandidateError, Engine, Receipt, hex, state};
use crate::provider::host_pin::DeviceRebind;
use crate::provider::identity::{self, ProcessIdentity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
mod acknowledged;
pub(super) use acknowledged::archive_acknowledged;
#[cfg(test)]
pub(super) mod fixture_prior_boot;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    owner: String,
    boot: String,
    run: String,
    token: String,
    process: ProcessIdentity,
    /// Logical to physical slot mapping, never endpoint authority or secret keys.
    slots: BTreeMap<u8, u8>,
    sockets: BTreeMap<u8, (u64, u64)>,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "dependency_reservation",
        "Dependency transport ownership is uncertain; reservations and paths were retained.",
    )
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/dependency-assignments")
}
fn socket(home: &Path, slot: u8) -> PathBuf {
    home.join(format!("dependency-{slot:02}.sock"))
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}
fn read(path: &Path) -> Result<Record, CandidateError> {
    read_with_bytes(path).map(|(record, _)| record)
}
fn read_with_bytes(path: &Path) -> Result<(Record, Vec<u8>), CandidateError> {
    read_with_identity(path).map(|(record, bytes, _)| (record, bytes))
}
/// Parsed record, original bytes and the no-follow descriptor's file identity.
type ObservedRecord = (Record, Vec<u8>, (u64, u64));
fn read_with_identity(path: &Path) -> Result<ObservedRecord, CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let m = file.metadata().map_err(|_| refused())?;
    // SAFETY: geteuid has no arguments or side effects.
    if !m.is_file()
        || m.nlink() != 1
        || m.len() > 32768
        || m.mode() & 0o077 != 0
        || m.uid() != unsafe { libc::geteuid() }
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(32769)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() as u64 != m.len() {
        return Err(refused());
    }
    let current = fs::symlink_metadata(path).map_err(|_| refused())?;
    if (current.dev(), current.ino()) != (m.dev(), m.ino()) || current.nlink() != 1 {
        return Err(refused());
    }
    let record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    Ok((record, bytes, (m.dev(), m.ino())))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LegacyReservation {
    pub record_sha256: String,
    pub sockets: BTreeMap<u8, (u64, u64)>,
    pub process: ProcessIdentity,
}
pub(super) fn inspect_legacy(
    candidate: &Candidate,
    run: &str,
    rebind: DeviceRebind,
    host_boot_micros: u64,
) -> Result<Option<LegacyReservation>, CandidateError> {
    let owner = state::Owner::load(candidate)?;
    let directory = root(candidate);
    let values = records(
        &directory,
        &owner.token,
        owner.dependency_sockets.map_or(0, |v| v.slots),
    )?;
    let Some(record) = values.iter().find(|r| r.run == run) else {
        return Ok(None);
    };
    let (again, bytes) = read_with_bytes(&directory.join(format!("{run}.json")))?;
    if &again != record || record.sockets.len() != record.slots.len() {
        return Err(refused());
    }
    // SAFETY: geteuid has no arguments or side effects.
    identity::verify(
        &record.process,
        &record.process,
        &record.process.executable,
        unsafe { libc::geteuid() },
    )?;
    rebind.definitely_dead_before_boot(&record.process, host_boot_micros)?;
    for slot in record.slots.values() {
        let expected = record.sockets.get(slot).ok_or_else(refused)?;
        let path = socket(&owner.short_home, *slot);
        let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if !metadata.file_type().is_socket()
            || metadata.uid() != record.process.uid
            || metadata.mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
            || !rebind.matches(*expected, (metadata.dev(), metadata.ino()))
        {
            return Err(refused());
        }
        crate::provider::relay_owner::publication::dead::no_listener(&path)
            .map_err(|_| refused())?;
    }
    Ok(Some(LegacyReservation {
        record_sha256: format!("{:x}", Sha256::digest(bytes)),
        sockets: record.sockets.clone(),
        process: record.process.clone(),
    }))
}
pub(super) fn verify_legacy_remaining(
    candidate: &Candidate,
    run: &str,
    rebind: DeviceRebind,
    selected: &LegacyReservation,
    allow_absent_record: bool,
) -> Result<(), CandidateError> {
    let owner = state::Owner::load(candidate)?;
    let path = root(candidate).join(format!("{run}.json"));
    if absent(&path)? {
        if !allow_absent_record {
            return Err(refused());
        }
        for slot in selected.sockets.keys() {
            if !absent(&socket(&owner.short_home, *slot))? {
                return Err(refused());
            }
        }
        return Ok(());
    }
    let values = records(
        &root(candidate),
        &owner.token,
        owner.dependency_sockets.map_or(0, |v| v.slots),
    )?;
    let record = values
        .iter()
        .find(|record| record.run == run)
        .ok_or_else(refused)?;
    let (same, bytes) = read_with_bytes(&path)?;
    if &same != record
        || selected.record_sha256 != format!("{:x}", Sha256::digest(bytes))
        || selected.sockets != record.sockets
        || selected.process != record.process
    {
        return Err(refused());
    }
    for slot in record.slots.values() {
        let path = socket(&owner.short_home, *slot);
        if absent(&path)? {
            continue;
        }
        let expected = record.sockets.get(slot).ok_or_else(refused)?;
        let observed = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if !observed.file_type().is_socket()
            || observed.uid() != record.process.uid
            || observed.mode() & 0o7777 != 0o600
            || observed.nlink() != 1
            || !rebind.matches(*expected, (observed.dev(), observed.ino()))
        {
            return Err(refused());
        }
        crate::provider::relay_owner::publication::dead::no_listener(&path)
            .map_err(|_| refused())?;
    }
    Ok(())
}
fn valid(record: &Record, owner: &str, capacity: u8) -> bool {
    record.version == 1
        && record.owner == owner
        && hex(&record.owner, 32)
        && hex(&record.run, 32)
        && hex(&record.token, 32)
        && record.boot.len() == 36
        && record.process.pid > 1
        && record.process.start_micros > 0
        && record.process.executable.is_absolute()
        && !record.slots.is_empty()
        && record.slots.len() <= usize::from(capacity)
        && record.slots.keys().all(|s| *s < 32)
        && record.slots.values().all(|s| *s < capacity)
        && record.slots.values().collect::<BTreeSet<_>>().len() == record.slots.len()
        && record
            .sockets
            .iter()
            .all(|(s, (_, ino))| *ino != 0 && record.slots.values().any(|v| v == s))
}
fn records(directory: &Path, owner: &str, capacity: u8) -> Result<Vec<Record>, CandidateError> {
    if absent(directory)? {
        return Ok(Vec::new());
    }
    state::check_private_directory(directory)?;
    let mut result = Vec::new();
    let mut used = BTreeSet::new();
    for entry in fs::read_dir(directory).map_err(|_| refused())? {
        let path = entry.map_err(|_| refused())?.path();
        let record = read(&path)?;
        if result.len() >= 32
            || path.file_name().and_then(|v| v.to_str())
                != Some(format!("{}.json", record.run).as_str())
            || !valid(&record, owner, capacity)
            || record.slots.values().any(|s| !used.insert(*s))
        {
            return Err(refused());
        }
        result.push(record);
    }
    Ok(result)
}
fn select(
    requested: &BTreeSet<u8>,
    unavailable: &BTreeSet<u8>,
    capacity: u8,
    automatic: bool,
) -> Result<BTreeMap<u8, u8>, CandidateError> {
    if requested.iter().any(|s| *s >= 32) {
        return Err(refused());
    }
    let available: Vec<u8> = (0..capacity).filter(|s| !unavailable.contains(s)).collect();
    if requested.len() > available.len()
        || (!automatic
            && requested
                .iter()
                .any(|s| *s >= capacity || unavailable.contains(s)))
    {
        return Err(CandidateError::new(
            "dependency_capacity_exhausted",
            format!(
                "Dependency transport request needs {} slots; {} of {} are available. Existing graphs and reservations were preserved.",
                requested.len(),
                available.len(),
                capacity
            ),
        ));
    }
    Ok(if automatic {
        requested.iter().copied().zip(available).collect()
    } else {
        requested.iter().map(|s| (*s, *s)).collect()
    })
}

/// Legacy unscoped exact callers still honor every durable scoped reservation,
/// including the crash window before any socket has been bound.
pub(super) fn check_exact_available(
    candidate: &Candidate,
    engine: &Engine<'_>,
    requested: &BTreeSet<u8>,
) -> Result<(), CandidateError> {
    if requested.is_empty() {
        return Ok(());
    }
    engine.guest().verify()?;
    let owner = state::Owner::load(candidate)?;
    let capacity = owner.dependency_sockets.ok_or_else(refused)?.slots;
    let existing = records(&root(candidate), &owner.token, capacity)?;
    let mut unavailable = existing
        .iter()
        .flat_map(|r| r.slots.values().copied())
        .collect::<BTreeSet<_>>();
    for slot in 0..capacity {
        if !absent(&socket(&owner.short_home, slot))? {
            unavailable.insert(slot);
        }
    }
    select(requested, &unavailable, capacity, false)?;
    Ok(())
}

/// Declared after ManagedOwner in HostRelayRuntime: listeners/grants close before
/// this guard may release their reservation. Interrupted admitted graphs retain it.
pub(super) struct Reservation {
    record: Record,
    directory: PathBuf,
    provider: PathBuf,
    home: PathBuf,
    home_identity: (u64, u64),
    releasable: bool,
}
impl Reservation {
    pub(super) fn reserve(
        candidate: &Candidate,
        engine: &Engine<'_>,
        run: &str,
        requested: &BTreeSet<u8>,
        automatic: bool,
    ) -> Result<Option<Self>, CandidateError> {
        if requested.is_empty() {
            return Ok(None);
        }
        if !hex(run, 32) {
            return Err(refused());
        }
        engine.guest().verify()?;
        let owner = state::Owner::load(candidate)?;
        let capacity = owner.dependency_sockets.ok_or_else(refused)?.slots;
        let directory = root(candidate);
        let existing = records(&directory, &owner.token, capacity)?;
        if existing.iter().any(|r| r.run == run) {
            return Err(refused());
        }
        let mut unavailable = existing
            .iter()
            .flat_map(|r| r.slots.values().copied())
            .collect::<BTreeSet<_>>();
        for slot in 0..capacity {
            if !absent(&socket(&owner.short_home, slot))? {
                unavailable.insert(slot);
            }
        }
        let slots = select(requested, &unavailable, capacity, automatic)?;
        let mut random = [0; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(state::io)?;
        let record = Record {
            version: 1,
            owner: owner.token,
            boot: engine.guest().boot_id().into(),
            run: run.into(),
            token: random.iter().map(|b| format!("{b:02x}")).collect(),
            process: identity::observe(std::process::id() as i32)?,
            slots,
            sockets: BTreeMap::new(),
        };
        let m = fs::metadata(&owner.short_home).map_err(state::io)?;
        state::private_directory(&directory)?;
        state::write(&directory.join(format!("{run}.json")), &record)?;
        Ok(Some(Self {
            record,
            directory,
            provider: candidate.state_root.join("run/smolvm"),
            home: owner.short_home,
            home_identity: (m.dev(), m.ino()),
            releasable: true,
        }))
    }
    pub(super) fn mapping(&self) -> &BTreeMap<u8, u8> {
        &self.record.slots
    }
    pub(super) fn bound(&mut self) -> Result<(), CandidateError> {
        for slot in self.record.slots.values() {
            let m = fs::symlink_metadata(socket(&self.home, *slot)).map_err(|_| refused())?;
            if !m.file_type().is_socket()
                || m.mode() & 0o7777 != 0o600
                || m.nlink() != 1
                || m.uid() != self.record.process.uid
            {
                return Err(refused());
            }
            self.record.sockets.insert(*slot, (m.dev(), m.ino()));
        }
        self.save()
    }
    fn save(&self) -> Result<(), CandidateError> {
        state::write(
            &self.directory.join(format!("{}.json", self.record.run)),
            &self.record,
        )
    }
    pub(super) fn admitted(&mut self) {
        self.releasable = false;
    }
    /// Constructor failures still hold the provider lease; remove only this exact
    /// record after all partially created listeners have already been dropped.
    pub(super) fn cancel_locked(&mut self) -> Result<(), CandidateError> {
        if self
            .record
            .slots
            .values()
            .any(|s| !absent(&socket(&self.home, *s)).unwrap_or(false))
        {
            return Err(refused());
        }
        remove_record(&self.directory, &self.record)
    }
}
fn remove_record(directory: &Path, record: &Record) -> Result<(), CandidateError> {
    let path = directory.join(format!("{}.json", record.run));
    if !absent(&path.with_extension("pending"))? || read(&path)? != *record {
        return Err(refused());
    }
    fs::remove_file(&path).map_err(state::io)?;
    File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(state::io)
}
/// How long dropping an unadmitted [`Reservation`] waits for the provider lease to remove
/// its own receipt. Drop cannot report failure, so this bounds how long an abandoned start
/// blocks its caller. When the lease stays busy past it, or the lease, home or receipt
/// cannot be verified, the receipt is left exactly as written: its slots stay reserved
/// (never double-assigned), and the fallback that releases it is the explicit
/// [`recover_orphan`] for a never-admitted run, or dead-owner graph cleanup
/// ([`recover_cleaned`]) once this process is gone. Both require the recorded owner to
/// be dead, so a live process never loses its own reservation to them.
const RELEASE_LEASE_WAIT: Duration = Duration::from_secs(5);

/// What [`Reservation::release_within`] did with an unadmitted reservation's receipt.
#[derive(Debug, PartialEq, Eq)]
enum Release {
    /// Admitted or already released: the receipt is not this guard's to remove.
    Retained,
    /// The lease was taken and an exact, unbound receipt was removed.
    Removed,
    /// The lease was taken but the home, a socket or the receipt did not verify.
    Refused,
    /// The lease was still busy when the wait expired; the receipt was left for recovery.
    LeaseBusy,
    /// The lease could not be opened or verified; the receipt was left for recovery.
    LeaseUnavailable,
}

impl Reservation {
    /// Remove this unadmitted reservation's receipt under the provider lease, waiting at
    /// most `wait` for that lease. `LeaseBusy` and `LeaseUnavailable` never touch the receipt.
    fn release_within(&mut self, wait: Duration) -> Release {
        if !self.releasable {
            return Release::Retained;
        }
        let deadline = Instant::now() + wait;
        loop {
            match state::Lock::acquire_existing(&self.provider) {
                Ok(_lock) => {
                    let removed = fs::metadata(&self.home)
                        .is_ok_and(|m| (m.dev(), m.ino()) == self.home_identity)
                        && self.cancel_locked().is_ok();
                    self.releasable = false;
                    return if removed {
                        Release::Removed
                    } else {
                        Release::Refused
                    };
                }
                Err(e) if e.code == "provider_busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(e) if e.code == "provider_busy" => return Release::LeaseBusy,
                Err(_) => return Release::LeaseUnavailable,
            }
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let _ = self.release_within(RELEASE_LEASE_WAIT);
    }
}
fn fingerprint(record: &Record) -> Result<String, CandidateError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(record).map_err(|_| refused())?)
    ))
}

/// Inventory is observation only; it never treats PID death as release authority.
pub fn inspect(candidate: &Candidate) -> Result<serde_json::Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let owner = state::Owner::load(candidate)?;
    let values = records(
        &root(candidate),
        &owner.token,
        owner.dependency_sockets.map_or(0, |v| v.slots),
    )?;
    engine.guest().verify()?;
    let mut output = Vec::new();
    for record in values {
        output.push(serde_json::json!({"run":record.run,"slots":record.slots,"reservation":fingerprint(&record)?,"owner_alive":identity::alive(record.process.pid)?}));
    }
    Ok(serde_json::json!({"reservations":output}))
}
fn recover_record(
    candidate: &Candidate,
    record: &Record,
    rebind: Option<DeviceRebind>,
) -> Result<(), CandidateError> {
    if identity::alive(record.process.pid)? {
        return Err(refused());
    }
    let owner = state::Owner::load(candidate)?;
    if record.owner != owner.token {
        return Err(refused());
    }
    recover_paths(&owner.short_home, record, rebind)?;
    remove_record(&root(candidate), record)
}
fn recover_paths(
    home: &Path,
    record: &Record,
    rebind: Option<DeviceRebind>,
) -> Result<(), CandidateError> {
    // Validate every selected path before removing any. Unexpected or unrecorded
    // paths are never adopted, even when nobody currently listens on them.
    let mut selected = Vec::new();
    for slot in record.slots.values() {
        let path = socket(home, *slot);
        if absent(&path)? {
            continue;
        }
        let m = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if !m.file_type().is_socket()
            || m.mode() & 0o7777 != 0o600
            || m.uid() != record.process.uid
            || m.nlink() != 1
            || !record.sockets.get(slot).is_some_and(|expected| {
                rebind.map_or(*expected == (m.dev(), m.ino()), |v| {
                    v.matches(*expected, (m.dev(), m.ino()))
                })
            })
        {
            return Err(refused());
        }
        crate::provider::relay_owner::publication::dead::no_listener(&path)
            .map_err(|_| refused())?;
        selected.push((path, (m.dev(), m.ino())));
    }
    for (path, id) in selected {
        let m = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if (m.dev(), m.ino()) != id || !m.file_type().is_socket() {
            return Err(refused());
        }
        fs::remove_file(path).map_err(state::io)?;
    }
    Ok(())
}
/// Explicit orphan recovery is restricted to attempts that never admitted a graph.
/// Admitted attempts must pass the existing authenticated/dead-owner graph cleanup.
pub fn recover_orphan(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<serde_json::Value, CandidateError> {
    if !hex(run, 32) || !hex(expected, 64) {
        return Err(refused());
    }
    let _engine = Engine::connect_cleanup(candidate)?;
    let owner = state::Owner::load(candidate)?;
    let values = records(
        &root(candidate),
        &owner.token,
        owner.dependency_sockets.map_or(0, |v| v.slots),
    )?;
    let record = values.iter().find(|r| r.run == run).ok_or_else(refused)?;
    if fingerprint(record)? != expected || !absent(&super::directory(candidate, run)?)? {
        return Err(refused());
    }
    recover_record(candidate, record, None)?;
    Ok(serde_json::json!({"run":run,"released":true}))
}
/// Caller holds Engine lease and has completed dead-owner cleanup/verification.
pub(super) fn recover_cleaned(
    candidate: &Candidate,
    receipt: &Receipt,
    rebind: Option<(DeviceRebind, &LegacyReservation)>,
) -> Result<(), CandidateError> {
    let directory = root(candidate);
    if absent(&directory.join(format!("{}.json", receipt.run)))? {
        return Ok(());
    }
    let owner = state::Owner::load(candidate)?;
    let values = records(
        &directory,
        &owner.token,
        owner.dependency_sockets.map_or(0, |v| v.slots),
    )?;
    let record = values
        .iter()
        .find(|r| r.run == receipt.run)
        .ok_or_else(refused)?;
    let slots = receipt
        .relay_startup
        .as_ref()
        .ok_or_else(refused)?
        .services
        .values()
        .flat_map(|s| s.bindings.values().map(|b| b.slot))
        .collect::<BTreeSet<_>>();
    if receipt.owner != record.owner
        || receipt.phase != "stopped-data-retained"
        || slots != record.slots.values().copied().collect()
    {
        return Err(refused());
    }
    if let Some((_, selected)) = rebind {
        let (again, bytes) = read_with_bytes(&directory.join(format!("{}.json", receipt.run)))?;
        if &again != record
            || selected.record_sha256 != format!("{:x}", Sha256::digest(bytes))
            || selected.sockets != record.sockets
            || selected.process != record.process
        {
            return Err(refused());
        }
    }
    recover_record(candidate, record, rebind.map(|(value, _)| value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    #[test]
    fn automatic_groups_are_disjoint_and_exact_contract_is_preserved() {
        let requested = BTreeSet::from([0, 1]);
        let first = select(&requested, &BTreeSet::new(), 4, true).unwrap();
        let used = first.values().copied().collect();
        let second = select(&requested, &used, 4, true).unwrap();
        assert_eq!(first, BTreeMap::from([(0, 0), (1, 1)]));
        assert_eq!(second, BTreeMap::from([(0, 2), (1, 3)]));
        assert!(select(&requested, &used, 4, false).is_err());
        assert_eq!(
            select(&BTreeSet::from([3]), &used, 4, false).unwrap(),
            BTreeMap::from([(3, 3)])
        );
    }
    #[test]
    fn exhausted_request_never_returns_partial_mapping() {
        let unavailable = BTreeSet::from([0, 2]);
        assert!(select(&BTreeSet::from([0, 1, 2]), &unavailable, 4, true).is_err());
        assert_eq!(
            select(&BTreeSet::from([7, 9]), &unavailable, 4, true).unwrap(),
            BTreeMap::from([(7, 1), (9, 3)])
        );
        assert!(select(&BTreeSet::from([32]), &BTreeSet::new(), 32, true).is_err());
    }
    fn fixture_record(run: char, slot: u8) -> Record {
        Record {
            version: 1,
            owner: "a".repeat(32),
            boot: "b".repeat(36),
            run: run.to_string().repeat(32),
            token: "c".repeat(32),
            process: identity::observe(std::process::id() as i32).unwrap(),
            slots: BTreeMap::from([(0, slot)]),
            sockets: BTreeMap::new(),
        }
    }
    fn store(directory: &Path, record: &Record) {
        state::private_directory(directory).unwrap();
        state::write(&directory.join(format!("{}.json", record.run)), record).unwrap();
    }
    #[test]
    fn receipts_retain_capacity_across_boot_and_refuse_foreign_or_duplicate_slots() {
        let fixture = super::super::tests::Fixture::new();
        let a = fixture_record('1', 0);
        store(&fixture.0, &a);
        let mut b = fixture_record('2', 1);
        b.boot = "d".repeat(36);
        store(&fixture.0, &b);
        assert_eq!(records(&fixture.0, &a.owner, 2).unwrap().len(), 2);
        assert!(records(&fixture.0, &"d".repeat(32), 2).is_err());
        b.slots.insert(0, 0);
        state::write(&fixture.0.join(format!("{}.json", b.run)), &b).unwrap();
        assert!(records(&fixture.0, &a.owner, 2).is_err());
    }
    #[test]
    fn pending_or_torn_receipt_refuses_and_is_preserved() {
        let fixture = super::super::tests::Fixture::new();
        let r = fixture_record('1', 0);
        store(&fixture.0, &r);
        let path = fixture.0.join(format!("{}.pending", r.run));
        fs::write(&path, b"torn").unwrap();
        assert!(records(&fixture.0, &r.owner, 2).is_err());
        assert!(remove_record(&fixture.0, &r).is_err());
        assert_eq!(fs::read(path).unwrap(), b"torn");
    }
    #[test]
    fn no_writer_fifo_and_symlink_receipts_refuse_without_blocking() {
        use std::ffi::CString;
        let fixture = super::super::tests::Fixture::new();
        let fifo = fixture.0.join("fifo.json");
        let name = CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: valid NUL-terminated private fixture path; creates no open descriptor.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read(&fifo).is_err());
        let alias = fixture.0.join("alias.json");
        std::os::unix::fs::symlink(&fifo, &alias).unwrap();
        assert!(read(&alias).is_err());
        assert!(fifo.exists());
    }
    struct ShortFixture(PathBuf);
    impl ShortFixture {
        fn new() -> Self {
            use std::os::unix::fs::DirBuilderExt;
            let path = PathBuf::from("/tmp")
                .join(format!("hds-{}", super::super::probes::token().unwrap()));
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for ShortFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn listener(home: &Path, record: &mut Record, slot: u8) -> std::os::unix::net::UnixListener {
        use std::os::unix::fs::PermissionsExt;
        let path = socket(home, slot);
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let m = fs::symlink_metadata(&path).unwrap();
        record.sockets.insert(slot, (m.dev(), m.ino()));
        listener
    }
    /// Run one ignored socket-recovery fixture of this module alone in a child test process.
    ///
    /// Recovery must find a listener this test just dropped closed. In the shared parallel
    /// test process an unrelated test's pre-exec fork (`process::clean_command`) holds a copy
    /// of every descriptor open at the fork until it execs, so the dropped listener can still
    /// accept and recovery correctly refuses it as live.
    fn isolated(child: &str) {
        use crate::provider::test_executable::{ISOLATED_HANG_GUARD, run_isolated};
        run_isolated(
            &format!("provider::graph::dependency_slots::tests::{child}"),
            ISOLATED_HANG_GUARD,
        );
    }
    #[test]
    fn recovery_refuses_live_and_replaced_sockets_without_touching_siblings() {
        isolated("live_and_replaced_sockets_child");
    }
    #[test]
    #[ignore = "isolated socket-recovery fixture launched by recovery_refuses_live_and_replaced_sockets_without_touching_siblings"]
    fn live_and_replaced_sockets_child() {
        let fixture = ShortFixture::new();
        let mut a = fixture_record('1', 0);
        let mut b = fixture_record('2', 1);
        let a_listener = listener(&fixture.0, &mut a, 0);
        let b_listener = listener(&fixture.0, &mut b, 1);
        assert!(recover_paths(&fixture.0, &a, None).is_err());
        drop(a_listener);
        let old = a.sockets[&0];
        a.sockets.insert(0, (old.0, old.1 + 1));
        assert!(recover_paths(&fixture.0, &a, None).is_err());
        assert!(socket(&fixture.0, 0).exists());
        a.sockets.insert(0, old);
        recover_paths(&fixture.0, &a, None).unwrap();
        assert!(!socket(&fixture.0, 0).exists());
        assert!(UnixStream::connect(socket(&fixture.0, 1)).is_ok());
        drop(b_listener);
    }
    #[test]
    fn recovery_preflights_entire_assignment_before_unlinking() {
        isolated("preflight_assignment_child");
    }
    #[test]
    #[ignore = "isolated socket-recovery fixture launched by recovery_preflights_entire_assignment_before_unlinking"]
    fn preflight_assignment_child() {
        let fixture = ShortFixture::new();
        let mut a = fixture_record('1', 0);
        a.slots.insert(1, 1);
        let first = listener(&fixture.0, &mut a, 0);
        let second = listener(&fixture.0, &mut a, 1);
        drop(first);
        assert!(recover_paths(&fixture.0, &a, None).is_err());
        assert!(socket(&fixture.0, 0).exists());
        drop(second);
        recover_paths(&fixture.0, &a, None).unwrap();
        assert!(!socket(&fixture.0, 0).exists());
        assert!(!socket(&fixture.0, 1).exists());
    }
    #[test]
    fn release_requires_exact_receipt_and_leaves_other_graphs_unchanged() {
        let fixture = super::super::tests::Fixture::new();
        let a = fixture_record('1', 0);
        let b = fixture_record('2', 1);
        store(&fixture.0, &a);
        store(&fixture.0, &b);
        let mut stale = a.clone();
        stale.token = "d".repeat(32);
        assert!(remove_record(&fixture.0, &stale).is_err());
        let other = fs::read(fixture.0.join(format!("{}.json", b.run))).unwrap();
        remove_record(&fixture.0, &a).unwrap();
        assert_eq!(records(&fixture.0, &a.owner, 2).unwrap(), vec![b.clone()]);
        assert_eq!(
            fs::read(fixture.0.join(format!("{}.json", b.run))).unwrap(),
            other
        );
    }
    /// A candidate whose provider holds an owner record, plus the short-home alias it names.
    struct LeaseFixture {
        _root: super::super::tests::Fixture,
        candidate: Candidate,
        provider: PathBuf,
        short_home: PathBuf,
        token: String,
    }
    impl LeaseFixture {
        fn new() -> Self {
            let root = super::super::tests::Fixture::new();
            let candidate = Candidate::discover(&root.0).unwrap();
            let provider = candidate.state_root.join("run/smolvm");
            state::private_directory(&provider.join("home")).unwrap();
            drop(state::Lock::acquire(&provider).unwrap());
            let token = super::super::probes::token().unwrap();
            let short_home = Path::new("/private/tmp").join(format!("hkl-{}", &token[..12]));
            std::os::unix::fs::symlink(provider.join("home"), &short_home).unwrap();
            let owner: state::Owner = serde_json::from_value(serde_json::json!({
                "version":1,"checkout":candidate.checkout,"token":token,
                "machine":format!("hack-{}",&token[..12]),"short_home":short_home,
                "created":true,"phase":"running","process":null,
                "dependency_sockets":{"slots":2},"storage":null,"overlay":null,
                "guest_boot_id":null,"previous_guest_boot_id":null,"daemon_pid":null,
                "daemon_start":null,"rootfs_digest":null
            }))
            .unwrap();
            state::write(&provider.join("owner.json"), &owner).unwrap();
            Self {
                _root: root,
                candidate,
                provider,
                short_home,
                token,
            }
        }
        /// An unadmitted reservation of `slot` whose recorded owner is a dead process,
        /// as it is for recovery once the process that dropped it has exited.
        fn reservation(&self, run: char, slot: u8) -> (Reservation, PathBuf) {
            let mut record = fixture_record(run, slot);
            record.owner = self.token.clone();
            record.process.pid = i32::MAX;
            assert!(!identity::alive(record.process.pid).unwrap());
            let directory = root(&self.candidate);
            store(&directory, &record);
            let m = fs::metadata(&self.short_home).unwrap();
            let receipt = directory.join(format!("{}.json", record.run));
            let reservation = Reservation {
                record,
                directory,
                provider: self.provider.clone(),
                home: self.short_home.clone(),
                home_identity: (m.dev(), m.ino()),
                releasable: true,
            };
            (reservation, receipt)
        }
    }
    impl Drop for LeaseFixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.short_home);
        }
    }
    /// HACK-1457: when the lease stays busy past the release wait, dropping an unadmitted
    /// reservation leaves its receipt exactly as written, still reserving its slot, and
    /// dead-owner recovery (the core of `recover_orphan` and `recover_cleaned`) releases it.
    #[test]
    fn a_release_that_outlasts_a_busy_lease_leaves_a_recoverable_receipt() {
        let fixture = LeaseFixture::new();
        // A free lease: the guard removes its own unbound receipt.
        let (mut free, free_receipt) = fixture.reservation('1', 0);
        assert_eq!(
            free.release_within(Duration::ZERO),
            Release::Removed,
            "E_TEST_RELEASE_NOT_REMOVED"
        );
        assert!(absent(&free_receipt).unwrap(), "E_TEST_RELEASE_NOT_REMOVED");

        let (mut busy, receipt) = fixture.reservation('2', 1);
        let written = fs::read(&receipt).unwrap();
        let held = state::Lock::acquire_existing(&fixture.provider).unwrap();
        let wait = Duration::from_millis(100);
        let started = Instant::now();
        assert_eq!(
            busy.release_within(wait),
            Release::LeaseBusy,
            "E_TEST_RELEASE_IGNORED_BUSY_LEASE"
        );
        assert!(started.elapsed() >= wait, "E_TEST_RELEASE_WAIT_NOT_HONORED");
        assert_eq!(
            fs::read(&receipt).ok().as_deref(),
            Some(&written[..]),
            "E_TEST_RECEIPT_CHANGED"
        );
        let reserved = records(&root(&fixture.candidate), &fixture.token, 2).unwrap();
        assert_eq!(
            reserved,
            vec![busy.record.clone()],
            "E_TEST_SLOT_NOT_RESERVED"
        );
        drop(held);

        let lease = state::Lock::acquire_existing(&fixture.provider).unwrap();
        recover_record(&fixture.candidate, &busy.record, None).unwrap();
        assert!(absent(&receipt).unwrap(), "E_TEST_RECEIPT_NOT_RECOVERED");
        drop(lease);
        // A late retry never removes or recreates a receipt it no longer matches.
        assert_eq!(busy.release_within(wait), Release::Refused);
        assert!(absent(&receipt).unwrap());
    }
    /// Dropping the guard is what releases an abandoned start: `Drop` runs the bounded
    /// release, and an admitted reservation's receipt stays for its running graph.
    #[test]
    fn dropping_an_unadmitted_reservation_releases_its_receipt_under_a_free_lease() {
        let fixture = LeaseFixture::new();
        let (abandoned, abandoned_receipt) = fixture.reservation('3', 0);
        drop(abandoned);
        assert!(
            absent(&abandoned_receipt).unwrap(),
            "E_TEST_DROP_NOT_RELEASED"
        );
        let (mut admitted, admitted_receipt) = fixture.reservation('4', 1);
        let written = fs::read(&admitted_receipt).unwrap();
        admitted.admitted();
        drop(admitted);
        assert_eq!(
            fs::read(&admitted_receipt).ok().as_deref(),
            Some(&written[..]),
            "E_TEST_DROP_RELEASED_ADMITTED"
        );
    }
    /// Hang guard for the claim-writer test, not a correctness bound. A writer can
    /// wait behind seven fsync-backed critical sections whose latency is unbounded on
    /// a loaded host (HACK-1430: a 3 s per-writer budget expired at load average
    /// ~190), so only a lease that is never released should reach this limit.
    const CLAIM_LEASE_HANG_GUARD: Duration = Duration::from_secs(120);
    /// Counts one writer inside the claim lease. Declared after the lease guard, it drops
    /// first, so a writer that panics inside the lease has left the count before the next
    /// writer can take the lease, and that writer does not report the panic as an overlap.
    struct InsideLease<'a>(&'a std::sync::atomic::AtomicUsize);
    impl Drop for InsideLease<'_> {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    /// The panic message a writer thread ended with, or a closed placeholder.
    fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
        payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("E_TEST_CLAIM_WRITER_PANIC_UNPRINTABLE")
    }
    #[test]
    fn concurrent_claim_writers_serialize_without_overlapping_slots() {
        let slots = claim_writers(None).unwrap_or_else(|failure| panic!("{failure}"));
        assert_eq!(slots, (0..8).collect());
    }
    /// HACK-1457: a writer that panics inside the lease is reported as that panic. Before,
    /// it left the inside count raised, and the next writer failed as a lease overlap.
    #[test]
    fn a_writer_panic_inside_the_lease_names_itself_not_an_overlap() {
        let failure = claim_writers(Some(0)).unwrap_err();
        assert_eq!(
            failure, "E_TEST_CLAIM_WRITER_PANICKED (writer 0: E_TEST_INJECTED_WRITER_FAULT)",
            "E_TEST_CLAIM_FAILURE_MISATTRIBUTED"
        );
    }
    /// Run eight contending claim writers; `fault` names a writer that panics inside the
    /// lease. Returns the slots claimed, or every writer panic in writer order, so a
    /// failure names its own cause rather than a symptom it left for other writers.
    fn claim_writers(fault: Option<u8>) -> Result<BTreeSet<u8>, String> {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        const WRITERS: u8 = 8;
        let fixture = super::super::tests::Fixture::new();
        let provider = fixture.0.join("provider");
        let directory = fixture.0.join("claims");
        // Hold the lease until every writer has been refused once, so all of them
        // contend before any may claim a slot, whatever the scheduler does.
        let held = state::Lock::acquire(&provider).unwrap();
        let refused = Arc::new(AtomicUsize::new(0));
        let inside = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for index in 0..WRITERS {
            let provider = provider.clone();
            let directory = directory.clone();
            let refused = Arc::clone(&refused);
            let inside = Arc::clone(&inside);
            threads.push(std::thread::spawn(move || {
                let deadline = Instant::now() + CLAIM_LEASE_HANG_GUARD;
                let mut was_refused = false;
                let lock = loop {
                    match state::Lock::acquire(&provider) {
                        Ok(lock) => break lock,
                        Err(e) if e.code == "provider_busy" => {
                            if !was_refused {
                                was_refused = true;
                                refused.fetch_add(1, SeqCst);
                            }
                            assert!(Instant::now() < deadline, "E_TEST_CLAIM_LEASE_HANG");
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        Err(e) => panic!("E_TEST_CLAIM_LEASE_REFUSED: {}", e.code),
                    }
                };
                assert!(was_refused, "E_TEST_CLAIM_WRITER_UNCONTENDED");
                // The lease, not the slot selection, must exclude other writers.
                let entered = inside.fetch_add(1, SeqCst);
                let in_lease = InsideLease(&inside);
                assert_eq!(entered, 0, "E_TEST_CLAIM_LEASE_OVERLAP");
                if fault == Some(index) {
                    panic!("E_TEST_INJECTED_WRITER_FAULT");
                }
                let mut record = fixture_record(char::from(b'1' + index), 0);
                let existing = records(&directory, &record.owner, WRITERS)
                    .unwrap_or_else(|e| panic!("E_TEST_CLAIM_RECORDS_REFUSED: {}", e.code));
                let used = existing
                    .iter()
                    .flat_map(|r| r.slots.values().copied())
                    .collect();
                record.slots = select(&BTreeSet::from([0]), &used, WRITERS, true)
                    .unwrap_or_else(|e| panic!("E_TEST_CLAIM_SELECT_REFUSED: {}", e.code));
                store(&directory, &record);
                assert_eq!(inside.load(SeqCst), 1, "E_TEST_CLAIM_LEASE_OVERLAP");
                drop(in_lease);
                drop(lock);
                record.slots[&0]
            }));
        }
        // No writer can finish while the lease is held; one that did already failed,
        // so stop waiting and let join report it.
        let deadline = Instant::now() + CLAIM_LEASE_HANG_GUARD;
        let mut all_refused = false;
        while Instant::now() < deadline && !threads.iter().any(|t| t.is_finished()) {
            if refused.load(SeqCst) == usize::from(WRITERS) {
                all_refused = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        drop(held);
        let mut slots = BTreeSet::new();
        let mut panics = Vec::new();
        for (index, thread) in threads.into_iter().enumerate() {
            match thread.join() {
                Ok(slot) => {
                    slots.insert(slot);
                }
                Err(payload) => {
                    panics.push(format!("writer {index}: {}", panic_message(&*payload)))
                }
            }
        }
        if !panics.is_empty() {
            return Err(format!(
                "E_TEST_CLAIM_WRITER_PANICKED ({})",
                panics.join("; ")
            ));
        }
        assert!(all_refused, "E_TEST_CLAIM_WRITERS_NOT_REFUSED");
        assert_eq!(
            records(&directory, &"a".repeat(32), WRITERS).unwrap().len(),
            usize::from(WRITERS)
        );
        Ok(slots)
    }
    #[test]
    fn legacy_exact_selection_cannot_steal_unbound_durable_reservation() {
        let fixture = super::super::tests::Fixture::new();
        let record = fixture_record('1', 0);
        store(&fixture.0, &record);
        assert!(record.sockets.is_empty());
        let reserved = records(&fixture.0, &record.owner, 2)
            .unwrap()
            .into_iter()
            .flat_map(|r| r.slots.into_values())
            .collect();
        assert!(select(&BTreeSet::from([0]), &reserved, 2, false).is_err());
        assert_eq!(
            select(&BTreeSet::from([1]), &reserved, 2, false).unwrap(),
            BTreeMap::from([(1, 1)])
        );
    }
}
