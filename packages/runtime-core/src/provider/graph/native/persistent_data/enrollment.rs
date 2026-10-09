//! Durable enrollment owner. The native adapter separately supplies the cooperative
//! guest lease and original-effect identity; deserialization grants no effect authority.
//!
//! The transport must exclusively create a previously absent volume under its retained
//! guest authority, including its continuously held common cooperative mutation lease.
//! Unserialized direct same-user/guest writers are outside that authority. Docker's
//! idempotent volumes/create response, an absence probe, copied
//! labels or empty contents cannot meet that obligation. Errors never retry creation,
//! adopt an observed volume, delete data or recover an interrupted enrollment.

use super::{Binding, CompareOptions, Enrollment, Kind, Observation, Owner, Record};
use crate::{CandidateError, provider::state, reject_aliased_state};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

// Sealing prevents callers from passing an arbitrary observation callback as create
// authority. Each crate-owned adapter requires its own effect qualification.
pub(crate) mod sealed {
    pub trait Transport {}
}

/// Trusted bounded transport under the existing guest/effect owner.
/// Each method must honor the supplied aggregate deadline;
/// `create_new` must refuse existing names within its closed supported-writer authority;
/// all supported competing creators must hold the same continuously fenced lease.
pub trait Transport: sealed::Transport {
    fn verify(&mut self, expected: &Binding, deadline: Instant) -> Result<(), CandidateError>;
    fn inspect(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError>;
    fn create_new(
        &mut self,
        request: &CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError>;
}

/// Immutable original-create request, assembled only after the pending intent is durable.
/// It contains stable storage ownership, never a compute generation/run/plan reference.
pub struct CreateRequest {
    binding: Binding,
    name: String,
    intent: String,
}
impl CreateRequest {
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn intent(&self) -> &str {
        &self.intent
    }
}

pub struct EnrollOptions<'a> {
    /// Existing private host directory external to application data; never initialized here.
    pub state_root: &'a Path,
    pub binding: &'a Binding,
    /// Fresh owner-supplied nonce; no runtime generation is encoded or inferred.
    pub intent: &'a str,
    pub deadline: Instant,
    pub cancelled: &'a AtomicBool,
}
pub struct ReadOptions<'a> {
    pub state_root: &'a Path,
    pub binding: &'a Binding,
    pub deadline: Instant,
    pub cancelled: &'a AtomicBool,
}

/// Exclusively enroll one original create. The pending file and its parent are synced
/// before the sole create call. Promotion requires that call's captured identity plus
/// fresh matching observation and unchanged original private files/locks/guest fences.
/// Before rename, failure preserves pending (or incomplete staging); after rename,
/// publication/sync failure is uncertain and cannot return successful enrollment.
/// Nothing resumes or promotes an interrupted attempt in a subsequent invocation.
pub fn enroll_new<T: Transport>(
    options: EnrollOptions<'_>,
    transport: &mut T,
) -> Result<Owner, CandidateError> {
    enroll(options, transport, &mut SystemSync)
}

/// Observe existing enrollment under its existing lock. Missing root, lock, record,
/// pending intent or staging residue refuses without creating or repairing any file.
/// Success is a fresh retained-read comparison, not engine execution/deletion authority.
pub fn read_retained<T: Transport>(
    options: ReadOptions<'_>,
    transport: &mut T,
) -> Result<Owner, CandidateError> {
    let binding = snapshot(options.binding)?;
    let guard = Guard {
        deadline: options.deadline,
        cancelled: options.cancelled,
    };
    guard.check()?;
    let files = Files::existing(options.state_root, &binding)?;
    let record = RecordPin::read(&files.slot.path.join("owner.json"))?;
    let owner = super::decode(&record.bytes)?;
    let Enrollment::Enrolled { volume } = &owner.0.enrollment else {
        return Err(refused());
    };
    if volume.name != volume_name(&binding) {
        return Err(refused());
    }
    files.verify(Some(&record))?;
    guard.check()?;
    transport
        .verify(&binding, guard.deadline)
        .map_err(|_| refused())?;
    files.verify(Some(&record))?;
    guard.check()?;
    let observed = transport
        .inspect(&volume.name, guard.deadline)
        .map_err(|_| refused())?;
    super::compare(CompareOptions {
        record: &owner,
        expected: &binding,
        observed: observed.as_ref(),
    })?;
    transport
        .verify(&binding, guard.deadline)
        .map_err(|_| refused())?;
    files.verify(Some(&record))?;
    guard.check()?;
    Ok(owner)
}

