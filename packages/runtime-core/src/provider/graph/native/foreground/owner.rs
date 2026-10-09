//! Exact native owner publication. Compose owner records and paths remain unchanged.
use super::*;
use crate::provider::{identity, identity::ProcessIdentity, state};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::{
        fd::{AsFd, BorrowedFd},
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    NativeGraphOwner,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    kind: Kind,
    candidate: PathBuf,
    review: native_input::Review,
    process: ProcessIdentity,
    parent: (u64, u64),
    socket: (u64, u64),
    lock: (u64, u64),
}
/// A distinct closed publication format: old live owners never acquire boot provenance by inference.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BootQualifiedRecord {
    version: u32,
    kind: Kind,
    candidate: PathBuf,
    review: native_input::Review,
    process: ProcessIdentity,
    parent: (u64, u64),
    socket: (u64, u64),
    lock: (u64, u64),
    host_boot_micros: u64,
}
impl BootQualifiedRecord {
    fn into_record(self) -> (Record, Option<HostBoot>) {
        (
            Record {
                version: self.version,
                kind: self.kind,
                candidate: self.candidate,
                review: self.review,
                process: self.process,
                parent: self.parent,
                socket: self.socket,
                lock: self.lock,
            },
            Some(HostBoot::LegacyMicros(self.host_boot_micros)),
        )
    }
}
/// Version4 has no calendar qualifier: exact process incarnation remains a separate fence.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionQualifiedRecord {
    version: u32,
    kind: Kind,
    candidate: PathBuf,
    review: native_input::Review,
    process: ProcessIdentity,
    parent: (u64, u64),
    socket: (u64, u64),
    lock: (u64, u64),
    host_boot_uuid: host_boot::Session,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) enum HostBoot {
    LegacyMicros(u64),
    Session(host_boot::Session),
}
impl HostBoot {
    fn verify_with(
        &self,
        micros: impl FnOnce() -> Result<u64, CandidateError>,
        session: impl FnOnce() -> Result<host_boot::Session, CandidateError>,
    ) -> Result<(), CandidateError> {
        let equal = match self {
            Self::LegacyMicros(expected) => micros().ok() == Some(*expected),
            Self::Session(expected) => session().ok().as_ref() == Some(expected),
        };
        if !equal {
            return Err(refused());
        }
        Ok(())
    }
    fn verify(&self) -> Result<(), CandidateError> {
        self.verify_with(
            crate::provider::host_filesystem::host_boot_micros,
            host_boot::read,
        )
    }
}
fn decode(bytes: &[u8]) -> Result<(Record, Option<HostBoot>), CandidateError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| refused())?;
    match value.get("version").and_then(Value::as_u64) {
        Some(2) => {
            let record: Record = serde_json::from_slice(bytes).map_err(|_| refused())?;
            Ok((record, None))
        }
        Some(3) => {
            let record: BootQualifiedRecord =
                serde_json::from_slice(bytes).map_err(|_| refused())?;
            if record.host_boot_micros == 0 || record.process.start_micros < record.host_boot_micros
            {
                return Err(refused());
            }
            Ok(record.into_record())
        }
        Some(4) => {
            let record: SessionQualifiedRecord =
                serde_json::from_slice(bytes).map_err(|_| refused())?;
            if record.process.start_micros == 0 {
                return Err(refused());
            }
            Ok((
                Record {
                    version: record.version,
                    kind: record.kind,
                    candidate: record.candidate,
                    review: record.review,
                    process: record.process,
                    parent: record.parent,
                    socket: record.socket,
                    lock: record.lock,
                },
                Some(HostBoot::Session(record.host_boot_uuid)),
            ))
        }
        _ => Err(refused()),
    }
}
fn id(metadata: &fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}
fn private(metadata: &fs::Metadata) -> bool {
    // SAFETY: geteuid has no preconditions or effects.
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}
pub(super) fn root(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    if !super::super::hex(run, 32) {
        return Err(refused());
    }
    let bytes = serde_json::to_vec(&("hack-native-foreground-v2", &candidate.state_root, run))
        .map_err(|_| refused())?;
    Ok(format!(
        "/private/tmp/hknf-{}",
        &format!("{:x}", Sha256::digest(bytes))[..24]
    )
    .into())
}
/// No PID-only fallback or dead-owner adoption. An orphan socket is still evidence.
pub(super) fn present(candidate: &Candidate, run: &str) -> Result<bool, CandidateError> {
    let root = root(candidate, run)?;
    if !exists(&root)? {
        return Ok(false);
    }
    state::check_private_directory(&root).map_err(|_| refused())?;
    Ok(exists(&root.join("owner.json"))? || exists(&root.join("control.sock"))?)
}

