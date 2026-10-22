//! Explicit, single-target quarantine of one admitted disposable cache directory
//! inside an ordinary owned volume of a stopped, data-retaining graph.
//!
//! Authority is the conjunction of: the receipt's admitted
//! `x-hack-disposable-cache` declaration for that exact path, an operator-reviewed
//! selection digest (receipt bytes, volume incarnation, directory identities and
//! measured bytes), the provider mutation lease, owned volume labels, and the
//! absence of every container consumer. Nothing is deleted. The directory is
//! renamed within one mount into a Hack-owned `hack-quarantine` sibling of the
//! volume's `_data` root, which no container mounts. Quarantined bytes stay
//! until the owning volume itself is explicitly removed; ordinary cleanup,
//! restart and restore never collect them, so reclaimed bytes are always zero.
//!
//! Recovery: a durable host record is committed before the guest rename and is
//! marked `quarantined` only after the guest reports a synchronized move. A
//! pending record resumes only for its identical selection (same receipt bytes
//! and volume incarnation). Any pending record, including one whose receipt has
//! since changed through a restart, can be resolved explicitly: the guest reads
//! the recorded destination under the volume root lock and the record becomes
//! `quarantined` (the recorded inode is there) or `abandoned` (nothing was
//! moved). Resolution never moves bytes. A torn record write refuses replay.
//!
//! Volume incarnation: Docker's `local` driver reports `CreatedAt` from the
//! modification time of the volume directory, the parent of `_data`. The first
//! quarantine of a volume creates `hack-quarantine` in that directory, which
//! changes `CreatedAt`. `CreatedAt` is therefore recorded as observed evidence
//! only and never compared as identity. The incarnation is every other
//! inspected field (name, driver, mountpoint, labels, options, scope) plus the
//! guest-observed `_data` directory identity, which each guest script
//! re-verifies and the post-effect recheck observes again. A volume replaced
//! under the same name gets a new `_data` directory and is refused.
use super::*;
use sha2::{Digest, Sha256};
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;

const RECORD_LIMIT: u64 = 16 * 1024;
/// Records are retained as diagnosis evidence; there is no automatic
/// collection. Volume names are run-scoped, so the per-volume budget renews
/// with each run while the global ceiling bounds the private directory scan.
const MAX_RECORDS: usize = 1024;
const MAX_VOLUME_RECORDS: usize = 16;
const QUARANTINE_DIRECTORY: &str = "hack-quarantine";

fn refused() -> CandidateError {
    error(
        "graph_cache_quarantine",
        "The disposable cache selection is missing, unsafe, changed or in use; no cache bytes were moved.",
    )
}
/// A changed volume after a guest effect. Bytes may already have moved, so the
/// pre-effect wording would be false; the durable record stays `pending`.
fn unsettled() -> CandidateError {
    error(
        "graph_cache_quarantine_unsettled",
        "The volume changed during the cache quarantine; the record stays pending for explicit resume or resolution.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// One explicit target. `volume` is the logical Compose volume name and `path`
/// must equal one admitted disposable directory of that volume.
#[derive(Clone, Copy, Debug)]
pub struct CacheQuarantineTarget<'a> {
    pub run: &'a str,
    pub volume: &'a str,
    pub path: &'a str,
}

/// Exact reviewed state. Its digest is the only accepted `--expect-selection`.
/// Boot identity is deliberately excluded so an interrupted move can resume
/// after a guest restart when every recorded identity still matches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u32,
    run: String,
    owner: String,
    receipt_sha256: String,
    volume: String,
    volume_name: String,
    /// Docker `CreatedAt` as observed at selection. Evidence bound into the
    /// reviewed digest; not incarnation identity (see the module notes).
    volume_created: String,
    root_identity: String,
    path: String,
    target_identity: String,
    target_bytes: u64,
    allocated_bytes: u64,
    entries: u64,
}
impl Selection {
    fn sha256(&self) -> Result<String, CandidateError> {
        Ok(digest(&serde_json::to_vec(self).map_err(|_| refused())?))
    }
    /// The destination name; distinct directory identities never share one.
    fn quarantine_id(digest: &str) -> &str {
        &digest[..32]
    }
}

