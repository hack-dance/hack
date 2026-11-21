//! Content-addressed canonical JSON for value-free step outputs.

use super::{Result, Store, disk, invalid};
use crate::canonical_digest::{self, Digest};
use sha2::{Digest as _, Sha256};
use std::path::PathBuf;

/// The largest CAS object the store writes or reads (plan outputs are far smaller).
pub(super) const MAX_CAS_BYTES: u64 = 16 * 1024 * 1024;

/// Implement only for a type with no field that can hold an env value, managed
/// file content, credential, token, execution input or normalized Compose text.
pub trait ValueFree: serde::Serialize {}

impl Store {
    /// Store canonical JSON under the SHA-256 of its bytes and return that digest.
    pub fn put_cas<T: ValueFree>(&self, value: &T) -> Result<Digest> {
        let value =
            serde_json::to_value(value).map_err(|_| invalid("Cannot encode CAS output."))?;
        let bytes = canonical_digest::canonical_json(&value)
            .map_err(|_| invalid("Cannot encode CAS output."))?;
        if bytes.len() as u64 > MAX_CAS_BYTES {
            return Err(invalid("CAS output exceeds the step store limit."));
        }
        let digest = Digest(Sha256::digest(&bytes).into());
        let shard = self.cas_shard(&digest);
        disk::create_directory(&shard)?;
        let path = shard.join(format!("{:x}", crate::Hex(digest.0)));
        disk::publish(&self.root, &path, &bytes)?;
        Ok(digest)
    }

    /// Read and verify CAS bytes. An object that does not hash to its name, or is
    /// larger than `MAX_CAS_BYTES`, is absent and is removed.
    pub fn get_cas(&self, digest: &Digest) -> Result<Option<Vec<u8>>> {
        let path = self.cas_path(digest);
        let Some(mut file) = self.read_file(&path)? else {
            return Ok(None);
        };
        let verified = disk::read_limited(&mut file, MAX_CAS_BYTES)?
            .filter(|bytes| Digest(Sha256::digest(bytes).into()) == *digest);
        if verified.is_none() {
            // Best effort: the object is absent either way.
            let _ = disk::remove_current(&file, &path);
        }
        Ok(verified)
    }

    pub(super) fn has_verified_cas(&self, digest: &Digest) -> Result<bool> {
        Ok(self.get_cas(digest)?.is_some())
    }

    fn cas_path(&self, digest: &Digest) -> PathBuf {
        self.cas_shard(digest)
            .join(format!("{:x}", crate::Hex(digest.0)))
    }

    fn cas_shard(&self, digest: &Digest) -> PathBuf {
        self.root
            .join("cas")
            .join(format!("{:x}", crate::Hex(&digest.0[..1])))
    }
}
