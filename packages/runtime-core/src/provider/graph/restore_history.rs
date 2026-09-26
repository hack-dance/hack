//! Bounded diagnostic history. Only the current graph receipt authorizes execution.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

const LIMIT: usize = 8;
const BYTE_LIMIT: usize = 1024 * 1024;
const FILE: &str = "restore-history.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    version: u32,
    run: String,
    owner: String,
    namespace: String,
    truncated: bool,
    entries: Vec<Receipt>,
    // Fixed migration witnesses permit interrupted legacy retirement to resume.
    legacy: BTreeMap<String, String>,
}
fn refused() -> CandidateError {
    error(
        "graph_restore_history",
        "Restore history is foreign, incomplete, or exceeds its bounded format.",
    )
}
fn bytes(value: &impl Serialize) -> Result<Vec<u8>, CandidateError> {
    serde_json::to_vec_pretty(value).map_err(|_| refused())
}
fn digest(receipt: &Receipt) -> Result<String, CandidateError> {
    Ok(format!("{:x}", Sha256::digest(bytes(receipt)?)))
}
fn validate(receipt: &Receipt, current: &Receipt) -> Result<(), CandidateError> {
    if receipt.version != 1
        || receipt.run != current.run
        || receipt.owner != current.owner
        || receipt.namespace != current.namespace
        || receipt.plan_id != current.plan_id
        || receipt.phase != "stopped-data-retained"
    {
        return Err(refused());
    }
    Ok(())
}
fn exists(path: &Path) -> bool {
    path.exists() || path.is_symlink()
}
fn legacy_paths(root: &Path) -> Result<Vec<String>, CandidateError> {
    let entries = fs::read_dir(root)
        .map_err(state::io)?
        .take(257)
        .collect::<Result<Vec<_>, _>>()
        .map_err(state::io)?;
    if entries.len() > 256 {
        return Err(refused());
    }
    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(refused());
        };
        if !name.starts_with("restore-") || name == FILE || name == "restore-history.pending" {
            continue;
        }
        if !(1..=LIMIT).any(|i| name == format!("restore-{i}")) {
            return Err(refused());
        }
        state::check_private_directory(&entry.path())?;
        result.push(name.to_owned());
    }
    result.sort();
    Ok(result)
}
fn legacy_receipt(
    root: &Path,
    name: &str,
    current: &Receipt,
    empty_ok: bool,
) -> Result<Option<Receipt>, CandidateError> {
    let directory = root.join(name);
    state::check_private_directory(&directory)?;
    let children = fs::read_dir(&directory)
        .map_err(state::io)?
        .take(2)
        .collect::<Result<Vec<_>, _>>()
        .map_err(state::io)?;
    if children.is_empty() && empty_ok {
        return Ok(None);
    }
    if children.len() != 1 || children[0].file_name() != "previous.json" {
        return Err(refused());
    }
    let receipt: Receipt = state::read(&directory.join("previous.json"))?;
    validate(&receipt, current)?;
    Ok(Some(receipt))
}
fn load(root: &Path, current: &Receipt) -> Result<History, CandidateError> {
    validate(current, current)?;
    state::check_private_directory(root)?;
    let path = root.join(FILE);
    let names = legacy_paths(root)?;
    if exists(&path) {
        let history: History = state::read(&path)?;
        if history.version != 1
            || history.run != current.run
            || history.owner != current.owner
            || history.namespace != current.namespace
            || history.entries.is_empty()
            || history.entries.len() > LIMIT
            || history.legacy.len() > LIMIT
        {
            return Err(refused());
        }
        for receipt in &history.entries {
            validate(receipt, current)?;
        }
        for (name, hash) in &history.legacy {
            if !(1..=LIMIT).any(|i| name == &format!("restore-{i}")) || !hex(hash, 64) {
                return Err(refused());
            }
        }
        for name in names {
            let expected = history.legacy.get(&name).ok_or_else(refused)?;
            if let Some(receipt) = legacy_receipt(root, &name, current, true)? {
                if &digest(&receipt)? != expected {
                    return Err(refused());
                }
            }
        }
        return Ok(history);
    }
    let mut history = History {
        version: 1,
        run: current.run.clone(),
        owner: current.owner.clone(),
        namespace: current.namespace.clone(),
        truncated: false,
        entries: Vec::new(),
        legacy: BTreeMap::new(),
    };
    for name in names {
        let receipt = legacy_receipt(root, &name, current, false)?.ok_or_else(refused)?;
        history.legacy.insert(name, digest(&receipt)?);
        history.entries.push(receipt);
    }
    Ok(history)
}

/// Recovery may supersede a prior cleanup sidecar only when durable history
/// identifies a different, fully stopped container generation of this graph.
#[cfg(any(target_os = "macos", test))]
pub(super) fn confirms_prior_generation(
    root: &Path,
    current: &Receipt,
) -> Result<bool, CandidateError> {
    let Some(history) = verified_for_recovery(root, current)? else {
        return Ok(false);
    };
    Ok(history.entries.iter().any(|entry| {
        entry.resources.iter().any(|(key, resource)| {
            resource.kind == Kind::Container
                && resource.id.as_deref().is_some_and(|old| {
                    current.resources.get(key).and_then(|now| now.id.as_deref()) != Some(old)
                })
        })
    }))
}

