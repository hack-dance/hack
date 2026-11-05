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
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
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

/// Pinned standalone BuildKit client for native image builds.
///
/// The release asset is a single Developer ID signed `darwin-arm64` executable that runs
/// on the host against the guest engine's forwarded private socket. Its bytes are pinned
/// by SHA-256 in `provider-pins.json`; preparation copies it into owned private state, so
/// the caller's file is never executed, and every later use re-verifies the prepared tree.
pub const BUILDER_SHA256: &str = "e5040acdaac1a349de84c0e7a80c861a368e0d141bf7260e1fd9a74b16749477";
pub const BUILDER_VERSION: &str = "0.34.1";
const BUILDER: BinaryPin = BinaryPin {
    label: "BuildKit client",
    version: BUILDER_VERSION,
    sha256: BUILDER_SHA256,
    directory: "buildx-0.34.1-darwin-arm64",
    executable: "docker-buildx",
    record: "buildx.json",
    staging: "buildx-installing",
    verify_signature: true,
};

/// One pinned single-file provider executable and where its prepared tree lives.
struct BinaryPin {
    label: &'static str,
    version: &'static str,
    sha256: &'static str,
    directory: &'static str,
    executable: &'static str,
    record: &'static str,
    staging: &'static str,
    verify_signature: bool,
}

fn binary_root(candidate: &Candidate, pin: &BinaryPin) -> PathBuf {
    candidate.state_root.join("providers").join(pin.directory)
}

/// Prepare the pinned BuildKit client from a caller-supplied copy of its release asset.
///
/// No state is created unless the file matches the pin. An existing prepared tree is
/// re-verified and reused, never overwritten. An interrupted preparation leaves its
/// private staging directory in place and refuses until it is inspected.
pub fn prepare_builder(candidate: &Candidate, binary: &Path) -> Result<Artifact, CandidateError> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(CandidateError::new(
            "unsupported_host",
            "This pinned artifact requires Apple Silicon macOS.",
        ));
    }
    prepare_binary(candidate, binary, &BUILDER)
}

/// The prepared BuildKit client executable. Callers run it only after `verify_builder`.
pub fn builder_executable(candidate: &Candidate) -> PathBuf {
    binary_root(candidate, &BUILDER).join(BUILDER.executable)
}

/// Verify the prepared BuildKit client before any use.
pub fn verify_builder(candidate: &Candidate) -> Result<Artifact, CandidateError> {
    verify_binary(candidate, &BUILDER)
}

fn binary_mismatch(pin: &BinaryPin, detail: &str) -> CandidateError {
    CandidateError::new(
        "artifact_digest_mismatch",
        format!("{} {detail}", pin.label),
    )
}

fn prepare_binary(
    candidate: &Candidate,
    source: &Path,
    pin: &BinaryPin,
) -> Result<Artifact, CandidateError> {
    // A FIFO or device would block or stream; only a regular file is hashed.
    if !fs::metadata(source).map_err(io)?.is_file() || digest(source)? != pin.sha256 {
        return Err(binary_mismatch(
            pin,
            "file does not match the pinned SHA-256.",
        ));
    }
    let _lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    let providers = candidate.state_root.join("providers");
    state::private_directory(&providers)?;
    if binary_root(candidate, pin).try_exists().map_err(io)? {
        return verify_binary(candidate, pin);
    }
    let staging = providers.join(pin.staging);
    state::private_directory(&staging)?;
    let prepared = staging.join(pin.directory);
    // Non-recursive and exclusive: a leftover from an interrupted run is retained, not reused.
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&prepared)
        .map_err(io)?;
    let owned = prepared.join(pin.executable);
    let mut input = File::open(source).map_err(io)?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o700)
        .open(&owned)
        .map_err(io)?;
    std::io::copy(&mut input, &mut output).map_err(io)?;
    output.sync_all().map_err(io)?;
    drop(output);
    // Rehash the owned copy to close source replacement between the check and the copy.
    if digest(&owned)? != pin.sha256 {
        return Err(binary_mismatch(
            pin,
            "file changed during preparation; staging retained.",
        ));
    }
    fs::set_permissions(&owned, fs::Permissions::from_mode(0o700)).map_err(io)?;
    if pin.verify_signature {
        run(
            clean_command(Path::new("/usr/bin/codesign"))
                .args(["--verify", "--strict"])
                .arg(&owned),
            Duration::from_secs(10),
        )?;
    }
    let artifact = Artifact {
        version: pin.version.into(),
        archive_sha256: pin.sha256.into(),
        tree_sha256: tree_digest(&prepared)?,
    };
    fs::rename(&prepared, binary_root(candidate, pin)).map_err(io)?;
    state::write(&providers.join(pin.record), &artifact)?;
    // Only the now-empty staging directory; never recursive.
    let _ = fs::remove_dir(&staging);
    Ok(artifact)
}

