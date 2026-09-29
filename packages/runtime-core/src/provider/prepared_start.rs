//! Opt-in prepared-base selection when a pool's disks are first formatted, and the
//! lifecycle hooks that keep template integrity, adoption and network-tools ownership consistent
//! with that choice.
//!
//! `lifecycle` calls this module at five points, each under the pool's held operation lock:
//! 1. [`before_create`], fresh pools only: roll back an unstarted activation of this pool, then
//!    activate the newest independently verified base bound to this pool's pins, or keep the
//!    stock templates with a typed reason (`require` refuses instead), and verify whichever
//!    templates the first start will clone.
//! 2. [`verify`], before each start and after the first start until disk adoption: a bound
//!    pool's activated templates against its receipt; otherwise the stock SmolVM pins. Neither
//!    check is ever skipped, and a base is never checked against the stock pins.
//! 3. [`after_adoption`]: remove the activated templates once the first start's disks are
//!    adopted. A failure is recorded and retried at the next boot; it never stops a healthy pool.
//! 4. [`network_tools_owner`]: the base-scoped owner for bound pools and seed builds.
//! 5. [`status`]: the recorded selection and activation state, read without the lock.
//!
//! Fallback vs refusal: `prefer` keeps the stock templates when no usable base exists or a base
//! fails activation (digest mismatch, different volume, busy or unreadable store). Pool-level
//! ambiguity (an unowned template, an interrupted record write that cannot be proven, an
//! activation that does not match this pool) always refuses, because the pool's own state is
//! uncertain. A pool that never asked for a base behaves exactly as before.
use super::disk_template::{self, Stage};
use super::prepared_base::{self, ActivationRecord, ActivationState, Pins, PoolTarget, TEMPLATES};
use super::prepared_store::{self, StoreLock};
use super::state::{self, Owner};
use super::{BridgeIntent, bridge};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const SELECTION: &str = "prepared-base-selection.json";
const RECORD: &str = "prepared-base.json";
const SEED: &str = "prepared-seed.json";
const TEMPLATE_DIR: &str = "home/.smolvm";
const LIMIT: u64 = 64 * 1024;

fn error(code: &'static str, message: impl Into<String>) -> CandidateError {
    CandidateError::new(code, message)
}

/// How strongly a fresh pool asks for a prepared base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Use a usable base; otherwise keep the stock templates and record why.
    Prefer,
    /// Use a usable base or refuse before anything is created.
    Require,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "prefer" => Some(Self::Prefer),
            "require" => Some(Self::Require),
            _ => None,
        }
    }
}

/// A prepared-base request for one `up`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub mode: Mode,
    /// Explicit, absolute, private store on the same APFS volume as the pool.
    pub store: PathBuf,
}

/// Pool bridge selection for `up_with_prepared_base`; mirrors the private bridge request.
#[derive(Debug, Clone, Copy)]
pub enum Bridges {
    Exact(Option<BridgeIntent>),
    Minimum(BridgeIntent),
}

impl From<Bridges> for bridge::Request {
    fn from(bridges: Bridges) -> Self {
        match bridges {
            Bridges::Exact(intent) => Self::Exact(intent),
            Bridges::Minimum(intent) => Self::Minimum(intent),
        }
    }
}

/// Per-invocation startup selections that do not change pool capacity.
#[derive(Debug, Clone, Copy, Default)]
pub struct Start<'a> {
    /// Expected retained foreground run and selection, as `up_with_retained_project_share`.
    pub retained: Option<(&'a str, &'a str)>,
    /// Prepared-base request for a fresh pool; `None` keeps the stock templates.
    pub prepared: Option<&'a Request>,
}

/// Where a pool's first-start templates come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Prepared,
    Stock,
}

/// The recorded choice for this pool, for status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub mode: Mode,
    pub source: Source,
    pub base_id: Option<String>,
    /// Why the stock templates were kept.
    pub reason: Option<String>,
    /// Why removing the activated templates after adoption failed; retried at the next boot.
    pub consume_error: Option<String>,
}

/// Prepared-base state reported by `runtime status`.
#[derive(Debug, Serialize)]
pub struct Status {
    pub selection: Option<Selection>,
    pub activation: Option<ActivationState>,
    pub base_id: Option<String>,
}

fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm")
}

fn disks(candidate: &Candidate, owner: &Owner) -> Result<[PathBuf; 2], CandidateError> {
    let dir = owner.real_data_dir(candidate)?;
    Ok([dir.join("storage.raw"), dir.join("overlay.raw")])
}