fn snapshot(binding: &Binding) -> Result<Binding, CandidateError> {
    if !super::binding_valid(binding) {
        return Err(refused());
    }
    Ok(binding.clone())
}
pub(super) fn refused() -> CandidateError {
    CandidateError::new(
        "native_persistent_data_enrollment",
        "Persistent data enrollment is incomplete, ambiguous or changed; retained data was not adopted or deleted.",
    )
}
pub(super) fn volume_name(binding: &Binding) -> String {
    format!(
        "hkp-{}-{}-{}",
        binding.scope.namespace, binding.scope.owner, binding.scope.storage
    )
}
fn slot_name(binding: &Binding) -> String {
    slot_key(&binding.scope.namespace, &binding.scope.storage)
}
fn slot_key(namespace: &str, storage: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(namespace.as_bytes());
    digest.update([0]);
    digest.update(storage.as_bytes());
    format!("persistent-{:x}", digest.finalize())
}

/// Read-only binding selection. It never turns pending/staging into enrollment and
/// grants no observation authority. The consumer must call read_retained afterward.
pub(super) fn existing_binding(
    root: &Path,
    namespace: &str,
    storage: &str,
) -> Result<Option<Binding>, CandidateError> {
    if !super::super::super::hex(namespace, 64) || !super::logical_name(storage) {
        return Err(refused());
    }
    let root = Directory::open(root)?;
    let path = root.path.join(slot_key(namespace, storage));
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            root.verify()?;
            return Ok(None);
        }
        Err(_) => return Err(refused()),
        Ok(_) => {}
    }
    let slot = Directory::open(&path)?;
    let lock = state::Lock::acquire_existing(&slot.path).map_err(|_| refused())?;
    let files = Files { root, slot, lock };
    files.verify(None)?;
    let record = RecordPin::read(&files.slot.path.join("owner.json"))?;
    let owner = super::decode(&record.bytes)?;
    if owner.0.binding.scope.namespace != namespace
        || owner.0.binding.scope.storage != storage
        || !matches!(owner.0.enrollment, Enrollment::Enrolled { .. })
    {
        return Err(refused());
    }
    files.verify(Some(&record))?;
    Ok(Some(owner.0.binding))
}

struct Guard<'a> {
    deadline: Instant,
    cancelled: &'a AtomicBool,
}
impl Guard<'_> {
    fn check(&self) -> Result<(), CandidateError> {
        if self.cancelled.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
            return Err(refused());
        }
        Ok(())
    }
}

fn enroll<T: Transport, S: Sync>(
    options: EnrollOptions<'_>,
    transport: &mut T,
    sync: &mut S,
) -> Result<Owner, CandidateError> {
    let binding = snapshot(options.binding)?;
    if !super::super::super::hex(options.intent, 32) {
        return Err(refused());
    }
    let request = CreateRequest {
        name: volume_name(&binding),
        binding,
        intent: options.intent.into(),
    };
    let guard = Guard {
        deadline: options.deadline,
        cancelled: options.cancelled,
    };
    guard.check()?;
    transport
        .verify(&request.binding, guard.deadline)
        .map_err(|_| refused())?;
    guard.check()?;
    if transport
        .inspect(&request.name, guard.deadline)
        .map_err(|_| refused())?
        .is_some()
    {
        return Err(refused());
    }
    guard.check()?;
    let files = Files::fresh(options.state_root, &request.binding, sync)?;
    let pending = RecordPin::create(
        &files.slot.path.join("owner.json"),
        &Owner(Record {
            version: 1,
            kind: Kind::NativePersistentDataOwner,
            binding: request.binding.clone(),
            enrollment: Enrollment::Pending {
                intent: request.intent.clone(),
                volume_name: request.name.clone(),
            },
        }),
        sync,
        Step::PendingFile,
    )?;
    sync.sync(&files.slot.file, Step::PendingDirectory)?;
    fresh(&files, &pending, &request.binding, &guard, transport)?;
    if transport
        .inspect(&request.name, guard.deadline)
        .map_err(|_| refused())?
        .is_some()
    {
        return Err(refused());
    }
    // The last absence observation grants no create authority: the sealed adapter must
    // still refuse a competing name within its continuously held common writer lease.
    fresh(&files, &pending, &request.binding, &guard, transport)?;
    let captured = transport
        .create_new(&request, guard.deadline)
        .map_err(|_| refused())?;
    let enrolled = Owner(Record {
        version: 1,
        kind: Kind::NativePersistentDataOwner,
        binding: request.binding.clone(),
        enrollment: Enrollment::Enrolled {
            volume: captured.volume.clone(),
        },
    });
    super::compare(CompareOptions {
        record: &enrolled,
        expected: &request.binding,
        observed: Some(&captured),
    })?;
    if captured.volume.name != request.name {
        return Err(refused());
    }
    fresh(&files, &pending, &request.binding, &guard, transport)?;
    let observed = transport
        .inspect(&request.name, guard.deadline)
        .map_err(|_| refused())?;
    super::compare(CompareOptions {
        record: &enrolled,
        expected: &request.binding,
        observed: observed.as_ref(),
    })?;
    fresh(&files, &pending, &request.binding, &guard, transport)?;
    let staged = RecordPin::create(
        &files.slot.path.join("owner.next"),
        &enrolled,
        sync,
        Step::EnrolledFile,
    )?;
    files.verify_record(&pending)?;
    staged.verify()?;
    transport
        .verify(&request.binding, guard.deadline)
        .map_err(|_| refused())?;
    let observed = transport
        .inspect(&request.name, guard.deadline)
        .map_err(|_| refused())?;
    super::compare(CompareOptions {
        record: &enrolled,
        expected: &request.binding,
        observed: observed.as_ref(),
    })?;
    transport
        .verify(&request.binding, guard.deadline)
        .map_err(|_| refused())?;
    files.verify_record(&pending)?;
    staged.verify()?;
    guard.check()?;
    fs::rename(&staged.path, &pending.path).map_err(|_| refused())?;
    // No arbitrary writer is admitted by this private nonblocking lock. As with other
    // provider state, unsynchronized same-UID external writers are not atomically frozen.
    let committed = staged.at(pending.path);
    files.verify(Some(&committed))?;
    sync.sync(&files.slot.file, Step::CommittedDirectory)?;
    transport
        .verify(&request.binding, guard.deadline)
        .map_err(|_| refused())?;
    let observed = transport
        .inspect(&request.name, guard.deadline)
        .map_err(|_| refused())?;
    super::compare(CompareOptions {
        record: &enrolled,
        expected: &request.binding,
        observed: observed.as_ref(),
    })?;
    transport
        .verify(&request.binding, guard.deadline)
        .map_err(|_| refused())?;
    files.verify(Some(&committed))?;
    guard.check()?;
    Ok(enrolled)
}

