//! The release archive is pinned, verified before extraction, and never installed globally.
use super::{
    process::{clean_command, run},
    state::{self, io},
};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const ARCHIVE_SHA256: &str = "d0c962a017fe07a1b58c1437b16e6a2320c00d8a7cae739882103b871ef7af0f";
pub const VERSION: &str = "1.14.3";
const DIRECTORY: &str = "smolvm-1.14.3-darwin-arm64";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub version: String,
    pub archive_sha256: String,
    pub tree_sha256: String,
}

pub fn digest(path: &Path) -> Result<String, CandidateError> {
    let mut file = File::open(path).map_err(io)?;
    if file.metadata().map_err(io)?.len() > 128 * 1024 * 1024 {
        return Err(CandidateError::new(
            "artifact_invalid",
            "Artifact file exceeds the pinned package's 128 MiB per-file limit.",
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("providers").join(DIRECTORY)
}

fn tree_digest(root: &Path) -> Result<String, CandidateError> {
    rootfs_digest(root, None)
}

pub fn rootfs_digest(root: &Path, marker: Option<&str>) -> Result<String, CandidateError> {
    fn visit(
        base: &Path,
        path: &Path,
        hash: &mut Sha256,
        marker: Option<&str>,
    ) -> Result<(), CandidateError> {
        let mut entries = fs::read_dir(path)
            .map_err(io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let relative = path.strip_prefix(base).expect("tree child");
            let text = relative.to_str().ok_or_else(|| {
                CandidateError::new("artifact_invalid", "Non-UTF8 artifact path.")
            })?;
            if marker == Some(text) {
                let m = fs::symlink_metadata(&path).map_err(io)?;
                if !m.is_file()
                    || m.nlink() != 1
                    || m.len() > 1024
                    || m.uid() != unsafe { libc::geteuid() }
                {
                    return Err(CandidateError::new(
                        "artifact_invalid",
                        "Unsafe readiness marker.",
                    ));
                }
                continue;
            }
            hash.update((text.len() as u64).to_le_bytes());
            hash.update(text.as_bytes());
            let m = fs::symlink_metadata(&path).map_err(io)?;
            hash.update(m.mode().to_le_bytes());
            if m.is_dir() {
                hash.update(b"directory");
                visit(base, &path, hash, marker)?;
            } else if m.is_file() {
                hash.update(b"file");
                hash.update(digest(&path)?);
            } else if m.file_type().is_symlink() {
                hash.update(b"symlink");
                let target = fs::read_link(&path).map_err(io)?;
                hash.update(target.as_os_str().as_encoded_bytes());
                // Guest rootfs links may be absolute guest paths; never follow them on host.
            } else {
                return Err(CandidateError::new(
                    "artifact_invalid",
                    "Unexpected special artifact file.",
                ));
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(root, root, &mut hash, marker)?;
    Ok(format!("{:x}", hash.finalize()))
}

pub fn prepare(candidate: &Candidate, archive: &Path) -> Result<Artifact, CandidateError> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(CandidateError::new(
            "unsupported_host",
            "This pinned artifact requires Apple Silicon macOS.",
        ));
    }
    // No state is created for a wrong artifact.
    if digest(archive)? != ARCHIVE_SHA256 {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "SmolVM archive does not match the pinned SHA-256.",
        ));
    }
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let providers = candidate.state_root.join("providers");
    state::private_directory(&providers)?;
    if root(candidate).try_exists().map_err(io)? {
        return verify(candidate);
    }
    let staging = providers.join("smolvm-installing");
    fs::create_dir(&staging).map_err(io)?;
    // Copy to exclusively owned staging and rehash to close source replacement between check/extract.
    let owned_archive = staging.join("release.tar.gz");
    let mut source = File::open(archive).map_err(io)?;
    let mut destination = File::create(&owned_archive).map_err(io)?;
    std::io::copy(&mut source, &mut destination).map_err(io)?;
    destination.sync_all().map_err(io)?;
    if digest(&owned_archive)? != ARCHIVE_SHA256 {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Archive changed during preparation; staging retained.",
        ));
    }
    // The exact pinned archive is trusted packaging; no unverified tar input is extracted.
    run(
        clean_command(Path::new("/usr/bin/tar"))
            .arg("-xzf")
            .arg(&owned_archive)
            .arg("-C")
            .arg(&staging),
        Duration::from_secs(60),
    )?;
    let extracted = staging.join(DIRECTORY);
    run(
        clean_command(Path::new("/usr/bin/codesign"))
            .args(["--verify", "--strict"])
            .arg(extracted.join("smolvm-bin")),
        Duration::from_secs(10),
    )?;
    let artifact = Artifact {
        version: VERSION.into(),
        archive_sha256: ARCHIVE_SHA256.into(),
        tree_sha256: tree_digest(&extracted)?,
    };
    fs::rename(extracted, root(candidate)).map_err(io)?;
    state::write(&providers.join("smolvm.json"), &artifact)?;
    // Retain the pinned archive as provenance and interrupted-install evidence. No recursive cleanup.
    Ok(artifact)
}