fn with_target<T>(
    candidate: &Candidate,
    owner: &Owner,
    lock: &state::Lock,
    operation: impl FnOnce(&PoolTarget<'_>) -> Result<T, CandidateError>,
) -> Result<T, CandidateError> {
    let root = root(candidate);
    let disks = disks(candidate, owner)?;
    let target = PoolTarget::new(&root, lock, [&disks[0], &disks[1]])?;
    operation(&target)
}

enum Choice {
    Fallback(String),
    Refuse(CandidateError),
}

/// Hook 1: choose and activate the templates a fresh pool's first start will clone, then verify
/// them. Runs before the pool records a create attempt, so every refusal leaves it retryable.
pub(super) fn before_create(
    candidate: &Candidate,
    owner: &Owner,
    lock: &state::Lock,
    request: Option<&Request>,
) -> Result<(), CandidateError> {
    with_target(candidate, owner, lock, |target| {
        // A never-started pool's unfinished activation is rolled back before any new choice;
        // an unprovable one refuses.
        prepared_base::recover(target)?;
        let templates = root(candidate).join(TEMPLATE_DIR);
        let Some(request) = request else {
            remove_selection(candidate)?;
            return disk_template::verify_expanded(&templates, Stage::BeforeUse);
        };
        let mut selection = Selection {
            mode: request.mode,
            source: Source::Stock,
            base_id: None,
            reason: None,
            consume_error: None,
        };
        match choose(owner, target, &templates, request) {
            Ok(base_id) => {
                selection.source = Source::Prepared;
                selection.base_id = Some(base_id);
                write_selection(candidate, &selection)
            }
            Err(Choice::Refuse(failure)) => Err(failure),
            Err(Choice::Fallback(reason)) if request.mode == Mode::Require => Err(error(
                "prepared_base_unavailable",
                format!("No usable prepared base ({reason}); nothing was created."),
            )),
            Err(Choice::Fallback(reason)) => {
                selection.reason = Some(reason);
                write_selection(candidate, &selection)?;
                disk_template::verify_expanded(&templates, Stage::BeforeUse)
            }
        }
    })
}

/// Errors that make a base unusable without saying anything about this pool's own state.
const BASE_FAILURES: [&str; 10] = [
    "prepared_base_digest",
    "prepared_base_unsupported",
    "prepared_base_missing",
    "prepared_base_incomplete",
    "prepared_base_invalid",
    "prepared_base_ownership",
    "prepared_base_capacity",
    "prepared_base_pin_mismatch",
    "prepared_base_exists",
    "prepared_base_store_busy",
];

fn choose(
    owner: &Owner,
    target: &PoolTarget<'_>,
    templates: &Path,
    request: &Request,
) -> Result<String, Choice> {
    for name in TEMPLATES {
        let path = templates.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(Choice::Fallback("stock_templates_present".into())),
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
            Err(failure) => return Err(Choice::Refuse(state::io(failure))),
        }
    }
    let rootfs = owner.rootfs_digest.as_deref().ok_or_else(|| {
        Choice::Refuse(error(
            "prepared_base_invalid",
            "The pool's agent rootfs digest is not recorded yet.",
        ))
    })?;
    let pins = Pins::current(owner.profile, rootfs);
    let unavailable = |failure: CandidateError| Choice::Fallback(format!("store:{}", failure.code));
    // Held through the clone and its verification, so no base is removed underneath them.
    let _shared = StoreLock::shared(&request.store).map_err(unavailable)?;
    let base = prepared_store::select(&request.store, &pins)
        .map_err(unavailable)?
        .ok_or_else(|| Choice::Fallback("no_verified_base_for_pins".into()))?;
    match prepared_base::activate(&base, &pins, target) {
        Ok(record) => Ok(record.base_id),
        Err(failure) if BASE_FAILURES.contains(&failure.code) => {
            Err(Choice::Fallback(format!("activation:{}", failure.code)))
        }
        Err(failure) => Err(Choice::Refuse(failure)),
    }
}

/// Hook 2: verify the templates a start may clone, until the pool adopts its disks.
pub(super) fn verify(
    candidate: &Candidate,
    owner: &Owner,
    lock: &state::Lock,
    stage: Stage,
) -> Result<(), CandidateError> {
    if owner.storage.is_some() && owner.overlay.is_some() {
        return Ok(());
    }
    with_target(
        candidate,
        owner,
        lock,
        |target| match ActivationRecord::load(target)? {
            None => disk_template::verify_expanded(&root(candidate).join(TEMPLATE_DIR), stage),
            Some(record) if record.state == ActivationState::Activated => {
                prepared_base::verify_activated(target).map(|_| ())
            }
            Some(_) => Err(error(
                "prepared_base_recovery_required",
                "This pool's prepared-base activation is not in place while its disks are unadopted; nothing was started.",
            )),
        },
    )
}

