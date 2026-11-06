//! Candidate-owned bounded image acquisition cache; import remains image_load's operation.
use super::image_platform::{ImagePlatform, PlatformPolicy};
use super::{engine, image_load, registry_image, state};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const MAX_ARCHIVES: usize = 16;
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_CACHE: u64 = 2 * 1024 * 1024 * 1024;
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
/// Cache address of one pinned reference for one platform. An arm64 entry keeps its original
/// address; an emulated platform of the same index is a separate entry, never a reuse.
fn entry_key(reference: &str, platform: ImagePlatform) -> String {
    match platform {
        ImagePlatform::LinuxArm64 => key(reference),
        ImagePlatform::LinuxAmd64 => key(&format!("{reference}\n{}", platform.name())),
    }
}
fn native(platform: &ImagePlatform) -> bool {
    *platform == ImagePlatform::LinuxArm64
}
fn canonical(value: &str) -> Result<String, CandidateError> {
    let (repo, pin) = registry_image::reference(value)?;
    Ok(format!("docker.io/{repo}@{pin}"))
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
    #[serde(default, skip_serializing_if = "native")]
    platform: ImagePlatform,
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
            || self.archive_bytes > MAX_ARCHIVE
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
        || m.len() > MAX_ARCHIVE
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
    platform: ImagePlatform,
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
    if receipt.platform != platform {
        return Err(refused(
            "Image cache entry platform differs from its address.",
        ));
    }
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
                "Image cache permits 16 content-addressed archives and 2 GiB total; unexpected entries refuse admission.",
            ));
        }
        let dir = entry.path();
        state::check_private_directory(&dir)?;
        let receipt: CacheReceipt = read_receipt(&dir.join("receipt.json"))?;
        if entry_key(&receipt.reference, receipt.platform) != name.to_string_lossy() {
            return Err(refused("Image cache address conflicts with its receipt."));
        }
        bytes = bytes
            .checked_add(
                inspect_entry(candidate, &dir, &receipt.reference, receipt.platform)?.archive_bytes,
            )
            .ok_or_else(|| refused("Image cache size overflow."))?;
        if bytes > MAX_CACHE {
            return Err(refused(
                "Image cache exceeds its 2 GiB budget; no files were removed.",
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
    /// The platform loaded; `linux/amd64` runs only under the pool's x86_64 translation.
    pub platform: ImagePlatform,
}
/// Resolve tags on every call, reuse their exact immutable archive when available,
/// and validate/import via the owned guest's existing loader. The engine must already
/// be running before acquisition. A cache miss reserves one 256 MiB slot within a
/// 16-archive/2 GiB budget; this operation never prunes or adopts conflicting files.
/// Runtime ownership is checked again by load_image after network work.
pub fn ensure(candidate: &Candidate, reference: &str) -> Result<EnsuredImage, CandidateError> {
    ensure_with(candidate, reference, PlatformPolicy::Native)
}

/// [`ensure`] under an explicit platform policy. `Native` is the default and admits only
/// Linux arm64. An opted-in policy may select Linux amd64, which is cached separately and
/// imported only into a pool booted with x86_64 translation (`image_load::load_for`).
pub fn ensure_with(
    candidate: &Candidate,
    reference: &str,
    policy: PlatformPolicy,
) -> Result<EnsuredImage, CandidateError> {
    // Validate input before touching runtime state; tags are checked by resolve after
    // the engine preflight, and pinned references never make a mutable resolution call.
    if reference.contains('@') {
        canonical(reference)?;
    } else {
        registry_image::tagged_reference(reference)?;
    }
    engine::info(candidate)?;
    let (pinned, policy) = if reference.contains('@') {
        (canonical(reference)?, policy)
    } else {
        // A tag resolves to one platform; the pinned entry is then that exact platform.
        let resolved = registry_image::resolve_with(reference, policy)?;
        let exact = match resolved.platform {
            "linux/amd64" => PlatformPolicy::Amd64,
            _ => PlatformPolicy::Native,
        };
        (resolved.pinned_reference, exact)
    };
    ensure_pinned_resolving(
        candidate,
        &pinned,
        policy,
        registry_image::pinned_platform,
        registry_image::acquire_with,
        |candidate, path, sha, image, platform| {
            image_load::load_for(candidate, path, sha, image, platform).map(|_| ())
        },
    )
}
/// [`ensure_pinned_resolving`] for a cache that must never need to resolve the published
/// platform: every case it covers has its preferred entry cached, or none.
#[cfg(test)]
fn ensure_pinned(
    candidate: &Candidate,
    reference: &str,
    policy: PlatformPolicy,
    acquire: impl FnOnce(
        &str,
        &Path,
        PlatformPolicy,
    ) -> Result<registry_image::AcquiredImage, CandidateError>,
    load: impl FnOnce(&Candidate, &Path, &str, &str, ImagePlatform) -> Result<(), CandidateError>,
) -> Result<EnsuredImage, CandidateError> {
    ensure_pinned_resolving(
        candidate,
        reference,
        policy,
        |_, _| panic!("must not resolve the published platform"),
        acquire,
        load,
    )
}
/// Ensure one pinned reference under `policy`. `resolve` names the platform the pinned image
/// itself selects under a policy; it is consulted only when the cache holds a later
/// preference but not an earlier one.
fn ensure_pinned_resolving(
    candidate: &Candidate,
    reference: &str,
    policy: PlatformPolicy,
    mut resolve: impl FnMut(&str, PlatformPolicy) -> Result<ImagePlatform, CandidateError>,
    acquire: impl FnOnce(
        &str,
        &Path,
        PlatformPolicy,
    ) -> Result<registry_image::AcquiredImage, CandidateError>,
    load: impl FnOnce(&Candidate, &Path, &str, &str, ImagePlatform) -> Result<(), CandidateError>,
) -> Result<EnsuredImage, CandidateError> {
    let reference = canonical(reference)?;
    let root = candidate.state_root.join("artifacts/images");
    let _lock = state::Lock::acquire(&root)?;
    let (count, bytes) = usage(candidate, &root)?;
    // A cached entry is reused only for the platform the pinned image itself selects under
    // the policy. The first preference is published whenever its entry exists. A later
    // preference's entry (amd64 under `PreferNative`, perhaps left by an explicit `Amd64`
    // acquisition) does not show the earlier one is absent, so the published platform is
    // resolved first; a published arm64 image is then acquired natively instead.
    let mut policy = policy;
    let mut existing = None;
    for (preference, platform) in policy.candidates().iter().enumerate() {
        let dir = root.join(entry_key(&reference, *platform));
        if !dir.try_exists().map_err(state::io)? {
            continue;
        }
        if preference > 0 {
            let published = resolve(&reference, policy)?;
            if !policy.candidates().contains(&published) {
                return Err(refused(
                    "Resolved image platform is outside the requested platform policy.",
                ));
            }
            if published != *platform {
                policy = PlatformPolicy::exact(published);
                break;
            }
        }
        existing = Some((dir, *platform));
        break;
    }
    let reused = existing.is_some();
    let (dir, receipt) = if let Some((dir, platform)) = existing {
        let receipt = inspect_entry(candidate, &dir, &reference, platform)?;
        (dir, receipt)
    } else {
        if count >= MAX_ARCHIVES || bytes > MAX_CACHE - MAX_ARCHIVE {
            return Err(refused(
                "Image cache admission requires a free 256 MiB slot within 16 archives and 2 GiB total; no automatic deletion.",
            ));
        }
        // Acquire into the first candidate's slot; a different confirmed platform moves the
        // complete entry to its own address below, still under the cache lock.
        let first = policy.candidates()[0];
        let mut dir = root.join(entry_key(&reference, first));
        state::private_directory(&dir)?;
        let acquired = match acquire(&reference, &dir.join("image.tar"), policy) {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir(&dir);
                return Err(error);
            }
        };
        if !policy.candidates().contains(&acquired.platform) {
            return Err(refused(
                "Acquired image platform is outside the requested platform policy.",
            ));
        }
        let (_, pin) = registry_image::reference(&reference)?;
        if acquired.source_digest != pin.as_str() {
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
            platform: acquired.platform,
        };
        receipt.validate(candidate, &reference)?;
        if archive_size(&dir.join("image.tar"))? != receipt.archive_bytes {
            return Err(refused("New archive differs from its acquisition receipt."));
        }
        state::write(&dir.join("receipt.json"), &receipt)?;
        if acquired.platform != first {
            let target = root.join(entry_key(&reference, acquired.platform));
            if target.try_exists().map_err(state::io)? {
                return Err(refused(
                    "Conflicting image cache entry; no entry was adopted or removed.",
                ));
            }
            fs::rename(&dir, &target).map_err(state::io)?;
            dir = target;
        }
        (dir, receipt)
    };
    // Even a warm cache goes through the loader's hash, ownership, validation receipt,
    // and content-ID/architecture readback; cached metadata alone never proves import.
    load(
        candidate,
        &dir.join("image.tar"),
        &receipt.archive_sha256,
        &receipt.image_id,
        receipt.platform,
    )?;
    Ok(EnsuredImage {
        pinned_reference: reference,
        image_id: receipt.image_id,
        archive_sha256: receipt.archive_sha256,
        archive_reused: reused,
        phase: "content-id-verified",
        platform: receipt.platform,
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
        policy: PlatformPolicy,
    ) -> Result<registry_image::AcquiredImage, CandidateError> {
        fs::write(path, b"fixture").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        Ok(registry_image::AcquiredImage {
            source_digest: registry_image::reference(reference)?.1,
            manifest_digest: format!("sha256:{}", "b".repeat(64)),
            image_id: format!("sha256:{}", "c".repeat(64)),
            archive_sha256: key("fixture"),
            archive_bytes: 7,
            platform: policy.candidates()[0],
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
                PlatformPolicy::Native,
                |reference, path, policy| {
                    acquired.set(acquired.get() + 1);
                    acquire(reference, path, policy)
                },
                |_, path, sha, image, _| {
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
                PlatformPolicy::Native,
                acquire,
                |_, _, _, _, _| Ok(()),
            )
            .unwrap();
        }
        let error = ensure_pinned(
            &f.1,
            &pin(99),
            PlatformPolicy::Native,
            |_, _, _| panic!("must not acquire"),
            |_, _, _, _, _| panic!("must not load"),
        )
        .unwrap_err();
        assert!(error.message.contains("16 archives"));
        assert_eq!(
            usage(&f.1, &f.1.state_root.join("artifacts/images")).unwrap(),
            (16, 112)
        );
    }
    #[test]
    fn aggregate_byte_budget_refuses_a_new_slot_without_pruning() {
        let f = Fixture::new();
        for n in 0..8 {
            let reference = pin(n);
            ensure_pinned(
                &f.1,
                &reference,
                PlatformPolicy::Native,
                acquire,
                |_, _, _, _, _| Ok(()),
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
                .set_len(MAX_ARCHIVE)
                .unwrap();
            let mut receipt = read_receipt(&dir.join("receipt.json")).unwrap();
            receipt.archive_bytes = MAX_ARCHIVE;
            state::write(&dir.join("receipt.json"), &receipt).unwrap();
        }
        assert_eq!(
            usage(&f.1, &f.1.state_root.join("artifacts/images")).unwrap(),
            (8, MAX_CACHE)
        );
        assert!(
            ensure_pinned(
                &f.1,
                &pin(99),
                PlatformPolicy::Native,
                |_, _, _| panic!("budget refuses fetch"),
                |_, _, _, _, _| panic!("no load")
            )
            .is_err()
        );
    }
    #[test]
    fn conflicting_and_unreceipted_cache_entries_refuse_before_load() {
        let f = Fixture::new();
        let reference = pin(1);
        ensure_pinned(
            &f.1,
            &reference,
            PlatformPolicy::Native,
            acquire,
            |_, _, _, _, _| Ok(()),
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
                PlatformPolicy::Native,
                |_, _, _| panic!("no acquire"),
                |_, _, _, _, _| panic!("no load")
            )
            .is_err()
        );
        fs::remove_file(dir.join("receipt.json")).unwrap();
        assert!(
            ensure_pinned(
                &f.1,
                &reference,
                PlatformPolicy::Native,
                |_, _, _| panic!("no acquire"),
                |_, _, _, _, _| panic!("no load")
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
                PlatformPolicy::Native,
                |_, _, _| Err(refused("synthetic fetch failure")),
                |_, _, _, _, _| panic!("no load")
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
                PlatformPolicy::Native,
                acquire,
                |_, _, _, _, _| Err(refused("synthetic import failure"))
            )
            .is_err()
        );
        let receipt = ensure_pinned(
            &f.1,
            &reference,
            PlatformPolicy::Native,
            |_, _, _| panic!("reuse complete archive"),
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(receipt.archive_reused);
    }
    #[test]
    fn emulated_platform_entries_are_separate_and_prefer_native_reuses_arm64_first() {
        let f = Fixture::new();
        let root = f.1.state_root.join("artifacts/images");
        let amd64_only = |reference: &str, path: &Path, policy: PlatformPolicy| {
            let mut acquired = acquire(reference, path, policy)?;
            acquired.platform = ImagePlatform::LinuxAmd64;
            Ok(acquired)
        };
        // An amd64-only index acquired under PreferNative moves to its own amd64 address
        // and loads as amd64.
        let loaded = Cell::new(None);
        let result = ensure_pinned(
            &f.1,
            &pin(1),
            PlatformPolicy::PreferNative,
            amd64_only,
            |_, _, _, _, platform| {
                loaded.set(Some(platform));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(result.platform, ImagePlatform::LinuxAmd64);
        assert_eq!(loaded.get(), Some(ImagePlatform::LinuxAmd64));
        assert!(!root.join(key(&pin(1))).exists());
        assert!(
            root.join(entry_key(&pin(1), ImagePlatform::LinuxAmd64))
                .exists()
        );
        // The native default never reuses or loads the emulated entry.
        let native = ensure_pinned(
            &f.1,
            &pin(1),
            PlatformPolicy::Native,
            acquire,
            |_, _, _, _, platform| {
                assert_eq!(platform, ImagePlatform::LinuxArm64);
                Ok(())
            },
        )
        .unwrap();
        assert!(!native.archive_reused);
        // With both entries present, PreferNative reuses arm64.
        let preferred = ensure_pinned(
            &f.1,
            &pin(1),
            PlatformPolicy::PreferNative,
            |_, _, _| panic!("reuse complete archive"),
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(preferred.archive_reused);
        assert_eq!(preferred.platform, ImagePlatform::LinuxArm64);
        assert_eq!(usage(&f.1, &root).unwrap().0, 2);
        // An acquisition outside the policy is refused.
        assert!(
            ensure_pinned(
                &f.1,
                &pin(2),
                PlatformPolicy::Native,
                amd64_only,
                |_, _, _, _, _| panic!("no load")
            )
            .is_err()
        );
    }
    #[test]
    fn prefer_native_resolves_the_published_platform_before_reusing_a_cached_amd64_entry() {
        let f = Fixture::new();
        let root = f.1.state_root.join("artifacts/images");
        // An explicit amd64 acquisition of a multi-platform index caches only amd64.
        let amd64 = ensure_pinned(
            &f.1,
            &pin(1),
            PlatformPolicy::Amd64,
            acquire,
            |_, _, _, _, platform| {
                assert_eq!(platform, ImagePlatform::LinuxAmd64);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(amd64.platform, ImagePlatform::LinuxAmd64);
        assert!(!root.join(key(&pin(1))).exists());
        // PreferNative resolves the index first: it publishes arm64, which is acquired
        // natively instead of reusing the emulated entry.
        let resolved = Cell::new(0);
        let asked = Cell::new(None);
        let preferred = ensure_pinned_resolving(
            &f.1,
            &pin(1),
            PlatformPolicy::PreferNative,
            |reference, policy| {
                resolved.set(resolved.get() + 1);
                assert_eq!(reference, pin(1));
                assert_eq!(policy, PlatformPolicy::PreferNative);
                Ok(ImagePlatform::LinuxArm64)
            },
            |reference, path, policy| {
                asked.set(Some(policy));
                acquire(reference, path, policy)
            },
            |_, _, _, _, platform| {
                assert_eq!(platform, ImagePlatform::LinuxArm64);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(resolved.get(), 1);
        assert_eq!(asked.get(), Some(PlatformPolicy::Native));
        assert!(!preferred.archive_reused);
        assert_eq!(preferred.platform, ImagePlatform::LinuxArm64);
        assert_eq!(usage(&f.1, &root).unwrap().0, 2);
        // With arm64 cached, nothing needs resolving.
        let warm = ensure_pinned(
            &f.1,
            &pin(1),
            PlatformPolicy::PreferNative,
            |_, _, _| panic!("reuse complete archive"),
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(warm.archive_reused);
        assert_eq!(warm.platform, ImagePlatform::LinuxArm64);

        // An amd64-only image resolves to amd64, so its cached entry is reused.
        ensure_pinned(
            &f.1,
            &pin(2),
            PlatformPolicy::Amd64,
            acquire,
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        let reused = ensure_pinned_resolving(
            &f.1,
            &pin(2),
            PlatformPolicy::PreferNative,
            |_, _| Ok(ImagePlatform::LinuxAmd64),
            |_, _, _| panic!("reuse complete archive"),
            |_, _, _, _, platform| {
                assert_eq!(platform, ImagePlatform::LinuxAmd64);
                Ok(())
            },
        )
        .unwrap();
        assert!(reused.archive_reused);
        assert_eq!(reused.platform, ImagePlatform::LinuxAmd64);
        // A failed resolution refuses before any acquisition or load.
        assert!(
            ensure_pinned_resolving(
                &f.1,
                &pin(2),
                PlatformPolicy::PreferNative,
                |_, _| Err(refused("synthetic resolution failure")),
                |_, _, _| panic!("no acquire"),
                |_, _, _, _, _| panic!("no load"),
            )
            .is_err()
        );
        assert_eq!(usage(&f.1, &root).unwrap().0, 3);
    }
    #[test]
    fn invalid_input_or_absent_runtime_never_allocates_archive_cache() {
        let f = Fixture::new();
        assert!(ensure(&f.1, "untrusted/thing:bad tag").is_err());
        assert!(ensure(&f.1, &pin(1)).is_err());
        assert!(ensure(&f.1, "fixture/image:latest").is_err());
        // Docker Hub shorthand passes reference admission and stops at the absent
        // runtime; an unacquirable registry refuses before any runtime check.
        assert_ne!(
            ensure(&f.1, "alpine:3.21").unwrap_err().code,
            "registry_image"
        );
        assert_eq!(
            ensure(&f.1, "ghcr.io/fixture/image:1").unwrap_err().code,
            "registry_image"
        );
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