pub fn verify(candidate: &Candidate) -> Result<Artifact, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    let artifact: Artifact = state::read(&candidate.state_root.join("providers/smolvm.json"))?;
    if artifact.version != VERSION
        || artifact.archive_sha256 != ARCHIVE_SHA256
        || artifact.tree_sha256 != tree_digest(&root(candidate))?
    {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Prepared SmolVM tree changed; refusing execution.",
        ));
    }
    Ok(artifact)
}

pub const ENGINE_SHA256: &str = "d1d9cb857c32c596ea96a9ca6b25d13621a97c83511e667868a33a320b2a707f";
pub const ENGINE_VERSION: &str = "29.5.2";
pub fn engine_root(candidate: &Candidate) -> PathBuf {
    candidate
        .state_root
        .join("providers/docker-29.5.2-linux-arm64")
}

pub fn prepare_engine(candidate: &Candidate, archive: &Path) -> Result<Artifact, CandidateError> {
    if digest(archive)? != ENGINE_SHA256 {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Docker engine archive does not match the pinned SHA-256.",
        ));
    }
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let providers = candidate.state_root.join("providers");
    state::private_directory(&providers)?;
    if engine_root(candidate).try_exists().map_err(io)? {
        return verify_engine(candidate);
    }
    let staging = providers.join("docker-installing");
    state::private_directory(&staging)?;
    let owned_archive = staging.join("release.tgz");
    let mut source = File::open(archive).map_err(io)?;
    let mut destination = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&owned_archive)
        .map_err(io)?;
    std::io::copy(&mut source, &mut destination).map_err(io)?;
    destination.sync_all().map_err(io)?;
    if digest(&owned_archive)? != ENGINE_SHA256 {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Engine archive changed during preparation; staging retained.",
        ));
    }
    run(
        clean_command(Path::new("/usr/bin/tar"))
            .arg("-xzf")
            .arg(&owned_archive)
            .arg("-C")
            .arg(&staging),
        Duration::from_secs(60),
    )?;
    let extracted = staging.join("docker");
    let artifact = Artifact {
        version: ENGINE_VERSION.into(),
        archive_sha256: ENGINE_SHA256.into(),
        tree_sha256: tree_digest(&extracted)?,
    };
    fs::rename(extracted, engine_root(candidate)).map_err(io)?;
    state::write(&providers.join("docker.json"), &artifact)?;
    Ok(artifact)
}

pub fn verify_engine(candidate: &Candidate) -> Result<Artifact, CandidateError> {
    reject_aliased_state(&engine_root(candidate))?;
    let artifact: Artifact = state::read(&candidate.state_root.join("providers/docker.json"))?;
    if artifact.version != ENGINE_VERSION
        || artifact.archive_sha256 != ENGINE_SHA256
        || artifact.tree_sha256 != tree_digest(&engine_root(candidate))?
    {
        return Err(CandidateError::new(
            "artifact_digest_mismatch",
            "Prepared Docker engine changed; refusing execution.",
        ));
    }
    Ok(artifact)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let mut random = [0_u8; 16];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-artifact-{nonce}"));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn published_pin_manifest_matches_the_executor() {
        let pins: serde_json::Value =
            serde_json::from_str(include_str!("../../provider-pins.json")).unwrap();
        assert_eq!(pins["smolvm"]["version"], VERSION);
        assert_eq!(pins["smolvm"]["archive_sha256"], ARCHIVE_SHA256);
        assert_eq!(pins["docker"]["version"], ENGINE_VERSION);
        assert_eq!(pins["docker"]["archive_sha256"], ENGINE_SHA256);
    }
    #[test]
    fn unexpected_large_sparse_files_are_rejected_before_hashing_gigabytes() {
        let root = fixture();
        let path = root.join("unexpected-template.ext4");
        File::create(&path)
            .unwrap()
            .set_len(20 * 1024 * 1024 * 1024)
            .unwrap();
        let started = std::time::Instant::now();
        assert_eq!(digest(&path).unwrap_err().code, "artifact_invalid");
        assert!(started.elapsed() < Duration::from_secs(1));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn only_the_owned_regular_ready_marker_is_excluded_from_guest_base_verification() {
        let root = fixture();
        fs::write(root.join("agent"), b"trusted").unwrap();
        let baseline = rootfs_digest(&root, None).unwrap();
        let marker = root.join(".smolvm-ready.owned");
        fs::write(&marker, b"ready").unwrap();
        assert_eq!(
            rootfs_digest(&root, Some(".smolvm-ready.owned")).unwrap(),
            baseline
        );
        fs::write(root.join("agent"), b"changed").unwrap();
        assert_ne!(
            rootfs_digest(&root, Some(".smolvm-ready.owned")).unwrap(),
            baseline
        );
        fs::remove_file(&marker).unwrap();
        std::os::unix::fs::symlink("/must-not-follow", &marker).unwrap();
        assert!(rootfs_digest(&root, Some(".smolvm-ready.owned")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
