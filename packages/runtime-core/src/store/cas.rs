//! Content-addressed canonical JSON for value-free step outputs.

use super::{Result, Store, disk, invalid, io_error};
use crate::canonical_digest::{self, Digest};
use sha2::{Digest as _, Sha256};
use std::io::Read;
use std::path::PathBuf;

const VERIFY_BELOW: u64 = 1024 * 1024;

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
        let digest = Digest(Sha256::digest(&bytes).into());
        let shard = self.cas_shard(&digest);
        disk::create_directory(&shard)?;
        let path = shard.join(format!("{:x}", crate::Hex(digest.0)));
        disk::publish(&self.root, &path, &bytes)?;
        Ok(digest)
    }

    /// Read CAS bytes, verifying objects smaller than 1 MiB. Remove a mismatch.
    ///
    /// An object of 1 MiB or more is returned unverified: a caller that needs a
    /// verified output goes through `lookup`, which verifies at any size.
    pub fn get_cas(&self, digest: &Digest) -> Result<Option<Vec<u8>>> {
        let path = self.cas_path(digest);
        let Some(mut file) = self.read_file(&path)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_error)?;
        if (bytes.len() as u64) < VERIFY_BELOW && Digest(Sha256::digest(&bytes).into()) != *digest {
            // Best effort: the object is absent either way.
            let _ = disk::remove_current(&file, &path);
            return Ok(None);
        }
        Ok(Some(bytes))
    }

    pub(super) fn has_verified_cas(&self, digest: &Digest) -> Result<bool> {
        let path = self.cas_path(digest);
        let Some(mut file) = self.read_file(&path)? else {
            return Ok(false);
        };
        // A cache hit requires verification at any size. Stream the hash so the
        // observation does not have to retain the output in memory.
        let mut hasher = Sha256::new();
        let mut buffer = [0; 16 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        if Digest(hasher.finalize().into()) != *digest {
            // Best effort: the object is absent either way.
            let _ = disk::remove_current(&file, &path);
            return Ok(false);
        }
        Ok(true)
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
