//! Explicit, bounded local image archives; no registry credentials or Docker contexts.
//!
//! An archive is validated in one streaming pass that also hashes every byte, so the
//! validated bytes are exactly the bytes whose SHA-256 the caller expected. The upload
//! to the engine re-reads the file through a reader that withholds its final bytes until
//! the complete stream has hashed to the same value; a file changed after validation
//! cannot complete an import. Memory use is bounded by small metadata members, not by
//! archive size.
use super::{engine::Engine, image_platform::ImagePlatform, image_policy::ImagePolicy, state};
use crate::{Candidate, CandidateError};
use flate2::read::MultiGzDecoder;
use reqwest::Method;
use ruzstd::decoding::{
    StreamingDecoder,
    errors::{FrameDecoderError, ReadFrameHeaderError},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Seek},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// Members at most this large whose content is raw JSON are retained for metadata checks.
const MAX_METADATA_MEMBER: u64 = 1024 * 1024;
/// Total retained metadata bytes per archive.
const MAX_RETAINED_METADATA: usize = 4 * 1024 * 1024;
/// Upload and import time allowed beyond the size-scaled transfer time.
const LOAD_BASE_TIMEOUT: Duration = Duration::from_secs(40);
/// Assumed slowest acceptable engine import rate when scaling the load timeout.
const LOAD_BYTES_PER_SECOND: u64 = 8 * 1024 * 1024;
/// Ceiling for one load request, so `ensure-image` stays inside its caller's bound.
const LOAD_MAX_TIMEOUT: Duration = Duration::from_secs(220);
/// Validation records a SHA-256 per block of this many archive bytes; the upload releases
/// a block only after it matches. Archives are at most 8 GiB, so at most 8192 digests.
const VERIFY_BLOCK: usize = 1024 * 1024;

fn error(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new("image_archive", message)
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify_digest(
    reader: &mut impl Read,
    expected: &str,
    limit: u64,
) -> Result<u64, CandidateError> {
    let mut reader = reader.take(limit + 1);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|_| error("Cannot read the image archive."))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > limit {
            return Err(error("Image archive exceeds its byte limit."));
        }
        digest.update(&buffer[..n]);
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err(error("Image archive digest mismatch."));
    }
    Ok(total)
}

/// Hashes and counts every byte read through it, refusing more than `limit`, and records
/// one SHA-256 per [`VERIFY_BLOCK`] bytes.
struct Hashing<R> {
    inner: R,
    digest: Sha256,
    total: u64,
    limit: u64,
    block: Sha256,
    block_len: usize,
    blocks: Vec<[u8; 32]>,
}
impl<R> Hashing<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            total: 0,
            limit,
            block: Sha256::new(),
            block_len: 0,
            blocks: Vec::new(),
        }
    }

    /// The digests of every complete block and the final partial block.
    fn finish(mut self) -> (String, u64, Vec<[u8; 32]>) {
        if self.block_len > 0 {
            self.blocks.push(self.block.finalize().into());
        }
        (
            format!("{:x}", self.digest.finalize()),
            self.total,
            self.blocks,
        )
    }
}
impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buffer)?;
        self.total += n as u64;
        if self.total > self.limit {
            return Err(std::io::Error::other("archive limit"));
        }
        self.digest.update(&buffer[..n]);
        let mut rest = &buffer[..n];
        while !rest.is_empty() {
            let take = rest.len().min(VERIFY_BLOCK - self.block_len);
            self.block.update(&rest[..take]);
            self.block_len += take;
            rest = &rest[take..];
            if self.block_len == VERIFY_BLOCK {
                self.blocks
                    .push(std::mem::take(&mut self.block).finalize().into());
                self.block_len = 0;
            }
        }
        Ok(n)
    }
}

/// A validated archive: its length and the SHA-256 of each [`VERIFY_BLOCK`] of it.
pub(super) struct Validated {
    pub(super) length: u64,
    blocks: Vec<[u8; 32]>,
}

/// The upload side of an import. Every byte it releases was validated: a block is read
/// in full and released only after it matches the digest validation recorded for that
/// position, and the final block is released only after the stream has ended at the
/// validated length with the expected whole-archive SHA-256. A file changed after
/// validation therefore fails the upload before any changed byte, and before any end of
/// archive, reaches the consumer; trailing padding cannot expose a changed tar early.
struct HeldTail<R> {
    inner: R,
    digest: Sha256,
    total: u64,
    expected_len: u64,
    expected: String,
    blocks: Vec<[u8; 32]>,
    next_block: usize,
    held: Vec<u8>,
    offset: usize,
    verified: bool,
}
impl<R: Read> HeldTail<R> {
    fn new(inner: R, validated: &Validated, expected: &str) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            total: 0,
            expected_len: validated.length,
            expected: expected.to_owned(),
            blocks: validated.blocks.clone(),
            next_block: 0,
            held: Vec::with_capacity(VERIFY_BLOCK),
            offset: 0,
            verified: false,
        }
    }

    /// Read and check the next block; on the last block, also check the stream end.
    fn load(&mut self) -> std::io::Result<()> {
        let changed = || std::io::Error::other("image archive changed");
        self.held.clear();
        self.offset = 0;
        (&mut self.inner)
            .take(VERIFY_BLOCK as u64)
            .read_to_end(&mut self.held)?;
        self.total += self.held.len() as u64;
        let expected = self.blocks.get(self.next_block).ok_or_else(changed)?;
        if self.held.is_empty() || Sha256::digest(&self.held).as_slice() != expected {
            return Err(changed());
        }
        self.digest.update(&self.held);
        self.next_block += 1;
        if self.next_block == self.blocks.len() {
            let mut extra = [0_u8; 1];
            let longer = loop {
                match self.inner.read(&mut extra) {
                    Ok(n) => break n > 0,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(e),
                }
            };
            let actual = format!("{:x}", std::mem::take(&mut self.digest).finalize());
            if longer || self.total != self.expected_len || actual != self.expected {
                return Err(changed());
            }
            self.verified = true;
        }
        Ok(())
    }
}
impl<R: Read> Read for HeldTail<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.offset == self.held.len() {
            if self.verified {
                return Ok(0);
            }
            self.load()?;
        }
        let n = (self.held.len() - self.offset).min(out.len());
        out[..n].copy_from_slice(&self.held[self.offset..self.offset + n]);
        self.offset += n;
        Ok(n)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