/// Durable state of one selected operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    /// Intent is durable; the guest rename may or may not have happened.
    Pending,
    /// The recorded directory is retained at its quarantine destination.
    Quarantined,
    /// Explicit resolution found no recorded directory at the destination;
    /// nothing was moved by this operation.
    Abandoned,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    selection_sha256: String,
    selection: Selection,
    outcome: Outcome,
}
impl Record {
    fn valid(&self) -> bool {
        self.version == 1
            && self.selection.version == 1
            && hex(&self.selection_sha256, 64)
            && self
                .selection
                .sha256()
                .is_ok_and(|value| value == self.selection_sha256)
    }
    fn id(&self) -> &str {
        Selection::quarantine_id(&self.selection_sha256)
    }
}

/// Pure admission over the loaded receipt. Only an admitted ordinary volume of a
/// stopped retained graph with no incomplete journal can select an exact path.
fn authorize<'r>(
    receipt: &'r Receipt,
    journal_incomplete: bool,
    target: &CacheQuarantineTarget<'_>,
) -> Result<&'r Resource, CandidateError> {
    if journal_incomplete
        || receipt.phase != "stopped-data-retained"
        || !project::valid_volume_subpath(target.path)
    {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("volume:{}", target.volume))
        .ok_or_else(refused)?;
    if resource.kind != Kind::Volume
        || resource.key != target.volume
        || resource.phase != "created"
        || resource.cache.is_some()
        || !resource.disposable_caches.iter().any(|p| p == target.path)
    {
        return Err(refused());
    }
    Ok(resource)
}

/// Parse the read-only guest observation. `None` means the target is absent.
fn parse_observation(output: &str) -> Result<Option<(String, u64, u64, u64)>, CandidateError> {
    if output == "absent\n" {
        return Ok(None);
    }
    let line = output
        .strip_prefix("present ")
        .and_then(|v| v.strip_suffix('\n'))
        .filter(|v| v.len() <= 128 && !v.contains('\n'))
        .ok_or_else(refused)?;
    let mut fields = line.split(' ');
    let identity = fields
        .next()
        .filter(|v| volume_subpaths::valid_identity(v))
        .ok_or_else(refused)?;
    let mut number = || -> Result<u64, CandidateError> {
        fields
            .next()
            .filter(|v| !v.is_empty() && v.len() <= 20 && v.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|v| v.parse().ok())
            .ok_or_else(refused)
    };
    let (bytes, allocated, entries) = (number()?, number()?, number()?);
    if fields.next().is_some() || entries == 0 {
        return Err(refused());
    }
    Ok(Some((identity.to_owned(), bytes, allocated, entries)))
}

/// The inspected fields that identify a volume incarnation: everything except
/// `CreatedAt`, which the local driver derives from a directory mtime that the
/// first quarantine's `mkdir hack-quarantine` changes.
fn stable_volume_fields(inspected: &Value) -> Value {
    let mut stable = inspected.clone();
    if let Some(fields) = stable.as_object_mut() {
        fields.remove("CreatedAt");
    }
    stable
}

/// Whether `current` is the same volume incarnation as the admitted one. A
/// `CreatedAt` change alone is accepted; any other inspected change, or a
/// different guest-observed `_data` identity (a replaced volume), refuses.
fn same_incarnation(
    admitted: &Value,
    admitted_root: &str,
    current: &Value,
    current_root: &str,
) -> bool {
    admitted.is_object()
        && admitted_root == current_root
        && stable_volume_fields(admitted) == stable_volume_fields(current)
}

fn same_device(a: &str, b: &str) -> bool {
    a.split_once(':').map(|v| v.0) == b.split_once(':').map(|v| v.0)
}

