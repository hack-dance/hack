//! Explicit, bounded local image archives; no registry credentials or Docker contexts.
//!
//! An archive is validated in one streaming pass that also hashes every byte, so the
//! validated bytes are exactly the bytes whose SHA-256 the caller expected. The upload
//! to the engine re-reads the file through a reader that withholds its final bytes until
//! the complete stream has hashed to the same value; a file changed after validation
//! cannot complete an import. Memory use is bounded by small metadata members, not by
//! archive size.
use super::{engine::Engine, image_policy::ImagePolicy, state};
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
/// Bytes the upload reader withholds until the whole archive has hashed correctly.
const HELD_TAIL: usize = 64 * 1024;

fn error(message: &str) -> CandidateError {
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

/// Hashes and counts every byte read through it, refusing more than `limit`.
struct Hashing<R> {
    inner: R,
    digest: Sha256,
    total: u64,
    limit: u64,
}
impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buffer)?;
        self.total += n as u64;
        if self.total > self.limit {
            return Err(std::io::Error::other("archive limit"));
        }
        self.digest.update(&buffer[..n]);
        Ok(n)
    }
}

/// The upload side of an import: releases bytes only while at least [`HELD_TAIL`] bytes
/// remain withheld, and releases the tail only after the complete stream has the expected
/// length and SHA-256. A changed file therefore fails the upload before its tar ends.
struct HeldTail<R> {
    inner: R,
    digest: Sha256,
    total: u64,
    expected_len: u64,
    expected: String,
    held: Vec<u8>,
    verified: bool,
}
impl<R: Read> HeldTail<R> {
    fn new(inner: R, expected_len: u64, expected: &str) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            total: 0,
            expected_len,
            expected: expected.to_owned(),
            held: Vec::new(),
            verified: false,
        }
    }
}
impl<R: Read> Read for HeldTail<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        loop {
            let releasable = if self.verified {
                self.held.len()
            } else {
                self.held.len().saturating_sub(HELD_TAIL)
            };
            if releasable > 0 {
                let n = releasable.min(out.len());
                out[..n].copy_from_slice(&self.held[..n]);
                self.held.drain(..n);
                return Ok(n);
            }
            if self.verified {
                return Ok(0);
            }
            let mut buffer = [0_u8; 64 * 1024];
            let n = self.inner.read(&mut buffer)?;
            if n == 0 {
                let actual = format!("{:x}", std::mem::take(&mut self.digest).finalize());
                if self.total != self.expected_len || actual != self.expected {
                    return Err(std::io::Error::other("image archive changed"));
                }
                self.verified = true;
                continue;
            }
            self.total += n as u64;
            if self.total > self.expected_len {
                return Err(std::io::Error::other("image archive changed"));
            }
            self.digest.update(&buffer[..n]);
            self.held.extend_from_slice(&buffer[..n]);
        }
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
    member: impl Read,
    mut sink: impl FnMut(&[u8]) -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    let mut member = BufReader::with_capacity(64 * 1024, member);
    let head = member
        .fill_buf()
        .map_err(|_| error("Cannot read an image archive member."))?;
    let (gzip, zstd) = (
        head.starts_with(&[0x1f, 0x8b]),
        head.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]),
    );
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

