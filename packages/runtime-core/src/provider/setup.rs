//! Explicit provider acquisition. Pinned bytes are the authority; URLs only locate them.
//! Preparation uses the manual entrypoints in an isolated staging home. A single rename
//! publishes the complete provider set; interrupted staging can be discarded and rebuilt.
//! The image builder is added afterwards by its own manual entrypoint, so a home that is
//! already complete gains it without its published provider set being touched.
mod download;
mod inspection;
pub use inspection::{
    Inspection, InstallationState, create_home, inspect_candidate, inspect_home,
    inspect_home_quiescence, validate_home_path,
};
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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
    buildx: FilePin,
}

/// Every pinned file setup may download, in the order it is displayed for consent: the
/// provider set, then the image builder.
pub fn pins() -> Result<Vec<FilePin>, CandidateError> {
    let (mut files, builder) = pin_set()?;
    files.push(builder);
    Ok(files)
}

/// The image builder's pin: a single executable, not an archive.
pub fn builder_pin() -> Result<FilePin, CandidateError> {
    Ok(pin_set()?.1)
}

/// Compile the repository's manifest into the executable; never trust a mutable bundle
/// manifest to grant network access or change the hashes accepted by manual preparation.
/// Returns the provider set that is published as one tree (provider, engine, then the
/// guest packages) and, apart from it, the image builder.
fn pin_set() -> Result<(Vec<FilePin>, FilePin), CandidateError> {
    let pins: Pins = serde_json::from_str(include_str!("../../provider-pins.json"))
        .map_err(|_| CandidateError::new("setup_pin_invalid", "Invalid compiled provider pins."))?;
    if pins.smolvm.archive_sha256 != artifact::ARCHIVE_SHA256
        || pins.docker.archive_sha256 != artifact::ENGINE_SHA256
        || pins.buildx.archive_sha256 != artifact::BUILDER_SHA256
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
    for pin in files.iter().chain([&pins.buildx]) {
        download::validate_pin(pin)?;
    }
    Ok((files, pins.buildx))
}

#[derive(Clone, Copy)]
pub struct OfflineInputs<'a> {
    pub archive: &'a Path,
    pub engine_archive: &'a Path,
    pub network_tools: &'a Path,
    /// The pinned image builder file. Optional: offline setup without it leaves the
    /// builder unprepared.
    pub builder: Option<&'a Path>,
}

/// Where setup may take the pinned image builder from.
#[derive(Clone, Copy, Debug)]
pub enum BuilderSource<'a> {
    /// Neither download consent nor an offline file: observe only, change nothing.
    Absent,
    /// The caller consented to the displayed pinned downloads.
    Download,
    /// The pinned release file, supplied offline.
    File(&'a Path),
}

impl<'a> BuilderSource<'a> {
    /// Offline inputs never reach the network, with or without a builder file.
    pub fn select(inputs: Option<OfflineInputs<'a>>, accepted: bool) -> Self {
        match inputs {
            Some(inputs) => inputs.builder.map_or(Self::Absent, Self::File),
            None if accepted => Self::Download,
            None => Self::Absent,
        }
    }
}

/// What setup did about the image builder.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Builder {
    /// This invocation prepared it.
    Installed,
    /// It was already prepared and verified.
    Reused,
    /// It is absent and no source was given; nothing was changed.
    NotPrepared,
    /// Something is there that does not verify against the pinned release. It was left
    /// exactly as it is, with or without a source; builds refuse it until it is replaced.
    Changed,
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

/// `status` and `files` describe the provider set; `builder` the image builder, whose
/// own file joins `files` when this invocation read it.
#[derive(Debug, Serialize)]
struct Installation {
    status: &'static str,
    files: Vec<FileResult>,
    builder: Builder,
}
impl Installation {
    fn new(status: &'static str, files: Vec<FileResult>) -> Self {
        Self {
            status,
            files,
            builder: Builder::NotPrepared,
        }
    }

    fn reused() -> Self {
        Self::new("reused", Vec::new())
    }

    fn with_builder(mut self, (builder, file): (Builder, Option<FileResult>)) -> Self {
        self.builder = builder;
        self.files.extend(file);
        self
    }

    fn with_probe(self, probe: impl Serialize) -> serde_json::Value {
        serde_json::json!({"status": self.status, "builder": self.builder, "files": self.files, "probe": probe})
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
    retire: Option<&[FilePin]>,
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
    let setup = candidate.state_root.join("setup");
    let setup_lock = retire.and_then(|_| {
        let downloads = setup.join("downloads");
        downloads.symlink_metadata().ok()?;
        state::Lock::acquire_existing(&setup).ok().or_else(|| {
            eprintln!(
                "Native setup kept provider downloads because the setup lock was unavailable."
            );
            None
        })
    });
    // Existing-only admission never creates directories or a lock before consent.
    let _lock = state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm")).map_err(|e| {
        if e.code == "provider_busy" { e } else { CandidateError::new("setup_existing_invalid", "Existing provider lock is missing or unsafe; files were preserved. Finish manual preparation or use a fresh native home.") }
    })?;
    let ready = reuse(candidate, &target, verify)?;
    if ready && let (Some(_setup_lock), Some(files)) = (setup_lock, retire) {
        retire_downloads(candidate, files);
    }
    Ok(ready)
}

