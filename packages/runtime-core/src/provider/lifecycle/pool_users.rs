//! Read-only evidence of whether anything still uses a running pool.
//!
//! `runtime status` reports `graph_runs` and `pool_idle` from this so callers
//! such as `hack doctor` never read the state layout themselves. Every reader
//! here only inspects metadata and directory entries: no lock, no creation.
//!
//! Users of a pool, all recorded under the home's `run/` directory:
//! - Compose graphs (`run/graphs`) and native-authored graphs
//!   (`run/native-graphs`), running or retained after `down`;
//! - environment allocations (`run/environment-leases`,
//!   `run/native-environment-leases`), bound to those graphs;
//! - interactive exec sessions (`run/exec-sessions`).
//!
//! Archived graphs (`run/graph-archive`) were removed and hold no pool
//! resources, so they are not users. An active image build is not observed:
//! its fence may only be probed under the provider lease, and `runtime down`
//! already refuses while one runs. Any entry that cannot be read or is not
//! recognized makes the answer unknown or "in use", never idle.
use super::state;
use std::{fs, io::ErrorKind, path::Path};

/// Bound on entries read from one directory; more is treated as unknown.
const MAX_ENTRIES: usize = 1024;
/// The cooperative lock file a store keeps beside its records.
const LOCK_FILE: &str = "operation.lock";

const GRAPH_DIRECTORIES: [&str; 2] = ["run/graphs", "run/native-graphs"];
const USER_DIRECTORIES: [&str; 3] = [
    "run/environment-leases",
    "run/native-environment-leases",
    "run/exec-sessions",
];

/// What the pool's state records, read without side effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PoolUsers {
    /// Graph runs, Compose and native-authored, running or retained; `None`
    /// when either inventory cannot be read.
    pub(super) graph_runs: Option<usize>,
    /// Records of other users; `None` when one store cannot be read.
    pub(super) other_records: Option<usize>,
}

fn is_graph_run(name: &str) -> bool {
    name.len() == 32
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Entries of a private directory, or `Some(0)` when it is absent. `None`
/// when it is not a private directory, an entry is unreadable, the bound is
/// exceeded, or `accept` refuses a name.
fn count(parent: &Path, accept: impl Fn(&str, &Path) -> Option<bool>) -> Option<usize> {
    match fs::symlink_metadata(parent) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(0),
        Err(_) => return None,
        Ok(metadata) if !metadata.is_dir() => return None,
        Ok(_) => (),
    }
    state::check_private_directory(parent).ok()?;
    let mut total = 0;
    for entry in fs::read_dir(parent).ok()?.take(MAX_ENTRIES + 1) {
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        if accept(&name, &entry.path())? {
            total += 1;
        }
        if total > MAX_ENTRIES {
            return None;
        }
    }
    Some(total)
}

pub(super) fn observe(state_root: &Path) -> PoolUsers {
    let mut graph_runs = Some(0);
    for directory in GRAPH_DIRECTORIES {
        let runs = count(&state_root.join(directory), |name, path| {
            // Only private run directories; anything else is not proof.
            let private = fs::symlink_metadata(path).ok()?.is_dir()
                && state::check_private_directory(path).is_ok();
            (is_graph_run(name) && private).then_some(true)
        });
        graph_runs = graph_runs.zip(runs).map(|(a, b)| a + b);
    }
    let mut other_records = Some(0);
    for directory in USER_DIRECTORIES {
        let records = count(&state_root.join(directory), |name, _| {
            Some(name != LOCK_FILE)
        });
        other_records = other_records.zip(records).map(|(a, b)| a + b);
    }
    PoolUsers {
        graph_runs,
        other_records,
    }
}

/// `Some(true)` only for a running pool with a live provider process and no
/// recorded user; `Some(false)` when it is not running or something uses it;
/// `None` when liveness or the records cannot be established.
pub(super) fn pool_idle(
    phase: &str,
    process_alive: Option<bool>,
    users: PoolUsers,
) -> Option<bool> {
    if phase != "running" || process_alive == Some(false) {
        return Some(false);
    }
    if users.graph_runs.is_some_and(|n| n > 0) || users.other_records.is_some_and(|n| n > 0) {
        return Some(false);
    }
    if process_alive != Some(true) {
        return None;
    }
    match (users.graph_runs, users.other_records) {
        (Some(0), Some(0)) => Some(true),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-pool-users-{}-{}",
                std::process::id(),
                crate::next_test_scratch()
            ));
            state::private_directory(&root).unwrap();
            Self(root)
        }
        fn dir(&self, path: &str) -> PathBuf {
            let path = self.0.join(path);
            let mut current = self.0.clone();
            for part in path.strip_prefix(&self.0).unwrap() {
                current.push(part);
                state::private_directory(&current).unwrap();
            }
            path
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const IDLE: PoolUsers = PoolUsers {
        graph_runs: Some(0),
        other_records: Some(0),
    };

    #[test]
    fn an_absent_or_empty_inventory_records_no_user() {
        let home = Home::new();
        assert_eq!(observe(&home.0), IDLE);
        for directory in GRAPH_DIRECTORIES.iter().chain(USER_DIRECTORIES.iter()) {
            home.dir(directory);
        }
        // A store's own lock file is not a user.
        fs::write(home.0.join("run/exec-sessions").join(LOCK_FILE), b"").unwrap();
        assert_eq!(observe(&home.0), IDLE);
    }

    #[test]
    fn native_authored_graphs_and_other_records_are_users() {
        let home = Home::new();
        home.dir(&format!("run/native-graphs/{}", "a".repeat(32)));
        assert_eq!(observe(&home.0).graph_runs, Some(1));
        home.dir(&format!("run/graphs/{}", "b".repeat(32)));
        assert_eq!(observe(&home.0).graph_runs, Some(2));

        let other = Home::new();
        fs::write(
            other.dir("run/native-environment-leases").join("slot.json"),
            b"{}",
        )
        .unwrap();
        assert_eq!(
            observe(&other.0),
            PoolUsers {
                graph_runs: Some(0),
                other_records: Some(1)
            }
        );
        // Removed graphs are archived and hold nothing in the pool.
        let archived = Home::new();
        archived.dir(&format!("run/graph-archive/{}", "c".repeat(32)));
        assert_eq!(observe(&archived.0), IDLE);
    }

    #[test]
    fn unrecognized_graph_state_is_never_proof_of_idleness() {
        let home = Home::new();
        fs::write(home.dir("run/graphs").join("unknown"), b"").unwrap();
        assert_eq!(observe(&home.0).graph_runs, None);
        assert_eq!(pool_idle("running", Some(true), observe(&home.0)), None);

        let file = Home::new();
        fs::create_dir_all(file.0.join("run")).unwrap();
        fs::write(file.0.join("run/native-graphs"), b"").unwrap();
        assert_eq!(observe(&file.0).graph_runs, None);
    }

    #[test]
    fn only_a_live_running_pool_without_users_is_idle() {
        assert_eq!(pool_idle("running", Some(true), IDLE), Some(true));
        assert_eq!(pool_idle("running", None, IDLE), None);
        assert_eq!(pool_idle("running", Some(false), IDLE), Some(false));
        assert_eq!(pool_idle("stopped", Some(true), IDLE), Some(false));
        let busy = PoolUsers {
            graph_runs: Some(1),
            other_records: None,
        };
        assert_eq!(pool_idle("running", Some(true), busy), Some(false));
        let unread = PoolUsers {
            graph_runs: Some(0),
            other_records: None,
        };
        assert_eq!(pool_idle("running", Some(true), unread), None);
    }
}
