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
        let shard = self.root.join(cas_shard(&digest));
        disk::create_directory(&shard)?;
        let path = shard.join(format!("{:x}", crate::Hex(digest.0)));
        disk::publish(&self.root, &path, &bytes)?;
        Ok(digest)
    }

    /// Read and verify CAS bytes. Unreadable or invalid objects are treated as absent.
    pub fn get_cas(&self, digest: &Digest) -> Option<Vec<u8>> {
        let path = cas_shard(digest).join(format!("{:x}", crate::Hex(digest.0)));
        let mut entry = disk::read_cache_file(&self.directory, &path, self.owner).ok()?;
        let verified = disk::read_limited(&mut entry.file, MAX_CAS_BYTES)
            .ok()?
            .filter(|bytes| Digest(Sha256::digest(bytes).into()) == *digest);
        if verified.is_none() {
            // Best effort: the object is absent either way.
            entry.discard();
        }
        verified
    }
}

fn cas_shard(digest: &Digest) -> PathBuf {
    PathBuf::from("cas").join(format!("{:x}", crate::Hex(&digest.0[..1])))
}