struct Manifest {
    config: String,
    layers: Vec<String>,
    repo_tags: Option<Vec<String>>,
}

/// Feed the decoded content of one member to `sink`, detecting compression from its
/// first bytes as the engine's loader does: gzip, zstd (including multiple and skippable
/// frames) or an uncompressed tar. Returns true when the member was not compressed.
fn decode_member(
    mut member: impl Read,
    mut sink: impl FnMut(&[u8]) -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    // The magic is read in full even when the member arrives in short reads.
    let mut magic = [0_u8; 4];
    let mut filled = 0;
    while filled < magic.len() {
        match member.read(&mut magic[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(error("Cannot read an image archive member.")),
        }
    }
    let head = &magic[..filled];
    let mut member = BufReader::with_capacity(64 * 1024, head.chain(member));
    let gzip = head.starts_with(&[0x1f, 0x8b]);
    // A zstd stream starts with a frame or a skippable frame (magic 0x184D2A50 through
    // 0x184D2A5F); both are little-endian.
    let zstd = head.first_chunk::<4>().is_some_and(|magic| {
        let magic = u32::from_le_bytes(*magic);
        magic == 0xFD2F_B528 || (0x184D_2A50..=0x184D_2A5F).contains(&magic)
    });
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut pump = |mut reader: Box<dyn Read + '_>| -> Result<(), CandidateError> {
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|_| error("Cannot decode the image layer."))?;
            if n == 0 {
                return Ok(());
            }
            sink(&buffer[..n])?;
        }
    };
    if gzip {
        return pump(Box::new(MultiGzDecoder::new(member))).map(|()| false);
    }
    if !zstd {
        return pump(Box::new(member)).map(|()| true);
    }
    loop {
        if member
            .fill_buf()
            .map_err(|_| error("Cannot read an image archive member."))?
            .is_empty()
        {
            return Ok(false);
        }
        match StreamingDecoder::new(&mut member) {
            Ok(decoder) => pump(Box::new(decoder))?,
            Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame {
                length,
                ..
            })) => {
                let skipped = std::io::copy(
                    &mut (&mut member).take(u64::from(length)),
                    &mut std::io::sink(),
                )
                .map_err(|_| error("Cannot decode the image layer."))?;
                if skipped != u64::from(length) {
                    return Err(error("Cannot decode the image layer."));
                }
            }
            Err(_) => return Err(error("Cannot decode the image layer.")),
        }
    }
}

/// One validated member: the SHA-256 of its decoded content and, for small raw JSON
/// members, the content itself.
struct Member {
    decoded: String,
    retained: Option<Vec<u8>>,
}

/// Validate one single-image Linux ARM64 tarball in a single streaming pass and return its
/// length.
#[cfg(test)]
fn validate_stream(
    reader: impl Read,
    expected_sha: &str,
    image: &str,
    archive_limit: u64,
    expanded_limit: u64,
) -> Result<u64, CandidateError> {
    validated(
        reader,
        expected_sha,
        image,
        archive_limit,
        expanded_limit,
        ImagePlatform::LinuxArm64,
    )
    .map(|v| v.length)
}