/// Retained private records under `state_root/run/cache-quarantine`.
struct Records {
    directory: PathBuf,
    records: Vec<Record>,
}
impl Records {
    fn load(candidate: &Candidate) -> Result<Self, CandidateError> {
        let run = candidate.state_root.join("run");
        state::check_private_directory(&run).map_err(|_| refused())?;
        let directory = run.join("cache-quarantine");
        let mut records = Vec::new();
        match fs::symlink_metadata(&directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(refused()),
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(refused());
                }
                state::check_private_directory(&directory).map_err(|_| refused())?;
                for entry in fs::read_dir(&directory).map_err(|_| refused())? {
                    let entry = entry.map_err(|_| refused())?;
                    // A torn `.pending` write or any foreign entry refuses replay.
                    let name = entry.file_name();
                    let name = name.to_str().ok_or_else(refused)?;
                    let id = name.strip_suffix(".json").ok_or_else(refused)?;
                    if records.len() >= MAX_RECORDS
                        || !hex(id, 32)
                        || !entry.file_type().map_err(|_| refused())?.is_file()
                    {
                        return Err(refused());
                    }
                    let record: Record =
                        state::read_bounded(&entry.path(), RECORD_LIMIT).map_err(|_| refused())?;
                    if !record.valid() || record.id() != id {
                        return Err(refused());
                    }
                    records.push(record);
                }
            }
        }
        Ok(Self { directory, records })
    }
    /// At most one unresolved operation per volume; it must be resumed or
    /// resolved first.
    fn pending(&self, volume_name: &str) -> Result<Option<&Record>, CandidateError> {
        let mut pending = self
            .records
            .iter()
            .filter(|r| r.outcome == Outcome::Pending && r.selection.volume_name == volume_name);
        let first = pending.next();
        if pending.next().is_some() {
            return Err(refused());
        }
        Ok(first)
    }
    /// A new selection never reuses a pending or quarantined record and stays
    /// within the per-volume and global budgets. An abandoned identical
    /// selection moved nothing, so selecting it again replaces that record.
    /// The same quarantined directory of the same volume incarnation is never
    /// selected again, even though its digest changes with `CreatedAt`.
    fn admits(&self, selection: &Selection, sha: &str) -> bool {
        let id = Selection::quarantine_id(sha);
        let existing = self.records.iter().find(|r| r.id() == id);
        if existing.is_some_and(|r| r.outcome != Outcome::Abandoned) {
            return false;
        }
        if self.records.iter().any(|r| {
            r.outcome == Outcome::Quarantined
                && r.selection.volume_name == selection.volume_name
                && r.selection.root_identity == selection.root_identity
                && r.selection.target_identity == selection.target_identity
        }) {
            return false;
        }
        let added = usize::from(existing.is_none());
        self.records.len() + added <= MAX_RECORDS
            && self
                .records
                .iter()
                .filter(|r| r.selection.volume_name == selection.volume_name)
                .count()
                + added
                <= MAX_VOLUME_RECORDS
    }
    /// Recorded bytes still retained in this volume incarnation, counting
    /// `replacement` in place of any stored record with the same id. Records
    /// written before the first quarantine changed `CreatedAt` still count.
    fn retained(&self, admitted: &Admitted, replacement: Option<&Record>) -> (u64, u64) {
        self.records
            .iter()
            .filter(|r| replacement.is_none_or(|n| n.id() != r.id()))
            .chain(replacement)
            .filter(|r| {
                r.outcome == Outcome::Quarantined
                    && r.selection.volume_name == admitted.resource.name
                    && r.selection.root_identity == admitted.root_identity
            })
            .fold((0, 0), |(count, bytes), r| {
                (count + 1, bytes.saturating_add(r.selection.target_bytes))
            })
    }
    fn write(&self, record: &Record) -> Result<(), CandidateError> {
        if !record.valid() {
            return Err(refused());
        }
        let bytes = serde_json::to_vec_pretty(record).map_err(|_| refused())?;
        if bytes.len() as u64 > RECORD_LIMIT {
            return Err(refused());
        }
        match fs::symlink_metadata(&self.directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&self.directory)
                    .map_err(|_| refused())?;
                fs::File::open(self.directory.parent().ok_or_else(refused)?)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| refused())?;
            }
            Err(_) => return Err(refused()),
            Ok(_) => {}
        }
        state::check_private_directory(&self.directory).map_err(|_| refused())?;
        state::write(
            &self.directory.join(format!("{}.json", record.id())),
            record,
        )
        .map_err(|_| refused())
    }
}

