//! Explicit provider acquisition. Pinned bytes are the authority; URLs only locate them.
//! Preparation uses the manual entrypoints in an isolated staging home. A single rename
//! publishes the complete provider set; interrupted staging can be discarded and rebuilt.
mod download;
#[cfg(test)]
mod tests;

use super::{artifact, network_tools, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize)]
pub struct FilePin {
    pub url: String,
    pub archive_sha256: String,
    /// Exact compressed length of the bytes selected by the pinned digest.
    pub size_bytes: u64,
    /// Upper bound, not an assertion of the compressed release's exact length.
    pub max_bytes: u64,
    pub redirect_hosts: Vec<String>,
}
impl FilePin {
    pub fn name(&self) -> Result<&str, CandidateError> {
        let name = self.url.rsplit('/').next().unwrap_or("");
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            || name == "."
            || name == ".."
        {
            return Err(CandidateError::new(
                "setup_pin_invalid",
                "Unsafe pinned filename.",
            ));
        }
        Ok(name)
    }
}

#[derive(Deserialize)]
struct Pins {
    smolvm: FilePin,
    docker: FilePin,
    network_tools: Vec<FilePin>,
}

/// Compile the repository's manifest into the executable; never trust a mutable bundle
/// manifest to grant network access or change the hashes accepted by manual preparation.
pub fn pins() -> Result<Vec<FilePin>, CandidateError> {
    let pins: Pins = serde_json::from_str(include_str!("../../provider-pins.json"))
        .map_err(|_| CandidateError::new("setup_pin_invalid", "Invalid compiled provider pins."))?;
    if pins.smolvm.archive_sha256 != artifact::ARCHIVE_SHA256
        || pins.docker.archive_sha256 != artifact::ENGINE_SHA256
        || pins.network_tools.len() != network_tools::PACKAGES.len()
    {
        return Err(CandidateError::new(
            "setup_pin_invalid",
            "Setup and preparation pins differ.",
        ));
    }
    for (pin, (name, hash)) in pins.network_tools.iter().zip(network_tools::PACKAGES) {
        if pin.name()? != name || pin.archive_sha256 != hash {
            return Err(CandidateError::new(
                "setup_pin_invalid",
                "Guest package pins differ.",
            ));
        }
    }
    let files: Vec<_> = [pins.smolvm, pins.docker]
        .into_iter()
        .chain(pins.network_tools)
        .collect();
    for pin in &files {
        download::validate_pin(pin)?;
    }
    Ok(files)
}

#[derive(Clone, Copy)]
pub struct OfflineInputs<'a> {
    pub archive: &'a Path,
    pub engine_archive: &'a Path,
    pub network_tools: &'a Path,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Downloaded,
    Resumed,
    Reused,
    Offline,
}

/// Accounting for archive inputs read this invocation. Reused bytes cover offline
/// inputs, verified cache entries and prefixes. Complete-home reuse reads no
/// archives and returns an empty file list instead.
#[derive(Debug, Serialize)]
struct FileResult {
    name: String,
    outcome: Outcome,
    size_bytes: u64,
    downloaded_bytes: u64,
    reused_bytes: u64,
}
impl FileResult {
    fn new(pin: &FilePin, outcome: Outcome, downloaded_bytes: u64) -> Result<Self, CandidateError> {
        Ok(Self {
            name: pin.name()?.to_owned(),
            outcome,
            size_bytes: pin.size_bytes,
            downloaded_bytes,
            reused_bytes: pin.size_bytes - downloaded_bytes,
        })
    }
}

#[derive(Debug, Serialize)]
struct Installation {
    status: &'static str,
    files: Vec<FileResult>,
}
impl Installation {
    fn reused() -> Self {
        Self {
            status: "reused",
            files: Vec::new(),
        }
    }

    fn with_probe(self, probe: impl Serialize) -> serde_json::Value {
        serde_json::json!({"status": self.status, "files": self.files, "probe": probe})
    }
}

/// Locations displayed before consent. Neither this function nor `pins` performs I/O.
pub fn download_directory(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("setup/downloads")
}

