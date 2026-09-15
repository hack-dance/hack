use super::*;

pub(super) fn path(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    directory(candidate, run)?;
    let parent = candidate.state_root.join("run/graph-archive");
    if parent.exists() || parent.is_symlink() {
        state::check_private_directory(&parent)?;
    }
    Ok(parent.join(run))
}

/// Retain a fully removed attempt outside the active admission inventory. Archived IDs remain
/// reserved permanently; this operation neither deletes evidence nor permits execution replay.
pub fn archive(candidate: &Candidate, run: &str) -> Result<Receipt, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
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
