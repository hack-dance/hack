use super::{Result, error, now, private_directory, private_file};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const OUTPUT_LIMIT: usize = 16 * 1024;
const CAPACITY: i64 = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mutation {
    pub operation_id: String,
    pub expected_generation: i64,
    pub target: String,
    pub principal: u32,
    #[serde(default)]
    pub request_digest: String,
    #[serde(default = "default_capabilities")]
    pub required_capabilities: Vec<String>,
}

fn default_capabilities() -> Vec<String> {
    vec!["fixture_jobs_v1".into()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status {
        version: u32,
    },
    Result {
        version: u32,
        job_id: String,
    },
    Submit {
        version: u32,
        mutation: Mutation,
        fixture: String,
        queue_timeout_ms: u64,
        execution_timeout_ms: u64,
    },
    SubmitSource {
        version: u32,
        mutation: Mutation,
        source: crate::provider::SourceJob,
        queue_timeout_ms: u64,
        execution_timeout_ms: u64,
    },
    ReconcileSource {
        version: u32,
        mutation: Mutation,
        job_id: String,
    },
    Cancel {
        version: u32,
        mutation: Mutation,
        job_id: String,
    },
}
impl Request {
    /// Canonical v1 digest: compact, sorted-key JSON after serde normalization,
    /// excluding mutation.request_digest itself.
    pub fn digest(&self) -> Result<String> {
        let mut value = serde_json::to_value(self).map_err(error)?;
        if let Some(mutation) = value.get_mut("mutation").and_then(|v| v.as_object_mut()) {
            mutation.remove("request_digest");
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&value).map_err(error)?)
        ))
    }
    pub fn seal(mut self) -> Result<Self> {
        let digest = self.digest()?;
        match &mut self {
            Self::Submit { mutation, .. }
            | Self::SubmitSource { mutation, .. }
            | Self::ReconcileSource { mutation, .. }
            | Self::Cancel { mutation, .. } => mutation.request_digest = digest,
            _ => {}
        }
        Ok(self)
    }
    pub fn version(&self) -> u32 {
        match self {
            Self::Status { version }
            | Self::Result { version, .. }
            | Self::Submit { version, .. }
            | Self::SubmitSource { version, .. }
            | Self::ReconcileSource { version, .. }
            | Self::Cancel { version, .. } => *version,
        }
    }
    fn mutation(&self) -> Option<&Mutation> {
        match self {
            Self::Submit { mutation, .. }
            | Self::SubmitSource { mutation, .. }
            | Self::ReconcileSource { mutation, .. }
            | Self::Cancel { mutation, .. } => Some(mutation),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub job_id: String,
    pub fixture: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::provider::SourceJob>,
    pub state: String,
    pub accepted_at_ms: i64,
    pub queue_deadline_ms: i64,
    pub execution_timeout_ms: u64,
    pub starts: u32,
    pub supervisor_pid: Option<i32>,
    pub child_pid: Option<i32>,
    pub supervisor_identity: Option<super::ProcessIdentity>,
    pub child_identity: Option<super::ProcessIdentity>,
    pub cancel_requested: bool,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub detail: Option<String>,
}
impl Receipt {
    pub fn terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "succeeded"
                | "failed"
                | "cancelled"
                | "timed_out"
                | "queue_expired"
                | "quarantined"
                | "reconciled_unknown"
        )
    }
}