/// Hook 3: after the first start's disks are adopted, remove the activated templates. Never
/// fails the boot: a refusal is recorded for status and retried at the next boot.
pub(super) fn after_adoption(candidate: &Candidate, owner: &Owner, lock: &state::Lock) {
    let outcome = with_target(
        candidate,
        owner,
        lock,
        |target| match ActivationRecord::load(target)? {
            Some(record) if record.state == ActivationState::Activated => {
                prepared_base::consume(target)
            }
            _ => Ok(()),
        },
    );
    if let Ok(Some(mut selection)) = read_selection(candidate) {
        let consume_error = outcome
            .err()
            .map(|failure| format!("{}: {}", failure.code, failure.message));
        if selection.consume_error != consume_error {
            selection.consume_error = consume_error;
            // Status only: the activation record, not this file, decides the retry.
            let _ = write_selection(candidate, &selection);
        }
    }
}

/// Hook 4: the owner recorded in the guest network-tools receipt.
pub(super) fn network_tools_owner(
    candidate: &Candidate,
    owner: &Owner,
    lock: &state::Lock,
) -> Result<String, CandidateError> {
    let record = with_target(candidate, owner, lock, ActivationRecord::load)?;
    if record.is_some() {
        return Ok(prepared_base::network_tools_owner(
            record.as_ref(),
            &owner.token,
        ));
    }
    Ok(match seed_base_id(candidate)? {
        Some(base_id) => format!("prepared-base:{base_id}"),
        None => owner.token.clone(),
    })
}

/// A seed build's marker: its pool installs network tools under the base-scoped owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SeedMarker {
    pub base_id: String,
    /// The seed's own state root; a marker copied anywhere else is refused.
    pub state_root: PathBuf,
}

fn seed_base_id(candidate: &Candidate) -> Result<Option<String>, CandidateError> {
    let path = root(candidate).join(SEED);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    let marker: SeedMarker = serde_json::from_slice(&prepared_base::read_private(&path, LIMIT)?)
        .map_err(|_| error("prepared_base_invalid", "Malformed prepared-seed marker."))?;
    if marker.state_root != candidate.state_root || !prepared_base::valid_base_id(&marker.base_id) {
        return Err(error(
            "foreign_state",
            "Prepared-seed marker does not belong to this state root; nothing was started.",
        ));
    }
    Ok(Some(marker.base_id))
}

/// Mark `candidate`'s fresh pool as the seed for `base_id`.
pub(super) fn write_seed_marker(
    candidate: &Candidate,
    base_id: &str,
) -> Result<(), CandidateError> {
    state::private_directory(&root(candidate))?;
    write_private(
        &root(candidate).join(SEED),
        &SeedMarker {
            base_id: base_id.into(),
            state_root: candidate.state_root.clone(),
        },
    )
}

/// Hook 5: status, read without the pool lock and without blocking.
pub fn status(candidate: &Candidate) -> Option<Status> {
    let selection = read_selection(candidate).ok().flatten();
    let record: Option<ActivationRecord> =
        prepared_base::read_private(&root(candidate).join(RECORD), LIMIT)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    if selection.is_none() && record.is_none() {
        return None;
    }
    Some(Status {
        selection,
        activation: record.as_ref().map(|record| record.state),
        base_id: record.map(|record| record.base_id),
    })
}

fn read_selection(candidate: &Candidate) -> Result<Option<Selection>, CandidateError> {
    let path = root(candidate).join(SELECTION);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    serde_json::from_slice(&prepared_base::read_private(&path, LIMIT)?)
        .map(Some)
        .map_err(|_| {
            error(
                "prepared_base_invalid",
                "Malformed prepared-base selection.",
            )
        })
}

fn write_selection(candidate: &Candidate, selection: &Selection) -> Result<(), CandidateError> {
    write_private(&root(candidate).join(SELECTION), selection)
}

fn remove_selection(candidate: &Candidate) -> Result<(), CandidateError> {
    match fs::remove_file(root(candidate).join(SELECTION)) {
        Err(failure) if failure.kind() != std::io::ErrorKind::NotFound => Err(state::io(failure)),
        _ => Ok(()),
    }
}

/// Write a small private JSON file atomically under a unique temporary name, so an interrupted
/// write can never block a later one (unlike a fixed pending name).
fn write_private(path: &Path, value: &impl Serialize) -> Result<(), CandidateError> {
    let parent = path.parent().expect("pool file parent");
    let mut random = [0_u8; 8];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut random))
        .map_err(state::io)?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = parent.join(format!(
        ".{}.{suffix}.pending",
        path.file_name().expect("pool file name").to_string_lossy()
    ));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|failure| error("prepared_base_invalid", failure.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(state::io)?;
    let written = file
        .write_all(&bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, path))
        .and_then(|()| File::open(parent).and_then(|dir| dir.sync_all()));
    if let Err(failure) = written {
        let _ = fs::remove_file(&temporary);
        return Err(state::io(failure));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
