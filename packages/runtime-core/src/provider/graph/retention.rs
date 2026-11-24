use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path},
};
const EXPORT_LIMIT: u64 = 17 * 1024 * 1024;

pub(super) fn consumed(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    directory(candidate, run)?;
    let parent = candidate.state_root.join("run/graph-consumed");
    if parent.exists() || parent.is_symlink() {
        state::check_private_directory(&parent)?;
    }
    Ok(parent.join(run))
}
fn read_private(path: &Path, limit: u64) -> Result<Vec<u8>, CandidateError> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.len() > limit
    {
        return Err(error(
            "graph_retention_file",
            "Unsafe retention evidence file.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 != m.len() {
        return Err(error("graph_retention_file", "Retention evidence changed."));
    }
    Ok(bytes)
}
pub fn reconcile_export(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let _engine = Engine::connect_cleanup(candidate)?;
    let archive = archive::path(candidate, run)?;
    state::check_private_directory(&archive)?;
    let parent = candidate.state_root.join("exports/graphs");
    state::private_directory(&parent)?;
    let retained = journal::retain_file(
        &parent,
        &format!("{run}.pending"),
        &format!("{run}-recovery"),
        EXPORT_LIMIT,
    )?;
    Ok(json!({"run":run,"retained":retained,"original_retained":true,"publication_replayed":false}))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tombstone {
    version: u32,
    run: String,
    owner: String,
    export_sha256: String,
}

pub fn prune(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    prune_with(candidate, &engine, run, false)
}

/// [`prune`] under a provider lease the caller already holds.
/// With `any_owner` (the archive's own room-making only), a removed attempt of an
/// earlier guest incarnation is pruned once its export proves it removed; its
/// tombstone records the run's own owner (HACK-2576).
pub(super) fn prune_with(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
    any_owner: bool,
) -> Result<Value, CandidateError> {
    let owned = |owner: &str| owner_accepted(any_owner, owner, engine.guest().incarnation());
    let archive = archive::path(candidate, run)?;
    let target = consumed(candidate, run)?;
    match fs::symlink_metadata(archive.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            return Err(error(
                "graph_relay_enrollment",
                "Uncertain archive journal blocks retention.",
            ));
        }
    }
    // Check a complete archive before even relying on an export. A partial prune
    // may have removed this receipt; its bounded retained tar is checked below.
    match fs::symlink_metadata(archive.join("state.json")) {
        Ok(_) => {
            let receipt: Receipt = state::read(&archive.join("state.json"))?;
            if receipt.version != 1
                || receipt.run != run
                || !owned(&receipt.owner)
                || receipt.phase != "removed"
            {
                return Err(error(
                    "graph_prune_identity",
                    "Archive identity differs from the owned removed graph.",
                ));
            }
            cleanup_enrollment::retention(&archive, &receipt)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(state::io(e)),
    }
    let exports = candidate.state_root.join("exports/graphs");
    state::check_private_directory(&exports)?;
    let bytes = read_private(&exports.join(format!("{run}.tar")), EXPORT_LIMIT)?;
    let digest = format!("{:x}", crate::Hex(Sha256::digest(&bytes)));
    let mut expected = BTreeMap::new();
    let mut tar = tar::Archive::new(bytes.as_slice());
    for entry in tar.entries().map_err(state::io)?.take(129) {
        let mut entry = entry.map_err(state::io)?;
        let path = entry.path().map_err(state::io)?.to_path_buf();
        if expected.len() >= 128
            || !entry.header().entry_type().is_file()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || entry.size() > 1024 * 1024
        {
            return Err(error(
                "graph_prune_export",
                "Invalid retained export entry.",
            ));
        }
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(state::io)?;
        if expected.insert(path, content).is_some() {
            return Err(error(
                "graph_prune_export",
                "Duplicate retained export entry.",
            ));
        }
    }

    let exported: Receipt = serde_json::from_slice(
        expected
            .get(Path::new("state.json"))
            .ok_or_else(|| error("graph_prune_export", "Export has no graph receipt."))?,
    )
    .map_err(|_| error("graph_prune_export", "Export graph receipt is invalid."))?;
    if exported.version != 1
        || exported.run != run
        || !owned(&exported.owner)
        || exported.phase != "removed"
        || expected.contains_key(Path::new("state.pending"))
    {
        return Err(error(
            "graph_prune_export",
            "Export graph identity or journal is uncertain.",
        ));
    }
    cleanup_enrollment::retention_receipt(
        &exported,
        expected.contains_key(Path::new("relay-cleanup-bridges.json"))
            || expected.contains_key(Path::new("relay-cleanup-bridges.pending")),
    )?;

    if target.join("state.json").exists() || target.join("state.json").is_symlink() {
        state::check_private_directory(&target)?;
        let receipt: Tombstone = state::read(&target.join("state.json"))?;
        if receipt.version != 1
            || receipt.run != run
            || !owned(&receipt.owner)
            || receipt.export_sha256 != digest
        {
            return Err(error(
                "graph_prune_identity",
                "Consumed-ID receipt or retained export differs.",
            ));
        }
    } else {
        state::check_private_directory(&archive)?;
        let receipt: Receipt = state::read(&archive.join("state.json"))?;
        if receipt.run != run
            || receipt.phase != "removed"
            || !owned(&receipt.owner)
            || export::bundle(&archive)?.0 != bytes
        {
            return Err(error(
                "graph_prune_export",
                "Verified export must exactly match the removed archive before pruning.",
            ));
        }
        let parent = target.parent().expect("consumed parent");
        state::private_directory(parent)?;
        if fs::read_dir(parent).map_err(state::io)?.take(4096).count() >= 4096 {
            return Err(error(
                "graph_consumed_budget",
                "4096 consumed-ID records are retained; pruning is blocked.",
            ));
        }
        if target.exists() || target.is_symlink() {
            state::check_private_directory(&target)?;
            journal::retain(&target)?;
        } else {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&target)
                .map_err(state::io)?;
        }
        fs::File::open(parent)
            .map_err(state::io)?
            .sync_all()
            .map_err(state::io)?;
        state::write(
            &target.join("state.json"),
            &Tombstone {
                version: 1,
                run: run.into(),
                owner: exported.owner.clone(),
                export_sha256: digest.clone(),
            },
        )?;
    }
    if archive.exists() || archive.is_symlink() {
        let mut remaining = BTreeMap::new();
        export::collect(&archive, &archive, 0, &mut remaining, &mut 0, &mut 128)?;
        if remaining
            .iter()
            .any(|(path, content)| expected.get(path) != Some(content))
        {
            return Err(error(
                "graph_prune_changed",
                "Remaining archive differs from verified export; nothing was deleted.",
            ));
        }
        for (path, content) in remaining {
            let path = archive.join(path);
            if read_private(&path, 1024 * 1024)? != content {
                return Err(error(
                    "graph_prune_changed",
                    "Archive changed during pruning.",
                ));
            }
            fs::remove_file(path).map_err(state::io)?;
        }
        remove_empty(&archive, 0, &mut 128)?;
        fs::File::open(archive.parent().expect("archive parent"))
            .map_err(state::io)?
            .sync_all()
            .map_err(state::io)?;
    }
    Ok(
        json!({"run":run,"archive_absent":true,"export_sha256":digest,"export_retained":true,"consumed_id_retained":true}),
    )
}
fn remove_empty(path: &Path, depth: usize, remaining: &mut usize) -> Result<(), CandidateError> {
    state::check_private_directory(path)?;
    if depth > 3 || *remaining == 0 {
        return Err(error(
            "graph_prune_budget",
            "Directory cleanup exceeds retention budget.",
        ));
    }
    *remaining -= 1;
    for entry in fs::read_dir(path).map_err(state::io)?.take(129) {
        remove_empty(&entry.map_err(state::io)?.path(), depth + 1, remaining)?;
    }
    fs::remove_dir(path).map_err(state::io)
}

/// Whether a removed attempt's recorded owner admits export and prune: the current
/// guest incarnation always; with `any_owner`, any incarnation, because a removed
/// attempt holds nothing and its export is the evidence (HACK-2576).
pub(super) fn owner_accepted(any_owner: bool, owner: &str, incarnation: &str) -> bool {
    any_owner || owner == incarnation
}

/// Archived graph attempts kept; past this `graph archive` used to refuse
/// (`graph_archive_budget`).
pub(super) const ARCHIVE_LIMIT: usize = 256;
/// Consumed-ID tombstones kept; past this pruning used to refuse (`graph_consumed_budget`).
const CONSUMED_LIMIT: usize = 4096;
/// How long the export of a fully pruned run is kept, like other diagnostics (seven
/// days), and how many such exports at most.
const EXPORT_KEEP: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
const EXPORT_COUNT: usize = 256;

/// Private subdirectories of `parent` with run-id names, oldest `state.json` first,
/// that `keep` accepts, and how many entries `parent` holds (bounded by `limit + 1`).
fn oldest_runs(
    parent: &Path,
    limit: usize,
    keep: impl Fn(&str, &Path) -> bool,
) -> Result<(usize, Vec<String>), CandidateError> {
    if !parent.exists() && !parent.is_symlink() {
        return Ok((0, Vec::new()));
    }
    state::check_private_directory(parent)?;
    let entries: Vec<_> = fs::read_dir(parent)
        .map_err(state::io)?
        .take(limit + 1)
        .collect::<Result<_, _>>()
        .map_err(state::io)?;
    let count = entries.len();
    if count < limit {
        return Ok((count, Vec::new()));
    }
    let mut found = Vec::new();
    for entry in entries {
        let Some(run) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = entry.path();
        if !hex(&run, 32)
            || !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir())
            || path.join("state.pending").exists()
            || path.join("state.pending").is_symlink()
            || !keep(&run, &path)
        {
            continue;
        }
        let Ok(modified) = fs::symlink_metadata(path.join("state.json"))
            .or_else(|_| fs::symlink_metadata(&path))
            .and_then(|m| m.modified())
        else {
            continue;
        };
        found.push((modified, run));
    }
    found.sort();
    Ok((count, found.into_iter().map(|(_, run)| run).collect()))
}