/// Direct operations and publication use the same retained per-run lock. An absence
/// check alone would allow a publisher to race a direct startup or cleanup.
pub(in crate::provider::graph::native) struct DirectGuard<'a> {
    candidate: &'a Candidate,
    run: &'a str,
    root: PathBuf,
    parent: (u64, u64),
    lock: state::Lock,
}
impl<'a> DirectGuard<'a> {
    pub(in crate::provider::graph::native) fn acquire(
        candidate: &'a Candidate,
        run: &'a str,
    ) -> Result<Self, CandidateError> {
        let gate = super::super::super::publication_gate::Guard::acquire(candidate)?;
        super::require_unpublished(candidate, run)?;
        let root = root(candidate, run)?;
        let lock = state::Lock::acquire(&root).map_err(|_| refused())?;
        let guard = Self {
            candidate,
            run,
            parent: id(&fs::symlink_metadata(&root).map_err(|_| refused())?),
            root,
            lock,
        };
        guard.verify()?;
        gate.verify(candidate)?;
        Ok(guard)
    }
    pub(in crate::provider::graph::native) fn verify(&self) -> Result<(), CandidateError> {
        if id(&fs::symlink_metadata(&self.root).map_err(|_| refused())?) != self.parent {
            return Err(refused());
        }
        super::super::super::host_pin_recovery::exact_lock_path(&self.root, &self.lock)?;
        super::require_unpublished(self.candidate, self.run)
    }
}

