//! Bounded, confirmation-only history for retired native graph attempts.
use super::*;
use std::path::Path;

const LIMIT: usize = 256;

fn parent(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/native-graph-archive")
}

pub(super) fn directory(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    if !hex(run, 32) {
        return Err(refused());
    }
    Ok(parent(candidate).join(run))
}

pub(super) fn inspection_directory(
    candidate: &Candidate,
    run: &str,
) -> Result<Option<(PathBuf, bool)>, CandidateError> {
    if !journal::absent(candidate, run)? {
        return Ok(Some((journal::directory(candidate, run)?, false)));
    }
    let archived = directory(candidate, run)?;
    Ok((!journal::directory_absent(candidate, &archived)?).then_some((archived, true)))
}

pub(super) fn load_inspection(
    candidate: &Candidate,
    run: &str,
    owner: &str,
    boot: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    let (root, archived) = inspection_directory(candidate, run)?.ok_or_else(refused)?;
    let (receipt, root) = journal::load_at(candidate, run, Some(owner), root)?;
    if receipt.boot != boot || (archived && !eligible(&receipt)) {
        return Err(refused());
    }
    if archived {
        persistent_data::tool::require_idle(&root)?;
    }
    Ok((receipt, root))
}

fn eligible(receipt: &Receipt) -> bool {
    // Persistent confirmation reopens a verifier pinned to the active path.
    // Its journal also fences later data enrollment.
    receipt.phase == Phase::Removed && !receipt.persistent()
}

fn oldest(
    paths: impl IntoIterator<Item = PathBuf>,
    mut eligible: impl FnMut(&Path) -> Result<bool, CandidateError>,
) -> Result<Option<PathBuf>, CandidateError> {
    let mut first = None;
    for path in paths {
        if eligible(&path)? {
            let key = (
                fs::metadata(path.join("state.json"))
                    .and_then(|m| m.modified())
                    .map_err(state::io)?,
                path,
            );
            if first.as_ref().is_none_or(|prior| &key < prior) {
                first = Some(key);
            }
        }
    }
    Ok(first.map(|(_, path)| path))
}

fn sync(path: &Path) -> Result<(), CandidateError> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(state::io)
}

/// Called under the provider mutation lease. Renames publish whole directories.
/// An interrupted eviction can be finished without touching another receipt.
pub(super) fn make_room(
    candidate: &Candidate,
    owner: &str,
    runs: &[String],
) -> Result<(), CandidateError> {
    let active = candidate.state_root.join("run/native-graphs");
    let source = oldest(runs.iter().map(|run| active.join(run)), |path| {
        let run = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(refused)?;
        let (receipt, root) = journal::load_owned(candidate, run, owner)?;
        persistent_data::tool::require_idle(&root)?;
        Ok(eligible(&receipt))
    })?
    .ok_or_else(refused)?;
    let run = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(refused)?;
    let archived = parent(candidate);
    let target = directory(candidate, run)?;
    if !journal::directory_absent(candidate, &target)? {
        return Err(refused());
    }

    state::private_directory(&archived)?;
    let run_root = archived.parent().ok_or_else(refused)?;
    let expired = run_root.join(".native-graph-archive-expired");
    if !journal::directory_absent(candidate, &expired)? {
        state::check_private_directory(&expired)?;
        fs::remove_dir_all(&expired).map_err(state::io)?;
        sync(run_root)?;
    }
    let history = storage_inventory::bounded_runs(&archived, LIMIT)?;
    if history.len() == LIMIT {
        let victims = history.iter().map(|run| archived.join(run));
        let victim = oldest(victims, |path| {
            let run = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(refused)?;
            let (receipt, root) = journal::load_at(candidate, run, None, path.to_path_buf())?;
            persistent_data::tool::require_idle(&root)?;
            Ok(eligible(&receipt))
        })?
        .ok_or_else(refused)?;
        fs::rename(victim, &expired).map_err(state::io)?;
        sync(run_root)?;
        sync(&archived)?;
        fs::remove_dir_all(&expired).map_err(state::io)?;
    }
    fs::rename(&source, target).map_err(state::io)?;
    sync(&archived)?;
    sync(&active)?;
    sync(run_root)?;
    Ok(())
}
