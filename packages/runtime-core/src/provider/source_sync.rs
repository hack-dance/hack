//! Single-host writer with an acknowledged guest-native working tree.
use super::{lifecycle::OwnedGuest, state};
use crate::{
    Candidate, CandidateError,
    project::snapshot::{ContentEntry, ContentRevision, Snapshot},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::GzEncoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAX_RECORD: u64 = 16 * 1024 * 1024;
fn error(message: &str) -> CandidateError {
    CandidateError::new("source_sync", message)
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u32,
    checkout: PathBuf,
    source: PathBuf,
    namespace: String,
    provider_incarnation: String,
    guest_tree_inode: Option<u64>,
    phase: String,
    acknowledged: Option<ContentRevision>,
    pending: Option<ContentRevision>,
    repair_paths: BTreeSet<String>,
    pending_operations: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SyncReceipt {
    pub namespace: String,
    pub phase: String,
    pub acknowledged_revision: Option<String>,
    pub pending_revision: Option<String>,
    pub guest_path: String,
    pub guest_tree_inode: Option<u64>,
    pub transferred_file_bytes: u64,
    pub compressed_payload_bytes: u64,
    pub prepare_millis: u64,
    pub transfer_millis: u64,
    pub guest_apply_millis: u64,
    pub cleanup_millis: u64,
    pub apply_millis: u64,
    pub reconciled: bool,
}

fn record_path(candidate: &Candidate, namespace: &str) -> Result<PathBuf, CandidateError> {
    if !hex(namespace, 64) {
        return Err(error("Invalid source workspace identity."));
    }
    Ok(candidate
        .state_root
        .join("run/source-sync")
        .join(namespace)
        .join("state.json"))
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|p| matches!(p, std::path::Component::Normal(_)))
        && Path::new(path)
            .components()
            .map(|p| p.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
            == path
}
fn write_record(path: &Path, record: &Record) -> Result<(), CandidateError> {
    if serde_json::to_vec(record)
        .map_err(|_| error("Cannot encode source sync state."))?
        .len() as u64
        > MAX_RECORD
    {
        return Err(error(
            "Source sync receipt exceeds its bounded metadata budget.",
        ));
    }
    state::write(path, record)
}

fn read_record(path: &Path) -> Result<Record, CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| error("Cannot read source sync state."))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("Cannot inspect source sync state."))?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > MAX_RECORD
    {
        return Err(error("Unsafe or oversized source sync state."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_RECORD + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Cannot read source sync state."))?;
    if bytes.len() as u64 > MAX_RECORD {
        return Err(error("Source sync state grew beyond its limit."));
    }
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| error("Invalid source sync state."))?;
    for manifest in record.acknowledged.iter().chain(record.pending.iter()) {
        manifest.validate()?;
    }
    if record.repair_paths.len() > 60_000
        || record.repair_paths.iter().any(|p| !valid_path(p))
        || record.pending_operations.len() > 8
        || record.pending_operations.iter().any(|id| !hex(id, 32))
    {
        return Err(error("Invalid retained source repair intent."));
    }
    if record.schema != 1
        || !hex(&record.namespace, 64)
        || !hex(&record.provider_incarnation, 32)
        || !["unpublished", "applying", "acknowledged"].contains(&record.phase.as_str())
    {
        return Err(error("Invalid source sync identity or phase."));
    }
    Ok(record)
}

fn receipt(record: &Record) -> SyncReceipt {
    SyncReceipt {
        namespace: record.namespace.clone(),
        phase: record.phase.clone(),
        acknowledged_revision: record.acknowledged.as_ref().map(|r| r.revision.clone()),
        pending_revision: record.pending.as_ref().map(|r| r.revision.clone()),
        guest_path: format!("/storage/hack-workspaces/{}/tree", record.namespace),
        guest_tree_inode: record.guest_tree_inode,
        transferred_file_bytes: 0,
        compressed_payload_bytes: 0,
        prepare_millis: 0,
        transfer_millis: 0,
        guest_apply_millis: 0,
        cleanup_millis: 0,
        apply_millis: 0,
        reconciled: false,
    }
}

pub fn sync_status(
    candidate: &Candidate,
    namespace: &str,
) -> Result<Option<SyncReceipt>, CandidateError> {
    let path = record_path(candidate, namespace)?;
    crate::reject_aliased_state(path.parent().expect("source state parent"))?;
    if !path
        .try_exists()
        .map_err(|_| error("Cannot inspect source sync state."))?
    {
        return Ok(None);
    }
    let record = read_record(&path)?;
    if record.checkout != candidate.checkout || record.namespace != namespace {
        return Err(error("Foreign source sync state."));
    }
    Ok(Some(receipt(&record)))
}

pub struct SyncSession<'a> {
    candidate: &'a Candidate,
    path: PathBuf,
    record: Record,
    _lock: state::Lock,
}