/// Room in the archive (HACK-2576): at its bound the oldest archived removed runs are
/// exported (if they are not yet) and pruned, exactly as `graph export` and
/// `graph prune` do, until there is room. Their consumed-ID tombstones stay. A run
/// that fails the export or prune proof is left as it is. The caller holds the
/// provider lease.
pub(super) fn make_archive_room(
    candidate: &Candidate,
    engine: &Engine<'_>,
) -> Result<(), CandidateError> {
    let parent = candidate.state_root.join("run/graph-archive");
    // A removed archived run, or one whose prune was interrupted after its tombstone
    // was written (its receipt may already be gone): `prune` resumes that one.
    let (mut count, oldest) = oldest_runs(&parent, ARCHIVE_LIMIT, |run, path| {
        prunable(candidate, run, path)
    })?;
    if count < ARCHIVE_LIMIT {
        return Ok(());
    }
    let exports = candidate.state_root.join("exports/graphs");
    for run in oldest {
        if count < ARCHIVE_LIMIT {
            break;
        }
        // Housekeeping is best-effort: it never makes the caller refuse by itself.
        let _ = make_consumed_room(candidate);
        let exported = exports.join(format!("{run}.tar"));
        // An export interrupted before its rename leaves `{run}.pending`; it is kept
        // aside as recovery evidence, as `graph reconcile-export` does, and redone.
        if !exported.exists() && exports.join(format!("{run}.pending")).exists() {
            let _ = journal::retain_file(
                &exports,
                &format!("{run}.pending"),
                &format!("{run}-recovery"),
                EXPORT_LIMIT,
            );
        }
        let proven = (exported.exists()
            || export::export_with(candidate, engine, &run, true).is_ok())
            && prune_with(candidate, engine, &run, true).is_ok();
        if proven {
            count -= 1;
        }
    }
    let _ = trim_exports(candidate);
    Ok(())
}

