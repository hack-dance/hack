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

pub const ARCHIVE_SHA256: &str = "8ebda502e332c739fdfc13b059be982cca66da9253c5229b4586af02c92781d9";
pub const VERSION: &str = "1.34.1";
const DIRECTORY: &str = "smolvm-1.34.1-darwin-arm64";

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
    refuse_other_pin(&providers, &SMOLVM)?;
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
    verify_tree(candidate, &SMOLVM)
}

/// Verify a prepared tree against its record before anything executes from it.
pub(super) fn verify_tree(
    candidate: &Candidate,
    pin: &TreePin,
) -> Result<Artifact, CandidateError> {
    let providers = candidate.state_root.join("providers");
    let prepared = providers.join(pin.directory);
    reject_aliased_state(&prepared)?;
    let artifact: Artifact = state::read(&providers.join(pin.record))?;
    if artifact.version != pin.version || artifact.archive_sha256 != pin.archive_sha256 {
        return Err(pin_changed(pin, &artifact));
    }
    if artifact.tree_sha256 != tree_digest(&prepared)? {
        return Err(CandidateError::new("artifact_digest_mismatch", pin.changed));
    }
    Ok(artifact)
}

/// The cheap part of [`verify_tree`]: the preparation record names this executor's pin and
/// the prepared tree is not an alias. Hashes nothing; returns the record, whose
/// `tree_sha256` is the tree's content anchor.
pub(super) fn verify_record(
    candidate: &Candidate,
    pin: &TreePin,
) -> Result<Artifact, CandidateError> {
    let providers = candidate.state_root.join("providers");
    reject_aliased_state(&providers.join(pin.directory))?;
    let artifact: Artifact = state::read(&providers.join(pin.record))?;
    if artifact.version != pin.version || artifact.archive_sha256 != pin.archive_sha256 {
        return Err(pin_changed(pin, &artifact));
    }
    Ok(artifact)
}

/// The metadata digest ([`super::tree_witness::metadata_digest`]) of a prepared tree.
pub(super) fn tree_metadata(
    candidate: &Candidate,
    pin: &TreePin,
) -> Result<String, CandidateError> {
    super::tree_witness::metadata_digest(
        &candidate.state_root.join("providers").join(pin.directory),
        None,
    )
}

/// [`verify_tree`]'s content proof, bracketed by the tree's metadata digest. Returns what the
/// proof witnessed; a tree whose metadata changed while it was hashed is refused, so the
/// witness never names metadata the content proof did not cover.
pub(super) fn verify_witnessed(
    candidate: &Candidate,
    pin: &TreePin,
) -> Result<super::tree_witness::Proven, CandidateError> {
    let before = tree_metadata(candidate, pin)?;
    super::tree_witness::note_content_proof();
    let artifact = verify_tree(candidate, pin)?;
    if tree_metadata(candidate, pin)? != before {
        return Err(CandidateError::new("artifact_digest_mismatch", pin.changed));
    }
    Ok(super::tree_witness::Proven {
        metadata: before,
        content: artifact.tree_sha256,
    })
}

/// The refusal for a home prepared under another provider pin. A pin bump is not an
/// in-place upgrade: the home's guest rootfs copy, disks and provider database were made
/// by the recorded release and are qualified only with it. Nothing is changed or removed;
/// the home stays usable by a build that pins the recorded release.
fn pin_changed(pin: &TreePin, recorded: &Artifact) -> CandidateError {
    CandidateError::new(
        "provider_pin_changed",
        format!(
            "This candidate home was prepared with {} {}; this executor pins {} {}. A provider pin change needs a fresh candidate home: prepare one with the pinned archive (runtime prepare). This home, its volumes and its prepared tree are unchanged; a build that pins {} still runs it, and a pool it left running must be stopped with that build (runtime down).",
            pin.label, recorded.version, pin.label, pin.version, recorded.version
        ),
    )
}

/// Refuse preparation in a home whose record names another pin, before any staging.
fn refuse_other_pin(providers: &Path, pin: &TreePin) -> Result<(), CandidateError> {
    let record = providers.join(pin.record);
    if !record.try_exists().map_err(io)? {
        return Ok(());
    }
    let recorded: Artifact = state::read(&record)?;
    if recorded.version != pin.version || recorded.archive_sha256 != pin.archive_sha256 {
        return Err(pin_changed(pin, &recorded));
    }
    Ok(())
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
    refuse_other_pin(&providers, &ENGINE)?;
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
    verify_tree(candidate, &ENGINE)
}

