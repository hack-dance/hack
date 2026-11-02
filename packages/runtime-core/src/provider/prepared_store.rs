//! Prepared-base store: the store lock, independent verification receipts, and the listing a
//! fresh pool selects from.
//!
//! Locking: `<store>/store.lock` is taken shared while a pool clones and verifies a base, and
//! exclusively to publish, record a verification or remove anything. Both are nonblocking: a
//! contended lock is reported, never waited on, so a fresh pool falls back to stock templates
//! instead of stalling behind a publisher. A staging directory seen under the exclusive lock is
//! therefore abandoned (every publisher holds that lock), and no base is removed while a pool
//! is cloning it.
//!
//! Verification: a base is eligible only with a receipt written by an independent verifier boot
//! (`prepared_verify`), bound to the published receipt's SHA-256 and template digests. The
//! publisher's sanitization record alone never makes a base eligible.
use super::prepared_base::{self, Pins, PublishedBase, TEMPLATES};
use super::state;
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const VERIFICATION_SCHEMA: &str = "hack.prepared-base-verification/v1";
const LOCK: &str = "store.lock";
const VERIFIED: &str = ".verified";
const LIMIT: u64 = 256 * 1024;

fn error(code: &'static str, message: impl Into<String>) -> CandidateError {
    CandidateError::new(code, message)
}

/// Refuse anything but an explicit, absolute, private store without symlinked ancestors.
pub fn open(store: &Path) -> Result<(), CandidateError> {
    if !store.is_absolute() {
        return Err(error(
            "prepared_base_invalid",
            "The prepared-base store must be an explicit absolute path.",
        ));
    }
    crate::reject_aliased_state(store)?;
    state::check_private_directory(store)
}

/// A held store lock; released on drop.
pub struct StoreLock(File);

impl StoreLock {
    /// Shared: a pool clones and verifies a base.
    pub fn shared(store: &Path) -> Result<Self, CandidateError> {
        Self::acquire(store, libc::LOCK_SH)
    }

    /// Exclusive: publish, record a verification, or remove store entries.
    pub fn exclusive(store: &Path) -> Result<Self, CandidateError> {
        Self::acquire(store, libc::LOCK_EX)
    }

    fn acquire(store: &Path, operation: libc::c_int) -> Result<Self, CandidateError> {
        open(store)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(store.join(LOCK))
            .map_err(state::io)?;
        let metadata = file.metadata().map_err(state::io)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(error("foreign_state", "Unsafe prepared-base store lock."));
        }
        // SAFETY: `file` is a live owned descriptor; flock retains no pointers.
        if unsafe { libc::flock(file.as_raw_fd(), operation | libc::LOCK_NB) } != 0 {
            return Err(error(
                "prepared_base_store_busy",
                "Another operation holds the prepared-base store; nothing was changed.",
            ));
        }
        Ok(Self(file))
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor is owned by `self` and still open.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// What the verifier observed inside a clone of the published disks, before any pool setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub owner_marker_present: bool,
    pub engine_id_present: bool,
    pub containers: u32,
    pub volumes: u32,
    pub network_tools_owner: String,
    pub network_tools_identity: String,
    pub network_tools_files_verified: bool,
    /// Image IDs in the engine's image store.
    pub images: Vec<String>,
    /// Paths outside the allow-list, on either disk. Must be empty.
    pub unexpected: Vec<String>,
}

/// Evidence from an independent verifier boot of one published base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    pub schema: String,
    pub base_id: String,
    pub receipt_sha256: String,
    /// Content digests re-proved on the verifier's own clone, in [`TEMPLATES`] order.
    pub template_sha256: Vec<String>,
    pub inventory: Inventory,
    pub verified_at_unix: u64,
}

impl Verification {
    /// Whether this is a passing verification of exactly `base`.
    pub fn accepts(&self, base: &PublishedBase) -> bool {
        let receipt = &base.receipt;
        let inventory = &self.inventory;
        self.schema == VERIFICATION_SCHEMA
            && self.base_id == receipt.base_id
            && self.receipt_sha256 == base.receipt_sha256
            && self.template_sha256.len() == TEMPLATES.len()
            && self
                .template_sha256
                .iter()
                .zip(&receipt.templates)
                .all(|(verified, published)| *verified == published.content_sha256)
            && !inventory.owner_marker_present
            && !inventory.engine_id_present
            && inventory.containers == 0
            && inventory.volumes == 0
            && inventory.network_tools_owner == receipt.network_tools_owner
            && inventory.network_tools_identity == receipt.pins.network_tools_identity
            && inventory.network_tools_files_verified
            && inventory.unexpected.is_empty()
    }
}

fn verification_path(store: &Path, base_id: &str) -> PathBuf {
    store.join(VERIFIED).join(format!("{base_id}.json"))
}

