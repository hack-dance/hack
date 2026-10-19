//! Compaction of retired graph-bound allocation intents.
//!
//! Ordinary graph cleanup retires every bound slot under the provider mutation lease, but each
//! immutable intent used to stay in `run/environment-leases` indefinitely. Admission, cleanup and
//! restore then scanned every historical generation of a repeatedly started graph. After the
//! caller confirms each recorded container and guest slot absent, compaction retains the exact
//! intent digest in one per-run tombstone and unlinks the active record.
//!
//! Commit and recovery points, in order:
//! 1. The tombstone gains per-slot `retired` digests (atomic rename plus directory sync). No
//!    active record is unlinked before this is durable, so a leftover tombstone temporary file
//!    is an uncommitted write with no authority and is discarded.
//! 2. Active records whose exact bytes match a retired digest are unlinked; the directory is
//!    synced. Until then such a record is residue: read-only inventory treats it as retired and
//!    the next compaction completes the unlink. Changed bytes are refused, never removed.
//! 3. Retired slots of prior guest boots are folded into one sealed summary per boot. A prior
//!    boot cannot allocate again, so the whole boot stays reserved without per-slot entries.
//!
//! Reservation: a retired slot, or any slot of a sealed boot, can never be recorded again,
//! selected for delivery, retired as live, or counted as a live allocation. Records are never
//! deleted to make room: an uncertain (pending), live, changed, misbound or foreign-owned record
//! refuses the whole compaction before its first write. Records of other runs, standalone
//! records and other incarnations' state are never modified.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const VERSION: u32 = 1;
/// Per-slot reservations retained for boots that may still allocate (normally the current one).
const MAX_RETIRED_SLOTS: usize = 16 * 1024;
const MAX_SEALED_BOOTS: usize = 4096;
/// Covers both maxima in pretty-printed JSON with margin; larger state is refused, not truncated.
const TOMBSTONE_LIMIT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    slots: u32,
    sha256: String,
}

/// Value-free retained evidence for one graph run. Bound to the owning VM incarnation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Tombstone {
    version: u32,
    run: String,
    incarnation: String,
    sealed: BTreeMap<String, Sealed>,
    retired: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Reservation<'a> {
    Free,
    Retired(&'a str),
    Sealed,
}

/// Value-free outcome counts for one compaction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Compaction {
    /// Newly confirmed records moved into the tombstone.
    pub compacted: usize,
    /// Residue of an interrupted compaction whose unlink was completed.
    pub completed: usize,
    /// Prior boots folded into sealed reservations.
    pub sealed_boots: usize,
}

/// `Resume` only completes an interrupted compaction: it selects no new record and seals nothing,
/// so it is safe where live allocations of the run may remain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Compact,
    Resume,
}

/// Owner identity and receipt bindings for one compaction.
#[derive(Clone, Copy)]
pub(super) struct Request<'a> {
    pub mode: Mode,
    /// VM incarnation that owns every record; others refuse.
    pub incarnation: &'a str,
    /// Current guest boot; it may still allocate, so it is never sealed.
    pub boot: &'a str,
    pub run: &'a str,
    /// Receipt service-to-container bindings each selected record must match.
    pub containers: &'a BTreeMap<String, String>,
}

/// Fault boundaries observed by in-process interruption tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Step {
    Recorded,
    Unlinked,
    Synced,
    Sealed,
}

fn directory(candidate: &Candidate) -> PathBuf {
    candidate
        .state_root
        .join("run/environment-lease-tombstones")
}

/// Boot UUID of a `hack-env-lease-<uuid>-<hex>` slot. Callers validate the slot first; an
/// invalid identity yields an empty boot that matches no reservation.
fn boot_of(slot: &str) -> &str {
    let start = "hack-env-lease-".len();
    slot.get(start..start + 36).unwrap_or("")
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn present(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}

fn sync(directory: &Path) -> Result<(), CandidateError> {
    fs::File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(state::io)
}

impl Tombstone {
    fn new(run: &str, incarnation: &str) -> Self {
        Self {
            version: VERSION,
            run: run.into(),
            incarnation: incarnation.into(),
            sealed: BTreeMap::new(),
            retired: BTreeMap::new(),
        }
    }

    fn validate(&self, run: &str, incarnation: &str) -> Result<(), CandidateError> {
        if self.version != VERSION
            || self.run != run
            || self.incarnation != incarnation
            || !hex(run, 32)
            || !hex(incarnation, 32)
            || self.retired.len() > MAX_RETIRED_SLOTS
            || self.sealed.len() > MAX_SEALED_BOOTS
            || self
                .sealed
                .iter()
                .any(|(boot, sealed)| !uuid(boot) || sealed.slots == 0 || !hex(&sealed.sha256, 64))
            || self.retired.iter().any(|(slot, sha)| {
                !valid_slot(slot) || !hex(sha, 64) || self.sealed.contains_key(boot_of(slot))
            })
        {
            return Err(error());
        }
        Ok(())
    }

    fn reservation(&self, slot: &str) -> Reservation<'_> {
        if !valid_slot(slot) || self.sealed.contains_key(boot_of(slot)) {
            return Reservation::Sealed;
        }
        match self.retired.get(slot) {
            Some(sha) => Reservation::Retired(sha),
            None => Reservation::Free,
        }
    }
}