/// Validate one single-image tarball in a single streaming pass, recording its length
/// and per-block digests for a verified re-read.
///
/// The stream must hash to `expected_sha` within `archive_limit` bytes. Members must be
/// a flat set of unique regular files named by exactly one `manifest.json` entry; the
/// config must hash to `image` and target exactly `platform`; each layer's decoded content
/// must match the config's `diff_ids`; total decoded bytes stay within `expanded_limit`.
fn validated(
    reader: impl Read,
    expected_sha: &str,
    image: &str,
    archive_limit: u64,
    expanded_limit: u64,
    platform: ImagePlatform,
) -> Result<Validated, CandidateError> {
    if !image.strip_prefix("sha256:").is_some_and(hex) || !hex(expected_sha) {
        return Err(error("Invalid image identity or archive size."));
    }
    let mut hashing = Hashing::new(reader, archive_limit);
    let mut members = BTreeMap::new();
    let mut expanded = 0_u64;
    let mut retained_total = 0_usize;
    {
        let mut archive = tar::Archive::new(&mut hashing);
        for entry in archive
            .entries()
            .map_err(|_| error("Invalid image archive."))?
        {
            let entry = entry.map_err(|_| error("Invalid image tar entry."))?;
            let path = entry
                .path()
                .map_err(|_| error("Invalid image archive path."))?
                .into_owned();
            let name = path
                .to_str()
                .ok_or_else(|| error("Image archive paths must be UTF-8."))?
                .to_owned();
            if !entry.header().entry_type().is_file()
                || name.len() > 256
                || name.chars().any(char::is_control)
                || path.components().count() != 1
                || !path.components().all(|p| matches!(p, Component::Normal(_)))
                || members.contains_key(&name)
                || members.len() >= 130
            {
                return Err(error(
                    "Only a flat, single-image tarball with unique regular members is supported.",
                ));
            }
            let small = entry.size() <= MAX_METADATA_MEMBER;
            let mut digest = Sha256::new();
            let mut retained = small.then(Vec::new);
            // Decided by the first byte that is not JSON whitespace, in whichever chunk it
            // arrives; the original bytes, whitespace included, are retained for identity.
            let mut raw_json: Option<bool> = None;
            let uncompressed = decode_member(entry, |bytes| {
                expanded += bytes.len() as u64;
                if expanded > expanded_limit {
                    return Err(error("Image expansion exceeds its configured budget."));
                }
                digest.update(bytes);
                if raw_json.is_none() {
                    raw_json = bytes
                        .iter()
                        .find(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
                        .map(|b| matches!(b, b'{' | b'['));
                }
                if raw_json == Some(false) {
                    retained = None;
                }
                if let Some(kept) = retained.as_mut() {
                    kept.extend_from_slice(bytes);
                    if kept.len() as u64 > MAX_METADATA_MEMBER {
                        retained = None;
                    }
                }
                Ok(())
            })?;
            let retained = retained.filter(|_| uncompressed && raw_json == Some(true));
            if let Some(kept) = &retained {
                retained_total += kept.len();
                if retained_total > MAX_RETAINED_METADATA {
                    return Err(error("Image archive metadata exceeds its limit."));
                }
            }
            members.insert(
                name,
                Member {
                    decoded: format!("sha256:{:x}", digest.finalize()),
                    retained,
                },
            );
        }
    }
    // Bytes after the end-of-archive marker are hashed too; the expected digest covers them.
    std::io::copy(&mut hashing, &mut std::io::sink())
        .map_err(|_| error("Image archive exceeds its byte limit."))?;
    let (actual, length, blocks) = hashing.finish();
    if actual != expected_sha {
        return Err(error("Image archive digest mismatch."));
    }
    let metadata = |name: &str, limit: usize| {
        members
            .get(name)
            .and_then(|m| m.retained.as_deref())
            .filter(|bytes| bytes.len() <= limit)
            .ok_or_else(|| error("Image archive metadata member is missing or too large."))
    };
    let manifest: Vec<Manifest> = serde_json::from_slice(metadata("manifest.json", 64 * 1024)?)
        .map_err(|_| error("Invalid image manifest."))?;
    let [manifest] = manifest.as_slice() else {
        return Err(error("An archive must contain exactly one image."));
    };
    if manifest.layers.is_empty()
        || manifest.layers.len() > 128
        || manifest
            .repo_tags
            .as_ref()
            .is_some_and(|tags| tags.len() > 8)
    {
        return Err(error("Image manifest exceeds its limits."));
    }
    let expected: BTreeSet<_> = std::iter::once("manifest.json")
        .chain(std::iter::once(manifest.config.as_str()))
        .chain(manifest.layers.iter().map(String::as_str))
        .collect();
    if expected.len() != manifest.layers.len() + 2
        || !expected
            .iter()
            .copied()
            .eq(members.keys().map(String::as_str))
    {
        return Err(error("Image manifest membership is inconsistent."));
    }
    let config_bytes = metadata(&manifest.config, MAX_METADATA_MEMBER as usize)?;
    if format!("sha256:{}", hash(config_bytes)) != image {
        return Err(error(
            "Image configuration does not match the expected content ID.",
        ));
    }
    let config: Value =
        serde_json::from_slice(config_bytes).map_err(|_| error("Invalid image configuration."))?;
    if config["architecture"] != platform.architecture() || config["os"] != "linux" {
        return Err(error(
            "Image architecture is incompatible with this provider.",
        ));
    }
    let diffs = config["rootfs"]["diff_ids"]
        .as_array()
        .filter(|v| v.len() == manifest.layers.len())
        .ok_or_else(|| error("Image layer identities are missing."))?;
    for (layer, diff) in manifest.layers.iter().zip(diffs) {
        if members.get(layer).map(|m| m.decoded.as_str()) != diff.as_str() {
            return Err(error("Expanded image layer identity is incorrect."));
        }
    }
    Ok(Validated { length, blocks })
}

/// Validate a Linux ARM64 archive file the caller just wrote, under the policy's budgets.
#[cfg(test)]
pub(super) fn validate_file(
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
) -> Result<u64, CandidateError> {
    validate_file_for(path, expected_sha, image, policy, ImagePlatform::LinuxArm64)
}

/// Validate an archive file the caller just wrote, whose configuration targets exactly
/// `platform`, under the policy's budgets.
pub(super) fn validate_file_for(
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
    platform: ImagePlatform,
) -> Result<u64, CandidateError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| error("Cannot open the image archive."))?;
    validated(
        file,
        expected_sha,
        image,
        policy.archive_limit,
        policy.expanded_limit,
        platform,
    )
    .map(|v| v.length)
}

