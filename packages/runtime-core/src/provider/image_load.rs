//! Explicit, bounded local image archives; no registry credentials or Docker contexts.
use super::{engine::Engine, state};
use crate::{Candidate, CandidateError};
use flate2::read::MultiGzDecoder;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::{Cursor, Read, Seek},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
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

fn read_verified_archive(
    file: &mut (impl Read + Seek),
    expected: &str,
) -> Result<Vec<u8>, CandidateError> {
    file.rewind()
        .map_err(|_| error("Cannot rewind the image archive."))?;
    let mut bytes = Vec::new();
    file.take(MAX_ARCHIVE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Cannot read the image archive."))?;
    // Retain the original descriptor and verify the bytes actually being validated/imported.
    // A changed file between the streaming check and this read cannot reuse the earlier hash.
    if bytes.len() as u64 > MAX_ARCHIVE || hash(&bytes) != expected {
        return Err(error("Image archive digest mismatch."));
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
struct Manifest {
    config: String,
    layers: Vec<String>,
    repo_tags: Option<Vec<String>>,
}

fn archive_member(bytes: &[u8], name: &str, limit: u64) -> Result<Vec<u8>, CandidateError> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    for entry in archive
        .entries()
        .map_err(|_| error("Invalid image tar archive."))?
    {
        let entry = entry.map_err(|_| error("Invalid image tar entry."))?;
        if entry
            .path()
            .map_err(|_| error("Invalid image archive path."))?
            .as_ref()
            == Path::new(name)
        {
            if entry.size() > limit {
                return Err(error("Image metadata exceeds its limit."));
            }
            let mut result = Vec::new();
            entry
                .take(limit + 1)
                .read_to_end(&mut result)
                .map_err(|_| error("Cannot read image metadata."))?;
            if result.len() as u64 > limit {
                return Err(error("Image metadata exceeds its limit."));
            }
            return Ok(result);
        }
    }
    Err(error("Image archive member is missing."))
}

fn validate_archive(bytes: &[u8], image: &str, max_expanded: u64) -> Result<(), CandidateError> {
    if !image.strip_prefix("sha256:").is_some_and(hex) || bytes.len() as u64 > MAX_ARCHIVE {
        return Err(error("Invalid image identity or archive size."));
    }
    let mut names = BTreeSet::new();
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    for entry in archive
        .entries()
        .map_err(|_| error("Invalid image archive."))?
    {
        let entry = entry.map_err(|_| error("Invalid image tar entry."))?;
        let path = entry
            .path()
            .map_err(|_| error("Invalid image archive path."))?;
        let name = path
            .to_str()
            .ok_or_else(|| error("Image archive paths must be UTF-8."))?;
        if !entry.header().entry_type().is_file()
            || name.len() > 256
            || name.chars().any(char::is_control)
            || path.components().count() != 1
            || !path.components().all(|p| matches!(p, Component::Normal(_)))
            || !names.insert(name.to_owned())
            || names.len() > 130
        {
            return Err(error(
                "Only a flat, single-image tarball with unique regular members is supported.",
            ));
        }
    }
    let manifest: Vec<Manifest> =
        serde_json::from_slice(&archive_member(bytes, "manifest.json", 64 * 1024)?)
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
    let expected: BTreeSet<_> = std::iter::once("manifest.json".to_owned())
        .chain(std::iter::once(manifest.config.clone()))
        .chain(manifest.layers.iter().cloned())
        .collect();
    if expected != names || expected.len() != manifest.layers.len() + 2 {
        return Err(error("Image manifest membership is inconsistent."));
    }
    let config_bytes = archive_member(bytes, &manifest.config, 1024 * 1024)?;
    if format!("sha256:{}", hash(&config_bytes)) != image {
        return Err(error(
            "Image configuration does not match the expected content ID.",
        ));
    }
    let config: Value =
        serde_json::from_slice(&config_bytes).map_err(|_| error("Invalid image configuration."))?;
    if config["architecture"] != "arm64" || config["os"] != "linux" {
        return Err(error(
            "Image architecture is incompatible with this provider.",
        ));
    }
    let diffs = config["rootfs"]["diff_ids"]
        .as_array()
        .filter(|v| v.len() == manifest.layers.len())
        .ok_or_else(|| error("Image layer identities are missing."))?;
    let mut expanded = 0_u64;
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    for entry in archive
        .entries()
        .map_err(|_| error("Invalid image archive."))?
    {
        let entry = entry.map_err(|_| error("Invalid image layer."))?;
        let path = entry
            .path()
            .map_err(|_| error("Invalid image layer path."))?;
        let Some(index) = manifest
            .layers
            .iter()
            .position(|p| Path::new(p) == path.as_ref())
        else {
            continue;
        };
        let remaining = max_expanded
            .checked_sub(expanded)
            .ok_or_else(|| error("Image expansion exceeds 2 GiB."))?;
        // This narrow loader accepts the compressed layers emitted by crane tarball.
        let mut decoder = MultiGzDecoder::new(entry).take(remaining + 1);
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let n = decoder
                .read(&mut buffer)
                .map_err(|_| error("Cannot decode the image layer."))?;
            if n == 0 {
                break;
            }
            expanded += n as u64;
            if expanded > max_expanded {
                return Err(error("Image expansion exceeds 2 GiB."));
            }
            digest.update(&buffer[..n]);
        }
        if diffs[index] != format!("sha256:{:x}", digest.finalize()) {
            return Err(error("Expanded image layer identity is incorrect."));
        }
    }
    Ok(())
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

pub fn load(
    candidate: &Candidate,
    path: &Path,
    expected_sha: &str,
    image: &str,
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
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_ARCHIVE {
        return Err(error(
            "Image input must be a singly linked regular file no larger than 256 MiB.",
        ));
    }
    if verify_digest(&mut file, expected_sha, MAX_ARCHIVE)? != metadata.len() {
        return Err(error("Image archive size changed during verification."));
    }
    let engine = Engine::connect(candidate)?;
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
    let bytes = read_verified_archive(&mut file, expected_sha)?;
    validate_archive(&bytes, image, MAX_EXPANDED)?;
    if !inspect(&engine, image)? {
        state::write(&path, &receipt)?;
        let result = engine.load_image_archive(bytes);
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
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(architecture: &str, extra: bool, incorrect_diff: bool) -> (Vec<u8>, String) {
        let payload = vec![b'x'; 2048];
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&payload).unwrap();
        let layer = encoder.finish().unwrap();
        let diff = if incorrect_diff {
            "0".repeat(64)
        } else {
            hash(&payload)
        };
        let config = serde_json::to_vec(
            &serde_json::json!({"architecture":architecture,"os":"linux",
            "rootfs":{"type":"layers","diff_ids":[format!("sha256:{diff}")]}}),
        )
        .unwrap();
        let image = format!("sha256:{}", hash(&config));
        let manifest = serde_json::to_vec(
            &serde_json::json!([{"Config":"config.json","Layers":["layer.tar.gz"],"RepoTags":[]}]),
        )
        .unwrap();
        let mut archive = tar::Builder::new(Vec::new());
        for (name, bytes) in [
            ("config.json", config.as_slice()),
            ("layer.tar.gz", layer.as_slice()),
            ("manifest.json", manifest.as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, name, bytes).unwrap();
        }
        if extra {
            let mut header = tar::Header::new_gnu();
            header.set_size(1);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, "extra", b"x".as_slice())
                .unwrap();
        }
        (archive.into_inner().unwrap(), image)
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
        let mut cursor = reader.inner;
        assert_eq!(
            read_verified_archive(&mut cursor, &expected).unwrap(),
            bytes
        );
        cursor.get_mut()[0] = 8;
        assert!(read_verified_archive(&mut cursor, &expected).is_err());
        cursor.get_mut().truncate(10);
        assert!(read_verified_archive(&mut cursor, &expected).is_err());
        let (archive, image) = fixture("arm64", false, false);
        let expected = hash(&archive);
        let mut input = Cursor::new(archive);
        verify_digest(&mut input, &expected, MAX_ARCHIVE).unwrap();
        let verified = read_verified_archive(&mut input, &expected).unwrap();
        validate_archive(&verified, &image, MAX_EXPANDED).unwrap();
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
        assert!(validate_archive(&bytes, &image, 2048).is_ok());
        assert!(validate_archive(&bytes, &image, 1024).is_err());
        assert!(validate_archive(&bytes, &format!("sha256:{}", "0".repeat(64)), 4096).is_err());
        for (bytes, image) in [
            fixture("amd64", false, false),
            fixture("arm64", true, false),
            fixture("arm64", false, true),
        ] {
            assert!(validate_archive(&bytes, &image, 4096).is_err());
        }
    }

    #[test]
    fn a_wrong_archive_hash_cannot_create_runtime_state() {
        let root = std::env::temp_dir().join(format!(
            "hkl-image-{}-{}",
            std::process::id(),
            crate::node::now()
        ));
        std::fs::create_dir(&root).unwrap();
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
