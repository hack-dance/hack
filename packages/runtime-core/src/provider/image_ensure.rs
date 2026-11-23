//! Candidate-owned bounded image acquisition cache; import remains image_load's operation.
use super::image_platform::{ImagePlatform, PlatformPolicy};
use super::{
    engine, image_load,
    image_policy::{ARCHIVE_CEILING, CACHE_CEILING, ImagePolicy, ImageTagMode},
    image_tag_store::{self, TagSource},
    lifecycle, registry_image, state,
};
use crate::timings::{Step, measure, measure_attributed};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
};
/// Content-addressed archives one candidate's cache may hold.
const MAX_ARCHIVES: usize = 64;
/// A new slot needs at least this much remaining cache budget.
const MIN_SLOT: u64 = 1024 * 1024;
const IMAGE_WORKERS: usize = 3;

#[derive(Default)]
struct CacheState {
    lease: Option<state::Lock>,
    reservations: BTreeMap<String, u64>,
    disk_reserved: u64,
}

#[derive(Default)]
struct ImageCache {
    state: Mutex<CacheState>,
    changed: Condvar,
    importer: Mutex<()>,
    pins: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
}

impl ImageCache {
    fn reserve_disk(
        &self,
        needed: u64,
        available: impl Fn() -> Result<u64, CandidateError>,
    ) -> Result<DiskReservation<'_>, CandidateError> {
        let mut cache = self.state.lock().unwrap();
        loop {
            if available()?.saturating_sub(cache.disk_reserved) >= needed {
                cache.disk_reserved += needed;
                return Ok(DiskReservation {
                    cache: self,
                    bytes: needed,
                });
            }
            if cache.disk_reserved == 0 {
                return Err(CandidateError::new(
                    "image_disk_space",
                    "The image archive and its temporary layer exceed available disk space.",
                ));
            }
            cache = self.changed.wait(cache).unwrap();
        }
    }

    fn enter(&self, root: &Path) -> Result<MutexGuard<'_, CacheState>, CandidateError> {
        let mut cache = self.state.lock().unwrap();
        if cache.lease.is_none() {
            let lease = lifecycle::startup_lease(root, lifecycle::STARTUP_LEASE_WAIT)?;
            let staging = root.with_file_name("image-staging");
            if staging.try_exists().map_err(state::io)? {
                clean_staging(&staging, 0)?;
            }
            cache.lease = Some(lease);
        }
        cache.lease.as_ref().unwrap().verify_path(root)?;
        Ok(cache)
    }
}

struct DiskReservation<'a> {
    cache: &'a ImageCache,
    bytes: u64,
}
impl Drop for DiskReservation<'_> {
    fn drop(&mut self) {
        self.cache.state.lock().unwrap().disk_reserved -= self.bytes;
        self.cache.changed.notify_all();
    }
}

fn disk_available(path: &Path) -> Result<u64, CandidateError> {
    const RESERVE: u64 = 512 * 1024 * 1024;
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| refused("Invalid image staging path."))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: The path is terminated and stat points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(state::io(std::io::Error::last_os_error()));
    }
    // SAFETY: statvfs initialized the buffer on success.
    let stat = unsafe { stat.assume_init() };
    let bytes = u64::try_from((stat.f_bavail as u128) * (stat.f_frsize as u128))
        .map_err(|_| refused("Invalid image disk headroom."))?;
    Ok(bytes.saturating_sub(RESERVE))
}

fn generated_sequence(name: &str) -> bool {
    name.split_once('-').is_some_and(|(pid, sequence)| {
        pid.parse::<u32>()
            .is_ok_and(|value| value > 0 && value.to_string() == pid)
            && sequence
                .parse::<u64>()
                .is_ok_and(|value| value.to_string() == sequence)
    })
}

fn clean_staging(path: &Path, level: u8) -> Result<(), CandidateError> {
    if !path.try_exists().map_err(state::io)? {
        return Ok(());
    }
    state::check_private_directory(path)?;
    for entry in fs::read_dir(path).map_err(state::io)? {
        let entry = entry.map_err(state::io)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let metadata = fs::symlink_metadata(entry.path()).map_err(state::io)?;
        if metadata.uid() != current_uid() {
            continue;
        }
        let generated_dir = (level == 0 && hex(&name))
            || (level == 1
                && name
                    .strip_prefix("attempt-")
                    .is_some_and(generated_sequence));
        if generated_dir && metadata.is_dir() && metadata.mode() & 0o077 == 0 {
            clean_staging(&entry.path(), level + 1)?;
        }
        let generated_file = matches!(&*name, "image.tar" | "receipt.json" | "receipt.pending")
            || [".hack-image-", ".hack-layer-"].iter().any(|prefix| {
                name.strip_prefix(prefix)
                    .and_then(|tail| tail.strip_suffix(".tmp"))
                    .is_some_and(generated_sequence)
            });
        if level > 0 && generated_file && metadata.is_file() {
            fs::remove_file(entry.path()).map_err(state::io)?;
        }
    }
    match fs::remove_dir(path) {
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        result => result.map_err(state::io),
    }
}

fn create_staging(root: &Path, reference: &str) -> Result<PathBuf, CandidateError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let key_dir = root.with_file_name("image-staging").join(key(reference));
    state::private_directory(&key_dir)?;
    loop {
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let attempt = key_dir.join(format!("attempt-{}-{sequence}", std::process::id()));
        match fs::DirBuilder::new().mode(0o700).create(&attempt) {
            Ok(()) => return Ok(attempt),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(state::io(error)),
        }
    }
}

