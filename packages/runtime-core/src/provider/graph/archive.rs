use super::*;

pub(super) fn path(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    directory(candidate, run)?;
    let parent = candidate.state_root.join("run/graph-archive");
    if parent.exists() || parent.is_symlink() {
        state::check_private_directory(&parent)?;
    }
    Ok(parent.join(run))
}

/// Selects exactly one receipt location without creating or promoting state.
fn receipt_root(candidate: &Candidate, run: &str) -> Result<(PathBuf, bool), CandidateError> {
    fn present(path: &std::path::Path) -> Result<bool, CandidateError> {
        crate::reject_aliased_state(path)?;
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(state::io(e)),
            Ok(metadata) if metadata.is_dir() => {
                state::check_private_directory(path)?;
                Ok(true)
            }
            Ok(_) => Err(error(
                "graph_confirmation_location",
                "Graph receipt location is not a private directory.",
            )),
        }
    }
    let active = directory(candidate, run)?;
    let archived = path(candidate, run)?;
    let (root, is_archived) = match (present(&active)?, present(&archived)?) {
        (true, false) => (active, false),
        (false, true) => (archived, true),
        _ => {
            return Err(error(
                "graph_confirmation_location",
                "Confirmation requires exactly one active or archived graph receipt.",
            ));
        }
    };
    Ok((root, is_archived))
}

#[cfg(any(target_os = "macos", test))]
fn confirmation_root(candidate: &Candidate, run: &str) -> Result<(PathBuf, bool), CandidateError> {
    let (root, is_archived) = receipt_root(candidate, run)?;
    match fs::symlink_metadata(root.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((root, is_archived)),
        _ => Err(error(
            "graph_journal_uncertain",
            "Pending or unreadable graph journal blocks confirmation.",
        )),
    }
}

/// Read only committed evidence for journal retention. Pending bytes are never
/// parsed or promoted; archived recovery is restricted to enrolled removed graphs.
pub(super) fn load_reconciliation(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    read_reconciliation(candidate, run, engine.guest().incarnation())
}

fn read_reconciliation(
    candidate: &Candidate,
    run: &str,
    incarnation: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    let (root, archived) = receipt_root(candidate, run)?;
    let (receipt, root) = load_at(root, run, incarnation)?;
    if archived && (receipt.phase != "removed" || receipt.relay_cleanup.is_none()) {
        return Err(error(
            "graph_archive_refused",
            "Archived journal recovery requires an enrolled removed graph.",
        ));
    }
    Ok((receipt, root))
}

/// Receipt-only recovery lookup. No cleanup, archive movement or replay is performed.
/// Ordinary graph loads remain active-only. The caller must independently inspect effects.
#[cfg(target_os = "macos")]
pub(super) fn load_confirmation(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    read_confirmation(candidate, run, engine.guest().incarnation())
}

#[cfg(any(target_os = "macos", test))]
fn read_confirmation(
    candidate: &Candidate,
    run: &str,
    incarnation: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    let (root, archived) = confirmation_root(candidate, run)?;
    let (receipt, root) = load_at(root, run, incarnation)?;
    if archived && receipt.phase != "removed" {
        return Err(error(
            "graph_archive_refused",
            "Archived confirmation requires an explicitly removed graph.",
        ));
    }
    Ok((receipt, root))
}

/// Retain a fully removed attempt outside the active admission inventory. Archived IDs remain
/// reserved permanently; this operation neither deletes evidence nor permits execution replay.
pub fn archive(candidate: &Candidate, run: &str) -> Result<Receipt, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    archive_with(candidate, &engine, run)
}

