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
    crate::reject_aliased_state(&path)?;
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
        snapshot.receipt().validate()?;
        if self.record.pending.is_some() && !reconcile {
            return Err(error(
                "An interrupted source apply requires explicit --reconcile.",
            ));
        }
        let started = Instant::now();
        let guest = OwnedGuest::connect(self.candidate)?;
        if guest.incarnation() != self.record.provider_incarnation {
            return Err(error("Provider incarnation changed during source sync."));
        }
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
        self.record.pending_operations.push(operation.clone());
        self.record.pending = Some(snapshot.receipt().clone());
        self.record.phase = "applying".into();
        write_record(&self.path, &self.record)?;
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
(set -C; : > "$2/delta.tar"; : > "$2/verify-before.sh"; : > "$2/verify-after.sh"; : > "$2/apply.sh")
stat -c %i "$1/tree"
"#,
            &[
                &root,
                &stage,
                &previous,
                if reconcile { "repair" } else { "normal" },
                &self.record.provider_incarnation,
            ],
            None,
        )?;
        let inode = observed_root
            .trim()
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
        let before = if reconcile {
            repair_script(&known_paths)
        } else {
            verification(self.record.acknowledged.as_ref())
        };
        let after = verification(Some(snapshot.receipt()));
        let apply = apply_script(snapshot, &delta.changed_paths, &delta.removed_entries);
        let prepare_millis = millis(started.elapsed());
        let transfer_started = Instant::now();
        let mut compressed_payload_bytes = 0;
        for (name, bytes) in [
            ("delta.tar", archive.as_slice()),
            ("verify-before.sh", before.as_bytes()),
            ("verify-after.sh", after.as_bytes()),
            ("apply.sh", apply.as_bytes()),
        ] {
            compressed_payload_bytes += upload(&guest, &format!("{stage}/{name}"), bytes)?;
        }
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
sh "$2/verify-before.sh"
tar -xf "$2/delta.tar" -C "$2/tree"
sh "$2/apply.sh" "$2/tree"
sh "$2/verify-after.sh"
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

pub(super) fn upload(
    guest: &OwnedGuest<'_>,
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
    guest.execute(
        r#"test ! -L "$1"; test -f "$1"; test "$(stat -c %s "$1")" = 0; (set -C; : > "$2")"#,
        &[path, &compressed_path],
        None,
    )?;
    for (index, chunk) in compressed.chunks(30 * 1024).enumerate() {
        guest.execute(
            r#"test ! -L "$1"; test -f "$1"; test "$(stat -c %s "$1")" = "$2"; base64 -d >> "$1""#,
            &[&compressed_path, &(index * 30 * 1024).to_string()],
            Some(&STANDARD.encode(chunk)),
        )?;
    }
    guest.execute(
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