/// An archived run the archive may export and prune: removed, or with an interrupted
/// prune (its tombstone written, its receipt possibly gone already).
fn prunable(candidate: &Candidate, run: &str, path: &Path) -> bool {
    state::read::<Receipt>(&path.join("state.json"))
        .is_ok_and(|receipt| receipt.phase == "removed" && receipt.run == run)
        || consumed(candidate, run).is_ok_and(|tombstone| tombstone.join("state.json").exists())
}

/// Room for one more tombstone: at the bound the oldest tombstones of fully pruned
/// runs (no archive left) are removed.
///
/// A tombstone only makes a fresh start with that run id refuse
/// (`graph_replay_refused`). The CLI makes every fresh run id from 128 random bits at
/// that start, and nothing reuses an id for a fresh start; a restore needs the run's
/// receipt, which pruning already removed. The oldest tombstone belongs to a run that
/// was removed, archived and pruned before 4096 others: no start that could still
/// carry its id is alive. One thing does change: inspecting that id afterwards reports
/// `graph_unreserved` (nothing reserved) instead of a missing receipt, and a stale
/// startup record of the CLI for it is then retired as never reserved. Nothing of the
/// run is left either way, so that answer is accurate in substance.
fn make_consumed_room(candidate: &Candidate) -> Result<(), CandidateError> {
    let parent = candidate.state_root.join("run/graph-consumed");
    let (mut count, oldest) = oldest_runs(&parent, CONSUMED_LIMIT, |run, _| {
        archive::path(candidate, run)
            .is_ok_and(|archived| !archived.exists() && !archived.is_symlink())
    })?;
    for run in oldest {
        if count < CONSUMED_LIMIT {
            break;
        }
        let path = parent.join(&run);
        state::check_private_directory(&path)?;
        fs::remove_dir_all(&path).map_err(state::io)?;
        count -= 1;
    }
    if count < CONSUMED_LIMIT {
        fs::File::open(&parent)
            .and_then(|directory| directory.sync_all())
            .map_err(state::io)?;
    }
    Ok(())
}

