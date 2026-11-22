//! Per-user step cache. Persisted records are hints for reuse and convey no authority.
//!
//! The CLI follows symlinks to resolve the base to its canonical path. The runtime
//! refuses symlinked ancestors of the path it receives. Each format has its own
//! subdirectory, currently `hack.store-1/`. Rotation writes a `SET_ASIDE` marker
//! with the canonical base and archive timestamp before renaming the root, and
//! reopening a live root clears a stray marker. After a successful open, best-effort
//! cleanup keeps the newest marked archive for up to seven days and removes owned
//! archives only with their own nonblocking exclusive lock. The old flat layout
//! and P1 sibling archives require the P1 `VERSION` marker and their own nonblocking
//! exclusive lock, and the flat `VERSION` is removed after the other entries are gone.
//!
//! `record()` and `put_cas()` can fail on a directory at the write path or a
//! wrong-mode or symlinked shard. Writes leave that damage in place. Callers must
//! ignore a cache write error and keep the step's result. A CAS lookup reads the
//! whole object (up to 16 MiB) to verify it.
//!
//! Some damage makes every open fail until a person fixes it. This includes a
//! damaged top-level layout entry (such as a non-directory `records`), a wrong-mode
//! `lock`, a mode-000 `VERSION`, and a foreign-owned or hard-linked key.
//!
//! There is no eviction yet. Garbage collection (P8) will clean up files that
//! crashed writers leave in `tmp/`.

mod cas;
mod disk;
mod key;
mod record;
#[cfg(test)]
mod tests;

pub use cas::ValueFree;
pub use key::{Build, InputDigest, StepClass, StepKey};
pub use record::{Output, OutputRef, ProducedBy, Record};

use crate::CandidateError;
use crate::canonical_digest::{self, Digest, Domain};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, CandidateError>;

/// An open cache with a shared lock held until the handle is dropped.
pub struct Store {
    root: PathBuf,
    directory: File,
    owner: u32,
    key: Zeroizing<[u8; 32]>,
    _lock: File,
}

/// The result of checking a record and the evidence required by its step class.
#[derive(Debug, Eq, PartialEq)]
pub enum Lookup {
    Hit(Record),
    Miss(MissReason),
}

/// Why a step must be recomputed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MissReason {
    /// The record or its required CAS object was absent.
    NoRecord,
    TornRecord,
    VersionChanged,
    ObservationFailed,
}

impl Store {
    /// Open or initialize this format's private directory inside the per-user base.
    pub fn open(base: &Path) -> Result<Self> {
        disk::open(base)
    }

    /// Derive an identity from a value without storing the value or its canonical bytes.
    pub fn keyed_digest(&self, domain: Domain, value: &Value) -> Result<Digest> {
        let encoded = Zeroizing::new(
            canonical_digest::canonical_json(value)
                .map_err(|_| invalid("Cannot encode the keyed step input."))?,
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key[..])
            .map_err(|_| invalid("Cannot initialize the keyed step digest."))?;
        mac.update(domain.as_str().as_bytes());
        mac.update(&[0]);
        mac.update(&encoded);
        Ok(Digest(mac.finalize().into_bytes().into()))
    }

    /// Check the record's integrity, then its CAS object or the caller's current observation.
    /// This never errors on store content; a caller treats every miss as run the step.
    pub fn lookup(&self, key: &StepKey, observe: impl FnOnce(&Record) -> bool) -> Lookup {
        let (record, file) = match self.read_record(key) {
            Ok(pair) => pair,
            Err(reason) => return Lookup::Miss(reason),
        };
        if key.class == StepClass::Cas {
            if record.output.reference != Some(OutputRef::Cas)
                || self.get_cas(&record.output.digest).is_none()
            {
                return Lookup::Miss(MissReason::NoRecord);
            }
        } else if !observe(&record) {
            return Lookup::Miss(MissReason::ObservationFailed);
        }
        // Use time is advisory (it orders garbage collection); a failed touch
        // never turns a hit into an error.
        let _ = disk::touch(&file);
        Lookup::Hit(record)
    }
}

/// The store base the CLI handed over with `--step-store`, once per process.
static CONFIGURED_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Take a leading `--step-store <dir>` from a command's arguments.
///
/// The runtime runs with a closed environment, so the CLI passes the per-user store
/// explicitly, right after `--candidate-root <dir>`, and only when the store is
/// switched on. The directory must be absolute. Recording it opens nothing: a step
/// that uses the store opens it then (HACK-2461 slices P2 on).
pub fn take_step_store_argument<'a, 'b>(command: &'b [&'a str]) -> Result<&'b [&'a str]> {
    match command {
        ["--step-store", root, rest @ ..] => {
            let root = Path::new(root);
            if !root.is_absolute() {
                return Err(invalid("The step store directory must be absolute."));
            }
            CONFIGURED_ROOT
                .set(root.to_owned())
                .map_err(|_| invalid("The step store is already configured."))?;
            Ok(rest)
        }
        ["--step-store"] => Err(invalid("Supply a directory after --step-store.")),
        _ => Ok(command),
    }
}

/// The store base passed with `--step-store`, if any.
pub fn configured_root() -> Option<&'static Path> {
    CONFIGURED_ROOT.get().map(PathBuf::as_path)
}

fn invalid(message: &'static str) -> CandidateError {
    CandidateError::new("step_store_invalid", message)
}

fn io_error(_: io::Error) -> CandidateError {
    invalid("Step store filesystem operation failed.")
}
