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
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.releasable {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match state::Lock::acquire_existing(&self.provider) {
                Ok(_lock) => {
                    if fs::metadata(&self.home)
                        .is_ok_and(|m| (m.dev(), m.ino()) == self.home_identity)
                    {
                        let _ = self.cancel_locked();
                    }
                    return;
                }
                Err(e) if e.code == "provider_busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => return,
            }
        }
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
    #[test]
    fn recovery_refuses_live_and_replaced_sockets_without_touching_siblings() {
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
    #[test]
    fn concurrent_claim_writers_serialize_without_overlapping_slots() {
        let fixture = super::super::tests::Fixture::new();
        let provider = fixture.0.join("provider");
        let directory = fixture.0.join("claims");
        let mut threads = Vec::new();
        for index in 0..8 {
            let provider = provider.clone();
            let directory = directory.clone();
            threads.push(std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(3);
                let _lock = loop {
                    match state::Lock::acquire(&provider) {
                        Ok(lock) => break lock,
                        Err(e) if e.code == "provider_busy" && Instant::now() < deadline => {
                            std::thread::yield_now()
                        }
                        Err(e) => panic!("unexpected reservation lock refusal: {}", e.code),
                    }
                };
                let mut record = fixture_record(char::from(b'1' + index), 0);
                let existing = records(&directory, &record.owner, 8).unwrap();
                let used = existing
                    .iter()
                    .flat_map(|r| r.slots.values().copied())
                    .collect();
                record.slots = select(&BTreeSet::from([0]), &used, 8, true).unwrap();
                store(&directory, &record);
                record.slots[&0]
            }));
        }
        let slots = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(slots, (0..8).collect());
        assert_eq!(records(&directory, &"a".repeat(32), 8).unwrap().len(), 8);
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