pub struct Store {
    pub(crate) connection: Connection,
    pub(crate) root: PathBuf,
    pub target: String,
}
impl Store {
    pub fn open(root: &Path, create: bool) -> Result<Self> {
        Self::open_mode(root, create, false)
    }
    pub fn inspect(root: &Path) -> Result<Self> {
        Self::open_mode(root, false, true)
    }
    fn open_mode(root: &Path, create: bool, read_only: bool) -> Result<Self> {
        private_directory(root, create)?;
        let root = root.canonicalize().map_err(error)?;
        // Reject aliases before SQLite opens its journal or main file.
        for suffix in [
            "journal.sqlite",
            "journal.sqlite-journal",
            "journal.sqlite-wal",
            "journal.sqlite-shm",
        ] {
            let path = root.join(suffix);
            if path.symlink_metadata().is_ok() {
                private_file(&path, false)?;
            }
        }
        private_file(&root.join("journal.sqlite"), create)?;
        let flags = if read_only {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        let mut connection =
            Connection::open_with_flags(root.join("journal.sqlite"), flags).map_err(error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(2))
            .map_err(error)?;
        if !read_only {
            connection
                .execute_batch(
                    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
                )
                .map_err(error)?;
        }
        let existing_version: i32 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(error)?;
        if existing_version != 1 && !(create && existing_version == 0) {
            return Err(error("Unsupported journal schema."));
        }
        if create && existing_version == 0 {
            let tables: i64 = connection
                .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
                .map_err(error)?;
            if tables != 0 {
                return Err(error("Unrecognized unversioned database."));
            }
            let mut nonce = [0u8; 32];
            // SAFETY: getentropy writes exactly this writable 32-byte buffer.
            if unsafe { libc::getentropy(nonce.as_mut_ptr().cast(), nonce.len()) } != 0 {
                return Err(error("Node identity entropy unavailable."));
            }
            let mut hasher = Sha256::new();
            hasher.update(root.as_os_str().as_encoded_bytes());
            hasher.update(nonce);
            let identity = format!("{:x}", hasher.finalize());
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            tx.execute_batch("CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, identity TEXT NOT NULL, state_root TEXT NOT NULL);
                CREATE TABLE operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL);
                CREATE TABLE jobs (id TEXT PRIMARY KEY, receipt TEXT NOT NULL);
                PRAGMA user_version=1;").map_err(error)?;
            tx.execute(
                "INSERT INTO meta VALUES (1,0,?,?)",
                params![
                    identity,
                    root.to_str()
                        .ok_or_else(|| error("Node path must be UTF-8."))?
                ],
            )
            .map_err(error)?;
            tx.commit().map_err(error)?;
        }
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(error)?;
        if version != 1 {
            return Err(error("Unsupported journal schema."));
        }
        let target: String = connection
            .query_row("SELECT identity FROM meta WHERE id=1", [], |r| r.get(0))
            .map_err(error)?;
        let bound_root: String = connection
            .query_row("SELECT state_root FROM meta WHERE id=1", [], |r| r.get(0))
            .map_err(error)?;
        if Path::new(&bound_root) != root {
            return Err(error("Journal belongs to a different node directory."));
        }
        if target.len() != 64 || !target.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error("Invalid node identity."));
        }
        Ok(Self {
            connection,
            root,
            target,
        })
    }

    pub fn handle(&mut self, request: &Request, uid: u32) -> Result<serde_json::Value> {
        self.handle_context(request, uid, None)
    }

    pub fn handle_for_candidate(
        &mut self,
        request: &Request,
        uid: u32,
        candidate: &crate::Candidate,
    ) -> Result<serde_json::Value> {
        if super::root(candidate) != self.root {
            return Err(error(
                "Source execution requires this candidate's bound node journal.",
            ));
        }
        self.handle_context(request, uid, Some(candidate))
    }

    fn handle_context(
        &mut self,
        request: &Request,
        uid: u32,
        candidate: Option<&crate::Candidate>,
    ) -> Result<serde_json::Value> {
        if request.version() != 1 {
            return Err(crate::CandidateError::new(
                "protocol_version",
                "Unsupported protocol version.",
            ));
        }
        if let Some(mutation) = request.mutation() {
            validate_id(&mutation.operation_id)?;
            if mutation.target != self.target || mutation.principal != uid {
                return Err(crate::CandidateError::new(
                    "authority_mismatch",
                    "Explicit target or peer principal mismatch.",
                ));
            }
            if mutation.request_digest != request.digest()? {
                return Err(crate::CandidateError::new(
                    "digest_mismatch",
                    "Request digest mismatch.",
                ));
            }
            if mutation.required_capabilities.is_empty()
                || mutation.required_capabilities.len() > 8
                || mutation.required_capabilities.iter().any(|c| {
                    !["fixture_jobs_v1", "cooperative_process_groups"].contains(&c.as_str())
                        && !(candidate.is_some()
                            && ["immutable_source_jobs_v1", "source_job_reconciliation_v1"]
                                .contains(&c.as_str()))
                })
            {
                return Err(crate::CandidateError::new(
                    "capability_mismatch",
                    "Unknown or empty required capability profile.",
                ));
            }
            if matches!(request, Request::SubmitSource { .. })
                && !mutation
                    .required_capabilities
                    .iter()
                    .any(|c| c == "immutable_source_jobs_v1")
            {
                return Err(crate::CandidateError::new(
                    "capability_mismatch",
                    "Source jobs require the immutable source capability.",
                ));
            }
            if matches!(request, Request::ReconcileSource { .. })
                && !mutation
                    .required_capabilities
                    .iter()
                    .any(|c| c == "source_job_reconciliation_v1")
            {
                return Err(crate::CandidateError::new(
                    "capability_mismatch",
                    "Reconciliation requires its explicit source-job capability.",
                ));
            }
            return self.mutate(request, candidate);
        }
        match request {
            Request::Status { .. } => {
                let generation: i64 = self
                    .connection
                    .query_row("SELECT generation FROM meta WHERE id=1", [], |r| r.get(0))
                    .map_err(error)?;
                let mut capabilities = vec!["fixture_jobs_v1", "cooperative_process_groups"];
                if candidate.is_some() {
                    capabilities
                        .extend(["immutable_source_jobs_v1", "source_job_reconciliation_v1"]);
                }
                Ok(
                    serde_json::json!({"version":1,"target":self.target,"generation":generation,
                    "jobs":self.list()?.iter().map(|r| serde_json::json!({"job_id":r.job_id,"state":r.state})).collect::<Vec<_>>(),
                    "capabilities":capabilities,"project_execution":false,"source_job_execution":candidate.is_some()}),
                )
            }
            Request::Result { job_id, .. } => {
                serde_json::to_value(self.get(job_id)?).map_err(error)
            }
            _ => unreachable!(),
        }
    }

    fn mutate(
        &mut self,
        request: &Request,
        candidate: Option<&crate::Candidate>,
    ) -> Result<serde_json::Value> {
        let m = request.mutation().expect("mutation variant");
        let digest = request.digest()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT digest,response FROM operations WHERE id=?",
                [&m.operation_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        if let Some((old_digest, response)) = previous {
            if digest != old_digest {
                return Err(crate::CandidateError::new(
                    "operation_conflict",
                    "Operation ID was already used with a different request.",
                ));
            }
            return serde_json::from_str(&response).map_err(error);
        }
        let generation: i64 = tx
            .query_row("SELECT generation FROM meta WHERE id=1", [], |r| r.get(0))
            .map_err(error)?;
        if m.expected_generation != generation {
            return Err(crate::CandidateError::new(
                "stale_generation",
                "Stale expected generation.",
            ));
        }
        let count: i64 = tx
            .query_row("SELECT count(*) FROM operations", [], |r| r.get(0))
            .map_err(error)?;
        if count >= CAPACITY {
            return Err(error(
                "Journal capacity reached; retry identities are retained.",
            ));
        }
        let mut source_guard = None;
        let mut reconciliation_lock = None;
        let job_id = match request {
            Request::Submit {
                queue_timeout_ms,
                execution_timeout_ms,
                ..
            }
            | Request::SubmitSource {
                queue_timeout_ms,
                execution_timeout_ms,
                ..
            } => {
                let (fixture, source) = match request {
                    Request::Submit { fixture, .. } => (fixture.as_str(), None),
                    Request::SubmitSource { source, .. } => ("immutable-source", Some(source)),
                    _ => unreachable!(),
                };
                if (source.is_none()
                    && !["success", "failure", "output", "tree"].contains(&fixture))
                    || !(100..=30_000).contains(queue_timeout_ms)
                    || !(100..=if source.is_some() { 300_000 } else { 10_000 })
                        .contains(execution_timeout_ms)
                {
                    return Err(error(
                        "Unsupported fixture or deadline (queue 100..30000ms, execution 100..10000ms).",
                    ));
                }
                let jobs: i64 = tx
                    .query_row("SELECT count(*) FROM jobs", [], |r| r.get(0))
                    .map_err(error)?;
                if jobs >= 128 {
                    return Err(crate::CandidateError::new(
                        "journal_capacity",
                        "Job capacity reached; receipts are retained.",
                    ));
                }
                if let Some(source) = source {
                    source_guard = Some(source.admit(candidate.ok_or_else(|| {
                        error("Source execution requires a bound candidate context.")
                    })?)?);
                }
                let id = format!("{:x}", Sha256::digest(m.operation_id.as_bytes()));
                let receipt = Receipt {
                    job_id: id.clone(),
                    fixture: fixture.into(),
                    source: source.cloned(),
                    state: "queued".into(),
                    accepted_at_ms: now(),
                    queue_deadline_ms: now() + *queue_timeout_ms as i64,
                    execution_timeout_ms: *execution_timeout_ms,
                    starts: 0,
                    supervisor_pid: None,
                    child_pid: None,
                    supervisor_identity: None,
                    child_identity: None,
                    cancel_requested: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    truncated: false,
                    exit_code: None,
                    signal: None,
                    detail: None,
                };
                tx.execute(
                    "INSERT INTO jobs VALUES (?,?)",
                    params![id, serde_json::to_string(&receipt).map_err(error)?],
                )
                .map_err(error)?;
                id
            }
            Request::ReconcileSource { job_id, .. } => {
                if job_id.len() != 64 || !job_id.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(error("Invalid job ID."));
                }
                let mut receipt = read_receipt(&tx, job_id)?;
                let source = reconciliation_source(&receipt)?;
                reconciliation_lock = Some(
                    super::try_lock(&self.root.join(format!("{job_id}.lock")))?.ok_or_else(
                        || error("Job supervisor is still active; reconciliation refused."),
                    )?,
                );
                crate::provider::reconcile_source_job(
                    candidate
                        .ok_or_else(|| error("Reconciliation requires the bound candidate."))?,
                    job_id,
                    source,
                )?;
                receipt.state = "reconciled_unknown".into();
                receipt.detail = Some("Owned container absence confirmed by explicit reconciliation. Prior execution outcome remains unknown; no job was replayed.".into());
                write_receipt(&tx, &receipt)?;
                job_id.clone()
            }
            Request::Cancel { job_id, .. } => {
                let mut receipt = read_receipt(&tx, job_id)?;
                if !receipt.terminal() {
                    receipt.cancel_requested = true;
                    if receipt.state == "queued" {
                        receipt.state = "cancelled".into();
                    }
                    write_receipt(&tx, &receipt)?;
                }
                job_id.clone()
            }
            _ => unreachable!(),
        };
        let response = serde_json::json!({"version":1,"operation_id":m.operation_id,"request_digest":digest,"generation":generation+1,"job_id":job_id,"accepted":true});
        tx.execute(
            "INSERT INTO operations VALUES (?,?,?)",
            params![m.operation_id, digest, response.to_string()],
        )
        .map_err(error)?;
        tx.execute("UPDATE meta SET generation=generation+1 WHERE id=1", [])
            .map_err(error)?;
        tx.commit().map_err(error)?;
        drop(source_guard);
        drop(reconciliation_lock);
        Ok(response)
    }

    pub fn get(&self, id: &str) -> Result<Receipt> {
        read_receipt(&self.connection, id)
    }
    pub fn list(&self) -> Result<Vec<Receipt>> {
        let mut statement = self
            .connection
            .prepare("SELECT receipt FROM jobs ORDER BY rowid")
            .map_err(error)?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(error)?;
        rows.map(|r| serde_json::from_str(&r.map_err(error)?).map_err(error))
            .collect()
    }
    /// All competing terminal updates and cancellation requests serialize here.
    pub(crate) fn update(
        &mut self,
        id: &str,
        change: impl FnOnce(&mut Receipt) -> Result<()>,
    ) -> Result<Receipt> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut receipt = read_receipt(&tx, id)?;
        if !receipt.terminal() {
            change(&mut receipt)?;
            write_receipt(&tx, &receipt)?;
        }
        tx.commit().map_err(error)?;
        Ok(receipt)
    }
    pub(crate) fn lock_path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error("Invalid job ID."));
        }
        Ok(self.root.join(format!("{id}.lock")))
    }
}
fn reconciliation_source(receipt: &Receipt) -> Result<&crate::provider::SourceJob> {
    if receipt.state != "quarantined" {
        return Err(error(
            "Only quarantined source jobs can be explicitly reconciled.",
        ));
    }
    receipt
        .source
        .as_ref()
        .ok_or_else(|| error("Host fixture jobs do not support source-container reconciliation."))
}
fn read_receipt(connection: &Connection, id: &str) -> Result<Receipt> {
    let raw: String = connection
        .query_row("SELECT receipt FROM jobs WHERE id=?", [id], |r| r.get(0))
        .map_err(error)?;
    serde_json::from_str(&raw).map_err(error)
}
fn write_receipt(connection: &Connection, receipt: &Receipt) -> Result<()> {
    connection
        .execute(
            "UPDATE jobs SET receipt=? WHERE id=?",
            params![
                serde_json::to_string(receipt).map_err(error)?,
                receipt.job_id
            ],
        )
        .map_err(error)?;
    Ok(())
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(error(
            "Operation ID must be 1..128 ASCII letters, digits, dots, underscores or hyphens.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reconciliation_refuses_live_or_foreign_work_and_preserves_uncertainty_on_failure() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-reconcile-{}-{}",
            std::process::id(),
            now()
        ));
        private_directory(&root, true).unwrap();
        let candidate = crate::Candidate::discover(&root).unwrap();
        let mut store = Store::open(&super::super::root(&candidate), true).unwrap();
        let uid = unsafe { libc::geteuid() };
        let mutation = |name: &str, generation, capabilities: Vec<String>| Mutation {
            operation_id: name.into(),
            expected_generation: generation,
            target: store.target.clone(),
            principal: uid,
            request_digest: String::new(),
            required_capabilities: capabilities,
        };
        let submit = Request::Submit {
            version: 1,
            mutation: mutation("fixture", 0, vec!["fixture_jobs_v1".into()]),
            fixture: "success".into(),
            queue_timeout_ms: 1000,
            execution_timeout_ms: 1000,
        }
        .seal()
        .unwrap();
        let reconcile_mutation =
            mutation("reconcile", 1, vec!["source_job_reconciliation_v1".into()]);
        let accepted = store
            .handle_for_candidate(&submit, uid, &candidate)
            .unwrap();
        let job = accepted["job_id"].as_str().unwrap();
        let request = Request::ReconcileSource {
            version: 1,
            mutation: reconcile_mutation,
            job_id: job.into(),
        }
        .seal()
        .unwrap();
        assert_eq!(
            store.handle(&request, uid).unwrap_err().code,
            "capability_mismatch"
        );
        assert!(
            store
                .handle_for_candidate(&request, uid, &candidate)
                .unwrap_err()
                .message
                .contains("Only quarantined")
        );
        let mut receipt = store.get(job).unwrap();
        receipt.state = "quarantined".into();
        write_receipt(&store.connection, &receipt).unwrap();
        assert!(
            store
                .handle_for_candidate(&request, uid, &candidate)
                .unwrap_err()
                .message
                .contains("Host fixture")
        );
        receipt.source = Some(crate::provider::SourceJob {
            namespace: "a".repeat(64),
            revision: "b".repeat(64),
            image: format!("sha256:{}", "c".repeat(64)),
            argv: vec!["/bin/true".into()],
            memory_bytes: 64 * 1024 * 1024,
        });
        write_receipt(&store.connection, &receipt).unwrap();
        let lock = super::super::try_lock(&store.lock_path(job).unwrap())
            .unwrap()
            .unwrap();
        assert!(
            store
                .handle_for_candidate(&request, uid, &candidate)
                .unwrap_err()
                .message
                .contains("still active")
        );
        drop(lock);
        assert!(
            store
                .handle_for_candidate(&request, uid, &candidate)
                .is_err(),
            "An absent provider cannot prove container cleanup"
        );
        assert_eq!(store.get(job).unwrap().state, "quarantined");
        let status = store
            .handle_for_candidate(&Request::Status { version: 1 }, uid, &candidate)
            .unwrap();
        assert_eq!(status["generation"], 1);
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM operations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        receipt.state = "reconciled_unknown".into();
        assert!(receipt.terminal());
        assert_ne!(receipt.state, "succeeded");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_full_rolls_back_job_and_operation_together() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-node-full-{}-{}",
            std::process::id(),
            now()
        ));
        let mut store = Store::open(&root, true).unwrap();
        let pages: i64 = store
            .connection
            .pragma_query_value(None, "page_count", |r| r.get(0))
            .unwrap();
        store
            .connection
            .pragma_update(None, "max_page_count", pages)
            .unwrap();
        let mut found_full = false;
        for index in 0..128 {
            let before = store.list().unwrap().len();
            let request = Request::Submit {
                version: 1,
                mutation: Mutation {
                    operation_id: format!("full-{index}"),
                    expected_generation: index,
                    target: store.target.clone(),
                    principal: unsafe { libc::geteuid() },
                    request_digest: String::new(),
                    required_capabilities: vec!["fixture_jobs_v1".into()],
                },
                fixture: "success".into(),
                queue_timeout_ms: 1000,
                execution_timeout_ms: 1000,
            }
            .seal()
            .unwrap();
            if let Err(failure) = store.handle(&request, unsafe { libc::geteuid() }) {
                assert!(failure.message.contains("full"), "{failure:?}");
                assert_eq!(store.list().unwrap().len(), before);
                let status = store
                    .handle(&Request::Status { version: 1 }, unsafe { libc::geteuid() })
                    .unwrap();
                assert_eq!(status["generation"], index);
                store
                    .connection
                    .pragma_update(None, "max_page_count", 10000)
                    .unwrap();
                let accepted = store.handle(&request, unsafe { libc::geteuid() }).unwrap();
                assert_eq!(
                    store.handle(&request, unsafe { libc::geteuid() }).unwrap(),
                    accepted
                );
                found_full = true;
                break;
            }
        }
        assert!(
            found_full,
            "Test must exercise SQLite's actual SQLITE_FULL path."
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
