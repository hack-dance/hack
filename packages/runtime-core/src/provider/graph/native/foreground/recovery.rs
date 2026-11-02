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
        "Native same-boot recovery requires the exact complete Ready selection, dead boot-qualified publisher and unchanged durable progress; evidence retained.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
        Phase::ReadyObserved => Ok(0),
        Phase::StopIntent => Ok(1),
        Phase::Stopped => Ok(2),
        Phase::RemovalIntent => Ok(3),
        Phase::Removed => Ok(4),
        _ => Err(refused()),
    }
}
fn resource_progress(receipt: &Receipt) -> Result<BTreeMap<String, u8>, CandidateError> {
    receipt
        .resources
        .iter()
        .map(|(key, resource)| {
            let rank = match (&resource.kind, resource.phase.as_str()) {
                (Kind::Container, "started") | (Kind::Network, "created") => 0,
                (Kind::Network, "remove-intent") => 1,
                (Kind::Container | Kind::Network, "removed") => 2,
                _ => return Err(refused()),
            };
            Ok((key.clone(), rank))
        })
        .collect()
}
impl Intent {
    fn original(&self, run: &str) -> Result<Receipt, CandidateError> {
        if self.version != 1
            || self.run != run
            || self.original.len() > 64 * 1024
            || !super::super::super::hex(&self.receipt_sha256, 64)
            || digest(self.original.as_bytes()) != self.receipt_sha256
            || self.receipt_progress > 4
        {
            return Err(refused());
        }
        let receipt: Receipt = serde_json::from_str(&self.original).map_err(|_| refused())?;
        receipt.require_recovery_ready().map_err(|_| refused())?;
        if receipt.review.scope().run != run
            || self.resource_progress.keys().ne(receipt.resources.keys())
            || self.resource_progress.iter().any(|(key, rank)| {
                *rank > 2 || (*rank == 1 && receipt.resources[key].kind != Kind::Network)
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
            || rank < self.receipt_progress
            || (rank == 0 && digest(bytes.as_bytes()) != self.receipt_sha256)
            || (self.progress != Progress::Cleanup && rank != 4)
            || resources
                .iter()
                .any(|(key, rank)| *rank < self.resource_progress[key])
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
            host_boot,
        })
    }
}
/// Select only a dead boot-qualified complete Ready publication, or its unchanged
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
    let (original, receipt_sha256) = match &intent {
        Some(intent) => {
            let original = intent.original(run)?;
            intent.current(&current_root, &original, &current, &bytes)?;
            intent.progress.verify(&lease)?;
            (original, intent.receipt_sha256.clone())
        }
        None => {
            current.require_recovery_ready().map_err(|_| refused())?;
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
    })
}

mod cleanup;
pub use cleanup::{Options, Outcome, recover};

#[cfg(test)]
mod tests;