pub struct SourceAdmission {
    _lock: state::Lock,
}

/// Workspace identity admitted while the caller retains the provider lease.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LiveWorkspace {
    pub namespace: String,
    pub provider_incarnation: String,
    pub tree_inode: u64,
}
impl LiveWorkspace {
    pub(super) fn valid(&self) -> bool {
        hex(&self.namespace, 64) && hex(&self.provider_incarnation, 32) && self.tree_inode != 0
    }
}

/// Does not acquire the long-lived writer namespace lock or connect recursively.
/// Every source-record writer holds the same provider lease as this caller.
pub(super) fn admit_live(
    guest: &OwnedGuest<'_>,
    namespace: &str,
    source: &Path,
    baseline: &ContentRevision,
) -> Result<LiveWorkspace, CandidateError> {
    let path = record_path(guest.candidate(), namespace)?;
    state::check_private_directory(path.parent().expect("source state parent"))?;
    if path
        .with_extension("pending")
        .try_exists()
        .map_err(state::io)?
        || path.with_extension("pending").is_symlink()
    {
        return Err(error("Source acknowledgement has an uncertain journal."));
    }
    let record = read_record(&path)?;
    let workspace = validate_live_record(
        &record,
        guest.candidate(),
        namespace,
        source,
        guest.incarnation(),
        baseline,
    )?;
    guest.execute(
        r#"
test ! -L /storage/hack-workspaces
test ! -L "$1"
test "$(stat -c %u:%a "$1")" = 0:700
test ! -L "$1/owner"
test "$(cat "$1/owner")" = "$2"
test -d "$1/tree"
test ! -L "$1/tree"
test "$(stat -c %i "$1/tree")" = "$3"
test ! -e "$1/pending"
test ! -L "$1/pending"
test ! -L "$1/revision"
test "$(cat "$1/revision")" = "$4"
"#,
        &[
            &format!("/storage/hack-workspaces/{namespace}"),
            guest.incarnation(),
            &workspace.tree_inode.to_string(),
            &baseline.revision,
        ],
        None,
    )?;
    Ok(workspace)
}

fn validate_live_record(
    record: &Record,
    candidate: &Candidate,
    namespace: &str,
    source: &Path,
    incarnation: &str,
    baseline: &ContentRevision,
) -> Result<LiveWorkspace, CandidateError> {
    baseline.validate()?;
    if record.checkout != candidate.checkout
        || record.namespace != namespace
        || record.source != source
        || record.provider_incarnation != incarnation
        || record.phase != "acknowledged"
        || record.pending.is_some()
        || !record.pending_operations.is_empty()
        || !record.repair_paths.is_empty()
        || record.acknowledged.as_ref().is_none_or(|ack| {
            ack.revision != baseline.revision || ack.selection_sha256 != baseline.selection_sha256
        })
    {
        return Err(error(
            "Live source requires an exact unambiguous acknowledged baseline.",
        ));
    }
    let workspace = LiveWorkspace {
        namespace: namespace.into(),
        provider_incarnation: incarnation.into(),
        tree_inode: record.guest_tree_inode.unwrap_or(0),
    };
    if !workspace.valid() {
        return Err(error("Live workspace identity is invalid."));
    }
    Ok(workspace)
}

impl SourceAdmission {
    /// Retained through durable job acceptance, so another sync cannot advance the revision.
    pub(super) fn acquire(
        candidate: &Candidate,
        namespace: &str,
        revision: &str,
    ) -> Result<Self, CandidateError> {
        let path = record_path(candidate, namespace)?;
        state::check_private_directory(path.parent().expect("source state parent"))?;
        let lock = state::Lock::acquire(path.parent().expect("source state parent"))?;
        let record = read_record(&path)?;
        if record.checkout != candidate.checkout || record.namespace != namespace {
            return Err(error("Foreign source sync state."));
        }
        if record.phase != "acknowledged"
            || record.pending.is_some()
            || record
                .acknowledged
                .as_ref()
                .is_none_or(|r| r.revision != revision)
        {
            return Err(CandidateError::new(
                "stale_source_revision",
                "Job input is not the current acknowledged source revision.",
            ));
        }
        let guest = OwnedGuest::connect(candidate)?;
        if record.provider_incarnation != guest.incarnation() {
            return Err(error(
                "Source acknowledgement belongs to another provider incarnation.",
            ));
        }
        guest.execute(
            r#"
test ! -L "$1"
test ! -L "$1/owner"
test "$(cat "$1/owner")" = "$2"
test ! -L "$1/tree"
test "$(stat -c %i "$1/tree")" = "$3"
test ! -e "$1/pending"
test ! -L "$1/pending"
test ! -L "$1/revision"
test "$(cat "$1/revision")" = "$4"
"#,
            &[
                &format!("/storage/hack-workspaces/{namespace}"),
                &record.provider_incarnation,
                &record
                    .guest_tree_inode
                    .ok_or_else(|| error("Acknowledged tree identity is missing."))?
                    .to_string(),
                revision,
            ],
            None,
        )?;
        Ok(Self { _lock: lock })
    }
}