struct Reservation<'a> {
    cache: &'a ImageCache,
    key: String,
    path: PathBuf,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let _ = clean_staging(&self.path, 2);
        if let Some(key_dir) = self.path.parent() {
            let _ = fs::remove_dir(key_dir);
        }
        self.cache
            .state
            .lock()
            .unwrap()
            .reservations
            .remove(&self.key);
        self.cache.changed.notify_all();
    }
}
fn refused(message: impl Into<crate::ErrorMessage>) -> CandidateError {
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
    format!("{:x}", crate::Hex(Sha256::digest(value.as_bytes())))
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
                "Image cache permits 64 content-addressed archives; unexpected entries refuse admission.",
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
        if bytes > CACHE_CEILING {
            return Err(refused(
                "Image cache exceeds its fixed ceiling; no files were removed.",
            ));
        }
    }
    Ok((count, bytes))
}
/// Evict one verified cache entry at the slot limit, under both the cache lease
/// and the graph inventory lease. The rename leaves a complete active inventory
/// even if the process stops before unlinking the retired archive.
fn free_archive_slot(
    candidate: &Candidate,
    root: &Path,
    coordinator: &ImageCache,
) -> Result<u64, CandidateError> {
    let _graph_lease = lifecycle::graph_inventory_lease(candidate)?;
    let referenced = super::image_build::reclaim::referenced_images(candidate)?;
    let pins = coordinator.pins.lock().unwrap();
    let mut oldest = None;
    for entry in fs::read_dir(root).map_err(state::io)? {
        let entry = entry.map_err(state::io)?;
        if entry.file_name() == "operation.lock" {
            continue;
        }
        let dir = entry.path();
        let receipt_path = dir.join("receipt.json");
        let receipt = read_receipt(&receipt_path)?;
        let (_, pin) = registry_image::pinned_syntax(&receipt.reference)?;
        // A worker can validate or import with the coordinator state unlocked.
        // A new worker cannot enter that state until this eviction finishes.
        if referenced.contains(&receipt.image_id)
            || referenced.contains(pin.as_str())
            || pins
                .get(&receipt.reference)
                .is_some_and(|held| held.try_lock().is_err())
        {
            continue;
        }
        let modified = fs::metadata(&receipt_path)
            .and_then(|metadata| metadata.modified())
            .map_err(state::io)?;
        let key = (modified, dir, receipt.archive_bytes);
        if oldest.as_ref().is_none_or(|prior| &key < prior) {
            oldest = Some(key);
        }
    }
    let (_, victim, bytes) = oldest.ok_or_else(|| {
        refused(
            "Image cache has 64 archives and every archive is referenced by retained graph state or in use.",
        )
    })?;
    let parent = root
        .parent()
        .ok_or_else(|| refused("Archive cache parent is missing."))?;
    let retired = parent.join(".image-archive-retired");
    remove_retired_archive(&retired)?;
    fs::rename(victim, &retired).map_err(state::io)?;
    sync_directory(root)?;
    sync_directory(parent)?;
    remove_retired_archive(&retired)?;
    sync_directory(parent)?;
    Ok(bytes)
}

fn sync_directory(path: &Path) -> Result<(), CandidateError> {
    fs::File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(state::io)
}

fn remove_retired_archive(path: &Path) -> Result<(), CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(state::io(error)),
        Ok(_) => state::check_private_directory(path)?,
    }
    // With the cache lease held a prior unlink may already have removed either
    // of these files. Check both before removing either, and preserve unknown files.
    let mut files = Vec::new();
    for entry in fs::read_dir(path).map_err(state::io)?.take(3) {
        let entry = entry.map_err(state::io)?;
        let file = entry.path();
        match entry.file_name().to_str() {
            Some("image.tar") => {
                archive_size(&file)?;
            }
            Some("receipt.json") => {
                read_receipt(&file)?;
            }
            _ => {
                return Err(refused(
                    "Unknown retired archive cache files; no files were removed.",
                ));
            }
        }
        files.push(file);
    }
    for file in files {
        fs::remove_file(file).map_err(state::io)?;
    }
    fs::remove_dir(path).map_err(state::io)
}