fn journal_incomplete(root: &Path, receipt: &Receipt) -> Result<bool, CandidateError> {
    let pending = root.join("state.pending");
    #[cfg(target_os = "macos")]
    let interrupted = interrupted_start_cleanup::incomplete(root, &receipt.run)?;
    #[cfg(not(target_os = "macos"))]
    let interrupted = false;
    Ok(pending.exists()
        || pending.is_symlink()
        || interrupted
        || startup::require_dependency_rebind_complete(root, receipt).is_err())
}

/// Provider effects of one operation. Production uses the cleanup-only engine
/// connection, which holds the provider mutation lease for the whole call;
/// tests substitute a fixture that runs the same guest scripts on a synthetic
/// volume, so the orchestration below is exercised exactly as shipped.
trait Port {
    fn load(&self, candidate: &Candidate, run: &str) -> Result<(Receipt, PathBuf), CandidateError>;
    fn inspect(
        &self,
        receipt: &Receipt,
        resource: &Resource,
    ) -> Result<Option<Value>, CandidateError>;
    fn containers(&self) -> Result<Value, CandidateError>;
    fn execute(&self, script: &str, arguments: &[&str]) -> Result<String, CandidateError>;
}
impl Port for Engine<'_> {
    fn load(&self, candidate: &Candidate, run: &str) -> Result<(Receipt, PathBuf), CandidateError> {
        load(candidate, self, run)
    }
    fn inspect(
        &self,
        receipt: &Receipt,
        resource: &Resource,
    ) -> Result<Option<Value>, CandidateError> {
        // Owner/graph/plan labels are verified here; a foreign volume that
        // reuses the recorded name fails with its own ownership diagnostic.
        inspect_resource(self, receipt, resource)
    }
    fn containers(&self) -> Result<Value, CandidateError> {
        self.request(Method::GET, "/v1.53/containers/json?all=true", None)
    }
    fn execute(&self, script: &str, arguments: &[&str]) -> Result<String, CandidateError> {
        self.guest().execute(script, arguments, None)
    }
}