fn check_watch_deadline(deadline: Option<Instant>, now: Instant) -> Result<(), CandidateError> {
    if deadline.is_some_and(|end| now >= end) {
        return Err(CandidateError::new(
            "source_watch_deadline",
            "Watch deadline expired before the observed source update was acknowledged.",
        ));
    }
    Ok(())
}

// Only the lease-acquisition result passes this boundary; never classify an
// apply result by error code after source or guest mutation has begun.
fn pre_effect_lease<T>(result: Result<T, CandidateError>) -> Result<Option<T>, CandidateError> {
    match result {
        Ok(lease) => Ok(Some(lease)),
        Err(error) if error.code == "provider_busy" => Ok(None),
        Err(error) => Err(error),
    }
}

impl<'a> SyncSession<'a> {
    pub fn open(
        candidate: &'a Candidate,
        namespace: &str,
        source: &Path,
    ) -> Result<Self, CandidateError> {
        let source = source
            .canonicalize()
            .map_err(|_| error("Cannot resolve source identity."))?;
        let path = record_path(candidate, namespace)?;
        let lock = state::Lock::acquire(path.parent().expect("state parent"))?;
        let guest = OwnedGuest::connect(candidate)?;
        let record = if path
            .try_exists()
            .map_err(|_| error("Cannot inspect source sync state."))?
        {
            let record = read_record(&path)?;
            if record.checkout != candidate.checkout
                || record.source != source
                || record.namespace != namespace
                || record.provider_incarnation != guest.incarnation()
            {
                return Err(error(
                    "Source sync state belongs to another source or provider incarnation.",
                ));
            }
            record
        } else {
            let record = Record {
                schema: 1,
                checkout: candidate.checkout.clone(),
                source,
                namespace: namespace.into(),
                provider_incarnation: guest.incarnation().into(),
                guest_tree_inode: None,
                phase: "unpublished".into(),
                acknowledged: None,
                pending: None,
                repair_paths: BTreeSet::new(),
                pending_operations: Vec::new(),
            };
            write_record(&path, &record)?;
            record
        };
        Ok(Self {
            candidate,
            path,
            record,
            _lock: lock,
        })
    }

    pub fn apply(
        &mut self,
        snapshot: &Snapshot,
        reconcile: bool,
    ) -> Result<SyncReceipt, CandidateError> {
        self.apply_inner(snapshot, reconcile, None, None, None)
    }

    /// Apply a freshly reviewed snapshot while honoring retained live graph consumers.
    pub fn apply_reviewed(
        &mut self,
        snapshot: &Snapshot,
        reconcile: bool,
        contract: &crate::project::live_source::Contract,
    ) -> Result<SyncReceipt, CandidateError> {
        contract.reviewed_snapshot(snapshot.receipt())?;
        self.apply_inner(snapshot, reconcile, Some(contract), None, None)
    }

    /// Watch-only attempt. None means provider lease contention or an expired
    /// watch deadline, before source intent, guest operations or apply mutation. All later failures
    /// remain errors, including a same-code error from a future effect boundary.
    pub fn try_apply_reviewed(
        &mut self,
        snapshot: &Snapshot,
        contract: &crate::project::live_source::Contract,
        deadline: Option<Instant>,
    ) -> Result<Option<SyncReceipt>, CandidateError> {
        contract.reviewed_snapshot(snapshot.receipt())?;
        if self.record.pending.is_some() {
            return Err(error(
                "An interrupted source apply requires explicit --reconcile.",
            ));
        }
        let guest = match pre_effect_lease(OwnedGuest::connect(self.candidate))? {
            Some(guest) => guest,
            None => return Ok(None),
        };
        if deadline.is_some_and(|end| Instant::now() >= end) {
            return Ok(None);
        }
        self.apply_inner(snapshot, false, Some(contract), Some(guest), deadline)
            .map(Some)
    }

