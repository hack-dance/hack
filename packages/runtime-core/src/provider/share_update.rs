//! Explicit stopped-pool project share set changes.
//!
//! A development pool shares one primary project root from creation. Further roots
//! join the same pool only through this journaled update, applied while the pool is
//! stopped and its provider released, and take effect at the next boot. A running
//! pool's mounts never change. The journal owns both sides of the provider-record and
//! owner commit, exactly as the stopped network extension does, and ordinary startup
//! cannot cross an unfinished update.
//!
//! Isolation between projects in one pool: each graph binds only the share whose root
//! equals its own reviewed source (`project_share_for`), every bind path stays under
//! that share's guest path, graph namespaces are derived from the canonical root, and
//! cleanup acts on one run's labelled resources. Removing a share is refused while any
//! retained graph receipt still names it.
use super::{
    ProjectShareIntent, config_audit, network_update,
    project_share::{self, MAX_PROJECT_SHARES},
    state::{self, Owner},
};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "project_share_update",
        "Stopped project share update is incomplete, not applicable, or its owned inputs changed; repeat the same update only after resolving ownership.",
    )
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm")
}
const JOURNAL: &str = "share-update.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Operation {
    Add,
    Remove,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    operation: Operation,
    share: ProjectShareIntent,
    database_identity: (u64, u64),
    owner_before: Value,
    owner_after: Value,
    record_before: Value,
    record_after: Value,
}

/// Startup, source admission and other stopped-pool updates refuse while a share
/// update journal (or its staging file) exists.
pub(super) fn require_complete(candidate: &Candidate) -> Result<(), CandidateError> {
    for name in [JOURNAL, "share-update.pending"] {
        match fs::symlink_metadata(root(candidate).join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(refused()),
        }
    }
    Ok(())
}

fn owner_value(owner: &Owner) -> Result<Value, CandidateError> {
    serde_json::to_value(owner).map_err(|_| refused())
}

/// The provider record's mount list for an owner: the read-only engine mount the
/// record already carries, then every share in set order.
fn record_mounts(record: &Value, owner: &Owner) -> Result<Value, CandidateError> {
    let engine = record["mounts"]
        .as_array()
        .and_then(|mounts| mounts.first())
        .ok_or_else(refused)?
        .clone();
    let mut mounts = vec![engine];
    mounts.extend(
        owner
            .project_shares()
            .into_iter()
            .map(|s| s.database_mount()),
    );
    Ok(Value::Array(mounts))
}

/// Pure plan: the exact owner and record after one add or remove. Only the share set
/// and the record's mount list change; every other owner and record field is kept.
fn plan(
    owner: &Owner,
    record: Value,
    operation: Operation,
    share: &ProjectShareIntent,
    database_identity: (u64, u64),
) -> Result<Journal, CandidateError> {
    let primary = owner.project_share.as_ref().ok_or_else(refused)?;
    project_share::validate_set(Some(primary), &owner.additional_project_shares)?;
    share.validate_receipt()?;
    if record_mounts(&record, owner)? != record["mounts"] {
        return Err(refused());
    }
    let mut after = owner.clone();
    match operation {
        Operation::Add => {
            if owner
                .project_shares()
                .iter()
                .any(|s| s.project == share.project || s.guest_path == share.guest_path)
                || owner.project_shares().len() >= MAX_PROJECT_SHARES
            {
                return Err(refused());
            }
            after.additional_project_shares.push(share.clone());
        }
        Operation::Remove => {
            // The primary share defines the pool; it is never removed here.
            let index = owner
                .additional_project_shares
                .iter()
                .position(|s| s == share)
                .ok_or_else(refused)?;
            after.additional_project_shares.remove(index);
        }
    }
    project_share::validate_set(
        after.project_share.as_ref(),
        &after.additional_project_shares,
    )?;
    let mut record_after = record.clone();
    record_after["mounts"] = record_mounts(&record, &after)?;
    Ok(Journal {
        version: 1,
        operation,
        share: share.clone(),
        database_identity,
        owner_before: owner_value(owner)?,
        owner_after: owner_value(&after)?,
        record_before: record,
        record_after,
    })
}