/// No network client can be constructed before this consent gate succeeds.
pub fn consent(
    accepted: bool,
    interactive: bool,
    confirm: impl FnOnce() -> Result<bool, CandidateError>,
) -> Result<(), CandidateError> {
    if accepted {
        return Ok(());
    }
    if !interactive {
        return Err(CandidateError::new(
            "E_INTERACTIVE_REQUIRED",
            "runtime setup requires confirmation; pass --accept-downloads to consent to the displayed pinned downloads.",
        ));
    }
    if !confirm()? {
        return Err(CandidateError::new(
            "setup_declined",
            "Pinned downloads declined; no files downloaded or installed.",
        ));
    }
    Ok(())
}

fn verified_install(candidate: &Candidate) -> Result<(), CandidateError> {
    artifact::verify(candidate)?;
    artifact::verify_engine(candidate)?;
    network_tools::verify(candidate)
}

fn observe_existing(
    candidate: &Candidate,
    verify: &impl Fn(&Candidate) -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    let target = candidate.state_root.join("providers");
    crate::reject_aliased_state(&target).map_err(|_| {
        CandidateError::new(
            "setup_existing_invalid",
            "Unsafe provider directory; existing files were preserved. Use a fresh native home.",
        )
    })?;
    if !target.try_exists().map_err(state::io)? {
        return Ok(false);
    }
    // Existing-only admission never creates directories or a lock before consent.
    let _lock = state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm")).map_err(|e| {
        if e.code == "provider_busy" { e } else { CandidateError::new("setup_existing_invalid", "Existing provider lock is missing or unsafe; files were preserved. Finish manual preparation or use a fresh native home.") }
    })?;
    reuse(candidate, &target, verify)
}

/// Verify a complete installation before asking for download consent. Read-only:
/// an absent home creates nothing; an existing home uses its retained lock.
pub fn reuse_existing(candidate: &Candidate) -> Result<Option<serde_json::Value>, CandidateError> {
    if !observe_existing(candidate, &verified_install)? {
        return Ok(None);
    }
    Ok(Some(Installation::reused().with_probe(
        super::probe_with_profile(candidate, super::Profile::Development)?,
    )))
}

/// Must be called only by the explicit setup command after consent (or with all offline
/// inputs). Does not boot a VM or touch trust, DNS, credentials or the system installation.
pub fn run(
    candidate: &Candidate,
    inputs: Option<OfflineInputs<'_>>,
    accepted: bool,
) -> Result<serde_json::Value, CandidateError> {
    if let Some(result) = reuse_existing(candidate)? {
        return Ok(result);
    }
    if inputs.is_none() {
        consent(accepted, false, || unreachable!())?;
    }
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(CandidateError::new(
            "unsupported_host",
            "Native setup requires Apple Silicon macOS.",
        ));
    }
    let installation = install(
        candidate,
        inputs,
        &pins()?,
        prepare_all,
        verified_install,
        download::client,
    )?;
    Ok(installation.with_probe(super::probe_with_profile(
        candidate,
        super::Profile::Development,
    )?))
}

fn prepare_all(candidate: &Candidate, inputs: OfflineInputs<'_>) -> Result<(), CandidateError> {
    super::prepare(candidate, inputs.archive)?;
    super::prepare_engine(candidate, inputs.engine_archive)?;
    super::prepare_network_tools(candidate, inputs.network_tools)?;
    Ok(())
}