#[derive(Debug, Serialize)]
pub struct EnsuredTag {
    pub reference: String,
    pub registry: String,
    pub source_digest: String,
    pub resolved_at_unix_seconds: u64,
    pub source: TagSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EnsuredImage {
    pub pinned_reference: String,
    pub image_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    pub archive_reused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_resolution: Option<EnsuredTag>,
    pub phase: &'static str,
    /// The platform loaded; `linux/amd64` runs only under the pool's x86_64 translation.
    pub platform: ImagePlatform,
}
fn manifest_path(candidate: &Candidate, pin: &str, policy: PlatformPolicy) -> PathBuf {
    let address = key(&format!("{pin}\n{policy:?}"));
    candidate
        .state_root
        .join("artifacts/image-proofs")
        .join(format!("{address}.json"))
}

pub(super) fn recorded_proof(
    candidate: &Candidate,
    pin: &str,
    policy: PlatformPolicy,
) -> Result<Option<registry_image::ManifestProof>, CandidateError> {
    let path = manifest_path(candidate, pin, policy);
    reject_aliased_state(
        path.parent()
            .ok_or_else(|| refused("Image proof parent is missing."))?,
    )?;
    match fs::symlink_metadata(&path) {
        Ok(_) => state::read_bounded(&path, registry_image::MANIFEST_PROOF_LIMIT).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(state::io(error)),
    }
}

pub(super) fn publish_proof(
    candidate: &Candidate,
    pin: &str,
    platform: PlatformPolicy,
    proof: &registry_image::ManifestProof,
) -> Result<(), CandidateError> {
    let path = manifest_path(candidate, pin, platform);
    let parent = path
        .parent()
        .ok_or_else(|| refused("Image proof parent is missing."))?;
    let lock = lifecycle::startup_lease(parent, lifecycle::STARTUP_LEASE_WAIT)?;
    let pending = path.with_extension("pending");
    match fs::symlink_metadata(&pending) {
        Ok(metadata)
            if metadata.is_file()
                && metadata.uid() == current_uid()
                && metadata.nlink() == 1
                && metadata.mode() & 0o077 == 0 =>
        {
            lock.verify_path(parent)?;
            fs::remove_file(pending).map_err(state::io)?;
        }
        Ok(_) => {
            let name = pending.file_name().unwrap().to_string_lossy();
            let location = format!("artifacts/image-proofs/{name}");
            return Err(CandidateError::new(
                "image_proof_pending",
                format!("Unsafe pending image proof at {location} was left in place."),
            )
            .with_state_component(&location));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(state::io(error)),
    }
    if path.try_exists().map_err(state::io)? {
        return Ok(());
    }
    state::write_before_rename(&path, proof, &|| lock.verify_path(parent))
}

fn check_registry_config(
    receipt: &CacheReceipt,
    selected: ImagePlatform,
    config: &str,
) -> Result<(), CandidateError> {
    if receipt.platform != selected || receipt.image_id != config {
        return Err(refused(
            "Cached image differs from the verified registry configuration.",
        ));
    }
    Ok(())
}

/// Resolve tags on every call, reuse their exact immutable archive when available,
/// Select a tag resolution, reuse its exact immutable archive when available,
/// and validate/import via the owned guest's existing loader. The engine must already
/// be running before acquisition. A cache miss acquires at most the policy's per-image
/// budget and the cache's remaining budget (at most 64 archives); an image whose
/// manifest exceeds that refuses before any layer transfer. At 64 archives, an
/// online miss can retire the oldest archive unreferenced by retained graph state. Runtime ownership is checked again by the loader after
/// network work.
pub fn ensure(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
) -> Result<EnsuredImage, CandidateError> {
    ensure_with(candidate, reference, policy, PlatformPolicy::Native)
}

/// [`ensure`] under an explicit platform policy. `Native` is the default and admits only
/// Linux arm64. An opted-in policy may select Linux amd64, which is cached separately and
/// imported only into a pool booted with x86_64 translation (`image_load::load_cached`).
pub fn ensure_with(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
) -> Result<EnsuredImage, CandidateError> {
    timed_acquire(
        Step::ImageEnsure,
        candidate,
        reference,
        policy,
        platform,
        true,
        (&ImageCache::default(), None),
    )
}

/// Distinct references can prepare archives together. Only the existing loader imports.
pub fn ensure_batch(
    candidate: &Candidate,
    jobs: &[(String, PlatformPolicy)],
    policy: &ImagePolicy,
) -> Vec<(usize, Result<EnsuredImage, CandidateError>, u64)> {
    let cache = ImageCache::default();
    let queue = std::sync::atomic::AtomicUsize::new(0);
    let finished = Mutex::new(Vec::with_capacity(jobs.len()));
    std::thread::scope(|scope| {
        for _ in 0..IMAGE_WORKERS.min(jobs.len()) {
            scope.spawn(|| {
                loop {
                    let index = queue.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some((reference, platform)) = jobs.get(index) else {
                        break;
                    };
                    let report =
                        std::env::var("HACK_INTERNAL_REPORT_IMAGE_WAIT").as_deref() == Ok("batch");
                    if report {
                        eprintln!("hack.image-wait:working {index}");
                    }
                    let started = std::time::Instant::now();
                    let result = timed_acquire(
                        Step::ImageEnsure,
                        candidate,
                        reference,
                        policy,
                        *platform,
                        true,
                        (&cache, Some(index)),
                    );
                    if report {
                        eprintln!("hack.image-wait:finished {index}");
                    }
                    finished.lock().unwrap().push((
                        index,
                        result,
                        started.elapsed().as_millis() as u64,
                    ));
                }
            });
        }
    });
    finished.into_inner().unwrap()
}

pub use super::image_tag_store::{present as present_tags, status as tag_status};

/// Resolve and verify an archive for `hack pull` without requiring a running guest.
pub fn cache(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
) -> Result<EnsuredImage, CandidateError> {
    timed_acquire(
        Step::ImageCache,
        candidate,
        reference,
        policy,
        platform,
        false,
        (&ImageCache::default(), None),
    )
}

fn timed_acquire(
    step: Step,
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    import: bool,
    (cache, index): (&ImageCache, Option<usize>),
) -> Result<EnsuredImage, CandidateError> {
    measure_attributed(step, None, |_, attrs| {
        let (result, count) = registry_image::count_requests(|| {
            acquire_for_use(candidate, reference, policy, platform, import, cache)
        });
        attrs.registry_requests = Some(count);
        attrs.image_index = index.map(|index| index as u64);
        result
    })
}

fn acquire_for_use(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    import: bool,
    cache: &ImageCache,
) -> Result<EnsuredImage, CandidateError> {
    let content_id = reference.strip_prefix("sha256:").is_some_and(hex);
    if content_id && !import {
        return Err(refused("A local image ID requires live guest observation."));
    }
    // Validate input, including registry admission, before touching runtime state; tags
    // are resolved after the engine preflight, and pinned references never make a
    // mutable resolution call.
    if reference.contains('@') {
        registry_image::pinned(reference, policy)?;
    } else if !content_id {
        registry_image::tagged(reference, policy)?;
    }
    let observer = if import {
        Some(measure(
            Step::ImageEnginePreflight,
            None,
            |_| -> Result<_, CandidateError> {
                let observer = engine::Observer::connect(candidate)?;
                observer.info()?;
                Ok(observer)
            },
        )?)
    } else {
        None
    };
    if let Some(observer) = observer.as_ref().filter(|_| content_id) {
        let actual = observer.image(reference)?;
        let selected = platform
            .candidates()
            .iter()
            .find(|selected| {
                actual["Id"] == reference
                    && actual["Os"] == "linux"
                    && actual["Architecture"] == selected.architecture()
                    && (!selected.emulated() || observer.guest().amd64_emulation())
            })
            .ok_or_else(|| refused("Loaded image identity or architecture differs."))?;
        return Ok(EnsuredImage {
            pinned_reference: reference.to_owned(),
            image_id: reference.to_owned(),
            archive_sha256: None,
            archive_reused: false,
            tag_resolution: None,
            phase: "content-id-verified",
            platform: *selected,
        });
    }
    let mut tag = if reference.contains('@') {
        None
    } else {
        Some(image_tag_store::resolve(
            candidate,
            reference,
            policy,
            platform,
            observer.as_ref(),
        )?)
    };
    let previous = tag.as_mut().and_then(|tag| tag.previous_loaded.take());
    let result = acquire_selection(
        candidate,
        reference,
        policy,
        platform,
        observer.as_ref(),
        cache,
        tag,
    );
    match (result, previous) {
        (Err(error), Some(mut previous)) if error.code.starts_with("registry_") => {
            previous.fallback_reason = Some(image_tag_store::fallback_reason(&error));
            acquire_selection(
                candidate,
                reference,
                policy,
                platform,
                observer.as_ref(),
                cache,
                Some(*previous),
            )
        }
        (result, _) => result,
    }
}

fn acquire_selection(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    observer: Option<&engine::Observer<'_>>,
    cache: &ImageCache,
    mut tag: Option<image_tag_store::TagResolution>,
) -> Result<EnsuredImage, CandidateError> {
    let mut ensured = match tag.as_mut() {
        Some(tag) if observer.is_some() => tag.confirm(|tag| {
            confirm_selection(
                candidate,
                reference,
                policy,
                platform,
                observer,
                cache,
                Some(tag),
            )
        })?,
        _ => confirm_selection(
            candidate,
            reference,
            policy,
            platform,
            observer,
            cache,
            tag.as_ref(),
        )?,
    };
    if observer.is_none() {
        ensured.phase = "archive-verified";
    }
    ensured.tag_resolution = tag.map(|tag| EnsuredTag {
        reference: tag.record.reference,
        registry: tag.record.registry,
        source_digest: tag.source_digest,
        resolved_at_unix_seconds: tag.resolved_at_unix_seconds,
        source: tag.source,
        fallback_reason: tag.fallback_reason,
    });
    Ok(ensured)
}

fn confirm_selection(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    observer: Option<&engine::Observer<'_>>,
    cache: &ImageCache,
    tag: Option<&image_tag_store::TagResolution>,
) -> Result<EnsuredImage, CandidateError> {
    let requested_platform = platform;
    let (pinned, platform) = match &tag {
        Some(tag) => (
            tag.pinned_reference.clone(),
            PlatformPolicy::exact(tag.platform),
        ),
        None => (
            registry_image::pinned(reference, policy)?.canonical(),
            platform,
        ),
    };
    let offline = policy.tag_mode == ImageTagMode::Offline
        || tag
            .as_ref()
            .is_some_and(|tag| tag.source == TagSource::Offline);
    let no_archive = || {
        CandidateError::new(
            "image_archive_offline_missing",
            "Registry unavailable and the selected immutable image archive is unavailable locally.",
        )
    };
    let proof_policy = tag
        .as_ref()
        .map_or(requested_platform, |tag| tag.proof_policy);
    let recorded = recorded_proof(candidate, &pinned, proof_policy)?;
    let selection = recorded
        .as_ref()
        .map(|proof| {
            measure(Step::ImagePinVerify, None, |_| {
                proof.verified_config(&pinned, requested_platform)
            })
        })
        .transpose()?;
    if let Some(tag) = &tag
        && !selection
            .as_ref()
            .is_some_and(|(selected, config)| *selected == tag.platform && *config == tag.image_id)
    {
        return Err(refused(
            "The recorded tag differs from its digest-bound registry metadata.",
        ));
    }
    let platform = selection
        .as_ref()
        .map_or(platform, |(selected, _)| PlatformPolicy::exact(*selected));
    let guest_hit = match (observer, &selection) {
        (Some(observer), Some((selected, config))) => {
            image_load::observe_image(observer, config, *selected)?
        }
        _ => false,
    };
    let acquired_proof = std::cell::RefCell::new(None);
    let ensured = if let Some((selected, config)) = selection.as_ref().filter(|_| guest_hit) {
        let receipt_path = candidate
            .state_root
            .join("artifacts/images")
            .join(entry_key(&pinned, *selected))
            .join("receipt.json");
        let archive_sha256 = read_receipt(&receipt_path)
            .ok()
            .filter(|receipt| {
                receipt.validate(candidate, &pinned).is_ok()
                    && receipt.platform == *selected
                    && receipt.image_id == *config
            })
            .map(|receipt| receipt.archive_sha256);
        EnsuredImage {
            pinned_reference: pinned.clone(),
            image_id: config.clone(),
            archive_sha256,
            archive_reused: false,
            tag_resolution: None,
            phase: "content-id-verified",
            platform: *selected,
        }
    } else {
        if offline && observer.is_some() {
            return Err(no_archive());
        }
        ensure_pinned_coordinated(
            (candidate, cache),
            &pinned,
            policy,
            platform,
            |reference, platform| {
                if offline {
                    return Err(no_archive());
                }
                registry_image::pinned_platform(reference, policy, platform)
            },
            |reference, path, platform, limit| {
                if offline {
                    return Err(no_archive());
                }
                let mut acquired = registry_image::acquire_with_disk_admission(
                    reference,
                    path,
                    policy,
                    limit,
                    platform,
                    |needed| cache.reserve_disk(needed, || disk_available(path.parent().unwrap())),
                )?;
                *acquired_proof.borrow_mut() = acquired.proof.take();
                Ok(acquired)
            },
            |candidate, path, receipt, _| {
                let config = || {
                    if let Some((selected, config)) = &selection {
                        check_registry_config(receipt, *selected, config)?;
                        return Ok(config.clone());
                    }
                    if offline {
                        return Err(no_archive());
                    }
                    let proof = match acquired_proof.borrow_mut().take() {
                        Some(proof) => proof,
                        None => measure(Step::ImagePinVerify, None, |_| {
                            registry_image::resolve_pinned(
                                &receipt.reference,
                                policy,
                                requested_platform,
                            )
                            .map(|resolved| resolved.proof)
                        })?,
                    };
                    let (selected, config) =
                        proof.verified_config(&receipt.reference, requested_platform)?;
                    check_registry_config(receipt, selected, &config)?;
                    publish_proof(candidate, &receipt.reference, requested_platform, &proof)?;
                    Ok(config)
                };
                let Some(observer) = observer else {
                    config()?;
                    return image_load::validate_file_for(
                        path,
                        &receipt.archive_sha256,
                        &receipt.image_id,
                        policy,
                        receipt.platform,
                    )
                    .map(|_| ());
                };
                let archive = image_load::CachedArchive {
                    path,
                    sha: &receipt.archive_sha256,
                    image: &receipt.image_id,
                    bytes: receipt.archive_bytes,
                    pin: &receipt.reference,
                    platform: receipt.platform,
                    recorded_config: selection.as_ref().map(|(_, config)| config.as_str()),
                    require_present: offline,
                };
                image_load::load_cached(candidate, &archive, policy, observer, config).map(|_| ())
            },
        )?
    };
    Ok(ensured)
}
/// [`ensure_pinned_coordinated`] for a cache that must never need to resolve the published
/// platform: every case it covers has its preferred entry cached, or none.
#[cfg(test)]
fn ensure_pinned(
    candidate: &Candidate,
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    acquire: impl FnOnce(
        &str,
        &Path,
        PlatformPolicy,
        u64,
    ) -> Result<registry_image::AcquiredImage, CandidateError>,
    load: impl FnOnce(&Candidate, &Path, &str, &str, ImagePlatform) -> Result<(), CandidateError>,
) -> Result<EnsuredImage, CandidateError> {
    ensure_pinned_coordinated(
        (candidate, &ImageCache::default()),
        reference,
        policy,
        platform,
        |_, _| panic!("must not resolve the published platform"),
        acquire,
        |candidate, path, receipt, _| {
            load(
                candidate,
                path,
                &receipt.archive_sha256,
                &receipt.image_id,
                receipt.platform,
            )
        },
    )
}
/// Ensure one pinned reference under `platform`. `resolve` names the platform the pinned
/// image itself selects under a policy; it is consulted only when the cache holds a later
/// preference but not an earlier one.
fn ensure_pinned_coordinated(
    (candidate, coordinator): (&Candidate, &ImageCache),
    reference: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
    mut resolve: impl FnMut(&str, PlatformPolicy) -> Result<ImagePlatform, CandidateError>,
    acquire: impl FnOnce(
        &str,
        &Path,
        PlatformPolicy,
        u64,
    ) -> Result<registry_image::AcquiredImage, CandidateError>,
    load: impl FnOnce(&Candidate, &Path, &CacheReceipt, bool) -> Result<(), CandidateError>,
) -> Result<EnsuredImage, CandidateError> {
    let reference = canonical(reference)?;
    let root = candidate.state_root.join("artifacts/images");
    let pin = coordinator
        .pins
        .lock()
        .unwrap()
        .entry(reference.clone())
        .or_default()
        .clone();
    let _pin = pin.lock().unwrap();
    let mut state = coordinator.enter(&root)?;
    let inventory = || measure(Step::ImageCacheInventory, None, |_| usage(candidate, &root));
    let mut occupied = inventory()?;
    // A cached entry is reused only for the platform the pinned image itself selects under
    // the policy. The first preference is published whenever its entry exists. A later
    // preference's entry (amd64 under `PreferNative`, perhaps left by an explicit `Amd64`
    // acquisition) does not show the earlier one is absent, so the published platform is
    // resolved first; a published arm64 image is then acquired natively instead.
    let mut platform = platform;
    let mut existing = None;
    for (preference, candidate_platform) in platform.candidates().iter().enumerate() {
        let dir = root.join(entry_key(&reference, *candidate_platform));
        if !dir.try_exists().map_err(state::io)? {
            continue;
        }
        if preference > 0 {
            let published = resolve(&reference, platform)?;
            if !platform.candidates().contains(&published) {
                return Err(refused(
                    "Resolved image platform is outside the requested platform policy.",
                ));
            }
            if published != *candidate_platform {
                platform = PlatformPolicy::exact(published);
                break;
            }
        }
        existing = Some((dir, *candidate_platform));
        break;
    }
    let reused = existing.is_some();
    let (dir, receipt) = if let Some((dir, entry_platform)) = existing {
        let receipt = inspect_entry(candidate, &dir, &reference, entry_platform)?;
        drop(state);
        (dir, receipt)
    } else {
        let limit = loop {
            let (mut count, mut bytes) = occupied;
            let remaining = policy.cache_limit.saturating_sub(bytes);
            if remaining.min(policy.archive_limit) < MIN_SLOT
                || (count == MAX_ARCHIVES && policy.tag_mode == ImageTagMode::Offline)
            {
                return Err(refused(
                    "Image cache admission requires a free slot within 64 archives and the configured cache budget.",
                ));
            }
            if count == MAX_ARCHIVES {
                bytes -= free_archive_slot(candidate, &root, coordinator)?;
                count -= 1;
            }
            let limit = policy
                .archive_limit
                .min(policy.cache_limit.saturating_sub(bytes));
            let reserved: u64 = state.reservations.values().sum();
            if count + state.reservations.len() < MAX_ARCHIVES
                && policy.cache_limit.saturating_sub(bytes + reserved) >= limit
            {
                break limit;
            }
            state = coordinator.changed.wait(state).unwrap();
            occupied = inventory()?;
        };
        let staging = create_staging(&root, &reference)?;
        state.reservations.insert(reference.clone(), limit);
        let reservation = Reservation {
            cache: coordinator,
            key: reference.clone(),
            path: staging,
        };
        drop(state);
        let dir = &reservation.path;
        let acquired = acquire(&reference, &dir.join("image.tar"), platform, limit)?;
        if !platform.candidates().contains(&acquired.platform) {
            return Err(refused(
                "Acquired image platform is outside the requested platform policy.",
            ));
        }
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
            platform: acquired.platform,
        };
        receipt.validate(candidate, &reference)?;
        if archive_size(&dir.join("image.tar"))? != receipt.archive_bytes {
            return Err(refused("New archive differs from its acquisition receipt."));
        }
        state::write(&dir.join("receipt.json"), &receipt)?;
        inspect_entry(candidate, dir, &reference, acquired.platform)?;
        let state = coordinator.enter(&root)?;
        let target = root.join(entry_key(&reference, acquired.platform));
        if target.try_exists().map_err(state::io)? {
            return Err(refused(
                "Conflicting image cache entry; no entry was adopted or removed.",
            ));
        }
        fs::rename(dir, &target).map_err(state::io)?;
        fs::File::open(&root)
            .and_then(|dir| dir.sync_all())
            .map_err(state::io)?;
        drop(state);
        drop(reservation);
        (target, receipt)
    };
    // Keep the import lease and the loader’s own live recheck unchanged.
    let _import = coordinator.importer.lock().unwrap();
    load(candidate, &dir.join("image.tar"), &receipt, reused)?;
    Ok(EnsuredImage {
        pinned_reference: reference,
        image_id: receipt.image_id,
        archive_sha256: Some(receipt.archive_sha256),
        archive_reused: reused,
        tag_resolution: None,
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
        platform: PlatformPolicy,
        _limit: u64,
    ) -> Result<registry_image::AcquiredImage, CandidateError> {
        fs::write(path, b"fixture").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        Ok(registry_image::AcquiredImage {
            proof: None,
            source_digest: registry_image::pinned_syntax(reference)?.1,
            manifest_digest: format!("sha256:{}", "b".repeat(64)),
            image_id: format!("sha256:{}", "c".repeat(64)),
            archive_sha256: key("fixture"),
            archive_bytes: 7,
            platform: platform.candidates()[0],
        })
    }
    #[test]
    fn disk_budget_waits_for_the_current_fetch_and_refuses_an_oversized_archive() {
        let cache = ImageCache::default();
        let first = cache.reserve_disk(7, || Ok(10)).unwrap();
        std::thread::scope(|scope| {
            let (started, waiting) = std::sync::mpsc::channel();
            let cache = &cache;
            let second = scope.spawn(move || {
                cache
                    .reserve_disk(7, || {
                        let _ = started.send(());
                        Ok(10)
                    })
                    .unwrap()
            });
            waiting
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            assert!(!second.is_finished());
            drop(first);
            drop(second.join().unwrap());
        });
        let error = cache.reserve_disk(11, || Ok(10)).err().unwrap();
        assert_eq!(error.code, "image_disk_space");
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn stopped_proof_writer() {
        let file = PathBuf::from(std::env::var_os("HACK_TEST_PENDING_IMAGE_PROOF").unwrap());
        let _lock = state::Lock::acquire(file.parent().unwrap()).unwrap();
        let proof = registry_image::test_manifest_resolution().proof;
        state::write_before_rename(&file, &proof, &|| {
            fs::write(file.with_extension("synced"), b"ready").unwrap();
            loop {
                std::thread::park();
            }
        })
        .unwrap();
    }

    #[test]
    fn killed_proof_writer_can_be_replaced_after_pending_sync() {
        let f = Fixture::new();
        let path = manifest_path(&f.1, &pin(1), PlatformPolicy::Native);
        let mut child = super::super::process::spawn_child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "provider::image_ensure::tests::stopped_proof_writer",
                ])
                .env("HACK_TEST_PENDING_IMAGE_PROOF", &path)
                .stdout(std::process::Stdio::null()),
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !path.with_extension("synced").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(path.with_extension("synced").exists());
        assert!(path.with_extension("pending").exists());
        assert!(!path.exists());
        publish_proof(
            &f.1,
            &pin(1),
            PlatformPolicy::Native,
            &registry_image::test_manifest_resolution().proof,
        )
        .unwrap();
        assert!(
            recorded_proof(&f.1, &pin(1), PlatformPolicy::Native)
                .unwrap()
                .is_some()
        );
        assert!(!path.with_extension("pending").exists());
    }

    #[test]
    fn a_batch_reuses_staging_without_moving_or_deleting_stray_entries() {
        let f = Fixture::new();
        let root = f.1.state_root.join("artifacts/images");
        let staging = root.with_file_name("image-staging");
        let key_dir = staging.join(key(&pin(1)));
        let foreign = key_dir.join("foreign");
        state::private_directory(&foreign).unwrap();
        for path in [
            staging.join(".DS_Store"),
            key_dir.join(".DS_Store"),
            foreign.join(".hack-image-1-0.tmp"),
        ] {
            fs::write(path, b"stray").unwrap();
        }
        let leftover = key_dir.join(".hack-image-1-0.tmp");
        fs::write(&leftover, b"partial").unwrap();
        let attempt = key_dir.join("attempt-1-0");
        state::private_directory(&attempt).unwrap();
        fs::write(attempt.join(".hack-layer-1-0.tmp"), b"partial").unwrap();

        let cache = ImageCache::default();
        for id in [1, 2] {
            ensure_pinned_coordinated(
                (&f.1, &cache),
                &pin(id),
                &ImagePolicy::default(),
                PlatformPolicy::Native,
                |_, _| panic!("no platform lookup"),
                acquire,
                |_, _, _, _| Ok(()),
            )
            .unwrap();
        }
        assert_eq!(usage(&f.1, &root).unwrap(), (2, 14));
        for path in [
            staging.join(".DS_Store"),
            key_dir.join(".DS_Store"),
            foreign.join(".hack-image-1-0.tmp"),
        ] {
            assert_eq!(fs::read(path).unwrap(), b"stray");
        }
        assert!(!leftover.exists());
        assert!(!attempt.exists());
    }

    #[test]
    fn an_unsafe_pending_proof_names_the_preserved_entry() {
        let f = Fixture::new();
        let pending =
            manifest_path(&f.1, &pin(1), PlatformPolicy::Native).with_extension("pending");
        state::private_directory(&pending).unwrap();
        let failure = publish_proof(
            &f.1,
            &pin(1),
            PlatformPolicy::Native,
            &registry_image::test_manifest_resolution().proof,
        )
        .unwrap_err();
        assert_eq!(failure.code, "image_proof_pending");
        assert!(
            failure
                .message
                .contains(pending.file_name().unwrap().to_str().unwrap())
        );
        assert!(pending.is_dir());
    }

    #[test]
    fn next_cache_writer_recovers_staging_left_by_interrupt() {
        let f = Fixture::new();
        let root = f.1.state_root.join("artifacts/images");
        let staged = root.with_file_name("image-staging").join(key(&pin(1)));
        state::private_directory(&staged).unwrap();
        fs::write(staged.join(".hack-image-1-0.tmp"), b"fixture").unwrap();
        let coordinator = ImageCache::default();
        let _cache = coordinator.enter(&root).unwrap();
        assert!(!staged.exists());
        assert_eq!(usage(&f.1, &root).unwrap(), (0, 0));
    }

    #[test]
    fn a_failed_fetch_can_settle_while_another_verified_archive_imports() {
        let f = Fixture::new();
        let cache = ImageCache::default();
        let policy = ImagePolicy::default();
        let (fetching, started) = std::sync::mpsc::channel();
        let (importing, import_started) = std::sync::mpsc::channel();
        let timeout = std::time::Duration::from_secs(5);
        std::thread::scope(|scope| {
            let candidate = &f.1;
            let cache = &cache;
            let policy = &policy;
            let first = scope.spawn(move || {
                ensure_pinned_coordinated(
                    (candidate, cache),
                    &pin(1),
                    policy,
                    PlatformPolicy::Native,
                    |_, _| panic!("no platform lookup"),
                    |reference, path, platform, limit| {
                        started.recv_timeout(timeout).unwrap();
                        acquire(reference, path, platform, limit)
                    },
                    |_, _, _, _| {
                        importing.send(()).unwrap();
                        Ok(())
                    },
                )
            });
            let second = scope.spawn(move || {
                ensure_pinned_coordinated(
                    (candidate, cache),
                    &pin(2),
                    policy,
                    PlatformPolicy::Native,
                    |_, _| panic!("no platform lookup"),
                    |_, path, _, _| {
                        fetching.send(()).unwrap();
                        import_started.recv_timeout(timeout).unwrap();
                        fs::write(path, "partial").unwrap();
                        Err(refused("fixture acquisition failed"))
                    },
                    |_, _, _, _| panic!("a failed acquisition cannot import"),
                )
            });
            assert!(first.join().unwrap().is_ok());
            assert_eq!(
                second.join().unwrap().unwrap_err().message,
                "fixture acquisition failed"
            );
        });
        let root = f.1.state_root.join("artifacts");
        assert_eq!(fs::read_dir(root.join("image-staging")).unwrap().count(), 0);
        assert_eq!(usage(&f.1, &root.join("images")).unwrap(), (1, 7));
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
                PlatformPolicy::Native,
                |reference, path, platform, limit| {
                    acquired.set(acquired.get() + 1);
                    acquire(reference, path, platform, limit)
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
    fn fresh_tag_config_must_match_the_acquisition_receipt() {
        let f = Fixture::new();
        let resolved = registry_image::test_manifest_resolution();
        let receipt = CacheReceipt {
            version: 1,
            checkout: f.1.checkout.clone(),
            reference: resolved.pinned_reference.clone(),
            archive_sha256: "a".repeat(64),
            image_id: format!("sha256:{}", "e".repeat(64)),
            archive_bytes: 7,
            platform: ImagePlatform::LinuxArm64,
        };
        let refusal =
            check_registry_config(&receipt, ImagePlatform::LinuxArm64, &resolved.image_id)
                .err()
                .unwrap();
        assert_eq!(
            refusal.message,
            "Cached image differs from the verified registry configuration."
        );
        let matching = CacheReceipt {
            image_id: resolved.image_id.clone(),
            ..receipt
        };
        check_registry_config(&matching, ImagePlatform::LinuxArm64, &resolved.image_id).unwrap();
    }

    #[test]
    fn cache_receipt_at_the_wrong_platform_address_is_rejected() {
        let f = Fixture::new();
        let reference = pin(1);
        ensure_pinned(
            &f.1,
            &reference,
            &ImagePolicy::default(),
            PlatformPolicy::Amd64,
            acquire,
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        let root = f.1.state_root.join("artifacts/images");
        let correct = root.join(entry_key(&reference, ImagePlatform::LinuxAmd64));
        let wrong = root.join(entry_key(&reference, ImagePlatform::LinuxArm64));
        fs::rename(correct, &wrong).unwrap();
        let failure = inspect_entry(&f.1, &wrong, &reference, ImagePlatform::LinuxArm64)
            .err()
            .unwrap();
        assert_eq!(
            failure.message,
            "Image cache entry platform differs from its address."
        );
    }

    #[test]
    fn cache_count_retires_oldest_unreferenced_archive_at_64() {
        let f = Fixture::new();
        let root = f.1.state_root.join("artifacts/images");
        let slot = |n| root.join(entry_key(&pin(n), ImagePlatform::LinuxArm64));
        let coordinator = ImageCache::default();
        let cache = |reference| {
            ensure_pinned_coordinated(
                (&f.1, &coordinator),
                &pin(reference),
                &ImagePolicy::default(),
                PlatformPolicy::Native,
                |_, _| unreachable!(),
                acquire,
                |_, _, _, _| Ok(()),
            )
        };
        for n in 0..MAX_ARCHIVES {
            cache(n).unwrap();
            fs::File::open(slot(n).join("receipt.json"))
                .unwrap()
                .set_modified(
                    std::time::UNIX_EPOCH + std::time::Duration::from_secs(1000 + n as u64),
                )
                .unwrap();
        }

        let archived = f.1.state_root.join("run/native-graph-archive/fixture");
        state::private_directory(&archived).unwrap();
        let receipt = archived.join("state.json");
        fs::write(&receipt, pin(0)).unwrap();
        let importing = coordinator.pins.lock().unwrap()[&pin(1)].clone();
        let active_import = importing.lock().unwrap();
        cache(99).unwrap();
        assert!(slot(0).exists());
        assert!(slot(1).exists());
        assert!(!slot(2).exists());
        drop(active_import);
        assert!(slot(99).exists());
        assert_eq!(usage(&f.1, &root).unwrap(), (64, 448));

        // All fixture archives use the same content ID, so this protects every slot.
        let id = read_receipt(&slot(0).join("receipt.json"))
            .unwrap()
            .image_id;
        fs::write(&receipt, id).unwrap();
        assert!(
            cache(100)
                .unwrap_err()
                .message
                .contains("every archive is referenced")
        );
        assert!(!slot(100).exists());
        assert_eq!(usage(&f.1, &root).unwrap(), (64, 448));
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
                PlatformPolicy::Native,
                |reference, path, platform, limit| {
                    limits.push(limit);
                    acquire(reference, path, platform, limit)
                },
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
                PlatformPolicy::Native,
                |_, _, _, _| panic!("budget refuses fetch"),
                |_, _, _, _, _| panic!("no load")
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
                PlatformPolicy::Native,
                |_, _, _, _| panic!("reuse"),
                |_, _, _, _, _| Ok(())
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
            PlatformPolicy::Native,
            |reference, path, platform, limit| {
                assert_eq!(limit, 2 * MIN_SLOT);
                let mut acquired = acquire(reference, path, platform, limit)?;
                acquired.archive_bytes = limit + 1;
                Ok(acquired)
            },
            |_, _, _, _, _| panic!("no load"),
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
                &ImagePolicy::default(),
                PlatformPolicy::Native,
                |_, _, _, _| panic!("no acquire"),
                |_, _, _, _, _| panic!("no load")
            )
            .is_err()
        );
        fs::remove_file(dir.join("receipt.json")).unwrap();
        assert!(
            ensure_pinned(
                &f.1,
                &reference,
                &ImagePolicy::default(),
                PlatformPolicy::Native,
                |_, _, _, _| panic!("no acquire"),
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
                &ImagePolicy::default(),
                PlatformPolicy::Native,
                |_, _, _, _| Err(refused("synthetic fetch failure")),
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
                &ImagePolicy::default(),
                PlatformPolicy::Native,
                acquire,
                |_, _, _, _, _| Err(refused("synthetic import failure"))
            )
            .is_err()
        );
        let receipt = ensure_pinned(
            &f.1,
            &reference,
            &ImagePolicy::default(),
            PlatformPolicy::Native,
            |_, _, _, _| panic!("reuse complete archive"),
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(receipt.archive_reused);
    }
    #[test]
    fn emulated_platform_entries_are_separate_and_prefer_native_reuses_arm64_first() {
        let f = Fixture::new();
        let root = f.1.state_root.join("artifacts/images");
        let amd64_only = |reference: &str, path: &Path, policy: PlatformPolicy, limit: u64| {
            let mut acquired = acquire(reference, path, policy, limit)?;
            acquired.platform = ImagePlatform::LinuxAmd64;
            Ok(acquired)
        };
        // An amd64-only index acquired under PreferNative moves to its own amd64 address
        // and loads as amd64.
        let loaded = Cell::new(None);
        let result = ensure_pinned(
            &f.1,
            &pin(1),
            &ImagePolicy::default(),
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
            &ImagePolicy::default(),
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
            &ImagePolicy::default(),
            PlatformPolicy::PreferNative,
            |_, _, _, _| panic!("reuse complete archive"),
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
                &ImagePolicy::default(),
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
            &ImagePolicy::default(),
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
        let preferred = ensure_pinned_coordinated(
            (&f.1, &ImageCache::default()),
            &pin(1),
            &ImagePolicy::default(),
            PlatformPolicy::PreferNative,
            |reference, policy| {
                resolved.set(resolved.get() + 1);
                assert_eq!(reference, pin(1));
                assert_eq!(policy, PlatformPolicy::PreferNative);
                Ok(ImagePlatform::LinuxArm64)
            },
            |reference, path, policy, limit| {
                asked.set(Some(policy));
                acquire(reference, path, policy, limit)
            },
            |_, _, receipt, _| {
                assert_eq!(receipt.platform, ImagePlatform::LinuxArm64);
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
            &ImagePolicy::default(),
            PlatformPolicy::PreferNative,
            |_, _, _, _| panic!("reuse complete archive"),
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        assert!(warm.archive_reused);
        assert_eq!(warm.platform, ImagePlatform::LinuxArm64);

        // An amd64-only image resolves to amd64, so its cached entry is reused.
        ensure_pinned(
            &f.1,
            &pin(2),
            &ImagePolicy::default(),
            PlatformPolicy::Amd64,
            acquire,
            |_, _, _, _, _| Ok(()),
        )
        .unwrap();
        let reused = ensure_pinned_coordinated(
            (&f.1, &ImageCache::default()),
            &pin(2),
            &ImagePolicy::default(),
            PlatformPolicy::PreferNative,
            |_, _| Ok(ImagePlatform::LinuxAmd64),
            |_, _, _, _| panic!("reuse complete archive"),
            |_, _, receipt, _| {
                assert_eq!(receipt.platform, ImagePlatform::LinuxAmd64);
                Ok(())
            },
        )
        .unwrap();
        assert!(reused.archive_reused);
        assert_eq!(reused.platform, ImagePlatform::LinuxAmd64);
        // A failed resolution refuses before any acquisition or load.
        assert!(
            ensure_pinned_coordinated(
                (&f.1, &ImageCache::default()),
                &pin(2),
                &ImagePolicy::default(),
                PlatformPolicy::PreferNative,
                |_, _| Err(refused("synthetic resolution failure")),
                |_, _, _, _| panic!("no acquire"),
                |_, _, _, _| panic!("no load"),
            )
            .is_err()
        );
        assert_eq!(usage(&f.1, &root).unwrap().0, 3);
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