/// Exports of fully pruned runs (tombstone present, archive gone) are diagnostics:
/// kept seven days, and at most 256 of them, oldest removed first. The export of a
/// run that is not fully pruned is never removed: pruning still needs it.
fn trim_exports(candidate: &Candidate) -> Result<(), CandidateError> {
    let exports = candidate.state_root.join("exports/graphs");
    if !exports.exists() {
        return Ok(());
    }
    state::check_private_directory(&exports)?;
    let mut pruned = Vec::new();
    for entry in fs::read_dir(&exports).map_err(state::io)?.take(8192) {
        let entry = entry.map_err(state::io)?;
        let Some(run) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".tar"))
            .map(str::to_owned)
        else {
            continue;
        };
        if !hex(&run, 32) {
            continue;
        }
        let tombstone = consumed(candidate, &run)?.join("state.json");
        let archived = archive::path(candidate, &run)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(state::io)?;
        if !metadata.is_file() || !tombstone.exists() || archived.exists() || archived.is_symlink()
        {
            continue;
        }
        pruned.push((metadata.modified().map_err(state::io)?, entry.path()));
    }
    pruned.sort();
    let now = std::time::SystemTime::now();
    let excess = pruned.len().saturating_sub(EXPORT_COUNT);
    for (index, (modified, path)) in pruned.into_iter().enumerate() {
        let expired = now
            .duration_since(modified)
            .is_ok_and(|age| age > EXPORT_KEEP);
        if index < excess || expired {
            fs::remove_file(&path).map_err(state::io)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod chain_tests {
    use super::*;

    fn candidate() -> (Candidate, PathBuf) {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-retention-chain-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        state::private_directory(&root).unwrap();
        (Candidate::discover(&root).unwrap(), root)
    }
    fn aged(path: &Path, seconds: u64) {
        let time = std::time::SystemTime::now() - std::time::Duration::from_secs(seconds);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }
    fn tombstone(candidate: &Candidate, run: &str, age: u64) {
        let path = consumed(candidate, run).unwrap();
        state::private_directory(path.parent().unwrap()).unwrap();
        state::private_directory(&path).unwrap();
        state::write(&path.join("state.json"), &json!({"run": run})).unwrap();
        aged(&path.join("state.json"), age);
    }

    #[test]
    fn a_full_tombstone_store_drops_its_oldest_fully_pruned_entries_only() {
        let (candidate, root) = candidate();
        for index in 0..CONSUMED_LIMIT {
            tombstone(&candidate, &format!("{index:032x}"), 10_000 - index as u64);
        }
        // The oldest one still has an archive (a partial prune): it is kept.
        let partial = format!("{:032x}", 0);
        state::private_directory(
            archive::path(&candidate, &partial)
                .unwrap()
                .parent()
                .unwrap(),
        )
        .unwrap();
        state::private_directory(&archive::path(&candidate, &partial).unwrap()).unwrap();
        make_consumed_room(&candidate).unwrap();
        assert!(consumed(&candidate, &partial).unwrap().exists());
        assert!(
            !consumed(&candidate, &format!("{:032x}", 1))
                .unwrap()
                .exists()
        );
        assert!(
            consumed(&candidate, &format!("{:032x}", 2))
                .unwrap()
                .exists()
        );
        // Below the bound nothing goes.
        make_consumed_room(&candidate).unwrap();
        assert!(
            consumed(&candidate, &format!("{:032x}", 2))
                .unwrap()
                .exists()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_the_archive_room_accepts_a_removed_run_of_an_earlier_incarnation() {
        let current = "a".repeat(32);
        let earlier = "b".repeat(32);
        // Manual export and prune keep the current-incarnation rule.
        assert!(owner_accepted(false, &current, &current));
        assert!(!owner_accepted(false, &earlier, &current));
        // The archive's own room-making accepts any incarnation's removed run.
        assert!(owner_accepted(true, &earlier, &current));
    }

    #[test]
    fn a_full_archive_offers_removed_and_interrupted_runs_oldest_first() {
        let (candidate, root) = candidate();
        let parent = candidate.state_root.join("run/graph-archive");
        for path in [candidate.state_root.join("run"), parent.clone()] {
            state::private_directory(&path).unwrap();
        }
        let archived = |index: usize, phase: Option<&str>, age: u64| {
            let run = format!("{index:032x}");
            let path = parent.join(&run);
            state::private_directory(&path).unwrap();
            if let Some(phase) = phase {
                state::write(
                    &path.join("state.json"),
                    &json!({"version":1,"run":run,"owner":"b".repeat(32),"namespace":"c".repeat(64),
                        "plan_id":"d".repeat(64),"phase":phase,"readiness":{},"resources":{}}),
                )
                .unwrap();
                aged(&path.join("state.json"), age);
            }
            run
        };
        for index in 0..ARCHIVE_LIMIT - 3 {
            archived(index, Some("removed"), 100);
        }
        let oldest = archived(1000, Some("removed"), 10_000);
        // Not removed: never offered.
        archived(1001, Some("stopped-data-retained"), 20_000);
        // An interrupted prune: its receipt is gone, its tombstone is written.
        let interrupted = archived(1002, None, 0);
        tombstone(&candidate, &interrupted, 0);
        let (count, offered) = oldest_runs(&parent, ARCHIVE_LIMIT, |run, path| {
            prunable(&candidate, run, path)
        })
        .unwrap();
        assert_eq!(count, ARCHIVE_LIMIT);
        assert_eq!(offered.first(), Some(&oldest));
        assert!(offered.contains(&interrupted));
        assert!(!offered.contains(&format!("{:032x}", 1001)));
        assert_eq!(offered.len(), ARCHIVE_LIMIT - 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exports_of_fully_pruned_runs_expire_and_others_are_never_removed() {
        let (candidate, root) = candidate();
        let exports = candidate.state_root.join("exports/graphs");
        for path in [
            candidate.state_root.clone(),
            candidate.state_root.join("exports"),
            exports.clone(),
        ] {
            state::private_directory(&path).unwrap();
        }
        let export = |run: &str, age: u64| {
            let path = exports.join(format!("{run}.tar"));
            fs::write(&path, b"tar").unwrap();
            aged(&path, age);
            path
        };
        let old_pruned = format!("{:032x}", 1);
        tombstone(&candidate, &old_pruned, 10);
        let old = export(&old_pruned, 8 * 24 * 60 * 60);
        let new_pruned = format!("{:032x}", 2);
        tombstone(&candidate, &new_pruned, 10);
        let new = export(&new_pruned, 60);
        // Not pruned yet (no tombstone): prune still needs its export.
        let unpruned = export(&format!("{:032x}", 3), 30 * 24 * 60 * 60);
        let foreign = exports.join("notes.tar");
        fs::write(&foreign, b"x").unwrap();
        trim_exports(&candidate).unwrap();
        assert!(!old.exists());
        assert!(new.exists());
        assert!(unpruned.exists());
        assert!(foreign.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