/// A provider tree that preparation extracted from a pinned archive and whose archive
/// it retained in its staging directory, so the tree can be re-prepared later.
pub(super) struct TreePin {
    label: &'static str,
    version: &'static str,
    archive_sha256: &'static str,
    /// The prepared tree under `providers/`.
    directory: &'static str,
    /// The archive's top-level directory as extracted.
    extracted: &'static str,
    /// The tree's preparation record under `providers/`.
    record: &'static str,
    /// Preparation's staging directory under `providers/`; it retains the archive.
    staging: &'static str,
    archive: &'static str,
    /// The executable whose code signature preparation checks, if any.
    signed: Option<&'static str>,
    /// The fixed refusal for a changed tree; it names the repair.
    changed: &'static str,
}

impl TreePin {
    pub(super) fn record_name(&self) -> &'static str {
        self.record
    }
}

pub(super) const SMOLVM: TreePin = TreePin {
    label: "SmolVM",
    version: VERSION,
    archive_sha256: ARCHIVE_SHA256,
    directory: DIRECTORY,
    extracted: DIRECTORY,
    record: "smolvm.json",
    staging: "smolvm-installing",
    archive: "release.tar.gz",
    signed: Some("smolvm-bin"),
    changed: "Prepared SmolVM tree changed; refusing execution. With the runtime stopped, run runtime repair-provider-tree to re-prepare it from the verified retained archive; runtime state and volumes are kept.",
};

pub(super) const ENGINE: TreePin = TreePin {
    label: "Docker engine",
    version: ENGINE_VERSION,
    archive_sha256: ENGINE_SHA256,
    directory: "docker-29.5.2-linux-arm64",
    extracted: "docker",
    record: "docker.json",
    staging: "docker-installing",
    archive: "release.tgz",
    signed: None,
    changed: "Prepared Docker engine changed; refusing execution. With the runtime stopped, run runtime repair-provider-tree to re-prepare it from the verified retained archive; runtime state and volumes are kept.",
};

/// The outcome of re-preparing one prepared provider tree.
#[derive(Debug, Serialize)]
pub struct TreeRepair {
    pub provider: &'static str,
    pub version: String,
    pub tree_sha256: String,
    /// `false` when the prepared tree already matched its record; nothing changed.
    pub repaired: bool,
    /// The changed tree's new name under `providers/`. It is retained, never deleted.
    pub retained_changed_tree: Option<String>,
}

fn repair_refused(code: &'static str, message: &'static str) -> CandidateError {
    CandidateError::new(code, message)
}

/// The archive preparation retained, when it is still an owned regular file in an
/// owned directory that no other user can write.
fn retained_archive(providers: &Path, pin: &TreePin) -> Result<PathBuf, CandidateError> {
    let staging = providers.join(pin.staging);
    let archive = staging.join(pin.archive);
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    for (path, directory) in [(&staging, true), (&archive, false)] {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(repair_refused(
                    "provider_repair_unavailable",
                    "No retained provider archive to repair from; prepare a fresh candidate home.",
                ));
            }
            Err(error) => return Err(io(error)),
        };
        let kind = if directory {
            metadata.is_dir()
        } else {
            metadata.is_file() && metadata.nlink() == 1
        };
        if !kind || metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
            return Err(repair_refused(
                "foreign_state",
                "Retained provider archive is not an owned regular file in an owned directory.",
            ));
        }
    }
    Ok(archive)
}

fn nonce() -> Result<String, CandidateError> {
    let mut random = [0_u8; 8];
    File::open("/dev/urandom")
        .map_err(io)?
        .read_exact(&mut random)
        .map_err(io)?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}

fn sync_directory(path: &Path) -> Result<(), CandidateError> {
    File::open(path).map_err(io)?.sync_all().map_err(io)
}