// Platform-independent orchestration so local-server tests exercise the same acquire,
// verify, locking, prepare ordering, publication and reuse decisions as the command.
fn install(
    candidate: &Candidate,
    inputs: Option<OfflineInputs<'_>>,
    files: &[FilePin],
    prepare: impl FnOnce(&Candidate, OfflineInputs<'_>) -> Result<(), CandidateError>,
    verify: impl Fn(&Candidate) -> Result<(), CandidateError>,
    client: impl FnOnce() -> Result<download::Client, CandidateError>,
) -> Result<Installation, CandidateError> {
    let setup = candidate.state_root.join("setup");
    let _setup_lock = state::Lock::acquire(&setup)?;
    let target = candidate.state_root.join("providers");
    {
        let _provider_lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
        if reuse(candidate, &target, &verify)? {
            return Ok(Installation::reused());
        }
    }
    let downloads = download_directory(candidate);
    let mut results = Vec::with_capacity(files.len());
    let (archive, engine, packages) = if let Some(inputs) = inputs {
        download::verify_input(inputs.archive, &files[0])?;
        download::verify_input(inputs.engine_archive, &files[1])?;
        for pin in &files[2..] {
            download::verify_input(&inputs.network_tools.join(pin.name()?), pin)?;
        }
        for pin in files {
            results.push(FileResult::new(pin, Outcome::Offline, 0)?);
        }
        (
            inputs.archive.to_path_buf(),
            inputs.engine_archive.to_path_buf(),
            inputs.network_tools.to_path_buf(),
        )
    } else {
        state::private_directory(&downloads)?;
        let client = client()?;
        for pin in files {
            results.push(download::acquire(&client, &downloads, pin)?);
        }
        (
            downloads.join(files[0].name()?),
            downloads.join(files[1].name()?),
            downloads.clone(),
        )
    };
    // All inputs have passed their hash before any prepare/extraction reads one.
    // Recheck after downloading, then serialize publication with manual preparation.
    let _provider_lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
    if reuse(candidate, &target, &verify)? {
        // A manual prepare may have finished while inputs were acquired. Keep
        // the actual transfer accounting even though publication is now a no-op.
        return Ok(Installation {
            status: "reused",
            files: results,
        });
    }
    publish(candidate, &setup, &target, |staged| {
        prepare(
            staged,
            OfflineInputs {
                archive: &archive,
                engine_archive: &engine,
                network_tools: &packages,
            },
        )?;
        verify(staged)
    })?;
    Ok(Installation {
        status: "installed",
        files: results,
    })
}

fn reuse(
    candidate: &Candidate,
    target: &Path,
    verify: &impl Fn(&Candidate) -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    crate::reject_aliased_state(target).map_err(|_| {
        CandidateError::new(
            "setup_existing_invalid",
            "Unsafe provider directory; existing files were preserved. Use a fresh native home.",
        )
    })?;
    if !target.try_exists().map_err(state::io)? {
        return Ok(false);
    }
    // Never overwrite an incomplete manual install or a home from another pin.
    verify(candidate).map_err(|e| CandidateError::new("setup_existing_invalid", format!("{}: existing .hack-local/providers was preserved. Finish the manual runtime prepare commands or use a fresh native home; changed trees need runtime repair-provider-tree.", e.code)))?;
    Ok(true)
}

/// The staging path is exclusively setup-owned under its retained lock. Nothing from
/// it is published until every preparation/verification succeeds. A crash before rename
/// leaves only disposable staging. Sync prepared files/directories before publication.
fn publish(
    candidate: &Candidate,
    setup: &Path,
    target: &Path,
    prepare: impl FnOnce(&Candidate) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let staging = setup.join("staging");
    if staging.try_exists().map_err(state::io)? {
        state::check_private_directory(&staging)?;
        writable_staging(&staging)?;
        fs::remove_dir_all(&staging).map_err(state::io)?;
    }
    state::private_directory(&staging)?;
    let mut staged = Candidate::discover(&candidate.checkout)?;
    staged.state_root = staging.clone();
    prepare(&staged)?;
    sync_tree(&staging.join("providers"))?;
    #[cfg(test)]
    tests::publication_checkpoint("before_rename");
    fs::rename(staging.join("providers"), target).map_err(state::io)?;
    #[cfg(test)]
    tests::publication_checkpoint("after_rename");
    fs::File::open(&candidate.state_root)
        .and_then(|f| f.sync_all())
        .map_err(state::io)?;
    Ok(())
}

// Extracted guest directories may be read-only. Only setup-owned, unpublished
// staging may gain owner permissions for disposal; never follow guest symlinks.
fn writable_staging(path: &Path) -> Result<(), CandidateError> {
    let metadata = path.symlink_metadata().map_err(state::io)?;
    if metadata.is_dir() {
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(metadata.permissions().mode() | 0o700),
        )
        .map_err(state::io)?;
        for entry in fs::read_dir(path).map_err(state::io)? {
            writable_staging(&entry.map_err(state::io)?.path())?;
        }
    }
    Ok(())
}

fn sync_tree(path: &Path) -> Result<(), CandidateError> {
    let metadata = path.symlink_metadata().map_err(state::io)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(state::io)? {
            sync_tree(&entry.map_err(state::io)?.path())?;
        }
    }
    // Guest rootfs symlinks describe guest paths; never follow them on the host.
    if metadata.is_file() || metadata.is_dir() {
        fs::File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(state::io)?;
    }
    Ok(())
}