fn load_at(path: &Path, run: &str, incarnation: &str) -> Result<Option<Tombstone>, CandidateError> {
    if !present(path)? {
        return Ok(None);
    }
    let tombstone: Tombstone = state::read_bounded(path, TOMBSTONE_LIMIT)?;
    tombstone.validate(run, incarnation)?;
    Ok(Some(tombstone))
}

/// Read-only. A run that cannot name a valid binding has no tombstone to consult.
pub(super) fn load(
    candidate: &Candidate,
    run: &str,
    incarnation: &str,
) -> Result<Option<Tombstone>, CandidateError> {
    if !hex(run, 32) {
        return Ok(None);
    }
    let parent = directory(candidate);
    crate::reject_aliased_state(&parent)?;
    if !parent.try_exists().map_err(state::io)? {
        return Ok(None);
    }
    state::check_private_directory(&parent)?;
    load_at(&parent.join(format!("{run}.json")), run, incarnation)
}

/// Whether an already loaded tombstone reserves the slot.
pub(super) fn reserves(tombstone: Option<&Tombstone>, slot: &str) -> bool {
    tombstone.is_some_and(|tombstone| tombstone.reservation(slot) != Reservation::Free)
}

/// Whether the slot is reserved by retained evidence, whether or not residue remains active.
pub(super) fn reserved(
    candidate: &Candidate,
    run: &str,
    incarnation: &str,
    slot: &str,
) -> Result<bool, CandidateError> {
    Ok(reserves(load(candidate, run, incarnation)?.as_ref(), slot))
}

/// Read-only classification for inventory. `true` means the committed active record is exact
/// residue of a durable compaction: retired, never live, and removed by the next compaction.
/// A sealed-boot replay, changed bytes or an uncertain pending record refuses.
pub(super) fn residue(
    candidate: &Candidate,
    tombstone: Option<&Tombstone>,
    slot: &str,
) -> Result<bool, CandidateError> {
    let Some(tombstone) = tombstone else {
        return Ok(false);
    };
    match tombstone.reservation(slot) {
        Reservation::Free => Ok(false),
        Reservation::Sealed => Err(error()),
        Reservation::Retired(sha) => {
            let committed = root(candidate).join(format!("{slot}.json"));
            if present(&committed.with_extension("pending"))?
                || digest(&retention::bytes(&committed)?) != sha
            {
                return Err(error());
            }
            Ok(true)
        }
    }
}

/// A leftover temporary file means the rename never committed (see module commit point 1).
fn discard_uncommitted(path: &Path) -> Result<(), CandidateError> {
    let metadata = match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(state::io(e)),
        Ok(metadata) => metadata,
    };
    // SAFETY: geteuid has no preconditions.
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > TOMBSTONE_LIMIT
    {
        return Err(error());
    }
    fs::remove_file(path).map_err(state::io)?;
    sync(path.parent().ok_or_else(error)?)
}

/// Commit point: atomic rename plus parent sync. Only the uncommitted temporary is replaced.
fn commit(parent: &Path, path: &Path, tombstone: &Tombstone) -> Result<(), CandidateError> {
    state::private_directory(parent)?;
    discard_uncommitted(&path.with_extension("pending"))?;
    state::write(path, tombstone)
}

/// Compact every confirmed-retired record bound to `run`. The caller holds the provider mutation
/// lease, has completed graph cleanup and passes the receipt's service-to-container bindings.
pub(crate) fn compact_graph(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    run: &str,
    containers: &BTreeMap<String, String>,
) -> Result<Compaction, CandidateError> {
    compact_with(
        candidate,
        Request {
            mode: Mode::Compact,
            incarnation: guest.incarnation(),
            boot: guest.boot_id(),
            run,
            containers,
        },
        |intent| {
            if let Some(binding) = &intent.graph {
                super::super::engine::require_container_absent(guest, &binding.container)?;
            }
            retention::absent(guest, &intent.slot)
        },
        |_| Ok(()),
    )
}

/// Complete only an interrupted compaction of `run`, under the caller's mutation lease. Exact
/// residue is unlinked; every other record is left untouched. No tombstone means no effect.
pub(crate) fn resume_graph(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    run: &str,
) -> Result<Compaction, CandidateError> {
    if load(candidate, run, guest.incarnation())?.is_none() {
        return Ok(Compaction::default());
    }
    compact_with(
        candidate,
        Request {
            mode: Mode::Resume,
            incarnation: guest.incarnation(),
            boot: guest.boot_id(),
            run,
            containers: &BTreeMap::new(),
        },
        |_| Err(error()),
        |_| Ok(()),
    )
}