/// Re-prepare one prepared provider tree that something outside Hack changed.
///
/// The caller holds the provider lock with the runtime stopped, so nothing executes
/// from the tree. The repair re-proves the tree from scratch: the preparation record
/// must match this executor's pin, the retained archive must be an owned regular file
/// whose SHA-256 is the pin, its owned copy is hashed again before extraction, and the
/// fresh extraction (signature checked, as preparation does) must hash to the recorded
/// tree digest. Only then is the changed tree renamed aside, retained and never
/// deleted, and the fresh tree renamed into place. Runtime state, disks and volumes
/// live under `run/` and are untouched. A failed repair keeps its private staging.
///
/// `None` means the tree was never prepared; an intact tree is reported unchanged.
pub(super) fn repair_tree(
    candidate: &Candidate,
    pin: &TreePin,
    _stopped: &state::Lock,
) -> Result<Option<TreeRepair>, CandidateError> {
    let providers = candidate.state_root.join("providers");
    let record = providers.join(pin.record);
    if !record.try_exists().map_err(io)? {
        return Ok(None);
    }
    state::check_private_directory(&providers)?;
    let recorded: Artifact = state::read(&record)?;
    if recorded.version != pin.version || recorded.archive_sha256 != pin.archive_sha256 {
        return Err(pin_changed(pin, &recorded));
    }
    let prepared = providers.join(pin.directory);
    let present = match fs::symlink_metadata(&prepared) {
        Ok(metadata) if metadata.is_dir() => true,
        Ok(_) => {
            return Err(repair_refused(
                "foreign_state",
                "Prepared provider tree is not a directory; repair refused.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(io(error)),
    };
    let report = |repaired, retained_changed_tree| TreeRepair {
        provider: pin.label,
        version: recorded.version.clone(),
        tree_sha256: recorded.tree_sha256.clone(),
        repaired,
        retained_changed_tree,
    };
    if present {
        reject_aliased_state(&prepared)?;
        // A tree that cannot even be hashed (for example a new special file) is changed.
        if tree_digest(&prepared).ok().as_deref() == Some(recorded.tree_sha256.as_str()) {
            return Ok(Some(report(false, None)));
        }
    }
    let archive = retained_archive(&providers, pin)?;
    if digest(&archive)? != pin.archive_sha256 {
        return Err(repair_refused(
            "artifact_digest_mismatch",
            "Retained provider archive does not match the pinned SHA-256; repair refused.",
        ));
    }
    let nonce = nonce()?;
    let work = providers.join(format!("{}-repairing-{nonce}", pin.directory));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&work)
        .map_err(io)?;
    let owned = work.join(pin.archive);
    let mut source = File::open(&archive).map_err(io)?;
    let mut destination = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&owned)
        .map_err(io)?;
    std::io::copy(&mut source, &mut destination).map_err(io)?;
    destination.sync_all().map_err(io)?;
    drop(destination);
    // Rehash the owned copy to close replacement between the check and extraction.
    if digest(&owned)? != pin.archive_sha256 {
        return Err(repair_refused(
            "artifact_digest_mismatch",
            "Retained provider archive changed during repair; repair staging retained.",
        ));
    }
    run(
        clean_command(Path::new("/usr/bin/tar"))
            .arg("-xzf")
            .arg(&owned)
            .arg("-C")
            .arg(&work),
        Duration::from_secs(60),
    )?;
    let extracted = work.join(pin.extracted);
    if let Some(executable) = pin.signed {
        run(
            clean_command(Path::new("/usr/bin/codesign"))
                .args(["--verify", "--strict"])
                .arg(extracted.join(executable)),
            Duration::from_secs(10),
        )?;
    }
    if tree_digest(&extracted)? != recorded.tree_sha256 {
        return Err(repair_refused(
            "artifact_digest_mismatch",
            "Re-extracted provider tree does not match its recorded digest; repair staging retained.",
        ));
    }
    let retained = if present {
        let name = format!("{}-changed-{nonce}", pin.directory);
        fs::rename(&prepared, providers.join(&name)).map_err(io)?;
        Some(name)
    } else {
        None
    };
    fs::rename(&extracted, &prepared).map_err(io)?;
    sync_directory(&providers)?;
    // Only this repair's owned archive copy and its now-empty directory; never recursive.
    let _ = fs::remove_file(&owned);
    let _ = fs::remove_dir(&work);
    verify_tree(candidate, pin)?;
    Ok(Some(report(true, retained)))
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

/// Prepared-tree fixtures with nested empty directories, laid out exactly as preparation
/// leaves state: the retained archive in staging, the tree and its record.
#[cfg(test)]
pub(super) mod tree_fixture {
    use super::*;

    const TEST_DIRECTORY: &str = "test-tree-1.0.0";
    /// Empty directories, as in a guest root filesystem, that cleanup tools prune.
    const EMPTY: [&str; 6] = [
        "agent-rootfs/dev",
        "agent-rootfs/proc",
        "agent-rootfs/tmp",
        "agent-rootfs/etc/init.d",
        "agent-rootfs/etc/periodic/daily",
        "agent-rootfs/etc/periodic/weekly",
    ];

    fn populate(tree: &Path) {
        for directory in EMPTY {
            fs::create_dir_all(tree.join(directory)).unwrap();
        }
        fs::create_dir_all(tree.join("lib")).unwrap();
        fs::write(tree.join("README.txt"), b"fixture provider").unwrap();
        fs::write(tree.join("lib/libfixture.dylib"), b"fixture library").unwrap();
        fs::write(tree.join("smolvm-bin"), b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(tree.join("smolvm-bin"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("/sbin/init", tree.join("agent-rootfs/init")).unwrap();
    }

    fn tar(arguments: &[&std::ffi::OsStr]) {
        run(
            clean_command(Path::new("/usr/bin/tar")).args(arguments),
            Duration::from_secs(60),
        )
        .unwrap();
    }

    /// A pinned test archive, prepared into `candidate`; returns its pin.
    pub(in crate::provider) fn prepare(candidate: &Candidate, scratch: &Path) -> TreePin {
        let source = scratch.join("archive-source");
        populate(&source.join(TEST_DIRECTORY));
        let archive = scratch.join("fixture-release.tar.gz");
        tar(&[
            "-czf".as_ref(),
            archive.as_os_str(),
            "-C".as_ref(),
            source.as_os_str(),
            TEST_DIRECTORY.as_ref(),
        ]);
        let sha256: &'static str = Box::leak(digest(&archive).unwrap().into_boxed_str());
        let pin = TreePin {
            label: "Test tree",
            version: "1.0.0",
            archive_sha256: sha256,
            directory: TEST_DIRECTORY,
            extracted: TEST_DIRECTORY,
            record: "test-tree.json",
            staging: "test-tree-installing",
            archive: "release.tar.gz",
            signed: None,
            changed: "Prepared test tree changed; refusing execution.",
        };
        let providers = candidate.state_root.join("providers");
        state::private_directory(&providers).unwrap();
        let staging = providers.join(pin.staging);
        fs::create_dir(&staging).unwrap();
        let retained = staging.join(pin.archive);
        fs::copy(&archive, &retained).unwrap();
        tar(&[
            "-xzf".as_ref(),
            retained.as_os_str(),
            "-C".as_ref(),
            staging.as_os_str(),
        ]);
        let extracted = staging.join(pin.extracted);
        let artifact = Artifact {
            version: pin.version.into(),
            archive_sha256: sha256.into(),
            tree_sha256: tree_digest(&extracted).unwrap(),
        };
        fs::rename(extracted, providers.join(pin.directory)).unwrap();
        state::write(&providers.join(pin.record), &artifact).unwrap();
        verify_tree(candidate, &pin).unwrap();
        pin
    }

    /// A SmolVM tree and record under the real pins, without an archive: enough for
    /// `verify` to pass until the tree changes. Only the macOS lifecycle tests use it.
    #[cfg(target_os = "macos")]
    pub(in crate::provider) fn prepared_smolvm(candidate: &Candidate) {
        let providers = candidate.state_root.join("providers");
        state::private_directory(&providers).unwrap();
        populate(&root(candidate));
        let artifact = Artifact {
            version: VERSION.into(),
            archive_sha256: ARCHIVE_SHA256.into(),
            tree_sha256: tree_digest(&root(candidate)).unwrap(),
        };
        state::write(&providers.join(SMOLVM.record), &artifact).unwrap();
        verify(candidate).unwrap();
    }

    /// Remove every empty directory below `path`, deepest first, as a cleanup tool does.
    pub(in crate::provider) fn prune_empty_directories(path: &Path) -> usize {
        let mut removed = 0;
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                removed += prune_empty_directories(&entry.path());
                if fs::read_dir(entry.path()).unwrap().next().is_none() {
                    fs::remove_dir(entry.path()).unwrap();
                    removed += 1;
                }
            }
        }
        removed
    }
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
    fn providers(candidate: &Candidate) -> PathBuf {
        candidate.state_root.join("providers")
    }
    fn lease(candidate: &Candidate) -> state::Lock {
        state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap()
    }
    fn repair_staging(candidate: &Candidate) -> Vec<String> {
        fs::read_dir(providers(candidate))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("-repairing-"))
            .collect()
    }

    #[test]
    fn a_home_prepared_under_another_pin_is_refused_by_name_and_left_unchanged() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let pin = tree_fixture::prepare(&candidate, &root);
        let record_path = providers(&candidate).join(pin.record);
        let mut recorded: Artifact = state::read(&record_path).unwrap();
        recorded.version = "0.9.0".into();
        fs::remove_file(&record_path).unwrap();
        state::write(&record_path, &recorded).unwrap();
        let tree = tree_digest(&providers(&candidate).join(pin.directory)).unwrap();

        for error in [
            verify_tree(&candidate, &pin).unwrap_err(),
            refuse_other_pin(&providers(&candidate), &pin).unwrap_err(),
        ] {
            assert_eq!(error.code, "provider_pin_changed");
            assert!(
                error.message.contains("prepared with Test tree 0.9.0")
                    && error.message.contains("pins Test tree 1.0.0")
                    && error.message.contains("fresh candidate home"),
                "{}",
                error.message
            );
        }
        // A changed archive pin with the same version is the same refusal.
        recorded.version = pin.version.into();
        recorded.archive_sha256 = "0".repeat(64);
        fs::remove_file(&record_path).unwrap();
        state::write(&record_path, &recorded).unwrap();
        assert_eq!(
            verify_tree(&candidate, &pin).unwrap_err().code,
            "provider_pin_changed"
        );
        // Neither refusal changed the prepared tree.
        assert_eq!(
            tree_digest(&providers(&candidate).join(pin.directory)).unwrap(),
            tree
        );
        // A home without a record is not refused.
        fs::remove_file(&record_path).unwrap();
        refuse_other_pin(&providers(&candidate), &pin).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_tree_pruned_of_empty_directories_is_repaired_from_its_retained_archive() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        let pin = tree_fixture::prepare(&candidate, &root);
        let prepared = providers(&candidate).join(pin.directory);
        let record: Artifact = state::read(&providers(&candidate).join(pin.record)).unwrap();
        assert!(tree_fixture::prune_empty_directories(&prepared) >= 6);
        assert_eq!(
            verify_tree(&candidate, &pin).unwrap_err().code,
            "artifact_digest_mismatch"
        );

        let lease = lease(&candidate);
        let repaired = repair_tree(&candidate, &pin, &lease).unwrap().unwrap();
        assert!(repaired.repaired);
        assert_eq!(repaired.tree_sha256, record.tree_sha256);
        verify_tree(&candidate, &pin).unwrap();
        assert!(prepared.join("agent-rootfs/etc/periodic/daily").is_dir());
        // The changed tree is retained aside, never deleted.
        let retained = providers(&candidate).join(repaired.retained_changed_tree.unwrap());
        assert!(retained.join("README.txt").is_file());
        assert!(!retained.join("agent-rootfs/dev").exists());
        // The retained archive stays; this repair's own staging is gone.
        assert!(
            providers(&candidate)
                .join(pin.staging)
                .join(pin.archive)
                .is_file()
        );
        assert!(repair_staging(&candidate).is_empty());
        let after: Artifact = state::read(&providers(&candidate).join(pin.record)).unwrap();
        assert_eq!(after.tree_sha256, record.tree_sha256);

        // An intact tree is reported, not replaced.
        let identity = fs::metadata(&prepared).unwrap().ino();
        let again = repair_tree(&candidate, &pin, &lease).unwrap().unwrap();
        assert!(!again.repaired);
        assert!(again.retained_changed_tree.is_none());
        assert_eq!(fs::metadata(&prepared).unwrap().ino(), identity);
        drop(lease);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repair_refuses_without_a_verified_archive_or_a_matching_extraction() {
        let root = fixture();
        let candidate = Candidate::discover(&root).unwrap();
        // A tree without a preparation record was never prepared: nothing to repair.
        let unprepared = tree_fixture::prepare(&candidate, &root);
        fs::remove_file(providers(&candidate).join(unprepared.record)).unwrap();
        let first = lease(&candidate);
        assert!(
            repair_tree(&candidate, &unprepared, &first)
                .unwrap()
                .is_none()
        );
        drop(first);
        fs::remove_dir_all(&candidate.state_root).unwrap();
        fs::remove_dir_all(root.join("archive-source")).unwrap();

        let pin = tree_fixture::prepare(&candidate, &root);
        let lease = lease(&candidate);
        let prepared = providers(&candidate).join(pin.directory);
        let retained = providers(&candidate).join(pin.staging).join(pin.archive);
        tree_fixture::prune_empty_directories(&prepared);
        let changed = tree_digest(&prepared).unwrap();

        fs::write(&retained, b"not the pinned archive").unwrap();
        assert_eq!(
            repair_tree(&candidate, &pin, &lease).unwrap_err().code,
            "artifact_digest_mismatch"
        );
        fs::remove_file(&retained).unwrap();
        assert_eq!(
            repair_tree(&candidate, &pin, &lease).unwrap_err().code,
            "provider_repair_unavailable"
        );
        std::os::unix::fs::symlink(root.join("fixture-release.tar.gz"), &retained).unwrap();
        assert_eq!(
            repair_tree(&candidate, &pin, &lease).unwrap_err().code,
            "foreign_state"
        );
        fs::remove_file(&retained).unwrap();
        fs::copy(root.join("fixture-release.tar.gz"), &retained).unwrap();
        assert!(repair_staging(&candidate).is_empty());

        // A record no extraction can match keeps the changed tree and the repair staging.
        let record = providers(&candidate).join(pin.record);
        let mut recorded: Artifact = state::read(&record).unwrap();
        let original = recorded.tree_sha256.clone();
        recorded.tree_sha256 = "0".repeat(64);
        fs::remove_file(&record).unwrap();
        state::write(&record, &recorded).unwrap();
        assert_eq!(
            repair_tree(&candidate, &pin, &lease).unwrap_err().code,
            "artifact_digest_mismatch"
        );
        assert_eq!(tree_digest(&prepared).unwrap(), changed);
        assert_eq!(repair_staging(&candidate).len(), 1);

        // A record for another version is refused by name before any extraction.
        recorded.tree_sha256 = original;
        recorded.version = "1.0.1".into();
        fs::remove_file(&record).unwrap();
        state::write(&record, &recorded).unwrap();
        assert_eq!(
            repair_tree(&candidate, &pin, &lease).unwrap_err().code,
            "provider_pin_changed"
        );
        assert_eq!(repair_staging(&candidate).len(), 1);
        assert_eq!(tree_digest(&prepared).unwrap(), changed);
        drop(lease);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn published_pin_manifest_matches_the_executor() {
        let pins: serde_json::Value =
            serde_json::from_str(include_str!("../../provider-pins.json")).unwrap();
        assert_eq!(pins["smolvm"]["version"], VERSION);
        assert_eq!(pins["smolvm"]["archive_sha256"], ARCHIVE_SHA256);
        assert_eq!(pins["smolvm"]["platform"], "darwin-arm64");
        assert_eq!(
            pins["smolvm"]["url"],
            format!(
                "https://github.com/smol-machines/smolvm/releases/download/v{VERSION}/{DIRECTORY}.tar.gz"
            )
        );
        assert_eq!(DIRECTORY, format!("smolvm-{VERSION}-darwin-arm64"));
        assert_eq!(SMOLVM.directory, DIRECTORY);
        assert_eq!(
            pins["smolvm"]["agent_protocol_version"],
            super::super::agent::PROTOCOL_VERSION
        );
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
