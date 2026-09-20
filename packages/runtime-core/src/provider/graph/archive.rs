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
    let (receipt, root) = load(candidate, &engine, run)?;
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
    verify_removed(&engine, &receipt)?;
    environment::archive_slots(candidate, &engine, &receipt, &root)?;
    let target = path(candidate, run)?;
    let parent = target.parent().expect("archive parent");
    state::private_directory(parent)?;
    if target.exists() || target.is_symlink() {
        return Err(error(
            "graph_archive_exists",
            "Archived evidence already exists; it will not be replaced.",
        ));
    }
    if fs::read_dir(parent).map_err(state::io)?.take(256).count() >= 256 {
        return Err(error(
            "graph_archive_budget",
            "Archive retains 256 attempts; explicit export/retention work is required.",
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
