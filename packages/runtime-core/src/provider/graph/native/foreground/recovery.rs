//! Explicit native recovery selectors and durable monotonic intent. Live control
//! and ordinary DirectGuard never acquire authority from a dead publication.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const FILE: &str = "live-owner-recovery.json";
// Keep the complete intent inside the existing secure reader's admitted bound.
// Oversized original selections cannot acquire retry authority.
const LIMIT: usize = 64 * 1024;
fn refused() -> CandidateError {
    error(
        "native_graph_live_owner_recovery",
        "Native dead-owner recovery requires an exact settled resource selection, dead boot-qualified publisher and unchanged durable progress; pending effects and evidence are retained.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", crate::Hex(Sha256::digest(bytes)))
}
fn id(path: &Path) -> Result<(u64, u64), CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
    Ok((metadata.dev(), metadata.ino()))
}
fn exists(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}
/// The frontend may retry the original selection after losing a recovery reply,
/// including after the publication has moved out of its live paths.
pub(in crate::provider::graph::native) fn requires_active(
    root: &Path,
) -> Result<bool, CandidateError> {
    Ok(exists(&root.join(FILE))? || exists(&root.join("live-owner-recovery.pending"))?)
}
fn directory(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    let root = journal::directory(candidate, run)?;
    for path in root
        .ancestors()
        .take_while(|path| path.starts_with(&candidate.state_root))
    {
        state::check_private_directory(path).map_err(|_| refused())?;
    }
    if exists(&root.join("state.pending"))? || exists(&root.join("live-owner-recovery.pending"))? {
        return Err(refused());
    }
    Ok(root)
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Progress {
    Cleanup,
    EnvironmentRetired,
    SocketRetirementIntent,
    SocketRetired,
    OwnerRetirementIntent,
    Complete,
}
impl Progress {
    fn verify(&self, lease: &owner::RecoveryLease<'_>) -> Result<(), CandidateError> {
        let (socket_original, owner_original) = lease
            .verify(
                *self >= Self::SocketRetirementIntent,
                *self >= Self::OwnerRetirementIntent,
            )
            .map_err(|_| refused())?;
        if (*self < Self::SocketRetirementIntent && (!socket_original || !owner_original))
            || (*self == Self::SocketRetirementIntent && !owner_original)
            || (*self == Self::SocketRetired && (socket_original || !owner_original))
            || (*self == Self::OwnerRetirementIntent && socket_original)
            || (*self == Self::Complete && (socket_original || owner_original))
        {
            return Err(refused());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum IntentKind {
    NativeGraphLiveOwnerRecovery,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    kind: IntentKind,
    run: String,
    journal_parent: (u64, u64),
    original: String,
    receipt_sha256: String,
    publication: owner::RecoverySelection,
    progress: Progress,
    receipt_progress: u8,
    resource_progress: BTreeMap<String, u8>,
    environment: crate::provider::native_environment::Inventory,
}
fn receipt_progress(receipt: &Receipt) -> Result<u8, CandidateError> {
    match receipt.phase {
        // `preparing` is admitted only from an ended boot ([`admitted_original`]).
        Phase::Preparing | Phase::ReadyObserved | Phase::FailedRetained => Ok(0),
        Phase::StopIntent => Ok(1),
        Phase::Stopped => Ok(2),
        Phase::RemovalIntent => Ok(3),
        Phase::Removed => Ok(4),
    }
}
fn resource_progress(receipt: &Receipt) -> Result<BTreeMap<String, u8>, CandidateError> {
    receipt
        .resources
        .iter()
        .map(|(key, resource)| {
            let rank = match (&resource.kind, resource.phase.as_str()) {
                (Kind::Container, "created" | "started") | (Kind::Network, "created") => 0,
                (Kind::Container | Kind::Network, "reserved") if resource.id.is_none() => 0,
                // An effect a start of an ended boot left pending ([`admitted_original`]):
                // that guest is gone, so the cleanup observes its outcome by id or exact
                // name, and refuses a present member it cannot attribute.
                (Kind::Container, "create-intent" | "start-intent" | "uncertain")
                | (Kind::Network, "create-intent" | "uncertain") => 0,
                (Kind::Container, "stopped") | (Kind::Network, "remove-intent") => 1,
                (Kind::Container | Kind::Network, "removed") => 2,
                _ => return Err(refused()),
            };
            Ok((key.clone(), rank))
        })
        .collect()
}
impl Intent {
    fn original(&self, run: &str, ended: bool) -> Result<Receipt, CandidateError> {
        if !matches!(self.version, 1 | 2)
            || self.run != run
            || self.original.len() > 64 * 1024
            || !super::super::super::hex(&self.receipt_sha256, 64)
            || digest(self.original.as_bytes()) != self.receipt_sha256
            || self.receipt_progress > 4
        {
            return Err(refused());
        }
        let receipt: Receipt = serde_json::from_str(&self.original).map_err(|_| refused())?;
        if self.version == 1 {
            receipt.require_recovery_ready().map_err(|_| refused())?;
        } else if !ended {
            receipt.require_recovery_settled().map_err(|_| refused())?;
        }
        if receipt.review.scope().run != run
            || self.receipt_progress < receipt_progress(&receipt)?
            || self.resource_progress.keys().ne(receipt.resources.keys())
            || self.resource_progress.iter().any(|(key, rank)| {
                *rank > 2
                    || (self.version == 1
                        && *rank == 1
                        && receipt.resources[key].kind != Kind::Network)
            })
        {
            return Err(refused());
        }
        Ok(receipt)
    }
    fn current(
        &self,
        root: &Path,
        original: &Receipt,
        current: &Receipt,
        bytes: &str,
    ) -> Result<(), CandidateError> {
        current.check_binding(original).map_err(|_| refused())?;
        let rank = receipt_progress(current)?;
        let resources = resource_progress(current)?;
        if id(root)? != self.journal_parent
            || rank < receipt_progress(original)?
            || rank < self.receipt_progress
            || (rank == 0 && digest(bytes.as_bytes()) != self.receipt_sha256)
            || (self.progress != Progress::Cleanup && rank != 4)
            || resources
                .iter()
                .any(|(key, rank)| *rank < self.resource_progress[key])
            || resources.iter().any(|(key, rank)| {
                *rank == 0 && current.resources[key].phase != original.resources[key].phase
            })
        {
            return Err(refused());
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum SelectionKind {
    NativeGraphRecoverySelection,
}
/// Read-only original selectors. They prove no current guest boot or resource
/// condition and are independently re-admitted by effectful cleanup. The first
/// selection captures the current private publication, not an external prior
/// owner-file inode; a committed intent anchors that admitted inode and digest.
#[derive(Serialize)]
pub struct Selection {
    version: u8,
    kind: SelectionKind,
    run: String,
    receipt: Receipt,
    receipt_sha256: String,
    owner_sha256: String,
    /// Present (`true`) only when the receipt belongs to an ended pool boot (HACK-2715):
    /// the selected receipt may then be a start caught mid-way, which only an ended
    /// boot's cleanup admits. Absent otherwise, so same-boot selections keep their bytes.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    ended_boot: bool,
    #[serde(flatten)]
    host_boot: SelectionBoot,
}
/// Exactly one original qualifier; the output version is selected from it.
#[derive(Serialize)]
#[serde(untagged)]
enum SelectionBoot {
    Legacy { host_boot_micros: u64 },
    Session { host_boot_uuid: host_boot::Session },
}
struct Admitted<'a> {
    candidate: &'a Candidate,
    run: &'a str,
    root: PathBuf,
    root_identity: (u64, u64),
    lease: owner::RecoveryLease<'a>,
    original: Receipt,
    original_bytes: String,
    receipt_sha256: String,
    intent: Option<Intent>,
    witness: Option<((u64, u64), Vec<u8>)>,
    /// Whether the original receipt belongs to an ended pool boot ([`admitted_original`]).
    ended_boot: bool,
}
impl Admitted<'_> {
    fn selection(&self) -> Result<Selection, CandidateError> {
        let (version, host_boot) = match self.lease.host_boot().map_err(|_| refused())? {
            owner::HostBoot::LegacyMicros(host_boot_micros) => {
                (1, SelectionBoot::Legacy { host_boot_micros })
            }
            owner::HostBoot::Session(host_boot_uuid) => {
                (2, SelectionBoot::Session { host_boot_uuid })
            }
        };
        Ok(Selection {
            version,
            kind: SelectionKind::NativeGraphRecoverySelection,
            run: self.run.into(),
            receipt: self.original.clone(),
            receipt_sha256: self.receipt_sha256.clone(),
            owner_sha256: self.lease.selected().fingerprint(),
            ended_boot: self.ended_boot,
            host_boot,
        })
    }
}
/// Select only a dead boot-qualified settled publication, or its unchanged
/// committed recovery intent. No file is created or repaired, and no provider
/// operation, private acquisition, signal or cleanup is performed.
pub fn select(candidate: &Candidate, run: &str) -> Result<Selection, CandidateError> {
    admit(candidate, run)?.selection()
}
fn admit<'a>(candidate: &'a Candidate, run: &'a str) -> Result<Admitted<'a>, CandidateError> {
    let root = directory(candidate, run)?;
    let root_identity = id(&root)?;
    let intent_path = root.join(FILE);
    let witness = if exists(&intent_path)? {
        let identity = id(&intent_path)?;
        let bytes = native_input::read_file(&intent_path, LIMIT).map_err(|_| refused())?;
        if id(&intent_path)? != identity {
            return Err(refused());
        }
        Some((identity, bytes))
    } else {
        None
    };
    let intent: Option<Intent> = witness
        .as_ref()
        .map(|(_, bytes)| serde_json::from_slice(bytes).map_err(|_| refused()))
        .transpose()?;
    let lease = owner::RecoveryLease::acquire(
        candidate,
        run,
        intent.as_ref().map(|intent| intent.publication.clone()),
        intent
            .as_ref()
            .is_some_and(|intent| intent.progress >= Progress::SocketRetirementIntent),
        intent
            .as_ref()
            .is_some_and(|intent| intent.progress >= Progress::OwnerRetirementIntent),
    )?;
    let review = lease.review().map_err(|_| refused())?;
    let (current, current_root, bytes) =
        journal::read_recovery(candidate, &review).map_err(|_| refused())?;
    // Which boot the run belongs to decides its admission rules before anything is
    // written (HACK-2715): an ended boot's run must be one its cleanup supports.
    let ended_boot = journal::pool_boot(candidate, &current) == journal::ReceiptBoot::Ended;
    if ended_boot {
        journal::ended_boot_recoverable(candidate, &current)?;
    }
    let (original, receipt_sha256) = match &intent {
        Some(intent) => {
            let original = intent.original(run, ended_boot)?;
            intent.current(&current_root, &original, &current, &bytes)?;
            intent.progress.verify(&lease)?;
            (original, intent.receipt_sha256.clone())
        }
        None => {
            admitted_original(&current, ended_boot)?;
            Progress::Cleanup.verify(&lease)?;
            (current, digest(bytes.as_bytes()))
        }
    };
    // Recheck immutable intent bytes/inode, publication and journal after all reads.
    let (again, _, current_bytes) =
        journal::read_recovery(candidate, &review).map_err(|_| refused())?;
    if current_bytes != bytes {
        return Err(refused());
    }
    if directory(candidate, run)? != root || id(&root)? != root_identity {
        return Err(refused());
    }
    match &witness {
        Some((identity, original_bytes))
            if id(&intent_path)? == *identity
                && native_input::read_file(&intent_path, LIMIT).map_err(|_| refused())?
                    == *original_bytes => {}
        None if !exists(&intent_path)? => {}
        _ => return Err(refused()),
    }
    if let Some(intent) = &intent {
        intent.current(&root, &original, &again, &current_bytes)?;
        intent.progress.verify(&lease)?;
        intent.environment.verify(candidate, &original)?;
    } else {
        Progress::Cleanup.verify(&lease)?;
    }
    let original_bytes = intent
        .as_ref()
        .map_or(bytes, |intent| intent.original.clone());
    Ok(Admitted {
        candidate,
        run,
        root,
        root_identity,
        lease,
        original,
        original_bytes,
        receipt_sha256,
        intent,
        witness,
        ended_boot,
    })
}
/// What a first recovery admits (HACK-2715). In the current boot only a settled receipt:
/// a start still in progress there may have engine effects in flight. A receipt of an
/// ended boot may also be a start caught mid-way (`preparing`, or `ready-observed` with a
/// failure observed): the guest that held its pending effects stopped, so nothing of it
/// can still land, and the cleanup in the new boot observes each member by its recorded
/// id or exact name, removes what it owns, and refuses a present member whose id was never
/// recorded. The cleanup re-checks the boot against the connected engine.
fn admitted_original(receipt: &Receipt, ended_boot: bool) -> Result<(), CandidateError> {
    if ended_boot {
        receipt.require_ended_boot_settled()
    } else {
        receipt.require_recovery_settled()
    }
    .map_err(|_| refused())
}

mod cleanup;
pub use cleanup::{Options, Outcome, recover};

#[cfg(test)]
mod tests;