pub(super) struct Pin {
    root: PathBuf,
    record: Record,
    host_boot: Option<HostBoot>,
    bytes: Vec<u8>,
    file: (u64, u64),
}
impl Pin {
    fn verify_host_boot(&self) -> Result<(), CandidateError> {
        if let Some(boot) = &self.host_boot {
            boot.verify()?;
        }
        Ok(())
    }
    pub(super) fn load(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let pin = Self::read(candidate, run)?;
        pin.verify()?;
        Ok(pin)
    }
    fn read(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = root(candidate, run)?;
        state::check_private_directory(&root).map_err(|_| refused())?;
        let file = fs::symlink_metadata(root.join("owner.json")).map_err(|_| refused())?;
        let bytes = native_input::read_file(&root.join("owner.json"), 8192)?;
        let (record, host_boot) = decode(&bytes)?;
        record
            .review
            .validate(record.review.scope())
            .map_err(|_| refused())?;
        if record.candidate != candidate.checkout || record.review.scope().run != run {
            return Err(refused());
        }
        let pin = Self {
            root,
            record,
            host_boot,
            bytes,
            file: id(&file),
        };
        Ok(pin)
    }
    pub(super) fn review(&self) -> &native_input::Review {
        &self.record.review
    }
    /// The caller already authenticated its retained connection before the owner
    /// retired. Absence grants no new connection, process or cleanup authority.
    pub(super) fn verify_retired(&self) -> Result<(), CandidateError> {
        self.verify_host_boot()?;
        state::check_private_directory(&self.root).map_err(|_| refused())?;
        let parent = fs::symlink_metadata(&self.root).map_err(|_| refused())?;
        let lock = fs::symlink_metadata(self.root.join("operation.lock")).map_err(|_| refused())?;
        if !parent.is_dir()
            || id(&parent) != self.record.parent
            || !lock.is_file()
            || !private(&lock)
            || lock.nlink() != 1
            || id(&lock) != self.record.lock
            || exists(&self.root.join("owner.json"))?
            || exists(&self.root.join("control.sock"))?
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        self.verify_files()?;
        let expected = &self.record.process;
        // SAFETY: geteuid has no preconditions; same-user peer authority remains native.
        if expected.uid != unsafe { libc::geteuid() } {
            return Err(refused());
        }
        identity::verify(
            expected,
            &identity::observe(expected.pid).map_err(|_| refused())?,
            &expected.executable,
            expected.uid,
        )
        .map_err(|_| refused())
    }
    fn verify_files(&self) -> Result<(), CandidateError> {
        self.verify_host_boot()?;
        state::check_private_directory(&self.root).map_err(|_| refused())?;
        let parent = fs::symlink_metadata(&self.root).map_err(|_| refused())?;
        let socket = fs::symlink_metadata(self.root.join("control.sock")).map_err(|_| refused())?;
        let lock = fs::symlink_metadata(self.root.join("operation.lock")).map_err(|_| refused())?;
        let file = fs::symlink_metadata(self.root.join("owner.json")).map_err(|_| refused())?;
        if !parent.is_dir()
            || id(&parent) != self.record.parent
            || !socket.file_type().is_socket()
            || !private(&socket)
            || id(&socket) != self.record.socket
            || !lock.is_file()
            || !private(&lock)
            || lock.nlink() != 1
            || id(&lock) != self.record.lock
            || id(&file) != self.file
            || native_input::read_file(&self.root.join("owner.json"), 8192)? != self.bytes
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn connect(&self) -> Result<UnixStream, CandidateError> {
        self.verify()?;
        let stream = transport::connect_socket(&self.root.join("control.sock"))?;
        let peer = transport::peer(&stream)?;
        let expected = &self.record.process;
        identity::verify(expected, &peer, &expected.executable, expected.uid)
            .map_err(|_| refused())?;
        self.verify()?;
        Ok(stream)
    }
}

/// Exact value-free publication bytes and inode, retained by a durable recovery intent.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoverySelection {
    bytes: String,
    file: (u64, u64),
}
impl RecoverySelection {
    pub(super) fn fingerprint(&self) -> String {
        format!("{:x}", Sha256::digest(self.bytes.as_bytes()))
    }
    fn record(
        &self,
        candidate: &Candidate,
        run: &str,
    ) -> Result<(Record, HostBoot), CandidateError> {
        if self.bytes.is_empty() || self.bytes.len() > 8192 {
            return Err(refused());
        }
        let (record, boot) = decode(self.bytes.as_bytes())?;
        let boot = boot.ok_or_else(refused)?;
        record
            .review
            .validate(record.review.scope())
            .map_err(|_| refused())?;
        // SAFETY: geteuid has no preconditions; private state remains same-user.
        if !matches!(record.version, 3 | 4)
            || record.candidate != candidate.checkout
            || record.review.scope().run != run
            || record.process.uid != unsafe { libc::geteuid() }
        {
            return Err(refused());
        }
        boot.verify()?;
        Ok((record, boot))
    }
}
/// Recovery keeps gate → original run lock for its entire lease. Ordinary live
/// Pin and DirectGuard remain strict and grant no dead-publication authority.
pub(super) struct RecoveryLease<'a> {
    candidate: &'a Candidate,
    run: &'a str,
    root: PathBuf,
    gate: super::super::super::publication_gate::Guard,
    lock: state::Lock,
    selection: RecoverySelection,
}
impl<'a> RecoveryLease<'a> {
    pub(super) fn acquire(
        candidate: &'a Candidate,
        run: &'a str,
        saved: Option<RecoverySelection>,
        socket_retirement_admitted: bool,
        owner_retirement_admitted: bool,
    ) -> Result<Self, CandidateError> {
        let gate = super::super::super::publication_gate::Guard::acquire_existing(candidate)?;
        let root = root(candidate, run)?;
        let lock = state::Lock::acquire_existing(&root)?;
        let selection = match saved {
            Some(value) => value,
            None => {
                let pin = Pin::read(candidate, run)?;
                if pin.host_boot.is_none() {
                    return Err(refused());
                }
                RecoverySelection {
                    bytes: String::from_utf8(pin.bytes).map_err(|_| refused())?,
                    file: pin.file,
                }
            }
        };
        let lease = Self {
            candidate,
            run,
            root,
            gate,
            lock,
            selection,
        };
        lease.verify(socket_retirement_admitted, owner_retirement_admitted)?;
        Ok(lease)
    }
    pub(super) fn selected(&self) -> &RecoverySelection {
        &self.selection
    }
    pub(super) fn review(&self) -> Result<native_input::Review, CandidateError> {
        self.selection
            .record(self.candidate, self.run)
            .map(|(record, _)| record.review)
    }
    pub(super) fn host_boot(&self) -> Result<HostBoot, CandidateError> {
        self.selection
            .record(self.candidate, self.run)
            .map(|(_, boot)| boot)
    }
    /// Caller has already durably admitted this exact path's retirement phase.
    /// Existing archive identity is retry evidence, never overwrite permission.
    pub(super) fn archive(&self, socket: bool) -> Result<(), CandidateError> {
        let (socket_original, owner_original) = self.verify(true, !socket)?;
        if !socket && socket_original {
            return Err(refused());
        }
        let original = if socket {
            socket_original
        } else {
            owner_original
        };
        if original {
            let path = self
                .root
                .join(if socket { "control.sock" } else { "owner.json" });
            exclusive_move(&path, &self.archive_path(socket))?;
            fs::File::open(&self.root)
                .and_then(|file| file.sync_all())
                .map_err(|_| refused())?;
        }
        self.verify(true, !socket)?;
        Ok(())
    }
    fn archive_path(&self, socket: bool) -> PathBuf {
        let fingerprint = self.selection.fingerprint();
        self.root.join(if socket {
            format!("control-{}.retired.sock", &fingerprint[..24])
        } else {
            format!("owner-{}.retired.json", &fingerprint[..24])
        })
    }
    fn selected_path(
        &self,
        socket: bool,
        admitted: bool,
        expected: (u64, u64),
    ) -> Result<(PathBuf, bool), CandidateError> {
        let original = self
            .root
            .join(if socket { "control.sock" } else { "owner.json" });
        let archived = self.archive_path(socket);
        let (path, original) = match (exists(&original)?, exists(&archived)?) {
            (true, false) => (original, true),
            (false, true) if admitted => (archived, false),
            _ => return Err(refused()),
        };
        let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if !private(&metadata)
            || id(&metadata) != expected
            || (socket && !metadata.file_type().is_socket())
            || (!socket && (!metadata.is_file() || metadata.nlink() != 1))
        {
            return Err(refused());
        }
        Ok((path, original))
    }
    /// Return which original paths remain. Retired paths require a pre-existing
    /// durable phase; missing both original and archive always refuses.
    pub(super) fn verify(
        &self,
        socket_admitted: bool,
        owner_admitted: bool,
    ) -> Result<(bool, bool), CandidateError> {
        self.gate.verify(self.candidate)?;
        let (record, _) = self.selection.record(self.candidate, self.run)?;
        state::check_private_directory(&self.root).map_err(|_| refused())?;
        if id(&fs::symlink_metadata(&self.root).map_err(|_| refused())?) != record.parent
            || self.lock.identity()? != record.lock
            || identity::alive(record.process.pid).map_err(|_| refused())?
        {
            return Err(refused());
        }
        super::super::super::host_pin_recovery::exact_lock_path(&self.root, &self.lock)?;
        let (socket, socket_original) = self.selected_path(true, socket_admitted, record.socket)?;
        let (owner, owner_original) =
            self.selected_path(false, owner_admitted, self.selection.file)?;
        if socket_original && !owner_original
            || native_input::read_file(&owner, 8192)? != self.selection.bytes.as_bytes()
        {
            return Err(refused());
        }
        transport::no_listener(&socket)?;
        if self.selected_path(true, socket_admitted, record.socket)? != (socket, socket_original)
            || self.selected_path(false, owner_admitted, self.selection.file)?
                != (owner.clone(), owner_original)
            || native_input::read_file(&owner, 8192)? != self.selection.bytes.as_bytes()
            || identity::alive(record.process.pid).map_err(|_| refused())?
        {
            return Err(refused());
        }
        self.selection.record(self.candidate, self.run)?;
        self.gate.verify(self.candidate)?;
        Ok((socket_original, owner_original))
    }
}