/// Filesystem state machine behind [`compact_graph`]. `confirm` proves one selected allocation
/// absent; `fault` lets tests stop at each commit boundary as an interruption would.
pub(super) fn compact_with(
    candidate: &Candidate,
    request: Request<'_>,
    confirm: impl Fn(&Intent) -> Result<(), CandidateError>,
    mut fault: impl FnMut(Step) -> Result<(), CandidateError>,
) -> Result<Compaction, CandidateError> {
    let Request {
        mode,
        incarnation,
        boot,
        run,
        containers,
    } = request;
    if !hex(run, 32) || !hex(incarnation, 32) || !uuid(boot) {
        return Err(error());
    }
    let parent = directory(candidate);
    let path = parent.join(format!("{run}.json"));
    let mut tombstone =
        load(candidate, run, incarnation)?.unwrap_or_else(|| Tombstone::new(run, incarnation));
    if tombstone.sealed.contains_key(boot) {
        return Err(error());
    }

    // Inventory and confirm every record bound to this run before the first write.
    let active = root(candidate);
    let mut residue = Vec::new();
    let mut selected = BTreeMap::new();
    for slot in recorded_slots(candidate)? {
        let intent = read_mode(candidate, &slot, incarnation, None, false)?;
        let Some(binding) = intent.graph.as_ref().filter(|binding| binding.run == run) else {
            continue;
        };
        let reservation = tombstone.reservation(&slot);
        if mode == Mode::Resume && reservation == Reservation::Free {
            continue;
        }
        let committed = active.join(format!("{slot}.json"));
        if present(&committed.with_extension("pending"))? {
            return Err(error());
        }
        let sha = digest(&retention::bytes(&committed)?);
        match reservation {
            Reservation::Sealed => return Err(error()),
            Reservation::Retired(expected) if expected == sha => residue.push(slot),
            Reservation::Retired(_) => return Err(error()),
            Reservation::Free => {
                if containers.get(&intent.service) != Some(&binding.container)
                    || retention::reserved(candidate, &slot)?
                {
                    return Err(error());
                }
                confirm(&intent)?;
                selected.insert(slot, sha);
            }
        }
    }
    let outcome = Compaction {
        compacted: selected.len(),
        completed: residue.len(),
        sealed_boots: 0,
    };

    if !selected.is_empty() {
        if tombstone.retired.len() + selected.len() > MAX_RETIRED_SLOTS {
            return Err(error());
        }
        tombstone.retired.extend(selected.clone());
        commit(&parent, &path, &tombstone)?;
        fault(Step::Recorded)?;
    }
    for slot in residue.iter().chain(selected.keys()) {
        let committed = active.join(format!("{slot}.json"));
        if tombstone.retired.get(slot) != Some(&digest(&retention::bytes(&committed)?)) {
            return Err(error());
        }
        fs::remove_file(&committed).map_err(state::io)?;
        fault(Step::Unlinked)?;
    }
    if outcome.compacted + outcome.completed > 0 {
        sync(&active)?;
        fault(Step::Synced)?;
    }

    // Resume may leave unselected records of this run active, so it never seals a boot.
    if mode == Mode::Resume {
        return Ok(outcome);
    }
    // Every record of this run was unlinked above or refused the compaction, so no active
    // allocation of a prior boot remains. Its whole boot is then reserved by one summary.
    let prior: BTreeSet<String> = tombstone
        .retired
        .keys()
        .map(|slot| boot_of(slot).to_owned())
        .filter(|retired| retired != boot)
        .collect();
    if prior.is_empty() {
        return Ok(outcome);
    }
    if tombstone.sealed.len() + prior.len() > MAX_SEALED_BOOTS {
        return Err(error());
    }
    for retired in &prior {
        let slots: Vec<(String, String)> = tombstone
            .retired
            .iter()
            .filter(|(slot, _)| boot_of(slot) == retired)
            .map(|(slot, sha)| (slot.clone(), sha.clone()))
            .collect();
        let mut summary = Sha256::new();
        for (slot, sha) in &slots {
            summary.update(format!("{slot} {sha}\n"));
            tombstone.retired.remove(slot);
        }
        tombstone.sealed.insert(
            retired.clone(),
            Sealed {
                slots: u32::try_from(slots.len()).map_err(|_| error())?,
                sha256: format!("{:x}", summary.finalize()),
            },
        );
    }
    commit(&parent, &path, &tombstone)?;
    fault(Step::Sealed)?;
    Ok(Compaction {
        sealed_boots: prior.len(),
        ..outcome
    })
}

#[cfg(test)]
mod tests;