/// Evidence observed under the provider lease for one admitted target.
struct Admitted {
    receipt: Receipt,
    resource: Resource,
    inspected: Value,
    mountpoint: String,
    quarantine: String,
    created: String,
    root_identity: String,
    receipt_sha256: String,
}
fn admit(
    candidate: &Candidate,
    port: &impl Port,
    target: &CacheQuarantineTarget<'_>,
) -> Result<Admitted, CandidateError> {
    let (receipt, root) = port.load(candidate, target.run)?;
    let incomplete = journal_incomplete(&root, &receipt)?;
    let resource = authorize(&receipt, incomplete, target)?.clone();
    let inspected = port.inspect(&receipt, &resource)?.ok_or_else(refused)?;
    let mountpoint = format!("/var/lib/docker/volumes/{}/_data", resource.name);
    let created = inspected["CreatedAt"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(refused)?
        .to_owned();
    if inspected["Name"] != resource.name.as_str()
        || inspected["Mountpoint"] != mountpoint.as_str()
        || inspected["Driver"] != "local"
    {
        return Err(refused());
    }
    // Stopped containers count: any consumer could start and observe the move.
    volume_subpaths::no_consumers(&port.containers()?, &resource.name)?;
    let root_identity = volume_subpaths::directory_identity_with(
        |script, arguments| port.execute(script, arguments),
        &resource,
        &inspected,
    )?;
    let receipt_sha256 = digest(&serde_json::to_vec_pretty(&receipt).map_err(|_| refused())?);
    let quarantine = format!(
        "/var/lib/docker/volumes/{}/{QUARANTINE_DIRECTORY}",
        resource.name
    );
    Ok(Admitted {
        receipt,
        resource,
        inspected,
        mountpoint,
        quarantine,
        created,
        root_identity,
        receipt_sha256,
    })
}
impl Admitted {
    fn observe(
        &self,
        port: &impl Port,
        target: &CacheQuarantineTarget<'_>,
    ) -> Result<Option<Selection>, CandidateError> {
        let output = port.execute(
            OBSERVE,
            &[&self.mountpoint, &self.root_identity, target.path],
        )?;
        let Some((target_identity, target_bytes, allocated_bytes, entries)) =
            parse_observation(&output)?
        else {
            return Ok(None);
        };
        if !same_device(&target_identity, &self.root_identity) {
            return Err(refused());
        }
        Ok(Some(Selection {
            version: 1,
            run: self.receipt.run.clone(),
            owner: self.receipt.owner.clone(),
            receipt_sha256: self.receipt_sha256.clone(),
            volume: self.resource.key.clone(),
            volume_name: self.resource.name.clone(),
            volume_created: self.created.clone(),
            root_identity: self.root_identity.clone(),
            path: target.path.to_owned(),
            target_identity,
            target_bytes,
            allocated_bytes,
            entries,
        }))
    }
    /// A pending record resumes only for the identical receipt and volume
    /// incarnation. `volume_created` is not compared: an interrupted first
    /// quarantine has already changed it by creating the quarantine root.
    fn resumes(&self, selection: &Selection, target: &CacheQuarantineTarget<'_>) -> bool {
        selection.run == self.receipt.run
            && selection.owner == self.receipt.owner
            && selection.receipt_sha256 == self.receipt_sha256
            && selection.volume == self.resource.key
            && selection.volume_name == self.resource.name
            && selection.root_identity == self.root_identity
            && selection.path == target.path
            && same_device(&selection.target_identity, &self.root_identity)
    }
    /// The volume incarnation must be unchanged across every guest effect:
    /// the same stable inspected fields and a freshly observed, identical
    /// `_data` identity. Our own quarantine root changes only `CreatedAt`.
    fn recheck(&self, port: &impl Port) -> Result<(), CandidateError> {
        let current = port
            .inspect(&self.receipt, &self.resource)
            .ok()
            .flatten()
            .ok_or_else(unsettled)?;
        let current_root = volume_subpaths::directory_identity_with(
            |script, arguments| port.execute(script, arguments),
            &self.resource,
            &current,
        )
        .map_err(|_| unsettled())?;
        if !same_incarnation(
            &self.inspected,
            &self.root_identity,
            &current,
            &current_root,
        ) {
            return Err(unsettled());
        }
        Ok(())
    }
}

fn report(record: &Record, phase: &str, retained: (u64, u64)) -> Value {
    let selection = &record.selection;
    json!({
        "run":selection.run,
        "volume":selection.volume,
        "path":selection.path,
        "phase":phase,
        "selection_sha256":record.selection_sha256,
        "receipt_sha256":selection.receipt_sha256,
        "quarantine":record.id(),
        "target_bytes":selection.target_bytes,
        "allocated_bytes":selection.allocated_bytes,
        "entries":selection.entries,
        "quarantined_bytes":if record.outcome == Outcome::Quarantined {selection.target_bytes} else {0},
        "retained_quarantine_records":retained.0,
        "retained_quarantine_bytes":retained.1,
        "reclaimed_bytes":0,
        "data_retained":true,
        "quarantine_retained_until":"explicit_volume_removal",
        "mutation":false
    })
}

fn inspect_with(
    candidate: &Candidate,
    port: &impl Port,
    target: &CacheQuarantineTarget<'_>,
) -> Result<Value, CandidateError> {
    let admitted = admit(candidate, port, target)?;
    let records = Records::load(candidate)?;
    let retained = records.retained(&admitted, None);
    if let Some(record) = records.pending(&admitted.resource.name)? {
        // The operator sees the recorded digest; resumption needs the exact
        // receipt, while resolution is always available and never moves bytes.
        let phase = if admitted.resumes(&record.selection, target) {
            "resume_required"
        } else {
            "resolve_required"
        };
        return Ok(report(record, phase, retained));
    }
    let Some(selection) = admitted.observe(port, target)? else {
        return Ok(json!({
            "run":target.run,"volume":target.volume,"path":target.path,
            "phase":"target_absent",
            "retained_quarantine_records":retained.0,
            "retained_quarantine_bytes":retained.1,
            "reclaimed_bytes":0,"mutation":false
        }));
    };
    let record = Record {
        version: 1,
        selection_sha256: selection.sha256()?,
        selection,
        outcome: Outcome::Pending,
    };
    Ok(report(&record, "selectable", retained))
}

fn quarantine_with(
    candidate: &Candidate,
    port: &impl Port,
    target: &CacheQuarantineTarget<'_>,
    expected_selection: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected_selection, 64) {
        return Err(refused());
    }
    let admitted = admit(candidate, port, target)?;
    let records = Records::load(candidate)?;
    let (mut record, resumed) = match records.pending(&admitted.resource.name)? {
        Some(record) => {
            if record.selection_sha256 != expected_selection
                || !admitted.resumes(&record.selection, target)
            {
                return Err(refused());
            }
            (record.clone(), true)
        }
        None => {
            let selection = admitted.observe(port, target)?.ok_or_else(refused)?;
            let sha = selection.sha256()?;
            // An identical retained selection can never be replayed.
            if sha != expected_selection || !records.admits(&selection, &sha) {
                return Err(refused());
            }
            let record = Record {
                version: 1,
                selection_sha256: sha,
                selection,
                outcome: Outcome::Pending,
            };
            // Commit point 1: intent is durable before any guest effect.
            records.write(&record)?;
            (record, false)
        }
    };
    let output = port.execute(
        MOVE,
        &[
            &admitted.mountpoint,
            &admitted.quarantine,
            record.id(),
            target.path,
            &admitted.root_identity,
            &record.selection.target_identity,
        ],
    )?;
    let moved = match output.as_str() {
        "cache-quarantine-v1 moved\n" => true,
        "cache-quarantine-v1 resumed\n" => false,
        _ => return Err(refused()),
    };
    admitted.recheck(port)?;
    // Commit point 2: completion follows the guest's synchronized rename.
    record.outcome = Outcome::Quarantined;
    records.write(&record)?;
    let mut value = report(
        &record,
        "quarantined",
        records.retained(&admitted, Some(&record)),
    );
    value["mutation"] = json!(true);
    value["resumed"] = json!(resumed);
    value["moved_now"] = json!(moved);
    Ok(value)
}