pub(super) fn exclusive_move(source: &Path, target: &Path) -> Result<(), CandidateError> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| refused())?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| refused())?;
    // SAFETY: both paths are NUL-terminated for this synchronous call. RENAME_EXCL
    // refuses any existing target; no replacement or copy fallback is permitted.
    if unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err(refused());
    }
    Ok(())
}

pub(super) struct Publication {
    listener: UnixListener,
    pin: Pin,
    lock: state::Lock,
}
impl Publication {
    pub(super) fn bind(
        candidate: &Candidate,
        review: &native_input::Review,
    ) -> Result<Self, CandidateError> {
        review.validate(review.scope()).map_err(|_| refused())?;
        let host_boot_uuid = host_boot::read()?;
        let gate = super::super::super::publication_gate::Guard::acquire(candidate)?;
        let run = review.scope().run;
        if exists(&super::super::journal::directory(candidate, run)?)? {
            return Err(refused());
        }
        let root = root(candidate, run)?;
        let lock = state::Lock::acquire(&root).map_err(|_| refused())?;
        if present(candidate, run)? {
            return Err(refused());
        }
        gate.verify(candidate)?;
        let listener = UnixListener::bind(root.join("control.sock")).map_err(|_| refused())?;
        fs::set_permissions(root.join("control.sock"), fs::Permissions::from_mode(0o600))
            .map_err(|_| refused())?;
        listener.set_nonblocking(true).map_err(|_| refused())?;
        let record = SessionQualifiedRecord {
            version: 4,
            kind: Kind::NativeGraphOwner,
            candidate: candidate.checkout.clone(),
            review: review.clone(),
            process: identity::observe(std::process::id() as i32)?,
            parent: id(&fs::symlink_metadata(&root).map_err(|_| refused())?),
            socket: id(&fs::symlink_metadata(root.join("control.sock")).map_err(|_| refused())?),
            lock: lock.identity().map_err(|_| refused())?,
            host_boot_uuid,
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| refused())?;
        if bytes.len() > 8192 {
            return Err(refused());
        }
        let (record, host_boot) = decode(&bytes)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("owner.json"))
            .map_err(|_| refused())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| refused())?;
        let pin = Pin {
            root,
            record,
            host_boot,
            bytes,
            file: id(&file.metadata().map_err(|_| refused())?),
        };
        fs::File::open(&pin.root)
            .and_then(|file| file.sync_all())
            .map_err(|_| refused())?;
        pin.verify()?;
        gate.verify(candidate)?;
        Ok(Self {
            listener,
            pin,
            lock,
        })
    }
    pub(super) fn descriptor(&self) -> BorrowedFd<'_> {
        self.listener.as_fd()
    }
    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        super::super::super::host_pin_recovery::exact_lock_path(&self.pin.root, &self.lock)?;
        self.pin.verify()
    }
    pub(super) fn accept(&self) -> Result<Option<UnixStream>, CandidateError> {
        self.verify()?;
        match self.listener.accept() {
            Ok((stream, _)) => {
                self.verify()?;
                if transport::peer(&stream).is_err() || stream.set_nonblocking(false).is_err() {
                    return Ok(None);
                }
                Ok(Some(stream))
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err(refused()),
        }
    }
    /// Caller must prove this attempt was never admitted, or its exact resources are removed.
    pub(super) fn finish(&mut self) -> Result<(), CandidateError> {
        self.verify()?;
        fs::remove_file(self.pin.root.join("control.sock")).map_err(|_| refused())?;
        fs::remove_file(self.pin.root.join("owner.json")).map_err(|_| refused())?;
        fs::File::open(&self.pin.root)
            .and_then(|file| file.sync_all())
            .map_err(|_| refused())
    }
}

#[cfg(test)]
mod boot_tests {
    use super::*;
    const UUID: &str = "12345678-abcd-abcd-abcd-123456789abc";
    fn session(value: &str) -> host_boot::Session {
        serde_json::from_value(json!(value)).unwrap()
    }
    #[test]
    fn session_authority_ignores_calendar_adjustment_but_not_reboot_or_unavailability() {
        let boot = HostBoot::Session(session(UUID));
        for changed_wall in [1, u64::MAX] {
            // Even an unavailable calendar reader cannot become V4 authority.
            boot.verify_with(|| Ok(changed_wall), || Ok(session(UUID)))
                .unwrap();
            boot.verify_with(|| Err(refused()), || Ok(session(UUID)))
                .unwrap();
        }
        assert!(
            boot.verify_with(
                || Ok(1),
                || Ok(session("12345678-abcd-abcd-abcd-123456789abd"))
            )
            .is_err()
        );
        assert!(boot.verify_with(|| Ok(1), || Err(refused())).is_err());
        let legacy = HostBoot::LegacyMicros(1);
        legacy.verify_with(|| Ok(1), || Err(refused())).unwrap();
        assert!(legacy.verify_with(|| Ok(2), || Ok(session(UUID))).is_err());
    }
}