    fn apply_inner(
        &mut self,
        snapshot: &Snapshot,
        reconcile: bool,
        contract: Option<&crate::project::live_source::Contract>,
        guest: Option<OwnedGuest<'a>>,
        deadline: Option<Instant>,
    ) -> Result<SyncReceipt, CandidateError> {
        snapshot.receipt().validate()?;
        if self.record.pending.is_some() && !reconcile {
            return Err(error(
                "An interrupted source apply requires explicit --reconcile.",
            ));
        }
        let started = Instant::now();
        let guest = match guest {
            Some(guest) => guest,
            None => OwnedGuest::connect(self.candidate)?,
        };
        if guest.incarnation() != self.record.provider_incarnation {
            return Err(error("Provider incarnation changed during source sync."));
        }
        super::graph::check_live_source_consumers(
            &guest,
            &self.record.namespace,
            self.record.guest_tree_inode,
            contract,
        )?;
        let delta = snapshot.delta(if reconcile {
            None
        } else {
            self.record.acknowledged.as_ref()
        });
        let mut known_paths = self.record.repair_paths.clone();
        for manifest in self
            .record
            .acknowledged
            .iter()
            .chain(self.record.pending.iter())
            .chain(std::iter::once(snapshot.receipt()))
        {
            known_paths.extend(manifest.entries.iter().map(|e| e.path.clone()));
        }
        let mut random = [0; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(|_| error("Cannot create source apply identity."))?;
        let operation: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let root = format!("/storage/hack-workspaces/{}", self.record.namespace);
        let stage = format!("{root}/incoming-{operation}");
        let previous = self
            .record
            .acknowledged
            .as_ref()
            .map(|r| r.revision.as_str())
            .unwrap_or("none")
            .to_owned();
        if self.record.pending_operations.len() >= 8 {
            if !reconcile {
                return Err(error(
                    "Retained source operations require explicit --reconcile.",
                ));
            }
            // A lost RPC may still be applying. Acquire its guest lock before retiring
            // staging, and retain repair intent until the new verified apply succeeds.
            let mut script = String::from(
                r#"
test ! -L "$1"
test "$(stat -c %u:%a "$1")" = 0:700
test ! -L "$1/owner"
test "$(cat "$1/owner")" = "$2"
test ! -L "$1/apply.lock"
exec 9>"$1/apply.lock"
flock -n 9
"#,
            );
            for operation in &self.record.pending_operations {
                script.push_str(&format!(
                    r#"
stage="$1/incoming-{operation}"
if test -e "$stage" || test -L "$stage"; then
  test ! -L "$stage"
  test "$(stat -c %u:%a "$stage")" = 0:700
  rm -rf -- "$stage"
fi
"#
                ));
            }
            guest.execute(&script, &[&root, &self.record.provider_incarnation], None)?;
            self.record.pending_operations.clear();
            write_record(&self.path, &self.record)?;
        }
        self.record.repair_paths = known_paths.clone();
        // Watch expiry refuses admission before durable intent. Once intent is
        // written, finish or retain the bounded apply; never cancel it mid-effect.
        check_watch_deadline(deadline, Instant::now())?;
        self.record.pending_operations.push(operation.clone());
        self.record.pending = Some(snapshot.receipt().clone());
        self.record.phase = "applying".into();
        write_record(&self.path, &self.record)?;
        let before = if reconcile {
            repair_script(&known_paths)
        } else {
            verification(self.record.acknowledged.as_ref())
        };
        let before_hash = hash(before.as_bytes());
        let observed_root = guest.execute(
            r#"
umask 077
test ! -L /storage/hack-workspaces
if test ! -e /storage/hack-workspaces; then mkdir /storage/hack-workspaces; fi
test "$(stat -c %u:%a /storage/hack-workspaces)" = 0:700
test ! -L "$1"
if test ! -e "$1"; then
  mkdir "$1"
  (set -C; printf '%s' "$5" > "$1/owner")
fi
test "$(stat -c %u:%a "$1")" = 0:700
test ! -L "$1/owner"
test "$(cat "$1/owner")" = "$5"
if test -e "$1/tree" || test -L "$1/tree"; then
  test ! -L "$1/tree"
  test -d "$1/tree"
else
  test "$3" = none
  mkdir "$1/tree"
  chmod 755 "$1/tree"
fi
if test "$4" != repair; then
  test ! -e "$1/pending"
  test ! -L "$1/revision"
  if test "$3" = none; then test ! -e "$1/revision"; else test "$(cat "$1/revision")" = "$3"; fi
fi
mkdir "$2"
mkdir "$2/tree"
(set -C; : > "$2/payload.tar")
reuse=new
test ! -L "$1/verify-current.sh"
if test -e "$1/verify-current.sh"; then
  test -f "$1/verify-current.sh"
  test "$(stat -c %u:%h "$1/verify-current.sh")" = 0:1
  if test "$4" != repair; then
    test "$(sha256sum "$1/verify-current.sh" | cut -d ' ' -f 1)" = "$6"
    reuse=reused
  fi
fi
printf '%s\n%s' "$(stat -c %i "$1/tree")" "$reuse"
"#,
            &[
                &root,
                &stage,
                &previous,
                if reconcile { "repair" } else { "normal" },
                &self.record.provider_incarnation,
                &before_hash,
            ],
            None,
        )?;
        let (observed_inode, cache_state) = observed_root
            .trim()
            .split_once('\n')
            .ok_or_else(|| error("Invalid guest source cache acknowledgement."))?;
        let reused = match cache_state {
            "new" => false,
            "reused" => true,
            _ => return Err(error("Invalid guest source cache acknowledgement.")),
        };
        let inode = observed_inode
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| error("Cannot establish the stable guest source root."))?;
        if self
            .record
            .guest_tree_inode
            .is_some_and(|previous| previous != inode)
        {
            return Err(error(
                "The watched guest source root was replaced; refusing adoption.",
            ));
        }
        self.record.guest_tree_inode = Some(inode);
        write_record(&self.path, &self.record)?;
        let archive = snapshot.delta_archive(&delta)?;
        let after = verification(Some(snapshot.receipt()));
        let apply = apply_script(snapshot, &delta.changed_paths, &delta.removed_entries);
        let payload = transfer_payload([
            ("delta.tar", archive.as_slice()),
            (
                "verify-before.sh",
                if reused { &[] } else { before.as_bytes() },
            ),
            ("verify-after.sh", after.as_bytes()),
            ("apply.sh", apply.as_bytes()),
        ])?;
        drop(archive);
        drop(before);
        drop(after);
        drop(apply);
        let prepare_millis = millis(started.elapsed());
        let transfer_started = Instant::now();
        let compressed_payload_bytes = upload(&guest, &format!("{stage}/payload.tar"), &payload)?;
        guest.execute(
            "tar -xf \"$1/payload.tar\" -C \"$1\"; rm \"$1/payload.tar\"; if test \"$3\" = reused; then cp \"$2/verify-current.sh\" \"$1/verify-before.sh\"; fi",
            &[&stage, &root, cache_state],
            None,
        )?;
        let transfer_millis = millis(transfer_started.elapsed());
        let apply_started = Instant::now();
        guest
            .execute(
                r#"
set -eu
test ! -L "$1/apply.lock"
exec 9>"$1/apply.lock"
flock -n 9
test "$(stat -c %i "$1/tree")" = "$5"
cd "$1/tree"
test ! -L "$1/pending"
printf '%s\n' "$3" > "$1/pending"
sync
test "$(sha256sum "$2/verify-before.sh" | cut -d ' ' -f 1)" = "$6"
sh "$2/verify-before.sh"
tar -xf "$2/delta.tar" -C "$2/tree"
sh "$2/apply.sh" "$2/tree"
sh "$2/verify-after.sh"
test ! -L "$1/verify-current.sh"
mv -T "$2/verify-after.sh" "$1/verify-current.sh"
test ! -L "$1/revision.next"
if test -e "$1/revision.next"; then
  test "$4" = repair
  test -f "$1/revision.next"
  rm "$1/revision.next"
fi
(set -C; printf '%s\n' "$3" > "$1/revision.next")
mv -T "$1/revision.next" "$1/revision"
sync
rm "$1/pending"
sync
printf '%s' "$3"
"#,
                &[
                    &root,
                    &stage,
                    &snapshot.receipt().revision,
                    if reconcile { "repair" } else { "normal" },
                    &inode.to_string(),
                    &before_hash,
                ],
                None,
            )
            .and_then(|ack| {
                if ack == snapshot.receipt().revision {
                    Ok(())
                } else {
                    Err(error(
                        "Guest source acknowledgement differs from the captured revision.",
                    ))
                }
            })?;
        let guest_apply_millis = millis(apply_started.elapsed());
        let cleanup_started = Instant::now();
        for operation in &self.record.pending_operations {
            guest.execute(
                r#"
stage="$1/incoming-$2"
if test -e "$stage" || test -L "$stage"; then
  test ! -L "$stage"
  test "$(stat -c %u:%a "$stage")" = 0:700
  rm -rf -- "$stage"
fi
"#,
                &[&root, operation],
                None,
            )?;
        }
        self.record.pending_operations.clear();
        self.record.repair_paths.clear();
        self.record.acknowledged = self.record.pending.take();
        self.record.phase = "acknowledged".into();
        write_record(&self.path, &self.record)?;
        let mut result = receipt(&self.record);
        result.transferred_file_bytes = delta.transferred_file_bytes;
        result.compressed_payload_bytes = compressed_payload_bytes;
        result.prepare_millis = prepare_millis;
        result.transfer_millis = transfer_millis;
        result.guest_apply_millis = guest_apply_millis;
        result.cleanup_millis = millis(cleanup_started.elapsed());
        result.apply_millis = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
        result.reconciled = reconcile;
        Ok(result)
    }
}