/// Validate one single-image tarball in a single streaming pass and return its length.
///
/// The stream must hash to `expected_sha` within `archive_limit` bytes. Members must be
/// a flat set of unique regular files named by exactly one `manifest.json` entry; the
/// config must hash to `image` and target Linux ARM64; each layer's decoded content
/// must match the config's `diff_ids`; total decoded bytes stay within `expanded_limit`.
fn validate_stream(
    reader: impl Read,
    expected_sha: &str,
    image: &str,
    archive_limit: u64,
    expanded_limit: u64,
) -> Result<u64, CandidateError> {
    if !image.strip_prefix("sha256:").is_some_and(hex) || !hex(expected_sha) {
        return Err(error("Invalid image identity or archive size."));
    }
    let mut hashing = Hashing {
        inner: reader,
        digest: Sha256::new(),
        total: 0,
        limit: archive_limit,
    };
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
            let mut first = true;
            let mut raw_json = false;
            let uncompressed = decode_member(entry, |bytes| {
                expanded += bytes.len() as u64;
                if expanded > expanded_limit {
                    return Err(error("Image expansion exceeds its configured budget."));
                }
                digest.update(bytes);
                if first {
                    first = false;
                    raw_json = matches!(bytes.first(), Some(b'{' | b'['));
                }
                if let Some(kept) = retained.as_mut().filter(|_| raw_json) {
                    kept.extend_from_slice(bytes);
                    if kept.len() as u64 > MAX_METADATA_MEMBER {
                        retained = None;
                    }
                }
                Ok(())
            })?;
            let retained = retained.filter(|kept| uncompressed && raw_json && !kept.is_empty());
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
    if format!("{:x}", hashing.digest.finalize()) != expected_sha {
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
    if config["architecture"] != "arm64" || config["os"] != "linux" {
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
    Ok(hashing.total)
}

/// Validate an archive file the caller just wrote, under the policy's budgets.
pub(super) fn validate_file(
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
) -> Result<u64, CandidateError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| error("Cannot open the image archive."))?;
    validate_stream(
        file,
        expected_sha,
        image,
        policy.archive_limit,
        policy.expanded_limit,
    )
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

fn inspect(engine: &Engine<'_>, image: &str) -> Result<bool, CandidateError> {
    match engine.request(Method::GET, &format!("/v1.53/images/{image}/json"), None) {
        Ok(value)
            if value["Id"] == image
                && value["Architecture"] == "arm64"
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

/// Import one explicit archive whose size and expansion fit `policy`'s budgets.
pub fn load_with(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
) -> Result<ImageReceipt, CandidateError> {
    load_waiting(
        candidate,
        path,
        expected_sha,
        image,
        policy,
        IMPORT_LEASE_WAIT,
    )
}

fn load_waiting(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
    policy: &ImagePolicy,
    lease_wait: Duration,
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
        if reusable_validation(&old, &receipt) && inspect(&engine, image)? {
            if old.provider_boot_id == receipt.provider_boot_id {
                return Ok(old);
            }
            receipt.phase = "content-id-verified".into();
            state::write(&path, &receipt)?;
            return Ok(receipt);
        }
        if old.phase == "loading"
            && old.provider_boot_id == receipt.provider_boot_id
            && !inspect(&engine, image)?
        {
            return Err(CandidateError::new(
                "image_load_indeterminate",
                "A previous load is unresolved on this boot; no archive was replayed.",
            ));
        }
    }
    // Validate exactly the bytes that hash to the expected value, then stream the same file;
    // the upload withholds its tail until the re-read stream hashes identically.
    file.rewind()
        .map_err(|_| error("Cannot rewind the image archive."))?;
    let length = validate_stream(
        &mut file,
        expected_sha,
        image,
        policy.archive_limit,
        policy.expanded_limit,
    )?;
    if length != metadata.len() {
        return Err(error("Image archive size changed during verification."));
    }
    if !inspect(&engine, image)? {
        file.rewind()
            .map_err(|_| error("Cannot rewind the image archive."))?;
        let upload = file
            .try_clone()
            .map_err(|_| error("Cannot read the image archive."))?;
        state::write(&path, &receipt)?;
        let result = engine.load_image_archive(
            reqwest::blocking::Body::sized(HeldTail::new(upload, length, expected_sha), length),
            load_timeout(length),
        );
        // A lost response is reconciled only by independent content-ID readback.
        if !inspect(&engine, image)? {
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

    #[test]
    fn upload_withholds_its_tail_until_the_whole_stream_hashes_as_expected() {
        let bytes: Vec<u8> = (0..300_000_u32).map(|n| n as u8).collect();
        let expected = hash(&bytes);
        let mut uploaded = Vec::new();
        HeldTail::new(Cursor::new(&bytes), bytes.len() as u64, &expected)
            .read_to_end(&mut uploaded)
            .unwrap();
        assert_eq!(uploaded, bytes);
        for changed in [
            {
                let mut changed = bytes.clone();
                changed[299_999] ^= 1;
                changed
            },
            bytes[..299_000].to_vec(),
            [bytes.as_slice(), b"x"].concat(),
        ] {
            let mut reader = HeldTail::new(Cursor::new(&changed), bytes.len() as u64, &expected);
            let mut released = Vec::new();
            let mut buffer = [0_u8; 4096];
            let failure = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => panic!("a changed stream must not end cleanly"),
                    Ok(n) => released.extend_from_slice(&buffer[..n]),
                    Err(e) => break e,
                }
            };
            assert_eq!(failure.to_string(), "image archive changed");
            // The withheld tail, which holds the tar end-of-archive blocks, never left.
            assert!(released.len() + HELD_TAIL <= changed.len().max(bytes.len()));
        }
    }

    #[test]
    fn gzip_zstd_multi_frame_and_uncompressed_layers_validate_by_decoded_identity() {
        let payload: Vec<u8> = (0..20_000_u32).map(|n| (n % 251) as u8).collect();
        for kind in [
            Layer::Gzip,
            Layer::Zstd,
            Layer::ZstdFrames,
            Layer::Uncompressed,
        ] {
            let (bytes, image) = archive(kind, &payload, "arm64", false, false);
            validate(&bytes, &image, 1 << 20).unwrap();
            let (bytes, image) = archive(kind, &payload, "arm64", false, true);
            assert!(validate(&bytes, &image, 1 << 20).is_err());
        }
        // A corrupt zstd frame refuses instead of being treated as raw content.
        let mut corrupt = compress(Layer::Zstd, &payload);
        let last = corrupt.len() - 2;
        corrupt[last] ^= 0xff;
        corrupt.truncate(corrupt.len() - 1);
        assert!(decode_member(Cursor::new(corrupt), |_| Ok(())).is_err());
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