/// A prior recovery sidecar may be archived only against its exact completed
/// receipt, never just any older generation in the bounded history.
#[cfg(target_os = "macos")]
pub(super) fn completed_for_recovery(
    root: &Path,
    current: &Receipt,
    expected: &str,
) -> Result<Option<Receipt>, CandidateError> {
    if !hex(expected, 64) {
        return Err(refused());
    }
    let Some(history) = verified_for_recovery(root, current)? else {
        return Ok(None);
    };
    history
        .entries
        .into_iter()
        .find_map(|entry| match digest(&entry) {
            Ok(actual) if actual == expected => Some(Ok(entry)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .transpose()
}

/// A superseded bridge sidecar must bind to the most recent fully stopped
/// generation, not merely to some older container in the bounded history.
#[cfg(target_os = "macos")]
pub(super) fn latest_for_bridge_recovery(
    root: &Path,
    current: &Receipt,
) -> Result<Option<Receipt>, CandidateError> {
    Ok(
        verified_for_recovery(root, current)?
            .and_then(|history| history.entries.into_iter().last()),
    )
}

#[cfg(any(target_os = "macos", test))]
fn verified_for_recovery(
    root: &Path,
    current: &Receipt,
) -> Result<Option<History>, CandidateError> {
    let path = root.join(FILE);
    if !exists(&path) {
        return Ok(None);
    }
    let history: History = state::read_bounded(&path, BYTE_LIMIT as u64)?;
    if history.version != 1
        || history.run != current.run
        || history.owner != current.owner
        || history.namespace != current.namespace
        || history.entries.is_empty()
        || history.entries.len() > LIMIT
        || history
            .entries
            .iter()
            .any(|entry| validate(entry, current).is_err())
    {
        return Err(refused());
    }
    Ok(Some(history))
}
fn next(root: &Path, current: &Receipt) -> Result<History, CandidateError> {
    let mut history = load(root, current)?;
    let same =
        history.entries.last().map(digest).transpose()?.as_deref() == Some(&digest(current)?);
    if !same {
        history.entries.push(current.clone());
    }
    while history.entries.len() > LIMIT || bytes(&history)?.len() > BYTE_LIMIT {
        if history.entries.len() <= 1 {
            return Err(refused());
        }
        history.entries.remove(0);
        history.truncated = true;
    }
    Ok(history)
}
fn recover_pending(root: &Path, expected: &[u8]) -> Result<(), CandidateError> {
    let path = root.join("restore-history.pending");
    if !exists(&path) {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(state::io)?;
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > BYTE_LIMIT as u64
    {
        return Err(refused());
    }
    let mut pending = Vec::new();
    (&mut file)
        .take(BYTE_LIMIT as u64 + 1)
        .read_to_end(&mut pending)
        .map_err(state::io)?;
    // A partial deterministic replacement contains no sole copy: committed history and
    // current state are untouched until publication. Unknown bytes are never discarded.
    if !expected.starts_with(&pending) {
        return Err(refused());
    }
    let after = fs::symlink_metadata(&path).map_err(state::io)?;
    if after.dev() != metadata.dev()
        || after.ino() != metadata.ino()
        || after.len() != pending.len() as u64
        || after.nlink() != 1
    {
        return Err(refused());
    }
    fs::remove_file(path).map_err(state::io)
}
/// Called under the provider operation lock, after compute absence has been verified.
pub(super) fn retain(root: &Path, current: &Receipt) -> Result<(), CandidateError> {
    let history = next(root, current)?;
    recover_pending(root, &bytes(&history)?)?;
    #[cfg(test)]
    super::fault_pause(root, &current.run, "history-before-publication")?;
    // fsync + atomic publication precedes any retirement; history never drives execution.
    state::write(&root.join(FILE), &history)?;
    #[cfg(test)]
    super::fault_pause(root, &current.run, "history-published")?;
    for (name, expected) in &history.legacy {
        let directory = root.join(name);
        if !exists(&directory) {
            continue;
        }
        if let Some(receipt) = legacy_receipt(root, name, current, true)? {
            if &digest(&receipt)? != expected {
                return Err(refused());
            }
            fs::remove_file(directory.join("previous.json")).map_err(state::io)?;
        }
        fs::remove_dir(directory).map_err(state::io)?;
        #[cfg(test)]
        super::fault_pause(root, &current.run, "history-retired-entry")?;
    }
    fs::File::open(root)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(super) fn latest(root: &Path) -> Result<Receipt, CandidateError> {
    let mut history: History = state::read(&root.join(FILE))?;
    history.entries.pop().ok_or_else(refused)
}