/// The bound for one engine load request of `bytes`.
fn load_timeout(bytes: u64) -> Duration {
    (LOAD_BASE_TIMEOUT + Duration::from_secs(bytes / LOAD_BYTES_PER_SECOND)).min(LOAD_MAX_TIMEOUT)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageReceipt {
    #[serde(default)]
    validation_version: u32,
    checkout: PathBuf,
    provider_incarnation: String,
    provider_boot_id: String,
    pub archive_sha256: String,
    pub image_id: String,
    pub phase: String,
}

fn reusable_validation(previous: &ImageReceipt, requested: &ImageReceipt) -> bool {
    previous.validation_version == 1
        && previous.phase == "content-id-verified"
        && previous.checkout == requested.checkout
        && previous.provider_incarnation == requested.provider_incarnation
        && previous.archive_sha256 == requested.archive_sha256
        && previous.image_id == requested.image_id
}

fn inspect(
    engine: &Engine<'_>,
    image: &str,
    platform: ImagePlatform,
) -> Result<bool, CandidateError> {
    match engine.request(Method::GET, &format!("/v1.53/images/{image}/json"), None) {
        Ok(value)
            if value["Id"] == image
                && value["Architecture"] == platform.architecture()
                && value["Os"] == "linux" =>
        {
            Ok(true)
        }
        Ok(_) => Err(error("Loaded image identity or architecture differs.")),
        Err(e) if e.code == "engine_not_found" => Ok(false),
        Err(e) => Err(e),
    }
}

/// How long an import waits for a provider lease that another operation holds, such as the
/// `graph inspect` behind `hack ps`. Everything `load` does before taking the lease is read-only
/// archive verification, and an `ensure-image` cache entry written before it (under the image
/// cache's own lock) is complete and reusable on its own, so waiting admits nothing early. On
/// expiry the load refuses `provider_busy` before any engine or receipt mutation.
const IMPORT_LEASE_WAIT: Duration = Duration::from_secs(5);

/// The provider lease for one import, waiting at most `wait` for a holder to release it. Only
/// acquisition is retried: identity is verified under the acquired lease, and an import that
/// has started is never retried here.
#[cfg(target_os = "macos")]
fn connect_for_import(candidate: &Candidate, wait: Duration) -> Result<Engine<'_>, CandidateError> {
    Engine::connect_until(candidate, std::time::Instant::now() + wait, || false)
}

/// Bounded acquisition exists only on macOS, the provider's host; elsewhere the lease stays strict.
#[cfg(not(target_os = "macos"))]
fn connect_for_import(
    candidate: &Candidate,
    _wait: Duration,
) -> Result<Engine<'_>, CandidateError> {
    Engine::connect(candidate)
}

/// Import one explicit archive under the default image budgets.
pub fn load(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
) -> Result<ImageReceipt, CandidateError> {
    load_with(
        candidate,
        path,
        expected_sha,
        image,
        &ImagePolicy::default(),
    )
}

/// Import one explicit Linux ARM64 archive whose size and expansion fit `policy`'s budgets.
pub fn load_with(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
) -> Result<ImageReceipt, CandidateError> {
    load_for(
        candidate,
        path,
        expected_sha,
        image,
        policy,
        ImagePlatform::LinuxArm64,
    )
}

/// [`load_with`] for an archive of `platform`. An emulated platform imports only into a
/// pool whose audited boot enabled x86_64 translation; the archive and readback are both
/// bound to that platform.
pub(super) fn load_for(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
    platform: ImagePlatform,
) -> Result<ImageReceipt, CandidateError> {
    load_waiting(
        candidate,
        path,
        expected_sha,
        image,
        policy,
        IMPORT_LEASE_WAIT,
        platform,
    )
}