fn resolve_with(
    candidate: &Candidate,
    port: &impl Port,
    target: &CacheQuarantineTarget<'_>,
    expected_selection: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected_selection, 64) {
        return Err(refused());
    }
    let admitted = admit(candidate, port, target)?;
    let records = Records::load(candidate)?;
    let mut record = records
        .pending(&admitted.resource.name)?
        .filter(|r| r.selection_sha256 == expected_selection && r.selection.path == target.path)
        .ok_or_else(refused)?
        .clone();
    // Read-only under the volume root lock. The current root identity is
    // checked; a replaced volume cannot hold the recorded destination inode.
    let output = port.execute(
        LOCATE,
        &[
            &admitted.mountpoint,
            &admitted.quarantine,
            record.id(),
            &admitted.root_identity,
            &record.selection.target_identity,
        ],
    )?;
    record.outcome = match output.as_str() {
        "cache-quarantine-v1 present\n" => Outcome::Quarantined,
        "cache-quarantine-v1 absent\n" => Outcome::Abandoned,
        _ => return Err(refused()),
    };
    admitted.recheck(port)?;
    records.write(&record)?;
    let phase = match record.outcome {
        Outcome::Quarantined => "quarantined",
        _ => "abandoned",
    };
    let mut value = report(&record, phase, records.retained(&admitted, Some(&record)));
    value["resolved"] = json!(true);
    Ok(value)
}

