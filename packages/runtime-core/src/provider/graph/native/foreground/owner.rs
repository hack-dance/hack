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
    bytes: Vec<u8>,
    file: (u64, u64),
}
impl Pin {
    pub(super) fn load(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = root(candidate, run)?;
        state::check_private_directory(&root).map_err(|_| refused())?;
        let file = fs::symlink_metadata(root.join("owner.json")).map_err(|_| refused())?;
        let bytes = native_input::read_file(&root.join("owner.json"), 8192)?;
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        record
            .review
            .validate(record.review.scope())
            .map_err(|_| refused())?;
        if record.version != 2
            || record.candidate != candidate.checkout
            || record.review.scope().run != run
        {
            return Err(refused());
        }
        let pin = Self {
            root,
            record,
            bytes,
            file: id(&file),
        };
        pin.verify()?;
        Ok(pin)
    }
    pub(super) fn review(&self) -> &native_input::Review {
        &self.record.review
    }
    /// The caller already authenticated its retained connection before the owner
    /// retired. Absence grants no new connection, process or cleanup authority.
    pub(super) fn verify_retired(&self) -> Result<(), CandidateError> {
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
        let record = Record {
            version: 2,
            kind: Kind::NativeGraphOwner,
            candidate: candidate.checkout.clone(),
            review: review.clone(),
            process: identity::observe(std::process::id() as i32)?,
            parent: id(&fs::symlink_metadata(&root).map_err(|_| refused())?),
            socket: id(&fs::symlink_metadata(root.join("control.sock")).map_err(|_| refused())?),
            lock: lock.identity().map_err(|_| refused())?,
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| refused())?;
        if bytes.len() > 8192 {
            return Err(refused());
        }
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
