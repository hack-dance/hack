//! Conservative durable name admission; slots are not automatically refunded.
use super::super::{publication, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const MAX_BYTES: usize = 1024 * 1024;
fn refused() -> CandidateError {
    CandidateError::new(
        "certificate_admission",
        "Certificate budget is unavailable or exhausted; preserve admission history.",
    )
}
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    owner: String,
    limit: usize,
    names: BTreeSet<String>,
}
fn read(root: &Path) -> Result<Record, CandidateError> {
    state::check_private_directory(root)?;
    let pending = root.join("state.pending");
    if pending.exists() || pending.is_symlink() {
        return Err(refused());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join("state.json"))
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.len() > MAX_BYTES as u64
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() > MAX_BYTES {
        return Err(refused());
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if record.version != 1
        || record.owner.len() != 32
        || !record.owner.bytes().all(|b| b.is_ascii_hexdigit())
        || !(1..=4096).contains(&record.limit)
        || record.names.len() > record.limit
        || record.names.iter().any(|name| {
            publication::normalize_hostname(name).ok().as_deref() != Some(name.as_str())
        })
    {
        return Err(refused());
    }
    Ok(record)
}
fn write(root: &Path, value: &Record) -> Result<(), CandidateError> {
    if serde_json::to_vec_pretty(value)
        .map_err(|_| refused())?
        .len()
        > MAX_BYTES
    {
        return Err(refused());
    }
    state::write(&root.join("state.json"), value)
}
pub(super) struct Budget {
    root: PathBuf,
    record: Record,
    _lock: state::Lock,
}
impl Budget {
    pub(super) fn open(root: &Path, owner: &str, limit: usize) -> Result<Self, CandidateError> {
        if !(1..=4096).contains(&limit) {
            return Err(refused());
        }
        let existing = root.exists() || root.is_symlink();
        let lock = state::Lock::acquire(root)?;
        let path = root.join("state.json");
        let pending = root.join("state.pending");
        if !existing
            && !path.exists()
            && !path.is_symlink()
            && !pending.exists()
            && !pending.is_symlink()
        {
            write(
                root,
                &Record {
                    version: 1,
                    owner: owner.into(),
                    limit,
                    names: BTreeSet::new(),
                },
            )?;
        }
        let record = read(root)?;
        if record.owner != owner || record.limit != limit {
            return Err(refused());
        }
        Ok(Self {
            root: root.into(),
            record,
            _lock: lock,
        })
    }
    pub(super) fn admit(&mut self, name: &str) -> Result<(), CandidateError> {
        if publication::normalize_hostname(name)?.as_str() != name
            || read(&self.root)? != self.record
        {
            return Err(refused());
        }
        if self.record.names.contains(name) {
            return Ok(());
        }
        if self.record.names.len() >= self.record.limit {
            return Err(refused());
        }
        let mut next = Record {
            version: 1,
            owner: self.record.owner.clone(),
            limit: self.record.limit,
            names: self.record.names.clone(),
        };
        next.names.insert(name.into());
        write(&self.root, &next)?;
        self.record = next;
        Ok(())
    }
}
pub(super) fn root(c: &Candidate) -> PathBuf {
    c.state_root.join("run/certificate-admission")
}
pub fn inspect(c: &Candidate) -> Result<serde_json::Value, CandidateError> {
    let owner = state::Owner::load(c)?;
    let root = root(c);
    if !root.exists() && !root.is_symlink() {
        return Ok(serde_json::json!({"configured":false}));
    }
    let record = read(&root)?;
    if record.owner != owner.token {
        return Err(refused());
    }
    Ok(
        serde_json::json!({"configured":true,"limit":record.limit,"admitted":record.names.len(),"remaining":record.limit-record.names.len(),"names":record.names,"maximum_receipt_bytes":MAX_BYTES,"scope":"admission-history-not-certificate-storage","automatic_refund":false}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-cert-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path.join("budget"))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn durable_budget_deduplicates_and_refuses_reset_or_concurrent_writer() {
        let f = Fixture::new();
        let owner = "a".repeat(32);
        let mut budget = Budget::open(&f.0, &owner, 2).unwrap();
        assert!(Budget::open(&f.0, &owner, 2).is_err());
        budget.admit("api.demo.hack").unwrap();
        budget.admit("api.demo.hack").unwrap();
        budget.admit("custom.example.test").unwrap();
        assert!(budget.admit("third.example.test").is_err());
        drop(budget);
        assert!(Budget::open(&f.0, &owner, 3).is_err());
        assert!(Budget::open(&f.0, &"b".repeat(32), 2).is_err());
        let mut budget = Budget::open(&f.0, &owner, 2).unwrap();
        budget.admit("api.demo.hack").unwrap();
        assert!(budget.admit("third.example.test").is_err());
        assert_eq!(read(&f.0).unwrap().names.len(), 2);
    }
    #[test]
    fn partial_and_replaced_history_refuses_even_previously_admitted_names() {
        let f = Fixture::new();
        let owner = "a".repeat(32);
        let mut budget = Budget::open(&f.0, &owner, 2).unwrap();
        budget.admit("a.hack").unwrap();
        let saved = fs::read(f.0.join("state.json")).unwrap();
        fs::write(f.0.join("state.pending"), b"{").unwrap();
        assert!(budget.admit("a.hack").is_err());
        drop(budget);
        assert!(Budget::open(&f.0, &owner, 2).is_err());
        assert_eq!(fs::read(f.0.join("state.json")).unwrap(), saved);
        fs::remove_file(f.0.join("state.pending")).unwrap();
        let mut budget = Budget::open(&f.0, &owner, 2).unwrap();
        fs::write(f.0.join("state.json"), b"{").unwrap();
        assert!(budget.admit("a.hack").is_err());
        assert_eq!(fs::read(f.0.join("state.json")).unwrap(), b"{");
        drop(budget);
        fs::remove_file(f.0.join("state.json")).unwrap();
        assert!(Budget::open(&f.0, &owner, 2).is_err());
        assert!(!f.0.join("state.json").exists());
    }
}
