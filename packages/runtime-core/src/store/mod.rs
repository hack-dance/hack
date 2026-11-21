//! Per-user step cache. Persisted records are hints for reuse and convey no authority.

mod cas;
mod disk;
mod key;
mod record;
#[cfg(test)]
mod tests;

pub use cas::ValueFree;
pub use key::{InputDigest, StepClass, StepKey};
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
    /// Open or initialize a private store, setting aside a root with an incompatible format.
    pub fn open(root: &Path) -> Result<Self> {
        disk::open(root)
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
    pub fn lookup(&self, key: &StepKey, observe: impl FnOnce(&Record) -> bool) -> Result<Lookup> {
        let (record, file) = match self.read_record(key)? {
            Ok(pair) => pair,
            Err(reason) => return Ok(Lookup::Miss(reason)),
        };
        if key.class == StepClass::Cas {
            if record.output.reference != Some(OutputRef::Cas)
                || !self.has_verified_cas(&record.output.digest)?
            {
                return Ok(Lookup::Miss(MissReason::NoRecord));
            }
        } else if !observe(&record) {
            return Ok(Lookup::Miss(MissReason::ObservationFailed));
        }
        disk::touch(&file)?;
        Ok(Lookup::Hit(record))
    }

    fn read_file(&self, path: &Path) -> Result<Option<File>> {
        // Check the shard and all its ancestors before opening its leaf.
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Step store file has no parent directory."))?;
        if !disk::existing_directory(parent, self.owner)? {
            return Ok(None);
        }
        disk::read_owned_file(path, self.owner)
    }
}

/// The store directory the CLI handed over with `--step-store`, once per process.
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

/// The store directory passed with `--step-store`, if any.
pub fn configured_root() -> Option<&'static Path> {
    CONFIGURED_ROOT.get().map(PathBuf::as_path)
}

fn invalid(message: &'static str) -> CandidateError {
    CandidateError::new("step_store_invalid", message)
}

fn io_error(_: io::Error) -> CandidateError {
    invalid("Step store filesystem operation failed.")
}
