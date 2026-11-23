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
use crate::CandidateError;
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
    for (index, entry) in fs::read_dir(parent).ok()?.take(MAX_ENTRIES + 1).enumerate() {
        if index == MAX_ENTRIES {
            return None;
        }
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        if accept(&name, &entry.path())? {
            total += 1;
        }
    }
    Some(total)
}

pub(super) fn observe_with(
    state_root: &Path,
    native_retired: impl Fn(&str) -> Option<bool>,
) -> PoolUsers {
    let mut graph_runs = Some(0);
    for directory in GRAPH_DIRECTORIES {
        let runs = count(&state_root.join(directory), |name, path| {
            // Only private run directories; anything else is not proof.
            let private = fs::symlink_metadata(path).ok()?.is_dir()
                && state::check_private_directory(path).is_ok();
            if !is_graph_run(name) || !private {
                return None;
            }
            if directory == "run/native-graphs" {
                return native_retired(name).map(|retired| !retired);
            }
            Some(true)
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

/// Receipt phases whose containers may be running or about to run in the current
/// boot: Compose graph runs (`run/graphs`) and native-authored graph runs
/// (`run/native-graphs`, kebab-case `journal::Phase`). `failed-retained` is
/// included: a failed start keeps the services that did start, uncleaned.
const LIVE_PHASES: [(&str, &[&str]); 2] = [
    (
        "run/graphs",
        &[
            "preparing",
            "restoring",
            "started-observed",
            "ready-observed",
            "failed-retained",
            "cleanup-intent",
        ],
    ),
    (
        "run/native-graphs",
        &[
            "preparing",
            "ready-observed",
            "failed-retained",
            "stop-intent",
        ],
    ),
];
/// Graph runs, Compose and native-authored, whose receipt says they are live,
/// sorted (HACK-2456).
///
/// `runtime down` names these when it stops a running pool under them: their
/// containers stop with the guest, and `hack up` (or `hack down --recover`) in each
/// project starts the pool again and recovers the run with its data kept. This is a
/// report, not a refusal, and like the rest of this module it reads without a lock:
/// `None` when an inventory or a receipt cannot be read, so the caller says it could
/// not tell instead of naming nothing.
pub(super) fn live_graph_runs(state_root: &Path) -> Option<Vec<String>> {
    let mut live = Vec::new();
    for (directory, phases) in LIVE_PHASES {
        let parent = state_root.join(directory);
        match fs::symlink_metadata(&parent) {
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(_) => return None,
            Ok(metadata) if !metadata.is_dir() => return None,
            Ok(_) => (),
        }
        state::check_private_directory(&parent).ok()?;
        for (index, entry) in fs::read_dir(&parent)
            .ok()?
            .take(MAX_ENTRIES + 1)
            .enumerate()
        {
            if index == MAX_ENTRIES {
                return None;
            }
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            if !is_graph_run(&name) {
                continue;
            }
            let receipt: serde_json::Value = state::read(&entry.path().join("state.json")).ok()?;
            if receipt["phase"]
                .as_str()
                .is_some_and(|phase| phases.contains(&phase))
            {
                live.push(name);
            }
        }
    }
    live.sort();
    Some(live)
}
/// The recovery intent a graph run directory may hold (`graph::dead_owner_cleanup`),
/// and its staging file. A completed intent stays as history: it records
/// `complete_sha256` and is not a pending operation.
const CLEANUP_INTENT: &str = "dead-owner-cleanup.json";
const CLEANUP_STAGING: &str = "dead-owner-cleanup.pending";

/// Whether this run directory holds an unfinished dead-owner recovery: a staging file,
/// or an intent without its completion digest. `None` when either cannot be read.
fn recovery_pending(run: &Path) -> Option<bool> {
    match fs::symlink_metadata(run.join(CLEANUP_STAGING)) {
        Ok(_) => return Some(true),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    match fs::symlink_metadata(run.join(CLEANUP_INTENT)) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(false),
        Err(_) => return None,
        Ok(_) => {}
    }
    let intent: serde_json::Value = state::read(&run.join(CLEANUP_INTENT)).ok()?;
    Some(!intent["complete_sha256"].is_string())
}
/// The refusal code of a pool that is not idle (HACK-2535).
pub(super) const POOL_IN_USE: &str = "project_share_pool_in_use";

/// Refuse unless nothing uses the running pool live, so stopping it loses nothing but
/// a boot (HACK-2535): no graph run whose receipt is live (`live_graph_runs`: running,
/// starting, restoring, stopping, or a failed start that kept its services), no
/// pending dead-owner recovery, and no interactive exec session. Retained and removed
/// runs hold no containers and do not count. Anything unreadable refuses. An active
/// image build is checked by `runtime down` itself, under the same lease.
pub(super) fn require_idle(state_root: &Path) -> Result<(), CandidateError> {
    const LIVE: &str = "The running native pool has a live project run (running, starting, restoring or stopping), so it was not stopped; nothing was changed.";
    const UNREAD: &str = "The running native pool's project runs or sessions could not be read, so it was not stopped; nothing was changed.";
    const RECOVERY: &str = "A project run of the running native pool has a pending recovery, so the pool was not stopped; nothing was changed.";
    const SESSION: &str = "The running native pool has an open interactive session, so it was not stopped; nothing was changed. `hack exec-sessions --reconcile` clears sessions that have finished.";
    let in_use = |message: &'static str| CandidateError::new(POOL_IN_USE, message);
    match live_graph_runs(state_root) {
        None => return Err(in_use(UNREAD)),
        Some(runs) if !runs.is_empty() => return Err(in_use(LIVE)),
        Some(_) => {}
    }
    for directory in GRAPH_DIRECTORIES {
        let pending = count(&state_root.join(directory), |name, path| {
            if !is_graph_run(name) {
                return Some(false);
            }
            recovery_pending(path)
        });
        match pending {
            Some(0) => {}
            Some(_) => return Err(in_use(RECOVERY)),
            None => return Err(in_use(UNREAD)),
        }
    }
    match count(&state_root.join("run/exec-sessions"), |name, _| {
        Some(name != LOCK_FILE)
    }) {
        Some(0) => Ok(()),
        Some(_) => Err(in_use(SESSION)),
        None => Err(in_use(UNREAD)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn only_a_pool_without_live_runs_pending_recovery_or_sessions_is_idle() {
        let home = Home::new();
        assert!(require_idle(&home.0).is_ok());
        // Retained and removed runs hold no containers.
        for (run, phase) in [("a", "stopped-data-retained"), ("b", "removed")] {
            let dir = home.dir(&format!("run/graphs/{}", run.repeat(32)));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": phase }),
            )
            .unwrap();
        }
        let native = home.dir(&format!("run/native-graphs/{}", "c".repeat(32)));
        state::write(
            &native.join("state.json"),
            &serde_json::json!({ "phase": "stopped" }),
        )
        .unwrap();
        assert!(require_idle(&home.0).is_ok());
        let refused = |home: &Home, why: &str| {
            let error = require_idle(&home.0).unwrap_err();
            assert_eq!(error.code, POOL_IN_USE);
            assert!(error.message.contains(why), "{}", error.message);
        };
        // A pending recovery of a retained run: an intent without its completion digest,
        // or a staging file.
        let intent = native.join(CLEANUP_INTENT);
        state::write(&intent, &serde_json::json!({ "complete_sha256": null })).unwrap();
        refused(&home, "pending recovery");
        // A completed recovery stays as history and does not keep the pool in use.
        state::write(
            &intent,
            &serde_json::json!({ "complete_sha256": "a".repeat(64) }),
        )
        .unwrap();
        assert!(require_idle(&home.0).is_ok());
        fs::write(native.join(CLEANUP_STAGING), b"{}").unwrap();
        refused(&home, "pending recovery");
        fs::remove_file(native.join(CLEANUP_STAGING)).unwrap();
        // An unreadable intent refuses.
        fs::write(&intent, b"{").unwrap();
        refused(&home, "could not be read");
        fs::remove_file(&intent).unwrap();
        // An open interactive session.
        let sessions = home.dir("run/exec-sessions");
        fs::write(sessions.join(LOCK_FILE), b"").unwrap();
        assert!(require_idle(&home.0).is_ok());
        fs::write(sessions.join("session.json"), b"{}").unwrap();
        refused(&home, "open interactive session");
        fs::remove_file(sessions.join("session.json")).unwrap();
        // A starting run, named.
        for phase in [
            "preparing",
            "ready-observed",
            "failed-retained",
            "cleanup-intent",
        ] {
            let dir = home.dir(&format!("run/graphs/{}", "d".repeat(32)));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": phase }),
            )
            .unwrap();
            refused(&home, "live project run");
        }
        // An unreadable receipt refuses.
        home.dir(&format!("run/graphs/{}", "e".repeat(32)));
        refused(&home, "could not be read");
    }
    #[test]
    fn runtime_down_names_only_runs_whose_receipt_is_live() {
        let home = Home::new();
        assert_eq!(live_graph_runs(&home.0), Some(vec![]));
        for (run, phase) in [
            ("a", "ready-observed"),
            ("b", "stopped-data-retained"),
            ("c", "restoring"),
            ("d", "removed"),
            ("6", "failed-retained"),
            ("5", "started-observed"),
        ] {
            let dir = home.dir(&format!("run/graphs/{}", run.repeat(32)));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": phase }),
            )
            .unwrap();
        }
        assert_eq!(
            live_graph_runs(&home.0),
            Some(vec![
                "5".repeat(32),
                "6".repeat(32),
                "a".repeat(32),
                "c".repeat(32)
            ])
        );
        // Native-authored graphs are listed by their own phases.
        for (run, phase) in [
            ("f", "ready-observed"),
            ("9", "stopped"),
            ("8", "stop-intent"),
            ("7", "failed-retained"),
        ] {
            let dir = home.dir(&format!("run/native-graphs/{}", run.repeat(32)));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": phase }),
            )
            .unwrap();
        }
        assert_eq!(
            live_graph_runs(&home.0),
            Some(vec![
                "5".repeat(32),
                "6".repeat(32),
                "7".repeat(32),
                "8".repeat(32),
                "a".repeat(32),
                "c".repeat(32),
                "f".repeat(32)
            ])
        );
        // An unreadable receipt makes the answer unknown, never "none".
        home.dir(&format!("run/graphs/{}", "e".repeat(32)));
        assert_eq!(live_graph_runs(&home.0), None);
    }

    fn observe(root: &Path) -> PoolUsers {
        observe_with(root, |_| Some(false))
    }

    #[test]
    fn only_proven_retired_native_graphs_are_excluded() {
        let home = Home::new();
        home.dir(&format!("run/native-graphs/{}", "a".repeat(32)));
        assert_eq!(observe_with(&home.0, |_| Some(true)), IDLE);
        assert_eq!(observe_with(&home.0, |_| None).graph_runs, None);
        assert_eq!(observe(&home.0).graph_runs, Some(1));
    }

    #[test]
    fn retired_entries_still_consume_the_inventory_read_bound() {
        let home = Home::new();
        for index in 0..=MAX_ENTRIES {
            home.dir(&format!("run/native-graphs/{index:032x}"));
        }
        assert_eq!(observe_with(&home.0, |_| Some(true)).graph_runs, None);
    }

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