/// Verify a complete installation before asking for download consent. An absent home
/// creates nothing; an existing home uses its retained lock. Online reuse may retire
/// proven setup downloads. Offline reuse preserves all possible caller inputs.
pub fn reuse_existing(
    candidate: &Candidate,
    builder: BuilderSource<'_>,
    offline: bool,
) -> Result<Option<serde_json::Value>, CandidateError> {
    let (files, _) = pin_set()?;
    if !observe_existing(candidate, &verified_install, (!offline).then_some(&files))? {
        return Ok(None);
    }
    let installation =
        Installation::reused().with_builder(ensure_pinned_builder(candidate, builder)?);
    Ok(Some(installation.with_probe(super::probe_with_profile(
        candidate,
        super::Profile::Development,
    )?)))
}

/// Must be called only by the explicit setup command after consent (or with all offline
/// inputs). Does not boot a VM or touch trust, DNS, credentials or the system installation.
pub fn run(
    candidate: &Candidate,
    inputs: Option<OfflineInputs<'_>>,
    accepted: bool,
) -> Result<serde_json::Value, CandidateError> {
    let builder = BuilderSource::select(inputs, accepted);
    if let Some(result) = reuse_existing(candidate, builder, inputs.is_some())? {
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
        &pin_set()?.0,
        prepare_all,
        verified_install,
        download::client,
    )?
    .with_builder(ensure_pinned_builder(candidate, builder)?);
    Ok(installation.with_probe(super::probe_with_profile(
        candidate,
        super::Profile::Development,
    )?))
}

fn ensure_pinned_builder(
    candidate: &Candidate,
    source: BuilderSource<'_>,
) -> Result<(Builder, Option<FileResult>), CandidateError> {
    ensure_builder(
        candidate,
        source,
        &pin_set()?.1,
        |candidate, file| artifact::prepare_builder(candidate, file).map(drop),
        |candidate| artifact::verify_builder(candidate).map(drop),
        download::client,
    )
}

/// Add the image builder to a home whose provider set is published, or report it.
///
/// Additive by construction: it reads and writes only the builder's own directory and
/// record (through the manual preparation entrypoint, under the provider lock that
/// entrypoint takes) and the private download cache. It never stages, publishes or
/// re-prepares the provider set, which a running pool may be executing from. A builder
/// that is already prepared is verified and left alone, and without a source nothing is
/// written at all.
///
/// A builder that is there but does not verify is reported as changed and never
/// touched: setup does not fail a complete home for it, and does not delete or
/// overwrite it either, with or without a source. Builds keep refusing it.
fn ensure_builder(
    candidate: &Candidate,
    source: BuilderSource<'_>,
    pin: &FilePin,
    prepare: impl FnOnce(&Candidate, &Path) -> Result<(), CandidateError>,
    verify: impl Fn(&Candidate) -> Result<(), CandidateError>,
    client: impl FnOnce() -> Result<download::Client, CandidateError>,
) -> Result<(Builder, Option<FileResult>), CandidateError> {
    match verify(candidate) {
        Ok(()) => return Ok((Builder::Reused, None)),
        Err(error) if error.code == artifact::BUILDER_NOT_PREPARED => {}
        Err(_) => return Ok((Builder::Changed, None)),
    }
    let offline = match source {
        BuilderSource::Absent => return Ok((Builder::NotPrepared, None)),
        BuilderSource::File(file) => Some(file),
        BuilderSource::Download => None,
    };
    // Serialize with other setups: the download cache belongs to the setup lock holder.
    let _setup_lock = state::Lock::acquire(&candidate.state_root.join("setup"))?;
    let (file, result) = if let Some(file) = offline {
        download::verify_input(file, pin)?;
        (
            file.to_path_buf(),
            FileResult::new(pin, Outcome::Offline, 0)?,
        )
    } else {
        let downloads = download_directory(candidate);
        state::private_directory(&downloads)?;
        let result = download::acquire(&client()?, &downloads, pin)?;
        (downloads.join(pin.name()?), result)
    };
    // The file passed its pinned hash and length; preparation hashes its own copy again.
    prepare(candidate, &file)?;
    verify(candidate)?;
    Ok((Builder::Installed, Some(result)))
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
            if inputs.is_none() {
                retire_downloads(candidate, files);
            }
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
        for (index, pin) in files.iter().enumerate() {
            results.push(if index < 2 {
                download::acquire_provider_archive(&client, &downloads, pin)?
            } else {
                download::acquire(&client, &downloads, pin)?
            });
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
        if inputs.is_none() {
            retire_downloads(candidate, files);
        }
        return Ok(Installation::new("reused", results));
    }
    publish(candidate, &setup, &target, |staged| {
        prepare(
            staged,
            OfflineInputs {
                archive: &archive,
                engine_archive: &engine,
                network_tools: &packages,
                builder: None,
            },
        )?;
        verify(staged)
    })?;
    if inputs.is_none() {
        retire_downloads(candidate, files);
    }
    Ok(Installation::new("installed", results))
}

/// A retry may have observed publication before the original setup synced it.
fn retire_downloads(candidate: &Candidate, files: &[FilePin]) {
    let directory = download_directory(candidate);
    if matches!(directory.symlink_metadata(), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        return;
    }
    if fs::File::open(&candidate.state_root)
        .and_then(|home| home.sync_all())
        .is_err()
    {
        eprintln!("Native setup kept provider downloads because it could not sync publication.");
        return;
    }
    for pin in files.iter().take(2) {
        if download::remove_provider_archive(&directory, pin).is_err() {
            eprintln!(
                "Native setup kept {} because safe archive removal could not be proven.",
                pin.name().unwrap_or("provider archive")
            );
        }
        #[cfg(test)]
        tests::publication_checkpoint("between_unlinks");
    }
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