/// A journal is valid only if replanning its `before` sides yields exactly its `after`.
fn validate(j: &Journal) -> Result<(Owner, Owner), CandidateError> {
    let before: Owner = serde_json::from_value(j.owner_before.clone()).map_err(|_| refused())?;
    let after: Owner = serde_json::from_value(j.owner_after.clone()).map_err(|_| refused())?;
    if j.version != 1 {
        return Err(refused());
    }
    let expected = plan(
        &before,
        j.record_before.clone(),
        j.operation,
        &j.share,
        j.database_identity,
    )?;
    if expected.owner_after != j.owner_after || expected.record_after != j.record_after {
        return Err(refused());
    }
    Ok((before, after))
}

/// Recovery accepts only the ordered sides: the record commits before the owner.
fn validate_sides(j: &Journal, owner: &Value, record: &Value) -> Result<(), CandidateError> {
    if (owner != &j.owner_before && owner != &j.owner_after)
        || (record != &j.record_before && record != &j.record_after)
        || (owner == &j.owner_after && record == &j.record_before)
    {
        return Err(refused());
    }
    Ok(())
}

const RECEIPT_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_DEPTH: usize = 3;

/// Conservative retained-graph reference check before a share is removed. Any graph
/// record (normalized or native, any phase, including pending journals) that names the
/// share's exact guest path or host root keeps the share; the caller cleans or archives
/// that project's graphs first. A false positive or an unreadable inventory only refuses.
fn require_unreferenced(
    candidate: &Candidate,
    share: &ProjectShareIntent,
) -> Result<(), CandidateError> {
    let needles = [
        share.guest_path.as_bytes().to_vec(),
        serde_json::to_vec(&share.project).map_err(|_| refused())?,
    ];
    let mut budget = MAX_ENTRIES;
    for parent in ["run/graphs", "run/native-graphs"] {
        let parent = candidate.state_root.join(parent);
        match fs::symlink_metadata(&parent) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(refused()),
            Ok(_) => state::check_private_directory(&parent)?,
        }
        scan(&parent, 0, &needles, &mut budget)?;
    }
    Ok(())
}

