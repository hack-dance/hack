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
/// included: a failed start keeps the services that did start, uncleaned. So is
/// `restarting` (every Compose start phase, `graph::START_PHASES`): `graph restart`
/// saves it before it starts any container, and a restart whose process died part way
/// keeps it with some containers running.
const LIVE_PHASES: [(&str, &[&str]); 2] = [
    (
        "run/graphs",
        &[
            "preparing",
            "restoring",
            "restarting",
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
/// `runtime down` refuses while there are any and names them (HACK-2477,
/// [`refuse_live_runs`]); `runtime down --force` stops the pool under them and reports
/// them: their containers stop with the guest, and each run's project recovers it as
/// [`after_forced_stop`] names (HACK-2715). Like the rest of this module it reads without a lock: `None` when an inventory
/// or a receipt cannot be read, so the caller says it could not tell instead of naming
/// nothing.
pub(super) fn live_graph_runs(state_root: &Path) -> Option<Vec<String>> {
    let current = current_boot(state_root);
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
            // A native run of a boot that ended under it (`runtime down --force`, a crash
            // or a host reboot, HACK-2715) runs nothing in this boot: its guest stopped
            // and its containers with it. It no longer keeps the pool in use; its project
            // clears it with `hack down` ([`after_forced_stop`]). On a pool recorded
            // stopped no run of either kind runs anything, so none is live
            // (HACK-2715 review round 2, seen on a real VM: right after `--force` a
            // stopped pool's `runtime status` still listed the ready Compose run).
            // Compose receipts name no boot, so on a running pool they keep their rule.
            let ended = match &current {
                PoolRecord::Running(boot) => {
                    directory == "run/native-graphs"
                        && receipt["boot"].as_str() != Some(boot.as_str())
                }
                PoolRecord::Stopped => true,
                PoolRecord::Unknown => false,
            };
            if !ended
                && receipt["phase"]
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
/// What the pool's record says, read without a lock.
enum PoolRecord {
    /// Recorded running this boot.
    Running(String),
    /// Recorded in a phase written only before a start or after proven provider
    /// absence ([`super::STOPPED_PHASES`]): nothing runs in the guest.
    Stopped,
    /// Absent, unreadable, booting, quiescing, or running with no boot id.
    Unknown,
}
fn current_boot(state_root: &Path) -> PoolRecord {
    let Ok(pool) = state::read::<serde_json::Value>(&state_root.join("run/smolvm/owner.json"))
    else {
        return PoolRecord::Unknown;
    };
    match pool["phase"].as_str() {
        Some("running") => pool["guest_boot_id"]
            .as_str()
            .map_or(PoolRecord::Unknown, |boot| {
                PoolRecord::Running(boot.to_owned())
            }),
        Some(phase) if super::STOPPED_PHASES.contains(&phase) => PoolRecord::Stopped,
        _ => PoolRecord::Unknown,
    }
}
/// What brings a run back after `runtime down --force` (or a crash) stopped the pool
/// under it (HACK-2715), as its project names it. Classified by the run's kind and its
/// receipt phase: a command is named only where it works from an ended boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterForcedStop {
    /// A Compose run (`run/graphs`) that was ready, or had every service started:
    /// `hack up` in its project starts the pool and recovers it from the ended boot
    /// (the cross-boot dead-owner recovery), data kept.
    HackUp,
    /// A Compose run caught in a start that failed or never finished (`failed-retained`,
    /// `preparing`) or in its owner's own stop (`cleanup-intent`): `hack up` does not
    /// recover it. Once its owner has exited, the explicit dead-owner cleanup
    /// (`graph recover-cleanup`) clears it while the pool is stopped, data kept.
    ExplicitCleanup,
    /// A native-authored run (`run/native-graphs`) that the cleanup from an ended boot
    /// admits (a graph2 receipt: no persistent data, live source, custom network topology
    /// or managed environment), in any phase, including a start caught mid-way:
    /// `hack down` in its project starts the pool and clears it (through its owner if
    /// that still runs, else the dead-owner recovery), then `hack up` starts it again.
    HackDownThenUp,
    /// The same native-authored run, caught mid-start with a container or network
    /// whose create was started but never recorded (no id, phase past `reserved`). The
    /// cleanup looks such a member up by its exact name: absent, `hack down` clears the
    /// run as above; present, nothing attributes it (labels never authorize adoption),
    /// so `hack down` refuses before any effect and keeps it, and no command clears it
    /// yet. The stderr line says so instead of promising `hack down`, then `hack up`
    /// (HACK-2715 review round 2).
    HackDownUnlessUnrecorded,
    /// Nothing recovers it from an ended boot: a native-authored run with boot-bound
    /// state (`native_graph_ended_boot_unsupported`), a Compose run caught restoring or
    /// restarting, or a receipt that cannot be read. Stop it with `hack down` before the
    /// pool stops. Its data is kept either way.
    ///
    /// A boot-bound native run of an ended boot blocks no other project's start or
    /// plain `runtime down`, except that it keeps its own volumes from any new consumer.
    /// Some runs still block other projects until they are cleared (HACK-2715 review
    /// round 2):
    /// - a Compose run caught restoring or restarting stays live for a plain
    ///   `runtime down` and the idle stop ([`live_graph_runs`]), as does a Compose run
    ///   in an [`AfterForcedStop::ExplicitCleanup`] phase until that cleanup clears it;
    /// - a native run left with a `state.pending` by a crash mid-save cannot be loaded,
    ///   so graph admission refuses every start until it is inspected;
    /// - a native start caught mid-way whose unrecorded member is found by its exact
    ///   name and fails the ownership check refuses graph admission too.
    StopFirst,
}

/// Native receipt fields bound to the guest boot or outside the recovery proof:
/// persistent data, its verifier, a live source and a custom topology.
const BOOT_BOUND_FIELDS: [&str; 5] = ["data", "data_mounts", "data_tool", "source", "topology"];

/// Whether a native-graph environment allocation record names this run. `None` when
/// the store cannot be read.
fn native_environment_names(state_root: &Path, run: &str) -> Option<bool> {
    let parent = state_root.join("run/native-environment-leases");
    match fs::symlink_metadata(&parent) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(false),
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
        if name == LOCK_FILE || !name.ends_with(".json") {
            continue;
        }
        let record: serde_json::Value = state::read(&entry.path()).ok()?;
        if record["binding"]["run"].as_str() == Some(run) {
            return Some(true);
        }
    }
    Some(false)
}

/// What recovers `run` after a forced stop (HACK-2715), read without a lock from its
/// receipt like the rest of this module. Anything unreadable is [`AfterForcedStop::StopFirst`]:
/// this names a command only when it is known to work.
pub fn after_forced_stop(state_root: &Path, run: &str) -> AfterForcedStop {
    if !is_graph_run(run) {
        return AfterForcedStop::StopFirst;
    }
    let compose = state_root.join("run/graphs").join(run);
    if fs::symlink_metadata(&compose).is_ok_and(|m| m.is_dir()) {
        let Ok(receipt) = state::read::<serde_json::Value>(&compose.join("state.json")) else {
            return AfterForcedStop::StopFirst;
        };
        return match receipt["phase"].as_str() {
            Some("ready-observed" | "started-observed") => AfterForcedStop::HackUp,
            Some("failed-retained" | "preparing" | "cleanup-intent") => {
                AfterForcedStop::ExplicitCleanup
            }
            _ => AfterForcedStop::StopFirst,
        };
    }
    let Ok(receipt) = state::read::<serde_json::Value>(
        &state_root
            .join("run/native-graphs")
            .join(run)
            .join("state.json"),
    ) else {
        return AfterForcedStop::StopFirst;
    };
    let graph2 = receipt["version"] == 2
        && BOOT_BOUND_FIELDS
            .iter()
            .all(|field| receipt.get(field).is_none());
    if !graph2 || native_environment_names(state_root, run) != Some(false) {
        return AfterForcedStop::StopFirst;
    }
    if unrecorded_member(&receipt) {
        AfterForcedStop::HackDownUnlessUnrecorded
    } else {
        AfterForcedStop::HackDownThenUp
    }
}

/// Whether a native receipt has a container or network whose create was started but
/// never recorded: no id, and a phase past `reserved` that is not `removed`. Only a
/// start caught mid-way leaves one; the cleanup can attribute it only by its absence.
fn unrecorded_member(receipt: &serde_json::Value) -> bool {
    receipt["resources"].as_object().is_some_and(|resources| {
        resources.values().any(|resource| {
            matches!(resource["kind"].as_str(), Some("container" | "network"))
                && resource["id"].is_null()
                && !matches!(resource["phase"].as_str(), Some("reserved" | "removed"))
        })
    })
}

/// The refusal code of `runtime down` while graph runs are live (HACK-2477).
pub(super) const DOWN_LIVE_RUNS: &str = "runtime_down_live_runs";
/// The refusal code of `runtime down` when the receipts cannot be read (HACK-2477).
pub(super) const DOWN_RUNS_UNREAD: &str = "runtime_down_runs_unreadable";

/// Refuse a plain `runtime down` of a running pool while any graph run is live
/// ([`live_graph_runs`]), naming the runs, or when the receipts cannot be read
/// (HACK-2477). Stopping the pool under them was the easy way into the stuck state
/// HACK-2456 recovers from; `--force` stops it anyway and reports them. The caller holds
/// the provider lease, and graph starts take that lease before they write a live
/// receipt, so no run turns live between this check and the stop.
pub(super) fn refuse_live_runs(state_root: &Path) -> Result<(), CandidateError> {
    const LIVE: &str = "Native project runs are running in this pool (listed in live_runs, the same ids as runtime status live_runs), so runtime down stopped nothing. Run hack down in each project first (hack down --recover for a run whose hack up has exited), or runtime down --force to stop the pool under them. After --force, hack up recovers a ready Compose run with its data kept, and a Compose run caught starting or stopping needs the explicit dead-owner cleanup; a native-authored project (hack.project.json) needs hack down, then hack up; a native-authored run with persistent data, a live source, a custom network or a managed environment, or a Compose run caught restoring or restarting, cannot be recovered after --force, so stop it with hack down first. The stderr line names the command for each run.";
    const UNREAD: &str = "The native pool's project runs could not be read, so runtime down stopped nothing. Usually a run directory under run/graphs or run/native-graphs of this home has no readable state.json, for example after a start crashed before its first save; runtime status then counts it in graph_runs and omits live_runs. Run runtime down --force to stop the pool anyway; a run whose receipt cannot be read may then need inspection before it recovers.";
    match live_graph_runs(state_root) {
        None => Err(CandidateError::new(DOWN_RUNS_UNREAD, UNREAD)),
        Some(runs) if !runs.is_empty() => {
            Err(CandidateError::new(DOWN_LIVE_RUNS, LIVE).with_live_runs(runs))
        }
        Some(_) => Ok(()),
    }
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
/// starting, restoring, restarting, stopping, or a failed start that kept its services), no
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
            "restarting",
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
    fn runtime_down_refuses_live_or_unreadable_runs_and_names_them() {
        let home = Home::new();
        assert!(refuse_live_runs(&home.0).is_ok());
        // Retained, removed and stopped runs hold no containers: down may stop the pool.
        for (directory, run, phase) in [
            ("run/graphs", "a", "stopped-data-retained"),
            ("run/graphs", "b", "removed"),
            ("run/native-graphs", "c", "stopped"),
        ] {
            let dir = home.dir(&format!("{directory}/{}", run.repeat(32)));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": phase }),
            )
            .unwrap();
        }
        assert!(refuse_live_runs(&home.0).is_ok());
        // A running Compose run, a Compose restart interrupted part way (its process
        // died after some containers restarted, so the receipt kept `restarting`) and a
        // stopping native-authored run refuse, all named.
        for (directory, run, phase) in [
            ("run/graphs", "d", "ready-observed"),
            ("run/graphs", "9", "restarting"),
            ("run/native-graphs", "e", "stop-intent"),
        ] {
            let dir = home.dir(&format!("{directory}/{}", run.repeat(32)));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": phase }),
            )
            .unwrap();
        }
        let refused = refuse_live_runs(&home.0).unwrap_err();
        assert_eq!(refused.code, DOWN_LIVE_RUNS);
        assert!(refused.message_fixed);
        assert!(refused.message.contains("--force"));
        let json = serde_json::to_value(&refused).unwrap();
        assert_eq!(
            json["live_runs"],
            serde_json::json!(["9".repeat(32), "d".repeat(32), "e".repeat(32)])
        );
        // An unreadable receipt refuses without naming anything.
        home.dir(&format!("run/graphs/{}", "f".repeat(32)));
        let refused = refuse_live_runs(&home.0).unwrap_err();
        assert_eq!(refused.code, DOWN_RUNS_UNREAD);
        assert!(
            serde_json::to_value(&refused)
                .unwrap()
                .get("live_runs")
                .is_none()
        );
    }

    /// HACK-2715: what a refusal or a forced stop names for each run, by kind and phase.
    /// A ready (or all-started) Compose run comes back with `hack up`; one caught in a
    /// start or in its owner's stop needs the explicit dead-owner cleanup; one caught
    /// restoring or restarting has no recovery. A native-authored graph2 run without a
    /// managed environment comes back with `hack down` then `hack up` in every phase,
    /// including a start caught mid-way; a native run with boot-bound state (data,
    /// source, topology or a managed environment) or an unreadable receipt is never
    /// promised a recovery.
    #[test]
    fn after_a_forced_stop_each_run_is_named_with_the_command_that_recovers_it() {
        let home = Home::new();
        let write = |directory: &str, run: &str, receipt: serde_json::Value| {
            let dir = home.dir(&format!("{directory}/{run}"));
            state::write(&dir.join("state.json"), &receipt).unwrap();
        };
        let (compose, native, data, topology, environment, unread, absent) = (
            "a".repeat(32),
            "b".repeat(32),
            "c".repeat(32),
            "d".repeat(32),
            "e".repeat(32),
            "f".repeat(32),
            "9".repeat(32),
        );
        write(
            "run/graphs",
            &compose,
            serde_json::json!({ "phase": "ready-observed" }),
        );
        let graph2 = serde_json::json!({ "version": 2, "phase": "ready-observed" });
        write("run/native-graphs", &native, graph2.clone());
        write(
            "run/native-graphs",
            &data,
            serde_json::json!({ "version": 4, "phase": "ready-observed", "data": {}, "data_mounts": {} }),
        );
        write(
            "run/native-graphs",
            &topology,
            serde_json::json!({ "version": 5, "phase": "ready-observed", "topology": {} }),
        );
        write("run/native-graphs", &environment, graph2);
        let leases = home.dir("run/native-environment-leases");
        fs::write(leases.join(LOCK_FILE), b"").unwrap();
        state::write(
            &leases.join("slot.json"),
            &serde_json::json!({ "binding": { "run": environment } }),
        )
        .unwrap();
        home.dir(&format!("run/native-graphs/{unread}"));
        let kind = |run: &str| after_forced_stop(&home.0, run);
        assert_eq!(kind(&compose), AfterForcedStop::HackUp);
        assert_eq!(kind(&native), AfterForcedStop::HackDownThenUp);
        for (phase, expected) in [
            ("started-observed", AfterForcedStop::HackUp),
            ("failed-retained", AfterForcedStop::ExplicitCleanup),
            ("preparing", AfterForcedStop::ExplicitCleanup),
            ("cleanup-intent", AfterForcedStop::ExplicitCleanup),
            ("restoring", AfterForcedStop::StopFirst),
            ("restarting", AfterForcedStop::StopFirst),
        ] {
            write(
                "run/graphs",
                &compose,
                serde_json::json!({ "phase": phase }),
            );
            assert_eq!(kind(&compose), expected, "Compose {phase}");
        }
        // Every native phase the cleanup from an ended boot admits, a start caught
        // mid-way included, names the same command.
        for phase in [
            "preparing",
            "failed-retained",
            "stop-intent",
            "ready-observed",
        ] {
            write(
                "run/native-graphs",
                &native,
                serde_json::json!({ "version": 2, "phase": phase }),
            );
            assert_eq!(
                kind(&native),
                AfterForcedStop::HackDownThenUp,
                "native {phase}"
            );
        }
        // HACK-2715 review round 2 (L3): a start caught mid-way with a member whose
        // create was started but never recorded is not promised `hack down`, then
        // `hack up`. Recorded, reserved and removed members keep the promise.
        let member = |kind: &str, id: serde_json::Value, phase: &str| {
            serde_json::json!({
                "version": 2,
                "phase": "preparing",
                "resources": { "member": { "kind": kind, "id": id, "phase": phase } },
            })
        };
        for (receipt, expected) in [
            (
                member("container", serde_json::Value::Null, "create-intent"),
                AfterForcedStop::HackDownUnlessUnrecorded,
            ),
            (
                member("network", serde_json::Value::Null, "create-intent"),
                AfterForcedStop::HackDownUnlessUnrecorded,
            ),
            (
                member("container", serde_json::json!("abc"), "created"),
                AfterForcedStop::HackDownThenUp,
            ),
            (
                member("container", serde_json::Value::Null, "reserved"),
                AfterForcedStop::HackDownThenUp,
            ),
            (
                member("container", serde_json::Value::Null, "removed"),
                AfterForcedStop::HackDownThenUp,
            ),
        ] {
            write("run/native-graphs", &native, receipt.clone());
            assert_eq!(kind(&native), expected, "{receipt}");
        }
        write(
            "run/native-graphs",
            &native,
            serde_json::json!({ "version": 2, "phase": "ready-observed" }),
        );
        for run in [&data, &topology, &environment, &unread, &absent] {
            assert_eq!(kind(run), AfterForcedStop::StopFirst, "{run}");
        }
        assert_eq!(kind("not-a-run"), AfterForcedStop::StopFirst);
        // An unreadable environment store names no command.
        fs::write(leases.join("broken.json"), b"{").unwrap();
        assert_eq!(kind(&native), AfterForcedStop::StopFirst);
    }

    /// HACK-2715 review: a native run of a boot that ended under it runs nothing in the
    /// pool's current boot, so it no longer keeps a plain `runtime down` refused (seen on a
    /// real VM: the leftover native run refused every later `runtime down`), and on a pool
    /// recorded stopped no native run is live. A run of the current boot, any Compose run,
    /// and every run while the pool record cannot be read or is booting or quiescing keep
    /// their old rule.
    #[test]
    fn a_native_run_of_an_ended_boot_is_not_live() {
        let home = Home::new();
        let (current, ended, compose) = ("a".repeat(32), "b".repeat(32), "c".repeat(32));
        for (directory, run, boot) in [
            ("run/native-graphs", &current, "boot-now"),
            ("run/native-graphs", &ended, "boot-old"),
            ("run/graphs", &compose, "boot-old"),
        ] {
            let dir = home.dir(&format!("{directory}/{run}"));
            state::write(
                &dir.join("state.json"),
                &serde_json::json!({ "phase": "ready-observed", "boot": boot }),
            )
            .unwrap();
        }
        let everything = Some(vec![current.clone(), ended.clone(), compose.clone()]);
        assert_eq!(live_graph_runs(&home.0), everything);
        let pool = home.dir("run/smolvm");
        let record = |phase: &str| {
            state::write(
                &pool.join("owner.json"),
                &serde_json::json!({ "phase": phase, "guest_boot_id": "boot-now" }),
            )
            .unwrap();
        };
        // HACK-2715 review round 2 (seen on a real VM): on a pool recorded stopped,
        // no run of either kind is live (right after `--force` the ready Compose
        // run was still listed). A pool booting or quiescing proves nothing.
        for stopped in super::super::STOPPED_PHASES {
            record(stopped);
            assert_eq!(live_graph_runs(&home.0), Some(vec![]), "{stopped}");
        }
        for unknown in ["booting", "quiescing"] {
            record(unknown);
            assert_eq!(live_graph_runs(&home.0), everything, "{unknown}");
        }
        record("running");
        assert_eq!(
            live_graph_runs(&home.0),
            Some(vec![current.clone(), compose.clone()])
        );
        assert!(require_idle(&home.0).is_err());
        let error = refuse_live_runs(&home.0).unwrap_err();
        let listed = serde_json::to_value(&error).unwrap()["live_runs"].clone();
        assert_eq!(listed, serde_json::json!([current, compose]));
    }

    #[test]
    fn every_compose_start_phase_is_live() {
        // A start in progress (fresh, restore or restart) may have running containers;
        // one whose process died keeps its phase, so the guard must still see it.
        let (directory, compose) = LIVE_PHASES[0];
        assert_eq!(directory, "run/graphs");
        for phase in crate::provider::graph::START_PHASES {
            assert!(compose.contains(&phase), "{phase} is not live");
        }
    }

    #[test]
    fn runtime_down_names_only_runs_whose_receipt_is_live() {
        let home = Home::new();
        assert_eq!(live_graph_runs(&home.0), Some(vec![]));
        for (run, phase) in [
            ("a", "ready-observed"),
            ("b", "stopped-data-retained"),
            ("c", "restoring"),
            ("4", "restarting"),
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
                "4".repeat(32),
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
                "4".repeat(32),
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
