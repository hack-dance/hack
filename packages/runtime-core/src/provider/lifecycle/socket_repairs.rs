//! The provider sockets native repaired for the running provider (HACK-2375 follow-up).
//!
//! A leased audit or the fresh-boot socket wait can change a world-accessible provider
//! socket to private (`bridge::private_socket`). Each repair is recorded here, keyed by the
//! provider process it belongs to, so `runtime up` and `runtime status` state it instead of
//! leaving it to be inferred from timestamps. A record for another provider process is
//! replaced, so the report always describes the running provider.
//!
//! This is a report only. Recording never fails or changes a start, an audit or a stop:
//! every write error is ignored, and a missing, foreign or malformed record reads as none.
use super::super::{identity::ProcessIdentity, state};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const FILE: &str = "socket-repairs.json";
const VERSION: u32 = 1;
/// More names than the provider can create (8 provider sockets and 32 bridge slots).
const MAX_NAMES: usize = 64;

/// The sockets repaired for the running provider, as reported by `runtime status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepairedSockets {
    pub count: usize,
    /// File names in the provider's machine directory, sorted.
    pub names: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    pid: i32,
    start_micros: u64,
    names: BTreeSet<String>,
}

fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_')
}

fn load(root: &Path) -> Option<Record> {
    let record: Record = state::read(&path(root)).ok()?;
    (record.version == VERSION
        && record.names.len() <= MAX_NAMES
        && record.names.iter().all(|name| valid(name)))
    .then_some(record)
}

/// Add `names` to the record of `process`. Best-effort: see the module contract. The caller
/// holds the pool's operation lock.
pub(super) fn record(root: &Path, process: Option<&ProcessIdentity>, names: &[String]) {
    let (Some(process), false) = (process, names.is_empty()) else {
        return;
    };
    let mut merged = match load(root) {
        Some(record)
            if record.pid == process.pid && record.start_micros == process.start_micros =>
        {
            record.names
        }
        _ => BTreeSet::new(),
    };
    merged.extend(names.iter().filter(|name| valid(name)).cloned());
    if merged.len() > MAX_NAMES {
        return;
    }
    let _ = replace(
        root,
        &Record {
            version: VERSION,
            pid: process.pid,
            start_micros: process.start_micros,
            names: merged,
        },
    );
}

/// The repairs recorded for `process`, the provider the receipt names now.
pub(super) fn report(root: &Path, process: Option<&ProcessIdentity>) -> Option<RepairedSockets> {
    let process = process?;
    let record = load(root)?;
    (record.pid == process.pid && record.start_micros == process.start_micros).then(|| {
        RepairedSockets {
            count: record.names.len(),
            names: record.names.into_iter().collect(),
        }
    })
}

/// Write through a temporary file only this call creates and names, then rename it over the
/// record. A failed write removes only that temporary file.
fn replace(root: &Path, record: &Record) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let bytes = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    let temporary = root.join(format!(
        "{FILE}.{}.{}.new",
        std::process::id(),
        SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    let written = file
        .write_all(&bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, path(root)));
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::File::open(root)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-socket-repairs-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        state::private_directory(&root).unwrap();
        root
    }

    fn process(pid: i32, start_micros: u64) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            start_micros,
            uid: 0,
            executable: PathBuf::from("/fixture/smolvm"),
        }
    }

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn repairs_are_merged_per_provider_and_reported_only_for_it() {
        let root = scratch();
        let first = process(10, 1);
        assert_eq!(report(&root, Some(&first)), None);
        // Nothing repaired writes nothing.
        record(&root, Some(&first), &[]);
        assert!(!path(&root).exists());
        record(
            &root,
            Some(&first),
            &names(&["port-forward.sock", "bridge-03.sock"]),
        );
        record(
            &root,
            Some(&first),
            &names(&["docker.sock", "bridge-03.sock"]),
        );
        assert_eq!(
            report(&root, Some(&first)),
            Some(RepairedSockets {
                count: 3,
                names: names(&["bridge-03.sock", "docker.sock", "port-forward.sock"]),
            })
        );
        // Another provider (a later boot) sees none, and its first repair replaces the record.
        let second = process(10, 2);
        assert_eq!(report(&root, Some(&second)), None);
        assert_eq!(report(&root, None), None);
        record(&root, Some(&second), &names(&["agent.sock"]));
        assert_eq!(report(&root, Some(&first)), None);
        assert_eq!(
            report(&root, Some(&second)).map(|repairs| repairs.names),
            Some(names(&["agent.sock"]))
        );
        let entries: Vec<_> = fs::read_dir(&root).unwrap().collect();
        assert_eq!(entries.len(), 1, "no temporary file is left");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_malformed_or_unwritable_record_never_fails_and_reads_as_none() {
        let root = scratch();
        let provider = process(10, 1);
        fs::write(path(&root), b"{not json").unwrap();
        assert_eq!(report(&root, Some(&provider)), None);
        // A record that does not decode is replaced by the next repair.
        record(&root, Some(&provider), &names(&["control.sock"]));
        assert_eq!(report(&root, Some(&provider)).unwrap().count, 1);
        // A directory at the record's path refuses the rename; recording still returns.
        fs::remove_file(path(&root)).unwrap();
        fs::create_dir(path(&root)).unwrap();
        record(&root, Some(&provider), &names(&["control.sock"]));
        assert_eq!(report(&root, Some(&provider)), None);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }
}