fn scan(
    directory: &Path,
    depth: usize,
    needles: &[Vec<u8>],
    budget: &mut usize,
) -> Result<(), CandidateError> {
    for entry in fs::read_dir(directory).map_err(|_| refused())? {
        *budget = budget.checked_sub(1).ok_or_else(refused)?;
        let path = entry.map_err(|_| refused())?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.file_type().is_symlink() {
            return Err(refused());
        }
        if metadata.is_dir() {
            if depth >= MAX_DEPTH {
                return Err(refused());
            }
            scan(&path, depth + 1, needles, budget)?;
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !metadata.is_file() || !(name.ends_with(".json") || name.ends_with(".pending")) {
            continue;
        }
        if metadata.len() > RECEIPT_LIMIT {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        File::open(&path)
            .and_then(|f| f.take(RECEIPT_LIMIT + 1).read_to_end(&mut bytes))
            .map_err(|_| refused())?;
        if needles
            .iter()
            .any(|needle| bytes.windows(needle.len()).any(|w| w == needle.as_slice()))
        {
            return Err(CandidateError::new(
                "project_share_in_use",
                "A retained graph still names this project share; clean or archive that project's graphs before removing its share.",
            ));
        }
    }
    Ok(())
}

/// Add one exactly approved project root to an owned, stopped development pool. The
/// new share is mounted at the next boot; nothing is booted, restarted or replaced.
pub fn add_project_share(
    candidate: &Candidate,
    share: &ProjectShareIntent,
) -> Result<Value, CandidateError> {
    share.validate()?;
    update(candidate, Operation::Add, share.clone())
}

/// Remove one additional project root from an owned, stopped development pool. The
/// root may already be moved or deleted; it is matched by its exact recorded path.
pub fn remove_project_share(
    candidate: &Candidate,
    project: &Path,
) -> Result<Value, CandidateError> {
    if !project.is_absolute() {
        return Err(refused());
    }
    reject_aliased_state(&root(candidate))?;
    let owner = Owner::load(candidate)?;
    let share = match fs::symlink_metadata(root(candidate).join(JOURNAL)) {
        // An interrupted removal names its own share; resume exactly that one.
        Ok(_) => {
            let j: Journal = state::read(&root(candidate).join(JOURNAL))?;
            if j.operation != Operation::Remove || j.share.project != project {
                return Err(refused());
            }
            j.share
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => owner
            .additional_project_shares
            .iter()
            .find(|s| s.project == project)
            .cloned()
            .ok_or_else(refused)?,
        Err(_) => return Err(refused()),
    };
    update(candidate, Operation::Remove, share)
}

fn update(
    candidate: &Candidate,
    operation: Operation,
    share: ProjectShareIntent,
) -> Result<Value, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    let _lock = state::Lock::acquire(&root(candidate))?;
    network_update::require_complete(candidate)?;
    let owner = Owner::load(candidate)?;
    let path = root(candidate).join(JOURNAL);
    let journal_present = match fs::symlink_metadata(&path) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(refused()),
    };
    if !journal_present {
        let present = owner.project_shares().contains(&&share);
        if operation == Operation::Add && present {
            return Ok(result(&owner, operation, &share, false));
        }
    }
    let _vm_lock = network_update::stopped_with(candidate, &owner, refused)?;
    if operation == Operation::Remove {
        require_unreferenced(candidate, &share)?;
    }
    let db = network_update::database(candidate);
    let record = config_audit::read_database(&db, &owner.machine)?;
    network_update::verify_record_process_with(&owner, &record, refused)?;
    let j: Journal = if journal_present {
        network_update::file_identity_with(&path, refused)?;
        state::read(&path)?
    } else {
        require_complete(candidate)?;
        config_audit::verify_value(candidate, &owner, &record)?;
        let j = plan(
            &owner,
            record.clone(),
            operation,
            &share,
            network_update::file_identity_with(&db, refused)?,
        )?;
        state::write(&path, &j)?;
        j
    };
    let (before, after) = validate(&j)?;
    let current_owner = owner_value(&owner)?;
    if j.operation != operation || j.share != share {
        return Err(refused());
    }
    validate_sides(&j, &current_owner, &record)?;
    config_audit::verify_value(candidate, &before, &j.record_before)?;
    config_audit::verify_value(candidate, &after, &j.record_after)?;
    if owner_value(&Owner::load(candidate)?)? != current_owner {
        return Err(refused());
    }
    super::lifecycle::verify_disks(candidate, &owner)?;
    network_update::apply_record(
        &db,
        &owner.machine,
        j.database_identity,
        &j.record_before,
        &j.record_after,
        refused,
    )?;
    config_audit::verify_value(
        candidate,
        &after,
        &config_audit::read_database(&db, &owner.machine)?,
    )?;
    super::lifecycle::verify_disks(candidate, &owner)?;
    // A fully written interrupted owner staging file is removable only if exact.
    let pending = root(candidate).join("owner.pending");
    match fs::symlink_metadata(&pending) {
        Ok(_) => {
            network_update::file_identity_with(&pending, refused)?;
            let staged: Value = state::read(&pending)?;
            if staged != j.owner_after {
                return Err(refused());
            }
            fs::remove_file(&pending).map_err(|_| refused())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(refused()),
    }
    if owner_value(&Owner::load(candidate)?)? != current_owner {
        return Err(refused());
    }
    if current_owner != j.owner_after {
        after.save(candidate)?;
    }
    let saved = Owner::load(candidate)?;
    config_audit::verify(candidate, &saved)?;
    fs::remove_file(&path).map_err(|_| refused())?;
    File::open(root(candidate))
        .and_then(|f| f.sync_all())
        .map_err(|_| refused())?;
    Ok(result(&saved, operation, &share, true))
}

fn result(owner: &Owner, operation: Operation, share: &ProjectShareIntent, changed: bool) -> Value {
    json!({
        "kind": match operation {
            Operation::Add => "project_share_added",
            Operation::Remove => "project_share_removed",
        },
        "owner": owner.token,
        "machine": owner.machine,
        "project": share.project,
        "changed": changed,
        "shares": owner.project_shares().len(),
        "share_limit": MAX_PROJECT_SHARES,
        "restarted": false,
        "disks_preserved": true,
        "effective": "next-boot",
    })
}

#[cfg(test)]
mod tests;
