//! Candidate-owned bounded image acquisition cache; import remains image_load's operation.
use super::{
    engine, image_load,
    image_policy::{ARCHIVE_CEILING, CACHE_CEILING, ImagePolicy},
    registry_image, state,
};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
/// Content-addressed archives one candidate's cache may hold.
const MAX_ARCHIVES: usize = 64;
/// A new slot needs at least this much remaining cache budget.
const MIN_SLOT: u64 = 1024 * 1024;
fn refused(message: &str) -> CandidateError {
    CandidateError::new("image_cache", message)
}
fn current_uid() -> u32 {
    // SAFETY: geteuid takes no arguments and has no caller preconditions.
    unsafe { libc::geteuid() }
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
/// Canonical pinned form by syntax alone, so recorded entries stay readable when the
/// policy that admitted their registry changes; new acquisition admits under the policy.
fn canonical(value: &str) -> Result<String, CandidateError> {
    registry_image::pinned_syntax(value).map(|(canonical, _)| canonical)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheReceipt {
    version: u32,
    checkout: PathBuf,
    reference: String,
    archive_sha256: String,
    image_id: String,
    archive_bytes: u64,
}
impl CacheReceipt {
    fn validate(&self, candidate: &Candidate, reference: &str) -> Result<(), CandidateError> {
        if self.version != 1
            || self.checkout != candidate.checkout
            || self.reference != reference
            || canonical(reference)? != reference
            || !hex(&self.archive_sha256)
            || !self.image_id.strip_prefix("sha256:").is_some_and(hex)
            || self.archive_bytes == 0
            || self.archive_bytes > ARCHIVE_CEILING
        {
            return Err(refused(
                "Conflicting image cache receipt; no entry was adopted or removed.",
            ));
        }
        Ok(())
    }
}
fn read_receipt(path: &Path) -> Result<CacheReceipt, CandidateError> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != current_uid()
        || m.mode() & 0o077 != 0
        || m.len() > 4096
    {
        return Err(refused("Unsafe image cache receipt."));
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes).map_err(state::io)?;
    if bytes.len() > 4096 {
        return Err(refused("Oversized image cache receipt."));
    }
    serde_json::from_slice(&bytes).map_err(|_| refused("Invalid image cache receipt."))
}
fn archive_size(path: &Path) -> Result<u64, CandidateError> {
    reject_aliased_state(
        path.parent()
            .ok_or_else(|| refused("Archive parent is missing."))?,
    )?;
    let m = fs::symlink_metadata(path).map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != current_uid()
        || m.mode() & 0o077 != 0
        || m.len() == 0
        || m.len() > ARCHIVE_CEILING
    {
        return Err(refused(
            "Unsafe image archive cache entry; no files were removed.",
        ));
    }
    Ok(m.len())
}
fn inspect_entry(
    candidate: &Candidate,
    dir: &Path,
    reference: &str,
) -> Result<CacheReceipt, CandidateError> {
    state::check_private_directory(dir)?;
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(state::io)? {
        count += 1;
        let entry = entry.map_err(state::io)?;
        if count > 2
            || !matches!(
                entry.file_name().to_str(),
                Some("image.tar" | "receipt.json")
            )
        {
            return Err(refused(
                "Incomplete or unknown image cache files require explicit inspection.",
            ));
        }
    }
    if count != 2 {
        return Err(refused(
            "Incomplete image cache entry requires explicit inspection.",
        ));
    }
    let receipt: CacheReceipt = read_receipt(&dir.join("receipt.json"))?;
    receipt.validate(candidate, reference)?;
    if archive_size(&dir.join("image.tar"))? != receipt.archive_bytes {
        return Err(refused("Cached archive size differs from its receipt."));
    }
    Ok(receipt)
}
fn usage(candidate: &Candidate, root: &Path) -> Result<(usize, u64), CandidateError> {
    let mut count = 0;
    let mut bytes = 0u64;
    for entry in fs::read_dir(root).map_err(state::io)? {
        let entry = entry.map_err(state::io)?;
        let name = entry.file_name();
        if name == "operation.lock" {
            continue;
        }
        count += 1;
        if count > MAX_ARCHIVES || !name.to_str().is_some_and(hex) {
            return Err(refused(
                "Image cache permits 64 content-addressed archives; unexpected entries refuse admission.",
            ));
        }
        let dir = entry.path();
        state::check_private_directory(&dir)?;
        let receipt: CacheReceipt = read_receipt(&dir.join("receipt.json"))?;
        if key(&receipt.reference) != name.to_string_lossy() {
            return Err(refused("Image cache address conflicts with its receipt."));
        }
        bytes = bytes
            .checked_add(inspect_entry(candidate, &dir, &receipt.reference)?.archive_bytes)
            .ok_or_else(|| refused("Image cache size overflow."))?;
        if bytes > CACHE_CEILING {
            return Err(refused(
                "Image cache exceeds its fixed ceiling; no files were removed.",
            ));
        }
    }
    Ok((count, bytes))
}
#[derive(Debug, Serialize)]
pub struct EnsuredImage {
    pub pinned_reference: String,
    pub image_id: String,
    pub archive_sha256: String,
    pub archive_reused: bool,
    pub phase: &'static str,
}
/// Resolve tags on every call, reuse their exact immutable archive when available,
/// and validate/import via the owned guest's existing loader. The engine must already
/// be running before acquisition. A cache miss acquires at most the policy's per-image
/// budget and the cache's remaining budget (at most 64 archives); an image whose
/// manifest exceeds that refuses before any layer transfer. This operation never prunes
/// or adopts conflicting files. Runtime ownership is checked again by the loader after
/// network work.
pub fn ensure(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
) -> Result<EnsuredImage, CandidateError> {
    // Validate input, including registry admission, before touching runtime state; tags
    // are resolved after the engine preflight, and pinned references never make a
    // mutable resolution call.
    if reference.contains('@') {
        registry_image::pinned(reference, policy)?;
    } else {
        registry_image::tagged(reference, policy)?;
    }
    engine::info(candidate)?;
    let pinned = if reference.contains('@') {
        registry_image::pinned(reference, policy)?.canonical()
    } else {
        registry_image::resolve(reference, policy)?.pinned_reference
    };
    ensure_pinned(
        candidate,
        &pinned,
        policy,
        |reference, path, limit| registry_image::acquire(reference, path, policy, limit),
        |candidate, path, sha, image| {
            image_load::load_with(candidate, path, sha, image, policy).map(|_| ())
        },
    )
}
fn ensure_pinned(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    acquire: impl FnOnce(&str, &Path, u64) -> Result<registry_image::AcquiredImage, CandidateError>,
    load: impl FnOnce(&Candidate, &Path, &str, &str) -> Result<(), CandidateError>,
) -> Result<EnsuredImage, CandidateError> {
    let reference = canonical(reference)?;
    let root = candidate.state_root.join("artifacts/images");
    let _lock = state::Lock::acquire(&root)?;
    let (count, bytes) = usage(candidate, &root)?;
    let dir = root.join(key(&reference));
    let reused = dir.try_exists().map_err(state::io)?;
    let receipt = if reused {
        inspect_entry(candidate, &dir, &reference)?
    } else {
        let limit = policy
            .archive_limit
            .min(policy.cache_limit.saturating_sub(bytes));
        if count >= MAX_ARCHIVES || limit < MIN_SLOT {
            return Err(refused(
                "Image cache admission requires a free slot within 64 archives and the configured cache budget; no automatic deletion.",
            ));
        }
        state::private_directory(&dir)?;
        let acquired = match acquire(&reference, &dir.join("image.tar"), limit) {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir(&dir);
                return Err(error);
            }
        };
        let (_, pin) = registry_image::pinned_syntax(&reference)?;
        if acquired.source_digest != pin.as_str() || acquired.archive_bytes > limit {
            return Err(refused(
                "Acquired image does not match the requested immutable reference.",
            ));
        }
        let receipt = CacheReceipt {
            version: 1,
            checkout: candidate.checkout.clone(),
            reference: reference.clone(),
            archive_sha256: acquired.archive_sha256,
            image_id: acquired.image_id,
            archive_bytes: acquired.archive_bytes,
        };
        receipt.validate(candidate, &reference)?;
        if archive_size(&dir.join("image.tar"))? != receipt.archive_bytes {
            return Err(refused("New archive differs from its acquisition receipt."));
        }
        state::write(&dir.join("receipt.json"), &receipt)?;
        receipt
    };
    // Even a warm cache goes through the loader's hash, ownership, validation receipt,
    // and content-ID/architecture readback; cached metadata alone never proves import.
    load(
        candidate,
        &dir.join("image.tar"),
        &receipt.archive_sha256,
        &receipt.image_id,
    )?;
    Ok(EnsuredImage {
        pinned_reference: reference,
        image_id: receipt.image_id,
        archive_sha256: receipt.archive_sha256,
        archive_reused: reused,
        phase: "content-id-verified",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };
    struct Fixture(PathBuf, Candidate);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "hkg-image-ensure-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let candidate = Candidate::discover(&root).unwrap();
            Self(root, candidate)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn pin(n: usize) -> String {
        format!("docker.io/fixture/image@sha256:{n:064x}")
    }
    fn acquire(
        reference: &str,
        path: &Path,
        _limit: u64,
    ) -> Result<registry_image::AcquiredImage, CandidateError> {
        fs::write(path, b"fixture").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        Ok(registry_image::AcquiredImage {
            source_digest: registry_image::pinned_syntax(reference)?.1,
            manifest_digest: format!("sha256:{}", "b".repeat(64)),
            image_id: format!("sha256:{}", "c".repeat(64)),
            archive_sha256: key("fixture"),
            archive_bytes: 7,
        })
    }
    #[test]
    fn warm_pin_reuses_archive_but_always_invokes_existing_loader() {
        let f = Fixture::new();
        let acquired = Cell::new(0);
        let loaded = Cell::new(0);
        for warm in [false, true] {
            let result = ensure_pinned(
                &f.1,
                &pin(1),
                &ImagePolicy::default(),
                |reference, path, limit| {
                    acquired.set(acquired.get() + 1);
                    acquire(reference, path, limit)
                },
                |_, path, sha, image| {
                    loaded.set(loaded.get() + 1);
                    assert_eq!(fs::read(path).unwrap(), b"fixture");
                    assert_eq!(sha, key("fixture"));
                    assert_eq!(image, format!("sha256:{}", "c".repeat(64)));
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(result.archive_reused, warm);
        }
        assert_eq!(acquired.get(), 1);
        assert_eq!(loaded.get(), 2);
    }
    #[test]
    fn cache_count_budget_refuses_without_deleting_existing_archives() {
        let f = Fixture::new();
        for n in 0..MAX_ARCHIVES {
            ensure_pinned(
                &f.1,
                &pin(n),
                &ImagePolicy::default(),
                acquire,
                |_, _, _, _| Ok(()),
            )
            .unwrap();
        }
        let error = ensure_pinned(
            &f.1,
            &pin(99),
            &ImagePolicy::default(),
            |_, _, _| panic!("must not acquire"),
            |_, _, _, _| panic!("must not load"),
        )
        .unwrap_err();
        assert!(error.message.contains("64 archives"));
        assert_eq!(
            usage(&f.1, &f.1.state_root.join("artifacts/images")).unwrap(),
            (64, 448)
        );
    }
    #[test]
    fn aggregate_byte_budget_bounds_each_acquisition_and_refuses_a_full_cache_without_pruning() {
        let f = Fixture::new();
        let slot = 4 * MIN_SLOT;
        let policy = ImagePolicy {
            archive_limit: slot,
            cache_limit: 2 * slot + MIN_SLOT / 2,
            ..ImagePolicy::default()
        };
        let mut limits = Vec::new();
        for n in 0..2 {
            let reference = pin(n);
            ensure_pinned(
                &f.1,
                &reference,
                &policy,
                |reference, path, limit| {
                    limits.push(limit);
                    acquire(reference, path, limit)
                },
                |_, _, _, _| Ok(()),
            )
            .unwrap();
            let dir =
                f.1.state_root
                    .join("artifacts/images")
                    .join(key(&reference));
            fs::OpenOptions::new()
                .write(true)
                .open(dir.join("image.tar"))
                .unwrap()
                .set_len(slot)
                .unwrap();
            let mut receipt = read_receipt(&dir.join("receipt.json")).unwrap();
            receipt.archive_bytes = slot;
            state::write(&dir.join("receipt.json"), &receipt).unwrap();
        }
        // Each acquisition is offered the per-image budget or the cache's remainder.
        assert_eq!(limits, [slot, slot]);
        assert_eq!(
            usage(&f.1, &f.1.state_root.join("artifacts/images")).unwrap(),
            (2, 2 * slot)
        );
        assert!(
            ensure_pinned(
                &f.1,
                &pin(99),
                &policy,
                |_, _, _| panic!("budget refuses fetch"),
                |_, _, _, _| panic!("no load")
            )
            .is_err()
        );
        // Budgets below the recorded entries keep them readable: cache admission does not
        // reject them, and the loader applies its own per-image budget on import.
        let lowered = ImagePolicy {
            archive_limit: 2 * MIN_SLOT,
            cache_limit: 2 * MIN_SLOT,
            ..ImagePolicy::default()
        };
        assert!(
            ensure_pinned(
                &f.1,
                &pin(0),
                &lowered,
                |_, _, _| panic!("reuse"),
                |_, _, _, _| Ok(())
            )
            .unwrap()
            .archive_reused
        );
        // A larger cache budget offers only its remainder, and an acquisition that
        // reports more than it was offered is refused rather than recorded;
        // its unreceipted slot is left for explicit inspection.
        let wider = ImagePolicy {
            cache_limit: 2 * slot + 2 * MIN_SLOT,
            ..policy.clone()
        };
        let error = ensure_pinned(
            &f.1,
            &pin(98),
            &wider,
            |reference, path, limit| {
                assert_eq!(limit, 2 * MIN_SLOT);
                let mut acquired = acquire(reference, path, limit)?;
                acquired.archive_bytes = limit + 1;
                Ok(acquired)
            },
            |_, _, _, _| panic!("no load"),
        )
        .unwrap_err();
        assert_eq!(error.code, "image_cache");
    }
    #[test]
    fn conflicting_and_unreceipted_cache_entries_refuse_before_load() {
        let f = Fixture::new();
        let reference = pin(1);
        ensure_pinned(
            &f.1,
            &reference,
            &ImagePolicy::default(),
            acquire,
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        let dir =
            f.1.state_root
                .join("artifacts/images")
                .join(key(&reference));
        fs::write(dir.join("image.tar"), b"changed length").unwrap();
        assert!(
            ensure_pinned(
                &f.1,
                &reference,
                &ImagePolicy::default(),
                |_, _, _| panic!("no acquire"),
                |_, _, _, _| panic!("no load")
            )
            .is_err()
        );
        fs::remove_file(dir.join("receipt.json")).unwrap();
        assert!(
            ensure_pinned(
                &f.1,
                &reference,
                &ImagePolicy::default(),
                |_, _, _| panic!("no acquire"),
                |_, _, _, _| panic!("no load")
            )
            .is_err()
        );
        assert_eq!(fs::read(dir.join("image.tar")).unwrap(), b"changed length");
    }
    #[test]
    fn acquisition_failure_removes_only_its_empty_new_slot_and_preserves_import_failure() {
        let f = Fixture::new();
        let reference = pin(1);
        assert!(
            ensure_pinned(
                &f.1,
                &reference,
                &ImagePolicy::default(),
                |_, _, _| Err(refused("synthetic fetch failure")),
                |_, _, _, _| panic!("no load")
            )
            .is_err()
        );
        assert!(
            !f.1.state_root
                .join("artifacts/images")
                .join(key(&reference))
                .exists()
        );
        assert!(
            ensure_pinned(
                &f.1,
                &reference,
                &ImagePolicy::default(),
                acquire,
                |_, _, _, _| Err(refused("synthetic import failure"))
            )
            .is_err()
        );
        let receipt = ensure_pinned(
            &f.1,
            &reference,
            &ImagePolicy::default(),
            |_, _, _| panic!("reuse complete archive"),
            |_, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(receipt.archive_reused);
    }
    #[test]
    fn invalid_input_or_absent_runtime_never_allocates_archive_cache() {
        let f = Fixture::new();
        let policy = ImagePolicy::default();
        assert!(ensure(&f.1, "untrusted/thing:bad tag", &policy).is_err());
        assert!(ensure(&f.1, &pin(1), &policy).is_err());
        assert!(ensure(&f.1, "fixture/image:latest", &policy).is_err());
        // Docker Hub shorthand and other registries pass reference admission and stop at
        // the absent runtime; a local registry that is not allowed refuses before any
        // runtime check.
        for admitted in [
            "alpine:3.21",
            "ghcr.io/fixture/image:1",
            "registry.test:5000/a/b/c:1",
        ] {
            assert_ne!(
                ensure(&f.1, admitted, &policy).unwrap_err().code,
                "registry_image",
                "{admitted}"
            );
        }
        for local in [
            "localhost:5000/fixture:1",
            "127.0.0.1:5000/fixture:1",
            "registry:5000/fixture:1",
        ] {
            assert_eq!(
                ensure(&f.1, local, &policy).unwrap_err().code,
                "registry_image",
                "{local}"
            );
        }
        assert!(!f.1.state_root.join("artifacts/images").exists());
    }
    #[test]
    fn symlink_receipt_is_not_followed() {
        let f = Fixture::new();
        let root = f.0.join("entry");
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink("/dev/zero", root.join("receipt.json")).unwrap();
        assert!(read_receipt(&root.join("receipt.json")).is_err());
    }
}