/// The recorded verification of `base`, if one exists. Read without blocking or following links.
pub fn verification(
    store: &Path,
    base: &PublishedBase,
) -> Result<Option<Verification>, CandidateError> {
    let path = verification_path(store, &base.receipt.base_id);
    match fs::symlink_metadata(&path) {
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(failure) => return Err(state::io(failure)),
        Ok(_) => {}
    }
    let bytes = prepared_base::read_private(&path, LIMIT)?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| {
        error(
            "prepared_base_invalid",
            "Prepared-base verification receipt is malformed; it was not used.",
        )
    })
}

/// Record `verification` under the exclusive store lock: written to a private temporary file,
/// synced, and renamed into place.
pub fn record_verification(
    store: &Path,
    _exclusive: &StoreLock,
    verification: &Verification,
) -> Result<(), CandidateError> {
    let dir = store.join(VERIFIED);
    match fs::symlink_metadata(&dir) {
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(state::io)?;
        }
        Err(failure) => return Err(state::io(failure)),
        Ok(_) => state::check_private_directory(&dir)?,
    }
    let path = verification_path(store, &verification.base_id);
    let temporary = dir.join(format!(".{}.pending", verification.base_id));
    let bytes = serde_json::to_vec_pretty(verification)
        .map_err(|failure| error("prepared_base_invalid", failure.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(state::io)?;
    let written = file
        .write_all(&bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, &path));
    if let Err(failure) = written {
        // Created exclusively above, under the exclusive store lock.
        let _ = fs::remove_file(&temporary);
        return Err(state::io(failure));
    }
    File::open(&dir)
        .and_then(|dir| dir.sync_all())
        .map_err(state::io)
}

/// One store entry, as `status` reports it.
#[derive(Debug, Serialize)]
pub struct Entry {
    pub base_id: String,
    /// Why the entry cannot be used, if it cannot.
    pub unusable: Option<String>,
    pub verified: bool,
    pub matches_pins: bool,
    pub verified_at_unix: Option<u64>,
}

/// Every base directory in `store`, with whether it is published, verified and bound to
/// `pins`. Dot-prefixed working directories are skipped.
pub fn entries(store: &Path, pins: &Pins) -> Result<Vec<Entry>, CandidateError> {
    open(store)?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(store).map_err(state::io)? {
        let name = entry.map_err(state::io)?.file_name();
        if let Some(id) = name.to_str()
            && prepared_base::valid_base_id(id)
        {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    let mut result = Vec::with_capacity(ids.len());
    for base_id in ids {
        let mut entry = Entry {
            base_id,
            unusable: None,
            verified: false,
            matches_pins: false,
            verified_at_unix: None,
        };
        match prepared_base::open_published(store, &entry.base_id) {
            Err(failure) => entry.unusable = Some(failure.code.to_string()),
            Ok(base) => {
                entry.matches_pins = base.bind(pins).is_ok();
                match verification(store, &base) {
                    Ok(Some(verification)) if verification.accepts(&base) => {
                        entry.verified = true;
                        entry.verified_at_unix = Some(verification.verified_at_unix);
                    }
                    Ok(_) => {}
                    Err(failure) => entry.unusable = Some(failure.code.to_string()),
                }
            }
        }
        result.push(entry);
    }
    Ok(result)
}

/// The most recently verified base bound to `pins`, if any.
pub fn select(store: &Path, pins: &Pins) -> Result<Option<PublishedBase>, CandidateError> {
    let chosen = entries(store, pins)?
        .into_iter()
        .filter(|entry| entry.unusable.is_none() && entry.verified && entry.matches_pins)
        .max_by(|left, right| {
            left.verified_at_unix
                .cmp(&right.verified_at_unix)
                .then_with(|| left.base_id.cmp(&right.base_id))
        });
    chosen
        .map(|entry| prepared_base::open_published(store, &entry.base_id))
        .transpose()
}

/// Remove one base and its verification under the exclusive store lock. No pool can be cloning
/// it: activation holds the shared lock throughout its clone and verification.
pub fn remove(store: &Path, _exclusive: &StoreLock, base_id: &str) -> Result<(), CandidateError> {
    if !prepared_base::valid_base_id(base_id) {
        return Err(error("prepared_base_invalid", "Invalid prepared base id."));
    }
    let dir = store.join(base_id);
    let metadata = fs::symlink_metadata(&dir).map_err(state::io)?;
    if !metadata.is_dir() {
        return Err(error(
            "foreign_state",
            "Prepared base entry is not a directory; nothing was removed.",
        ));
    }
    state::check_private_directory(&dir)?;
    let verification = verification_path(store, base_id);
    if fs::symlink_metadata(&verification).is_ok() {
        fs::remove_file(&verification).map_err(state::io)?;
    }
    fs::remove_dir_all(&dir).map_err(state::io)?;
    File::open(store)
        .and_then(|dir| dir.sync_all())
        .map_err(state::io)
}

#[cfg(test)]
mod tests;