/// Read-only selection for `quarantine_cache`. It measures the exact admitted
/// target under the provider lease and returns the digest to review. A pending
/// operation for the volume is reported as `resume_required` or
/// `resolve_required` instead. Every result reports the recorded bytes still
/// retained in this volume's quarantine.
pub fn inspect_cache_quarantine(
    candidate: &Candidate,
    target: CacheQuarantineTarget<'_>,
) -> Result<Value, CandidateError> {
    inspect_with(candidate, &Engine::connect_cleanup(candidate)?, &target)
}

/// Move one admitted disposable cache directory into the volume's owned
/// quarantine. Requires the exact digest from `inspect_cache_quarantine`;
/// repeating it after interruption resumes the same recorded operation.
pub fn quarantine_cache(
    candidate: &Candidate,
    target: CacheQuarantineTarget<'_>,
    expected_selection: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected_selection, 64) {
        return Err(refused());
    }
    quarantine_with(
        candidate,
        &Engine::connect_cleanup(candidate)?,
        &target,
        expected_selection,
    )
}

/// Settle the volume's pending record without moving bytes: `quarantined` when
/// the recorded directory is at its destination, otherwise `abandoned`. Use it
/// when resumption is refused, for example after a restart changed the receipt.
pub fn resolve_cache_quarantine(
    candidate: &Candidate,
    target: CacheQuarantineTarget<'_>,
    expected_selection: &str,
) -> Result<Value, CandidateError> {
    if !hex(expected_selection, 64) {
        return Err(refused());
    }
    resolve_with(
        candidate,
        &Engine::connect_cleanup(candidate)?,
        &target,
        expected_selection,
    )
}