fn millis(duration: std::time::Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

/// Fixed-name regular entries keep source content inside the nested delta archive.
/// The envelope passes the same compressed and decoded identity checks as every upload.
fn transfer_payload(entries: [(&str, &[u8]); 4]) -> Result<Vec<u8>, CandidateError> {
    let mut archive = tar::Builder::new(Vec::new());
    for (name, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        archive
            .append_data(&mut header, name, bytes)
            .map_err(|_| error("Cannot encode source transfer payload."))?;
    }
    archive
        .into_inner()
        .map_err(|_| error("Cannot finish source transfer payload."))
}

pub(super) fn upload(
    guest: &OwnedGuest<'_>,
    path: &str,
    bytes: &[u8],
) -> Result<u64, CandidateError> {
    upload_with(
        &mut |script, args, input| guest.execute(script, args, input),
        path,
        bytes,
    )
}

pub(super) fn upload_with(
    execute: &mut impl FnMut(&str, &[&str], Option<&str>) -> Result<String, CandidateError>,
    path: &str,
    bytes: &[u8],
) -> Result<u64, CandidateError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(bytes)
        .map_err(|_| error("Cannot compress source transfer."))?;
    let compressed = encoder
        .finish()
        .map_err(|_| error("Cannot finish source transfer compression."))?;
    let compressed_path = format!("{path}.gz");
    execute(
        r#"test ! -L "$1"; test -f "$1"; test "$(stat -c %s "$1")" = 0; (set -C; : > "$2")"#,
        &[path, &compressed_path],
        None,
    )?;
    for (index, chunk) in compressed.chunks(30 * 1024).enumerate() {
        execute(
            r#"test ! -L "$1"; test -f "$1"; test "$(stat -c %s "$1")" = "$2"; base64 -d >> "$1""#,
            &[&compressed_path, &(index * 30 * 1024).to_string()],
            Some(&STANDARD.encode(chunk)),
        )?;
    }
    execute(
        r#"
test ! -L "$1"; test -f "$1"; test "$(stat -c %s "$1")" = 0
test "$(sha256sum "$2" | cut -d ' ' -f 1)" = "$3"
/bin/busybox gzip -dc "$2" > "$1"
test "$(stat -c %s "$1")" = "$4"
test "$(sha256sum "$1" | cut -d ' ' -f 1)" = "$5"
rm "$2"
"#,
        &[
            path,
            &compressed_path,
            &hash(&compressed),
            &bytes.len().to_string(),
            &hash(bytes),
        ],
        None,
    )?;
    Ok(compressed.len() as u64)
}