fn load_waiting(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
    lease_wait: Duration,
    platform: ImagePlatform,
) -> Result<ImageReceipt, CandidateError> {
    if !hex(expected_sha) || !image.strip_prefix("sha256:").is_some_and(hex) {
        return Err(error("Expected archive and image hashes are required."));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| error("Cannot open the explicit image archive."))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("Cannot inspect the image archive."))?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > policy.archive_limit {
        return Err(error(
            "Image input must be a singly linked regular file within the configured image budget.",
        ));
    }
    if verify_digest(&mut file, expected_sha, policy.archive_limit)? != metadata.len() {
        return Err(error("Image archive size changed during verification."));
    }
    let engine = connect_for_import(candidate, lease_wait)?;
    if platform.emulated() && !engine.guest().amd64_emulation() {
        return Err(super::lifecycle::amd64_emulation_not_enabled());
    }
    let directory = candidate.state_root.join("run/image-loads");
    state::private_directory(&directory)?;
    let path = directory.join(format!("{expected_sha}.json"));
    let mut receipt = ImageReceipt {
        validation_version: 1,
        checkout: candidate.checkout.clone(),
        provider_incarnation: engine.guest().incarnation().into(),
        provider_boot_id: engine.guest().boot_id().into(),
        archive_sha256: expected_sha.into(),
        image_id: image.into(),
        phase: "loading".into(),
    };
    if path.try_exists().map_err(state::io)? {
        let old: ImageReceipt = state::read(&path)?;
        if old.checkout != receipt.checkout
            || old.provider_incarnation != receipt.provider_incarnation
            || old.archive_sha256 != expected_sha
            || old.image_id != image
            || !["loading", "content-id-verified"].contains(&old.phase.as_str())
        {
            return Err(error("Foreign image-load intent."));
        }
        // The complete archive hash was checked above. Only this validator's completed,
        // identity-bound receipt can avoid expanding the same layers again; engine presence
        // and architecture are still checked on every invocation, including after reboot.
        if reusable_validation(&old, &receipt) && inspect(&engine, image, platform)? {
            if old.provider_boot_id == receipt.provider_boot_id {
                return Ok(old);
            }
            receipt.phase = "content-id-verified".into();
            state::write(&path, &receipt)?;
            return Ok(receipt);
        }
        if old.phase == "loading"
            && old.provider_boot_id == receipt.provider_boot_id
            && !inspect(&engine, image, platform)?
        {
            return Err(CandidateError::new(
                "image_load_indeterminate",
                "A previous load is unresolved on this boot; no archive was replayed.",
            ));
        }
    }
    // Validate exactly the bytes that hash to the expected value, then stream the same file;
    // the upload releases only re-read blocks that match the validated ones, and its final
    // block only once the re-read stream hashes identically.
    file.rewind()
        .map_err(|_| error("Cannot rewind the image archive."))?;
    let validated = validated(
        &mut file,
        expected_sha,
        image,
        policy.archive_limit,
        policy.expanded_limit,
        platform,
    )?;
    let length = validated.length;
    if length != metadata.len() {
        return Err(error("Image archive size changed during verification."));
    }
    if !inspect(&engine, image, platform)? {
        file.rewind()
            .map_err(|_| error("Cannot rewind the image archive."))?;
        let upload = file
            .try_clone()
            .map_err(|_| error("Cannot read the image archive."))?;
        state::write(&path, &receipt)?;
        let result = engine.load_image_archive(
            reqwest::blocking::Body::sized(HeldTail::new(upload, &validated, expected_sha), length),
            load_timeout(length),
        );
        // A lost response is reconciled only by independent content-ID readback.
        if !inspect(&engine, image, platform)? {
            result?;
            return Err(error("The expected image is absent after load."));
        }
    }
    receipt.phase = "content-id-verified".into();
    state::write(&path, &receipt)?;
    Ok(receipt)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    #[derive(Clone, Copy)]
    pub(crate) enum Layer {
        Gzip,
        Zstd,
        /// Two zstd frames with a skippable frame between them.
        ZstdFrames,
        /// A skippable frame before the first zstd frame.
        ZstdLeadingSkippable,
        Uncompressed,
    }

    pub(crate) fn compress(kind: Layer, payload: &[u8]) -> Vec<u8> {
        use ruzstd::encoding::{CompressionLevel, compress_to_vec};
        match kind {
            Layer::Gzip => {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(payload).unwrap();
                encoder.finish().unwrap()
            }
            Layer::Zstd => compress_to_vec(payload, CompressionLevel::Fastest),
            Layer::ZstdFrames => {
                let (first, second) = payload.split_at(payload.len() / 2);
                let mut bytes = compress_to_vec(first, CompressionLevel::Fastest);
                bytes.extend_from_slice(&0x184D_2A50_u32.to_le_bytes());
                bytes.extend_from_slice(&3_u32.to_le_bytes());
                bytes.extend_from_slice(b"pad");
                bytes.extend(compress_to_vec(second, CompressionLevel::Uncompressed));
                bytes
            }
            Layer::ZstdLeadingSkippable => {
                let mut bytes = 0x184D_2A5F_u32.to_le_bytes().to_vec();
                bytes.extend_from_slice(&4_u32.to_le_bytes());
                bytes.extend_from_slice(b"meta");
                bytes.extend(compress_to_vec(payload, CompressionLevel::Fastest));
                bytes
            }
            Layer::Uncompressed => payload.to_vec(),
        }
    }

    /// A docker-archive tarball with one layer. Returns the archive and its config content ID.
    pub(crate) fn archive(
        kind: Layer,
        payload: &[u8],
        architecture: &str,
        extra: bool,
        incorrect_diff: bool,
    ) -> (Vec<u8>, String) {
        let layer = compress(kind, payload);
        let diff = if incorrect_diff {
            "0".repeat(64)
        } else {
            hash(payload)
        };
        let config = serde_json::to_vec(
            &serde_json::json!({"architecture":architecture,"os":"linux",
            "rootfs":{"type":"layers","diff_ids":[format!("sha256:{diff}")]}}),
        )
        .unwrap();
        let image = format!("sha256:{}", hash(&config));
        let manifest = serde_json::to_vec(
            &serde_json::json!([{"Config":"config.json","Layers":["layer"],"RepoTags":[]}]),
        )
        .unwrap();
        let mut archive = tar::Builder::new(Vec::new());
        let mut members = vec![
            ("config.json", config.as_slice()),
            ("layer", layer.as_slice()),
            ("manifest.json", manifest.as_slice()),
        ];
        if extra {
            members.push(("extra", b"x".as_slice()));
        }
        for (name, bytes) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, name, bytes).unwrap();
        }
        (archive.into_inner().unwrap(), image)
    }

    fn fixture(architecture: &str, extra: bool, incorrect_diff: bool) -> (Vec<u8>, String) {
        archive(
            Layer::Gzip,
            &[b'x'; 2048],
            architecture,
            extra,
            incorrect_diff,
        )
    }

    fn validate(bytes: &[u8], image: &str, expanded: u64) -> Result<u64, CandidateError> {
        validate_stream(Cursor::new(bytes), &hash(bytes), image, 1 << 30, expanded)
    }

    #[test]
    fn streamed_verification_bounds_reads_and_detects_changed_import_bytes() {
        struct Chunked {
            inner: Cursor<Vec<u8>>,
            largest_request: usize,
        }
        impl Read for Chunked {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.largest_request = self.largest_request.max(buffer.len());
                let len = buffer.len().min(31);
                self.inner.read(&mut buffer[..len])
            }
        }
        let bytes = vec![7; 200_000];
        let expected = hash(&bytes);
        let mut reader = Chunked {
            inner: Cursor::new(bytes.clone()),
            largest_request: 0,
        };
        assert_eq!(
            verify_digest(&mut reader, &expected, 200_000).unwrap(),
            200_000
        );
        assert!(reader.largest_request <= 64 * 1024);
        assert!(verify_digest(&mut Cursor::new(&bytes), &expected, 199_999).is_err());
        assert!(verify_digest(&mut Cursor::new(&bytes), &"0".repeat(64), 200_000).is_err());
        // Validation hashes the very bytes it validates: a changed or oversized stream
        // refuses even when its members are individually valid.
        let (archive, image) = fixture("arm64", false, false);
        let expected = hash(&archive);
        let length = archive.len() as u64;
        assert_eq!(
            validate_stream(Cursor::new(&archive), &expected, &image, length, 1 << 20).unwrap(),
            length
        );
        assert!(
            validate_stream(
                Cursor::new(&archive),
                &expected,
                &image,
                length - 1,
                1 << 20
            )
            .is_err()
        );
        let mut trailing = archive.clone();
        trailing.extend_from_slice(&[0; 512]);
        assert!(
            validate_stream(Cursor::new(&trailing), &expected, &image, 1 << 20, 1 << 20).is_err()
        );
        assert!(
            validate_stream(
                Cursor::new(&archive),
                &"0".repeat(64),
                &image,
                length,
                1 << 20
            )
            .is_err()
        );
    }

    /// Block digests for `bytes`, as validation records them.
    fn recorded(bytes: &[u8]) -> Validated {
        let mut hashing = Hashing::new(Cursor::new(bytes), u64::MAX);
        std::io::copy(&mut hashing, &mut std::io::sink()).unwrap();
        let (_, length, blocks) = hashing.finish();
        Validated { length, blocks }
    }

    /// Everything a consumer receives from `reader` before it fails.
    fn drain_until_failure(mut reader: impl Read) -> (Vec<u8>, std::io::Error) {
        let mut released = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => panic!("a changed stream must not end cleanly"),
                Ok(n) => released.extend_from_slice(&buffer[..n]),
                Err(e) => return (released, e),
            }
        }
    }

    #[test]
    fn upload_releases_only_verified_blocks_and_withholds_its_end_until_verified() {
        let bytes: Vec<u8> = (0..(2 * VERIFY_BLOCK + 300_000) as u32)
            .map(|n| (n % 253) as u8)
            .collect();
        let expected = hash(&bytes);
        let validated = recorded(&bytes);
        assert_eq!(validated.blocks.len(), 3);
        let mut uploaded = Vec::new();
        HeldTail::new(Cursor::new(&bytes), &validated, &expected)
            .read_to_end(&mut uploaded)
            .unwrap();
        assert_eq!(uploaded, bytes);
        let flip = |at: usize| {
            let mut changed = bytes.clone();
            changed[at] ^= 1;
            changed
        };
        for (changed, released_blocks) in [
            (flip(10), 0),
            (flip(VERIFY_BLOCK + 5), 1),
            (flip(bytes.len() - 1), 2),
            (bytes[..bytes.len() - 1000].to_vec(), 2),
            ([bytes.as_slice(), b"x"].concat(), 2),
            (bytes[..VERIFY_BLOCK].to_vec(), 1),
        ] {
            let (released, failure) =
                drain_until_failure(HeldTail::new(Cursor::new(&changed), &validated, &expected));
            assert_eq!(failure.to_string(), "image archive changed");
            // Only whole validated blocks left, never a changed byte, and never the final
            // block before the stream end was verified.
            assert_eq!(released, bytes[..released_blocks * VERIFY_BLOCK]);
        }
    }

    #[test]
    fn trailing_padding_cannot_expose_a_changed_archive_before_verification() {
        let (archive, image) = fixture("arm64", false, false);
        // More padding after the end-of-archive marker than one block, so the marker is
        // far from the physical end of the file.
        let mut padded = archive.clone();
        padded.resize(archive.len() + 2 * VERIFY_BLOCK, 0);
        let expected = hash(&padded);
        let validated = validated(
            Cursor::new(&padded),
            &expected,
            &image,
            1 << 30,
            1 << 20,
            ImagePlatform::LinuxArm64,
        )
        .unwrap();
        assert_eq!(validated.length, padded.len() as u64);
        // Unchanged, a tar consumer reads the archive to its end.
        let reader = HeldTail::new(Cursor::new(&padded), &validated, &expected);
        let names: Vec<String> = tar::Archive::new(reader)
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().display().to_string())
            .collect();
        assert_eq!(names, ["config.json", "layer", "manifest.json"]);
        // A member changed after validation: the consumer sees no byte and no end.
        let mut changed = padded.clone();
        changed[1024 + 600] ^= 1;
        let (released, failure) =
            drain_until_failure(HeldTail::new(Cursor::new(&changed), &validated, &expected));
        assert_eq!(failure.to_string(), "image archive changed");
        assert!(released.is_empty());
        let reader = HeldTail::new(Cursor::new(&changed), &validated, &expected);
        let mut consumer = tar::Archive::new(reader);
        let failed = consumer
            .entries()
            .map_or(true, |mut entries| entries.any(|entry| entry.is_err()));
        assert!(failed, "a tar consumer must fail, not end cleanly");
        // A change only in the trailing padding releases just validated bytes (the
        // original tar and its marker) and then fails instead of ending.
        let mut changed = padded.clone();
        let last = changed.len() - 1;
        changed[last] = 1;
        let (released, failure) =
            drain_until_failure(HeldTail::new(Cursor::new(&changed), &validated, &expected));
        assert_eq!(failure.to_string(), "image archive changed");
        assert_eq!(released, padded[..2 * VERIFY_BLOCK]);
    }

    #[test]
    fn gzip_zstd_multi_frame_and_uncompressed_layers_validate_by_decoded_identity() {
        let payload: Vec<u8> = (0..20_000_u32).map(|n| (n % 251) as u8).collect();
        for kind in [
            Layer::Gzip,
            Layer::Zstd,
            Layer::ZstdFrames,
            Layer::ZstdLeadingSkippable,
            Layer::Uncompressed,
        ] {
            let (bytes, image) = archive(kind, &payload, "arm64", false, false);
            validate(&bytes, &image, 1 << 20).unwrap();
            let (bytes, image) = archive(kind, &payload, "arm64", false, true);
            assert!(validate(&bytes, &image, 1 << 20).is_err());
        }
        // A leading skippable frame marks the member as zstd: it decodes to the payload
        // instead of being hashed as raw bytes.
        let mut decoded = Vec::new();
        let uncompressed = decode_member(
            Cursor::new(compress(Layer::ZstdLeadingSkippable, &payload)),
            |bytes| {
                decoded.extend_from_slice(bytes);
                Ok(())
            },
        )
        .unwrap();
        assert!(!uncompressed);
        assert_eq!(decoded, payload);
        // A corrupt zstd frame refuses instead of being treated as raw content.
        let mut corrupt = compress(Layer::Zstd, &payload);
        let last = corrupt.len() - 2;
        corrupt[last] ^= 0xff;
        corrupt.truncate(corrupt.len() - 1);
        assert!(decode_member(Cursor::new(corrupt), |_| Ok(())).is_err());
    }

    /// Reads at most `step` bytes per call, so members arrive in many small chunks.
    struct Trickle<'a> {
        bytes: &'a [u8],
        step: usize,
    }
    impl Read for Trickle<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let n = buffer.len().min(self.step).min(self.bytes.len());
            buffer[..n].copy_from_slice(&self.bytes[..n]);
            self.bytes = &self.bytes[n..];
            Ok(n)
        }
    }

    #[test]
    fn metadata_with_leading_json_whitespace_is_retained_with_its_original_bytes() {
        let payload: Vec<u8> = (0..4096_u32).map(|n| (n % 7) as u8).collect();
        let layer = compress(Layer::Gzip, &payload);
        let mut config = b" \t\r\n  ".to_vec();
        config.extend(
            serde_json::to_vec(&serde_json::json!({"architecture":"arm64","os":"linux",
                "rootfs":{"type":"layers","diff_ids":[format!("sha256:{}", hash(&payload))]}}))
            .unwrap(),
        );
        config.extend_from_slice(b"\n");
        // The content ID covers the whitespace: identity uses the original bytes.
        let image = format!("sha256:{}", hash(&config));
        let mut manifest = b"\n\n".to_vec();
        manifest.extend(
            serde_json::to_vec(
                &serde_json::json!([{"Config":"config.json","Layers":["layer"],"RepoTags":[]}]),
            )
            .unwrap(),
        );
        let mut builder = tar::Builder::new(Vec::new());
        for (name, bytes) in [
            ("config.json", config.as_slice()),
            ("layer", layer.as_slice()),
            ("manifest.json", manifest.as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, bytes).unwrap();
        }
        let bytes = builder.into_inner().unwrap();
        assert_eq!(
            validate(&bytes, &image, 1 << 20).unwrap(),
            bytes.len() as u64
        );
        // One- and three-byte reads split the whitespace and the compression magic
        // across chunk boundaries.
        for step in [1, 3] {
            let reader = Trickle {
                bytes: &bytes,
                step,
            };
            assert_eq!(
                validate_stream(reader, &hash(&bytes), &image, 1 << 30, 1 << 20).unwrap(),
                bytes.len() as u64,
                "step {step}"
            );
        }
        // The identity is still exact: the same JSON without the whitespace is a
        // different content ID.
        let trimmed = format!("sha256:{}", hash(config.trim_ascii()));
        assert!(validate(&bytes, &trimmed, 1 << 20).is_err());
    }

    #[test]
    fn validation_cache_requires_completed_versioned_exact_identity() {
        let value = serde_json::json!({
            "validation_version":1,"checkout":"/candidate","provider_incarnation":"owner",
            "provider_boot_id":"boot","archive_sha256":"archive","image_id":"image",
            "phase":"content-id-verified"
        });
        let requested: ImageReceipt = serde_json::from_value(value.clone()).unwrap();
        for (field, replacement) in [
            ("validation_version", serde_json::json!(0)),
            ("validation_version", serde_json::json!(2)),
            ("checkout", serde_json::json!("/other")),
            ("provider_incarnation", serde_json::json!("other")),
            ("archive_sha256", serde_json::json!("other")),
            ("image_id", serde_json::json!("other")),
            ("phase", serde_json::json!("loading")),
        ] {
            let mut altered = value.clone();
            altered[field] = replacement;
            let previous = serde_json::from_value(altered).unwrap();
            assert!(!reusable_validation(&previous, &requested), "{field}");
        }
        let mut legacy = value.clone();
        legacy.as_object_mut().unwrap().remove("validation_version");
        assert!(!reusable_validation(
            &serde_json::from_value(legacy).unwrap(),
            &requested
        ));
        let mut rebooted = value;
        rebooted["provider_boot_id"] = serde_json::json!("earlier-boot");
        assert!(reusable_validation(
            &serde_json::from_value(rebooted).unwrap(),
            &requested
        ));
    }

    #[test]
    fn archive_rejects_extra_members_wrong_architecture_digest_and_expansion() {
        let (bytes, image) = fixture("arm64", false, false);
        // Every decoded member counts: the 2048-byte layer plus its small metadata.
        assert!(validate(&bytes, &image, 4096).is_ok());
        assert!(validate(&bytes, &image, 2048).is_err());
        assert!(validate(&bytes, &format!("sha256:{}", "0".repeat(64)), 4096).is_err());
        for (bytes, image) in [
            fixture("amd64", false, false),
            fixture("arm64", true, false),
            fixture("arm64", false, true),
        ] {
            assert!(validate(&bytes, &image, 4096).is_err());
        }
    }

    #[test]
    fn an_amd64_archive_validates_only_for_the_selected_amd64_platform() {
        let amd64 = ImagePlatform::LinuxAmd64;
        let check = |bytes: &[u8], image: &str, platform| {
            validated(
                Cursor::new(bytes),
                &hash(bytes),
                image,
                1 << 30,
                4096,
                platform,
            )
            .map(drop)
        };
        let (bytes, image) = fixture("amd64", false, false);
        assert!(check(&bytes, &image, amd64).is_ok());
        assert!(check(&bytes, &image, ImagePlatform::LinuxArm64).is_err());
        let (bytes, image) = fixture("arm64", false, false);
        assert!(check(&bytes, &image, amd64).is_err());
        let (bytes, image) = fixture("amd64", false, true);
        assert!(check(&bytes, &image, amd64).is_err());
    }

    /// A candidate whose provider looks running to every check before the lease. Its recorded
    /// process is synthetic, so identity verification under an acquired lease always fails:
    /// an attempt that got past the lease is visible without any engine being reached.
    #[cfg(target_os = "macos")]
    struct RunningPool {
        root: PathBuf,
        candidate: Candidate,
        alias: PathBuf,
    }

    #[cfg(target_os = "macos")]
    impl RunningPool {
        fn new() -> Self {
            let root = crate::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                "hkl-image-lease",
            );
            let candidate = Candidate::discover(&root).unwrap();
            let mut owner = state::Owner::create(
                &candidate,
                super::super::Profile::Development,
                None,
                super::super::NetworkIntent::Isolated,
            )
            .unwrap();
            owner.phase = "running".into();
            owner.guest_boot_id = Some("11111111-1111-1111-1111-111111111111".into());
            owner.process = Some(super::super::identity::ProcessIdentity {
                pid: 2_000_000,
                start_micros: 1,
                uid: unsafe { libc::geteuid() },
                executable: PathBuf::from("/fixture/provider"),
            });
            owner.save(&candidate).unwrap();
            let alias = owner.short_home.clone();
            Self {
                root,
                candidate,
                alias,
            }
        }

        fn lease(&self) -> state::Lock {
            state::Lock::acquire(&self.candidate.state_root.join("run/smolvm")).unwrap()
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for RunningPool {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.alias);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_import_waits_out_a_brief_lease_holder_and_refuses_a_lasting_one_before_any_effect() {
        use std::time::Instant;
        let pool = RunningPool::new();
        let (bytes, image) = fixture("arm64", false, false);
        let path = pool.root.join("image.tar");
        std::fs::write(&path, &bytes).unwrap();
        let sha = hash(&bytes);
        let loads = pool.candidate.state_root.join("run/image-loads");

        // A holder that outlasts the wait: provider_busy once the wait ends, with no import
        // receipt and the verified archive untouched.
        let held = pool.lease();
        let started = Instant::now();
        let refused = load_waiting(
            &pool.candidate,
            &path,
            &sha,
            &image,
            &ImagePolicy::default(),
            Duration::from_millis(300),
            ImagePlatform::LinuxArm64,
        )
        .err()
        .unwrap();
        assert_eq!(refused.code, "provider_busy", "{refused:?}");
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(!loads.exists());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);

        // A holder that releases within the wait: the same attempt gets past the lease after
        // waiting and reaches identity verification under it, which the synthetic process fails
        // before any engine is reached or receipt written.
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(held);
        });
        let started = Instant::now();
        let admitted = load_waiting(
            &pool.candidate,
            &path,
            &sha,
            &image,
            &ImagePolicy::default(),
            Duration::from_secs(5),
            ImagePlatform::LinuxArm64,
        )
        .err()
        .unwrap();
        release.join().unwrap();
        assert_ne!(admitted.code, "provider_busy", "{admitted:?}");
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!loads.exists());
    }

    #[test]
    fn a_wrong_archive_hash_cannot_create_runtime_state() {
        let root = crate::unique_test_root(&std::env::temp_dir(), "hkl-image");
        let candidate = Candidate::discover(&root).unwrap();
        let (bytes, image) = fixture("arm64", false, false);
        let path = root.join("image.tar");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            load(&candidate, &path, &"0".repeat(64), &image)
                .err()
                .unwrap()
                .code,
            "image_archive"
        );
        assert!(!candidate.state_root.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
