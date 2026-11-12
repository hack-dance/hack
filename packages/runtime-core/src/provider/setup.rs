//! Explicit provider acquisition. Pinned bytes are the authority; URLs only locate them.
//! Preparation uses the manual entrypoints in an isolated staging home. A single rename
//! publishes the complete provider set; interrupted staging can be discarded and rebuilt.
mod download;
#[cfg(test)]
mod tests;

use super::{artifact, network_tools, state};
use crate::{Candidate, CandidateError};
use serde::Deserialize;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize)]
pub struct FilePin {
    pub url: String,
    pub archive_sha256: String,
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

/// Must be called only by the explicit setup command after consent (or with all offline
/// inputs). Does not boot a VM or touch trust, DNS, credentials or the system installation.
pub fn run(
    candidate: &Candidate,
    inputs: Option<OfflineInputs<'_>>,
    accepted: bool,
) -> Result<serde_json::Value, CandidateError> {
    if inputs.is_none() {
        consent(accepted, false, || unreachable!())?;
    }
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(CandidateError::new(
            "unsupported_host",
            "Native setup requires Apple Silicon macOS.",
        ));
    }
    let status = install(candidate, inputs, &pins()?, prepare_all, verified_install)?;
    Ok(
        serde_json::json!({"status": status, "probe": super::probe_with_profile(candidate, super::Profile::Development)?}),
    )
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
) -> Result<&'static str, CandidateError> {
    let setup = candidate.state_root.join("setup");
    let _setup_lock = state::Lock::acquire(&setup)?;
    let target = candidate.state_root.join("providers");
    {
        let _provider_lock = state::Lock::acquire(&candidate.state_root.join("run/smolvm"))?;
        if reuse(candidate, &target, &verify)? {
            return Ok("reused");
        }
    }
    let downloads = download_directory(candidate);
    let (archive, engine, packages) = if let Some(inputs) = inputs {
        download::verify_input(inputs.archive, &files[0])?;
        download::verify_input(inputs.engine_archive, &files[1])?;
        for pin in &files[2..] {
            download::verify_input(&inputs.network_tools.join(pin.name()?), pin)?;
        }
        (
            inputs.archive.to_path_buf(),
            inputs.engine_archive.to_path_buf(),
            inputs.network_tools.to_path_buf(),
        )
    } else {
        state::private_directory(&downloads)?;
        let client = download::client()?;
        for pin in files {
            download::acquire(&client, &downloads, pin)?;
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
        return Ok("reused");
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
    Ok("installed")
}

fn reuse(
    candidate: &Candidate,
    target: &Path,
    verify: &impl Fn(&Candidate) -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    crate::reject_aliased_state(target)?;
    if !target.try_exists().map_err(state::io)? {
        return Ok(false);
    }
    // Never overwrite an incomplete manual install or a home from another pin.
    verify(candidate).map_err(|e| CandidateError::new("setup_existing_invalid", format!("{}: {}. Existing provider directory {} was preserved. Finish the manual runtime prepare commands or use a fresh native home; changed trees need runtime repair-provider-tree.", e.code, e.message, target.display())))?;
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
    fs::rename(staging.join("providers"), target).map_err(state::io)?;
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