pub(super) fn verification(manifest: Option<&ContentRevision>) -> String {
    let entries = manifest.map(|m| m.entries.as_slice()).unwrap_or(&[]);
    let mut names: Vec<_> = entries.iter().map(|e| format!("./{}\0", e.path)).collect();
    names.sort();
    let mut script = format!(
        "set -eu\nset -o pipefail\nexport LC_ALL=C\ntest \"$(find . -mindepth 1 -print0 | sort -z | sha256sum | cut -d ' ' -f 1)\" = {}\n",
        quote(&hash(names.concat().as_bytes()))
    );
    let mut checksums = String::new();
    for entry in entries {
        let path = quote(&format!("./{}", entry.path));
        match entry.kind.as_str() {
            "directory" => script.push_str(&format!("test ! -L {path}; test -d {path}\n")),
            "symlink" => script.push_str(&format!(
                "test -L {path}; test \"$(readlink {path})\" = {}\n",
                quote(entry.link_target.as_deref().expect("validated link"))
            )),
            _ => {
                script.push_str(&format!(
                    "test ! -L {path}; test -f {path}; test {}-x {path}\n",
                    if entry.executable { "" } else { "! " }
                ));
                checksums.push_str(&format!(
                    "{}  ./{}\n",
                    entry.sha256.as_deref().expect("validated hash"),
                    entry.path
                ));
            }
        }
    }
    if !checksums.is_empty() {
        script.push_str("sha256sum -c - >/dev/null <<'HACK_SOURCE_CHECKSUMS'\n");
        script.push_str(&checksums);
        script.push_str("HACK_SOURCE_CHECKSUMS\n");
    }
    script
}