// Read-only. Rejects symlinked or non-directory components and reports the
// target's identity plus apparent file bytes, allocated bytes and entry count
// on the volume filesystem. Symlinks inside the target are counted, not followed.
const OBSERVE: &str = r#"set -efu
root=$1; root_identity=$2; relative=$3
parent=$root
while test "$parent" != /; do test ! -L "$parent"; test -d "$parent"; parent=${parent%/*}; test -n "$parent" || parent=/; done
test "$(stat -c %d:%i "$root")" = "$root_identity"
path=$root
previous_ifs=$IFS; IFS=/; set -- $relative; IFS=$previous_ifs
test "$#" -ge 1
for part in "$@"; do
 case "$part" in ''|.|..) exit 65;; esac
 path=$path/$part
 if test ! -e "$path" && test ! -L "$path"; then printf 'absent\n'; exit 0; fi
 test ! -L "$path"
 test -d "$path"
done
identity=$(stat -c %d:%i "$path")
test "${identity%%:*}" = "${root_identity%%:*}"
bytes=$({ find "$path" -xdev -type f -exec stat -c %s {} + || echo failed; } | awk '$0=="failed"{bad=1;next} {s+=$1} END{if(bad)exit 1; printf "%.0f\n", s}')
allocated=$({ find "$path" -xdev -exec stat -c '%b %B' {} + || echo failed; } | awk '$0=="failed"{bad=1;next} {s+=$1*$2;n+=1} END{if(bad)exit 1; printf "%.0f %.0f\n", s, n}')
test "$(stat -c %d:%i "$root")" = "$root_identity"
printf 'present %s %s %s\n' "$identity" "$bytes" "$allocated"
"#;

// The only mutation: one rename(2) under the volume root lock. Source and
// quarantine must resolve to the same mount (findmnt mount ID), so rename
// cannot fail with EXDEV and `mv` never reaches its copy-then-unlink fallback.
// Accepts the exact target at its source or already at its destination; any
// other layout refuses without effects.
const MOVE: &str = r#"set -efu
root=$1; quarantine=$2; id=$3; relative=$4; root_identity=$5; target_identity=$6
case "$id" in *[!0-9a-f]*|'') exit 64;; esac
test "${#id}" -eq 32
test "$quarantine" = "${root%/*}/hack-quarantine"
parent=$root
while test "$parent" != /; do test ! -L "$parent"; test -d "$parent"; parent=${parent%/*}; test -n "$parent" || parent=/; done
test "$(stat -c %d:%i "$root")" = "$root_identity"
test "${target_identity%%:*}" = "${root_identity%%:*}"
exec 9<"$root"
flock -w 5 9
test "$(stat -Lc %d:%i /proc/self/fd/9)" = "$root_identity"
if test ! -e "$quarantine" && test ! -L "$quarantine"; then mkdir -m 700 "$quarantine"; fi
test ! -L "$quarantine"
test -d "$quarantine"
test "$(stat -c %u:%a "$quarantine")" = "$(id -u):700"
test "$(stat -c %d "$quarantine")" = "${root_identity%%:*}"
path=$root
previous_ifs=$IFS; IFS=/; set -- $relative; IFS=$previous_ifs
test "$#" -ge 1
count=$#; index=0
for part in "$@"; do
 case "$part" in ''|.|..) exit 65;; esac
 index=$((index + 1))
 path=$path/$part
 if test "$index" -lt "$count"; then test ! -L "$path"; test -d "$path"; fi
done
destination=$quarantine/$id
if test -e "$path" || test -L "$path"; then
 test ! -L "$path"
 test -d "$path"
 test "$(stat -c %d:%i "$path")" = "$target_identity"
 test ! -e "$destination"
 test ! -L "$destination"
 mount=$(findmnt -n -o ID -T "$path")
 test -n "$mount"
 test "$(findmnt -n -o ID -T "$quarantine")" = "$mount"
 mv "$path" "$destination"
 state=moved
else
 test ! -L "$destination"
 test -d "$destination"
 state=resumed
fi
test "$(stat -c %d:%i "$destination")" = "$target_identity"
test "$(stat -c %d:%i "$root")" = "$root_identity"
sync -f "$root"
printf 'cache-quarantine-v1 %s\n' "$state"
"#;

// Read-only resolution of a pending record. Under the volume root lock (which
// MOVE holds across its rename and sync), the recorded destination either
// holds the recorded directory or is absent. Anything else refuses.
const LOCATE: &str = r#"set -efu
root=$1; quarantine=$2; id=$3; root_identity=$4; target_identity=$5
case "$id" in *[!0-9a-f]*|'') exit 64;; esac
test "${#id}" -eq 32
test "$quarantine" = "${root%/*}/hack-quarantine"
parent=$root
while test "$parent" != /; do test ! -L "$parent"; test -d "$parent"; parent=${parent%/*}; test -n "$parent" || parent=/; done
test "$(stat -c %d:%i "$root")" = "$root_identity"
exec 9<"$root"
flock -w 5 9
test "$(stat -Lc %d:%i /proc/self/fd/9)" = "$root_identity"
destination=$quarantine/$id
if test ! -e "$quarantine" && test ! -L "$quarantine"; then printf 'cache-quarantine-v1 absent\n'; exit 0; fi
test ! -L "$quarantine"
test -d "$quarantine"
test "$(stat -c %d "$quarantine")" = "${root_identity%%:*}"
if test ! -e "$destination" && test ! -L "$destination"; then printf 'cache-quarantine-v1 absent\n'; exit 0; fi
test ! -L "$destination"
test -d "$destination"
test "$(stat -c %d:%i "$destination")" = "$target_identity"
printf 'cache-quarantine-v1 present\n'
"#;

#[cfg(test)]
#[path = "cache_quarantine/tests.rs"]
mod tests;