fn verify_binary(candidate: &Candidate, pin: &BinaryPin) -> Result<Artifact, CandidateError> {
    let root = binary_root(candidate, pin);
    reject_aliased_state(&root)?;
    let artifact: Artifact = state::read(&candidate.state_root.join("providers").join(pin.record))?;
    let executable = fs::symlink_metadata(root.join(pin.executable)).map_err(io)?;
    if artifact.version != pin.version
        || artifact.archive_sha256 != pin.sha256
        || !executable.is_file()
        || artifact.tree_sha256 != tree_digest(&root)?
    {
        return Err(binary_mismatch(
            pin,
            "prepared tree changed; refusing execution.",
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
        const PLATFORM: &str = "darwin-arm64";
        assert_eq!(pins["buildx"]["version"], BUILDER_VERSION);
        assert_eq!(pins["buildx"]["platform"], PLATFORM);
        assert_eq!(pins["buildx"]["archive_sha256"], BUILDER_SHA256);
        assert_eq!(
            pins["buildx"]["url"],
            format!(
                "https://github.com/docker/buildx/releases/download/v{BUILDER_VERSION}/buildx-v{BUILDER_VERSION}.{PLATFORM}"
            )
        );
        assert_eq!(
            BUILDER.directory,
            format!("buildx-{BUILDER_VERSION}-{PLATFORM}")
        );
        assert_eq!(BUILDER.version, BUILDER_VERSION);
        assert_eq!(BUILDER.sha256, BUILDER_SHA256);
    }
    fn test_pin(bytes: &[u8]) -> BinaryPin {
        let sha256: &'static str =
            Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        BinaryPin {
            label: "Test client",
            version: "1.2.3",
            sha256,
            directory: "test-client-1.2.3",
            executable: "test-client",
            record: "test-client.json",
            staging: "test-client-installing",
            verify_signature: false,
        }
    }
    #[test]
    fn a_builder_binary_that_misses_the_pin_creates_no_state() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let untrusted = root.join("untrusted-client");
        fs::write(&untrusted, b"not the pinned client").unwrap();
        let error = prepare_binary(&candidate, &untrusted, &BUILDER).unwrap_err();
        assert_eq!(error.code, "artifact_digest_mismatch");
        let directory = root.join("not-a-file");
        fs::create_dir(&directory).unwrap();
        let error = prepare_binary(&candidate, &directory, &BUILDER).unwrap_err();
        assert_eq!(error.code, "artifact_digest_mismatch");
        assert!(!candidate.state_root.exists());
        assert!(verify_builder(&candidate).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_prepared_pinned_binary_is_reused_and_any_tree_change_refuses_execution() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let bytes = b"#!/bin/sh\nexit 0\n";
        let pin = test_pin(bytes);
        let source = root.join("release-asset");
        fs::write(&source, bytes).unwrap();
        let prepared = prepare_binary(&candidate, &source, &pin).unwrap();
        assert_eq!(prepared.version, "1.2.3");
        assert_eq!(prepared.archive_sha256, pin.sha256);
        let executable = binary_root(&candidate, &pin).join(pin.executable);
        let metadata = fs::symlink_metadata(&executable).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o700);
        assert_eq!(fs::read(&executable).unwrap(), bytes);
        // The caller's file is copied, never moved or linked.
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_ne!(metadata.ino(), fs::metadata(&source).unwrap().ino());
        assert!(
            !candidate
                .state_root
                .join("providers")
                .join(pin.staging)
                .exists()
        );
        // Preparing again verifies and reuses the existing tree.
        let again = prepare_binary(&candidate, &source, &pin).unwrap();
        assert_eq!(again.tree_sha256, prepared.tree_sha256);
        assert_eq!(
            verify_binary(&candidate, &pin).unwrap().tree_sha256,
            prepared.tree_sha256
        );

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let error = verify_binary(&candidate, &pin).unwrap_err();
        assert_eq!(error.code, "artifact_digest_mismatch");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        verify_binary(&candidate, &pin).unwrap();

        fs::write(&executable, b"#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(
            verify_binary(&candidate, &pin).unwrap_err().code,
            "artifact_digest_mismatch"
        );
        // A changed tree is never repaired by a later prepare.
        assert_eq!(
            prepare_binary(&candidate, &source, &pin).unwrap_err().code,
            "artifact_digest_mismatch"
        );
        fs::write(&executable, bytes).unwrap();
        verify_binary(&candidate, &pin).unwrap();

        let extra = binary_root(&candidate, &pin).join("plugin");
        fs::write(&extra, b"extra").unwrap();
        assert!(verify_binary(&candidate, &pin).is_err());
        fs::remove_file(&extra).unwrap();

        let other_version = BinaryPin {
            version: "1.2.4",
            ..test_pin(bytes)
        };
        assert_eq!(
            verify_binary(&candidate, &other_version).unwrap_err().code,
            "artifact_digest_mismatch"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_replaced_prepared_executable_or_aliased_root_refuses() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let bytes = b"pinned client";
        let pin = test_pin(bytes);
        let source = root.join("release-asset");
        fs::write(&source, bytes).unwrap();
        prepare_binary(&candidate, &source, &pin).unwrap();
        let prepared = binary_root(&candidate, &pin);
        let executable = prepared.join(pin.executable);
        fs::remove_file(&executable).unwrap();
        std::os::unix::fs::symlink(&source, &executable).unwrap();
        assert!(verify_binary(&candidate, &pin).is_err());
        fs::remove_file(&executable).unwrap();
        fs::write(&executable, bytes).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        verify_binary(&candidate, &pin).unwrap();

        let moved = root.join("moved");
        fs::rename(&prepared, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &prepared).unwrap();
        assert_eq!(
            verify_binary(&candidate, &pin).unwrap_err().code,
            "aliased_state"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn an_interrupted_preparation_is_retained_and_refused() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let bytes = b"pinned client";
        let pin = test_pin(bytes);
        let source = root.join("release-asset");
        fs::write(&source, bytes).unwrap();
        let leftover = candidate
            .state_root
            .join("providers")
            .join(pin.staging)
            .join(pin.directory);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&leftover)
            .unwrap();
        fs::write(leftover.join(pin.executable), b"partial").unwrap();
        assert!(prepare_binary(&candidate, &source, &pin).is_err());
        assert_eq!(fs::read(leftover.join(pin.executable)).unwrap(), b"partial");
        assert!(!binary_root(&candidate, &pin).exists());
        fs::remove_dir_all(root).unwrap();
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