fn repair_script(known: &BTreeSet<String>) -> String {
    if known.is_empty() {
        return verification(None);
    }
    let mut script = String::from("set -eu\nset -o pipefail\nexport LC_ALL=C\n");
    let allowed = known
        .iter()
        .map(|p| quote(&format!("./{p}")))
        .collect::<Vec<_>>()
        .join("|");
    script.push_str(&format!("find . -mindepth 1 -print0 | while IFS= read -r -d '' path; do case \"$path\" in {allowed}) ;; *) exit 71;; esac; done\n"));
    let mut paths: Vec<_> = known.iter().collect();
    paths.sort_by_key(|p| p.split('/').count());
    for path in &paths {
        let path = quote(&format!("./{path}"));
        script.push_str(&format!("if test -L {path}; then rm -- {path}; fi\n"));
    }
    paths.reverse();
    for path in paths {
        let path = quote(&format!("./{path}"));
        script.push_str(&format!("if test -d {path}; then rmdir -- {path}; elif test -f {path}; then rm -- {path}; elif test -e {path}; then exit 72; fi\n"));
    }
    script
}

fn apply_script(
    snapshot: &Snapshot,
    changed: &BTreeSet<String>,
    removed: &[ContentEntry],
) -> String {
    let mut script = String::from("set -eu\n");
    for entry in removed {
        let path = quote(&format!("./{}", entry.path));
        script.push_str(&format!(
            "{} -- {path}\n",
            if entry.kind == "directory" {
                "rmdir"
            } else {
                "rm"
            }
        ));
    }
    for entry in &snapshot.receipt().entries {
        if !changed.contains(&entry.path) {
            continue;
        }
        let path = quote(&format!("./{}", entry.path));
        if entry.kind == "directory" {
            script.push_str(&format!(
                "if test ! -d {path}; then mkdir -- {path}; fi; chmod 755 {path}\n"
            ));
        } else {
            script.push_str(&format!("mv -T -- \"$1\"/{} {path}\n", quote(&entry.path)));
        }
    }
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_contention_is_classified_only_at_pre_effect_lease_acquisition() {
        assert!(
            pre_effect_lease::<()>(Err(CandidateError::new("provider_busy", "lease held")))
                .unwrap()
                .is_none()
        );
        assert_eq!(pre_effect_lease(Ok(7)).unwrap(), Some(7));
        for code in ["runtime_changed", "runtime_pressure", "provider_state"] {
            assert_eq!(
                pre_effect_lease::<()>(Err(CandidateError::new(code, "refused")))
                    .unwrap_err()
                    .code,
                code
            );
        }
        // An identical error after a successful acquisition is propagated, not
        // converted to retryable contention by the acquisition-only classifier.
        let result = pre_effect_lease(Ok(())).and_then(|lease| {
            assert!(lease.is_some());
            Err::<(), _>(CandidateError::new("provider_busy", "after acquisition"))
        });
        assert_eq!(result.unwrap_err().code, "provider_busy");
    }

    #[test]
    fn live_admission_requires_exact_acknowledged_owner_source_revision_and_inode() {
        let root = std::env::temp_dir().join(format!(
            "live-admit-{}-{}",
            std::process::id(),
            crate::node::now()
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let source = root.join("source");
        let home = root.join("candidate");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&home).unwrap();
        let candidate = Candidate::discover(&home).unwrap();
        std::fs::write(
            source.join("compose.yaml"),
            format!(
                "services:\n  web:\n    image: sha256:{}\n    network_mode: none\n",
                "a".repeat(64)
            ),
        )
        .unwrap();
        let plan = crate::project::plan(
            &candidate,
            crate::project::PlanOptions {
                project: &source,
                compose_file: Path::new("compose.yaml"),
                profiles: &[],
            },
        )
        .unwrap();
        let manifest = crate::project::snapshot::capture(
            &source,
            &BTreeSet::new(),
            &plan.plan.source_selection.metadata_sha256,
        )
        .unwrap()
        .receipt()
        .clone();
        let record = Record {
            schema: 1,
            checkout: candidate.checkout.clone(),
            source: source.clone(),
            namespace: "b".repeat(64),
            provider_incarnation: "c".repeat(32),
            guest_tree_inode: Some(7),
            phase: "acknowledged".into(),
            acknowledged: Some(manifest.clone()),
            pending: None,
            repair_paths: BTreeSet::new(),
            pending_operations: vec![],
        };
        let check = |r: &Record| {
            validate_live_record(
                r,
                &candidate,
                &"b".repeat(64),
                &source,
                &"c".repeat(32),
                &manifest,
            )
        };
        assert_eq!(check(&record).unwrap().tree_inode, 7);
        for mutation in 0..8 {
            let mut changed: Record =
                serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
            match mutation {
                0 => changed.checkout = root.join("foreign"),
                1 => changed.source = root.join("foreign"),
                2 => changed.provider_incarnation = "d".repeat(32),
                3 => changed.pending = Some(manifest.clone()),
                4 => changed.phase = "applying".into(),
                5 => changed.guest_tree_inode = Some(0),
                6 => changed.pending_operations.push("e".repeat(32)),
                _ => changed.acknowledged = None,
            }
            assert!(check(&changed).is_err(), "mutation {mutation}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transfer_envelope_keeps_binary_source_separate_from_verification_scripts() {
        let delta = b"\0../apply.sh\nnot-a-script\xff";
        let expected: [(&str, &[u8]); 4] = [
            ("delta.tar", delta),
            ("verify-before.sh", b"before"),
            ("verify-after.sh", b"after"),
            ("apply.sh", b"apply"),
        ];
        let payload = transfer_payload(expected).unwrap();
        let mut archive = tar::Archive::new(payload.as_slice());
        let mut entries = archive.entries().unwrap();
        for (name, bytes) in expected {
            let mut entry = entries.next().unwrap().unwrap();
            assert_eq!(entry.path().unwrap().as_ref(), Path::new(name));
            assert!(entry.header().entry_type().is_file());
            assert_eq!(entry.header().mode().unwrap(), 0o600);
            let mut decoded = Vec::new();
            entry.read_to_end(&mut decoded).unwrap();
            assert_eq!(decoded, bytes);
        }
        assert!(entries.next().is_none());
    }

    #[test]
    fn sync_status_reads_receipts_without_starting_provider_and_refuses_aliases() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-sync-status-{}-{}",
            std::process::id(),
            crate::node::now()
        ));
        state::private_directory(&root).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        let namespace = "a".repeat(64);
        assert!(sync_status(&candidate, &namespace).unwrap().is_none());
        assert!(!candidate.state_root.exists());
        let path = record_path(&candidate, &namespace).unwrap();
        state::private_directory(path.parent().unwrap()).unwrap();
        let record = Record {
            schema: 1,
            checkout: candidate.checkout.clone(),
            source: root.join("source"),
            namespace: namespace.clone(),
            provider_incarnation: "b".repeat(32),
            guest_tree_inode: None,
            phase: "unpublished".into(),
            acknowledged: None,
            pending: None,
            repair_paths: BTreeSet::new(),
            pending_operations: vec![],
        };
        write_record(&path, &record).unwrap();
        let before = std::fs::read(&path).unwrap();
        let receipt = sync_status(&candidate, &namespace).unwrap().unwrap();
        assert_eq!(receipt.phase, "unpublished");
        assert_eq!(receipt.namespace, namespace);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!candidate.state_root.join("run/smolvm").exists());
        let retained = path.with_extension("retained");
        std::fs::rename(&path, &retained).unwrap();
        std::os::unix::fs::symlink(&retained, &path).unwrap();
        assert!(sync_status(&candidate, &namespace).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&retained, &path).unwrap();
        assert!(sync_status(&candidate, &namespace).is_err());
        std::fs::remove_file(&path).unwrap();
        let parent = path.parent().unwrap();
        let retained_parent = parent.with_extension("retained");
        std::fs::rename(parent, &retained_parent).unwrap();
        std::os::unix::fs::symlink(&retained_parent, parent).unwrap();
        assert!(sync_status(&candidate, &namespace).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