fn fresh<T: Transport>(
    files: &Files,
    record: &RecordPin,
    binding: &Binding,
    guard: &Guard<'_>,
    transport: &mut T,
) -> Result<(), CandidateError> {
    guard.check()?;
    files.verify(Some(record))?;
    transport
        .verify(binding, guard.deadline)
        .map_err(|_| refused())?;
    files.verify(Some(record))?;
    guard.check()
}

struct Directory {
    path: PathBuf,
    file: File,
}
impl Directory {
    fn open(path: &Path) -> Result<Self, CandidateError> {
        if !path.is_absolute() || fs::canonicalize(path).map_err(|_| refused())? != path {
            return Err(refused());
        }
        reject_aliased_state(path).map_err(|_| refused())?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| refused())?;
        let directory = Self {
            path: path.into(),
            file,
        };
        directory.verify()?;
        Ok(directory)
    }
    fn verify(&self) -> Result<(), CandidateError> {
        reject_aliased_state(&self.path).map_err(|_| refused())?;
        let fd = self.file.metadata().map_err(|_| refused())?;
        let path = fs::symlink_metadata(&self.path).map_err(|_| refused())?;
        if !fd.is_dir() || !safe(&fd, 0o700, false) || !same(&fd, &path) {
            return Err(refused());
        }
        Ok(())
    }
}
struct Files {
    root: Directory,
    slot: Directory,
    lock: state::Lock,
}
impl Files {
    fn fresh<S: Sync>(
        root: &Path,
        binding: &Binding,
        sync: &mut S,
    ) -> Result<Self, CandidateError> {
        let root = Directory::open(root)?;
        let path = root.path.join(slot_name(binding));
        root.verify()?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| refused())?;
        let slot = Directory::open(&path)?;
        root.verify()?;
        sync.sync(&root.file, Step::SlotDirectory)?;
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.join("operation.lock"))
            .map_err(|_| refused())?;
        sync.sync(&lock_file, Step::LockFile)?;
        let lock = state::Lock::from_file(lock_file).map_err(|_| refused())?;
        let files = Self { root, slot, lock };
        files.verify(None)?;
        Ok(files)
    }
    fn existing(root: &Path, binding: &Binding) -> Result<Self, CandidateError> {
        let root = Directory::open(root)?;
        let slot = Directory::open(&root.path.join(slot_name(binding)))?;
        let lock = state::Lock::acquire_existing(&slot.path).map_err(|_| refused())?;
        let files = Self { root, slot, lock };
        files.verify(None)?;
        Ok(files)
    }
    fn verify_record(&self, record: &RecordPin) -> Result<(), CandidateError> {
        self.root.verify()?;
        self.slot.verify()?;
        let lock =
            fs::symlink_metadata(self.slot.path.join("operation.lock")).map_err(|_| refused())?;
        if !lock.is_file()
            || lock.len() != 0
            || !safe(&lock, 0o600, true)
            || (lock.dev(), lock.ino()) != self.lock.identity().map_err(|_| refused())?
        {
            return Err(refused());
        }
        record.verify()
    }
    fn verify(&self, record: Option<&RecordPin>) -> Result<(), CandidateError> {
        absent(&self.slot.path.join("owner.next"))?;
        match record {
            Some(record) => self.verify_record(record),
            None => {
                self.root.verify()?;
                self.slot.verify()?;
                let lock = fs::symlink_metadata(self.slot.path.join("operation.lock"))
                    .map_err(|_| refused())?;
                if !lock.is_file()
                    || lock.len() != 0
                    || !safe(&lock, 0o600, true)
                    || (lock.dev(), lock.ino()) != self.lock.identity().map_err(|_| refused())?
                {
                    return Err(refused());
                }
                Ok(())
            }
        }
    }
}
fn absent(path: &Path) -> Result<(), CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}
fn safe(metadata: &fs::Metadata, mode: u32, single: bool) -> bool {
    // SAFETY: geteuid has no preconditions.
    metadata.uid() == unsafe { libc::geteuid() }
        && metadata.mode() & 0o777 == mode
        && (!single || metadata.nlink() == 1)
}
fn same(fd: &fs::Metadata, path: &fs::Metadata) -> bool {
    fd.dev() == path.dev() && fd.ino() == path.ino() && fd.file_type() == path.file_type()
}
struct RecordPin {
    path: PathBuf,
    file: File,
    bytes: Vec<u8>,
}
impl RecordPin {
    fn create<S: Sync>(
        path: &Path,
        owner: &Owner,
        sync: &mut S,
        step: Step,
    ) -> Result<Self, CandidateError> {
        let bytes = serde_json::to_vec(owner).map_err(|_| refused())?;
        super::decode(&bytes)?;
        Self::create_bytes(path, bytes, sync, step)
    }
    fn create_bytes<S: Sync>(
        path: &Path,
        bytes: Vec<u8>,
        sync: &mut S,
        step: Step,
    ) -> Result<Self, CandidateError> {
        if bytes.is_empty() || bytes.len() > super::LIMIT {
            return Err(refused());
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| refused())?;
        file.write_all(&bytes).map_err(|_| refused())?;
        sync.sync(&file, step)?;
        let pin = Self {
            path: path.into(),
            file,
            bytes,
        };
        pin.verify()?;
        Ok(pin)
    }
    fn read(path: &Path) -> Result<Self, CandidateError> {
        Self::read_validated(path, |bytes| super::decode(bytes).map(|_| ()))
    }
    fn read_validated(
        path: &Path,
        validate: impl FnOnce(&[u8]) -> Result<(), CandidateError>,
    ) -> Result<Self, CandidateError> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| refused())?;
        let bytes = read_bytes(&file)?;
        validate(&bytes)?;
        let pin = Self {
            path: path.into(),
            file,
            bytes,
        };
        pin.verify()?;
        Ok(pin)
    }
    fn at(self, path: PathBuf) -> Self {
        Self { path, ..self }
    }
    fn verify(&self) -> Result<(), CandidateError> {
        let fd = self.file.metadata().map_err(|_| refused())?;
        let path = fs::symlink_metadata(&self.path).map_err(|_| refused())?;
        if !same(&fd, &path) || read_bytes(&self.file)? != self.bytes {
            return Err(refused());
        }
        Ok(())
    }
}
fn read_bytes(mut file: &File) -> Result<Vec<u8>, CandidateError> {
    let m = file.metadata().map_err(|_| refused())?;
    if !m.is_file() || !safe(&m, 0o600, true) || m.len() > super::LIMIT as u64 {
        return Err(refused());
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| refused())?;
    let mut bytes = Vec::new();
    file.take(super::LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.is_empty() || bytes.len() > super::LIMIT {
        return Err(refused());
    }
    Ok(bytes)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    SlotDirectory,
    LockFile,
    PendingFile,
    PendingDirectory,
    EnrolledFile,
    CommittedDirectory,
}
trait Sync {
    fn sync(&mut self, file: &File, step: Step) -> Result<(), CandidateError>;
}
struct SystemSync;
impl Sync for SystemSync {
    fn sync(&mut self, file: &File, _step: Step) -> Result<(), CandidateError> {
        file.sync_all().map_err(|_| refused())
    }
}

#[cfg(test)]
mod tests;

pub mod witnessed;