/// [`archive`] under a provider lease the caller already holds.
fn archive_with(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<Receipt, CandidateError> {
    let (receipt, root) = load(candidate, engine, run)?;
    initializer_cache::require_resolved(&receipt)?;
    if receipt.phase != "removed"
        || root.join("state.pending").exists()
        || root.join("state.pending").is_symlink()
    {
        return Err(error(
            "graph_archive_refused",
            "Archive requires completed explicit data removal and no pending journal.",
        ));
    }
    verify_removed(engine, &receipt)?;
    environment::archive_slots(candidate, engine, &receipt, &root)?;
    let target = path(candidate, run)?;
    let parent = target.parent().expect("archive parent");
    state::private_directory(parent)?;
    if target.exists() || target.is_symlink() {
        return Err(error(
            "graph_archive_exists",
            "Archived evidence already exists; it will not be replaced.",
        ));
    }
    // HACK-2576: the oldest archived removed runs are exported and pruned first.
    retention::make_archive_room(candidate, engine)?;
    if fs::read_dir(parent).map_err(state::io)?.take(256).count() >= retention::ARCHIVE_LIMIT {
        return Err(error(
            "graph_archive_budget",
            "Archive retains 256 attempts that could not be proven removed, so none could be pruned to make room; inspect them with hack doctor --native-cleanup inspect.",
        ));
    }
    fs::rename(&root, &target).map_err(state::io)?;
    for directory in [parent, root.parent().expect("active parent")] {
        fs::File::open(directory)
            .map_err(state::io)?
            .sync_all()
            .map_err(state::io)?;
    }
    Ok(receipt)
}

/// Graph attempts the active inventory holds (`run/graphs`); a fresh run needs fewer.
const ACTIVE_LIMIT: usize = 64;

/// Room for a fresh run (HACK-2576). Every fully removed attempt stays in the active
/// inventory until something archives it, and nothing in the CLI did, so 64 of them
/// (each `down --remove-data` followed by `up`, each failed fresh start) refused
/// every later start for ever. At the bound, removed attempts are archived oldest
/// first, each proven removed exactly as `graph archive` proves it, until there is
/// room. An attempt that keeps data, has a pending journal or fails that proof is
/// never touched. The caller holds the provider lease.
pub(super) fn make_room(candidate: &Candidate, engine: &Engine<'_>) -> Result<(), CandidateError> {
    let (mut count, removed) = archivable(&candidate.state_root.join("run/graphs"))?;
    let mut skipped = 0;
    for run in removed {
        if count < ACTIVE_LIMIT {
            break;
        }
        match archive_with(candidate, engine, &run) {
            Ok(_) => count -= 1,
            // A run that fails the removal proof stays where it is; any other error
            // (the archive's own bound, the engine, the guest) is reported as it is.
            Err(error) if error.code == "graph_archive_refused" => skipped += 1,
            Err(error) => return Err(error),
        }
    }
    if count >= ACTIVE_LIMIT && skipped > 0 {
        return Err(error(
            "graph_retention_budget",
            "64 graph attempts are retained and not enough of the removed ones among them could be proven removed to make room; inspect them with hack doctor --native-cleanup inspect.",
        ));
    }
    Ok(())
}

/// The active inventory's size and, when it is at the bound, its removed attempts,
/// oldest receipt first. A run with a pending journal, an unreadable or foreign
/// receipt, or any phase but `removed` is never selected.
fn archivable(parent: &std::path::Path) -> Result<(usize, Vec<String>), CandidateError> {
    if !parent.exists() && !parent.is_symlink() {
        return Ok((0, Vec::new()));
    }
    state::check_private_directory(parent)?;
    // Below the bound no receipt is read.
    let entries: Vec<_> = fs::read_dir(parent)
        .map_err(state::io)?
        .take(ACTIVE_LIMIT + 1)
        .collect::<Result<_, _>>()
        .map_err(state::io)?;
    let count = entries.len();
    if count < ACTIVE_LIMIT {
        return Ok((count, Vec::new()));
    }
    let mut removed = Vec::new();
    for entry in entries {
        let Some(run) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let state = entry.path().join("state.json");
        let pending = entry.path().join("state.pending");
        if !hex(&run, 32) || pending.exists() || pending.is_symlink() {
            continue;
        }
        let Ok(receipt) = state::read::<Receipt>(&state) else {
            continue;
        };
        if receipt.phase == "removed" && receipt.run == run {
            let modified = fs::symlink_metadata(&state)
                .and_then(|metadata| metadata.modified())
                .map_err(state::io)?;
            removed.push((modified, run));
        }
    }
    removed.sort();
    Ok((count, removed.into_iter().map(|(_, run)| run).collect()))
}

pub(super) fn verify_removed(engine: &Engine<'_>, receipt: &Receipt) -> Result<(), CandidateError> {
    for resource in receipt.resources.values() {
        if resource.cache.is_some() && resource.phase == "released" {
            inspect_resource(engine, receipt, resource)?;
            continue;
        }
        let mut by_name = resource.clone();
        by_name.id = None;
        if resource.phase != "absent"
            || inspect_resource(engine, receipt, resource)?.is_some()
            || inspect_resource(engine, receipt, &by_name)?.is_some()
        {
            return Err(error(
                "graph_archive_refused",
                "Archive requires confirmed absence of every owned resource.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
