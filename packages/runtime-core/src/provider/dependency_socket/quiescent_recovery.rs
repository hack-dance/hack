//! Explicit legacy socket retirement while an independently verified VM stays live.
//! This uses a separate receipt from stopped-pool recovery. It never proves who
//! created an unreceipted socket; the reviewed selection authorizes only those inodes.
#[cfg(any(test, target_os = "macos"))]
use super::{
    DependencySocketIntent,
    recovery::{Socket, digest, hex, observed as observe_socket, path},
};
#[cfg(any(test, target_os = "macos"))]
use crate::provider::state;
use crate::{Candidate, CandidateError};
#[cfg(any(test, target_os = "macos"))]
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(any(test, target_os = "macos"))]
use serde_json::json;
#[cfg(any(test, target_os = "macos"))]
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

#[cfg(any(test, target_os = "macos"))]
const MAX_RECEIPTS: usize = 16;
#[cfg(any(test, target_os = "macos"))]
const RECEIPT_LIMIT: u64 = 16 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "quiescent_dependency_socket_recovery",
        "Live pool quiescence or selected socket identity is uncertain; paths and data were retained.",
    )
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Scope {
    version: u8,
    quiescence_sha256: String,
    slots: u8,
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Selection {
    scope: Scope,
    sockets: Vec<Socket>,
}

#[cfg(target_os = "macos")]
fn journal(candidate: &Candidate) -> PathBuf {
    candidate
        .state_root
        .join("run/smolvm/quiescent-dependency-socket-recovery")
}

#[cfg(any(test, target_os = "macos"))]
fn observed(directory: &Path, slot: u8) -> Result<Option<Socket>, CandidateError> {
    observe_socket(directory, slot).map_err(|_| refused())
}

#[cfg(any(test, target_os = "macos"))]
fn current(scope: Scope, directory: &Path) -> Result<Selection, CandidateError> {
    DependencySocketIntent::new(scope.slots)?;
    if scope.version != 1 || !hex(&scope.quiescence_sha256) {
        return Err(refused());
    }
    let mut sockets = Vec::new();
    for slot in 0..scope.slots {
        if let Some(socket) = observed(directory, slot)? {
            sockets.push(socket);
        }
    }
    Ok(Selection { scope, sockets })
}

#[cfg(any(test, target_os = "macos"))]
fn matching(
    selection: &Selection,
    scope: &Scope,
    directory: &Path,
) -> Result<usize, CandidateError> {
    if selection.scope != *scope
        || selection.sockets.is_empty()
        || selection.sockets.len() > usize::from(scope.slots)
        || selection.sockets.iter().any(|s| s.slot >= scope.slots)
        || selection
            .sockets
            .windows(2)
            .any(|pair| pair[0].slot >= pair[1].slot)
    {
        return Err(refused());
    }
    let mut remaining = 0;
    for slot in 0..scope.slots {
        let saved = selection.sockets.iter().find(|item| item.slot == slot);
        match (saved, observed(directory, slot)?) {
            (Some(saved), Some(actual)) if *saved == actual => remaining += 1,
            (Some(_), None) | (None, None) => {}
            _ => return Err(refused()),
        }
    }
    Ok(remaining)
}

#[cfg(any(test, target_os = "macos"))]
fn receipts(root: &Path) -> Result<Vec<PathBuf>, CandidateError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(refused()),
    };
    state::check_private_directory(root)?;
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| refused())?;
        let name = entry.file_name().into_string().map_err(|_| refused())?;
        // An incomplete journal or unknown file is retained and never interpreted
        // as permission to delete. Only committed, bounded selections can resume.
        if !name.strip_suffix(".json").is_some_and(hex) || paths.len() >= MAX_RECEIPTS {
            return Err(refused());
        }
        paths.push(entry.path());
    }
    paths.sort();
    Ok(paths)
}

#[cfg(any(test, target_os = "macos"))]
fn read(root: &Path, hash: &str) -> Result<Selection, CandidateError> {
    let selected: Selection =
        state::read_bounded(&root.join(format!("{hash}.json")), RECEIPT_LIMIT)?;
    if digest(&selected)? != hash {
        return Err(refused());
    }
    Ok(selected)
}

#[cfg(any(test, target_os = "macos"))]
fn inspect_scope(root: &Path, scope: &Scope, directory: &Path) -> Result<Value, CandidateError> {
    for receipt in receipts(root)? {
        let hash = receipt
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(refused)?;
        let selected = read(root, hash)?;
        if selected.scope == *scope {
            let remaining = matching(&selected, scope, directory)?;
            if remaining > 0 {
                return Ok(
                    json!({"recoverable":true,"sha256":hash,"selected":selected.sockets.len(),"remaining":remaining,"resumable":true,"mode":"live-quiescent-legacy"}),
                );
            }
        }
    }
    let selected = current(scope.clone(), directory)?;
    if selected.sockets.is_empty() {
        return Ok(json!({"recoverable":false,"selected":0,"mode":"live-quiescent-legacy"}));
    }
    Ok(
        json!({"recoverable":true,"sha256":digest(&selected)?,"selected":selected.sockets.len(),"remaining":selected.sockets.len(),"resumable":false,"mode":"live-quiescent-legacy"}),
    )
}

#[cfg(any(test, target_os = "macos"))]
fn recover_scope(
    root: &Path,
    scope: &Scope,
    directory: &Path,
    expected: &str,
    verify: impl Fn() -> Result<(), CandidateError>,
) -> Result<Value, CandidateError> {
    if !hex(expected) {
        return Err(refused());
    }
    verify()?;
    let paths = receipts(root)?;
    let filename = root.join(format!("{expected}.json"));
    let saved = if paths.contains(&filename) {
        read(root, expected)?
    } else {
        let selected = current(scope.clone(), directory)?;
        if selected.sockets.is_empty()
            || digest(&selected)? != expected
            || paths.len() >= MAX_RECEIPTS
        {
            return Err(refused());
        }
        verify()?;
        matching(&selected, scope, directory)?;
        state::private_directory(root)?;
        state::write(&filename, &selected)?;
        selected
    };
    let remaining = matching(&saved, scope, directory)?;
    for socket in &saved.sockets {
        verify()?;
        matching(&saved, scope, directory)?;
        if observed(directory, socket.slot)?.as_ref() == Some(socket) {
            fs::remove_file(path(directory, socket.slot)).map_err(state::io)?;
            File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(state::io)?;
        }
    }
    verify()?;
    if matching(&saved, scope, directory)? != 0 {
        return Err(refused());
    }
    Ok(
        json!({"recovered":true,"sha256":expected,"selected":saved.sockets.len(),"removed":remaining,"already_absent":saved.sockets.len()-remaining,"data_retained":true,"mode":"live-quiescent-legacy"}),
    )
}

/// Select unlistened declared socket inodes only after holding the pool publication
/// gate, all retained graph retirement locks and the provider lease. Owner bytes,
/// guest boot, data volumes, empty reservations and absent compute are pinned.
#[cfg(target_os = "macos")]
pub fn inspect(candidate: &Candidate) -> Result<Value, CandidateError> {
    let guard = crate::provider::graph::quiescent_dependency_recovery::Guard::acquire(candidate)?;
    let scope = Scope {
        version: 1,
        quiescence_sha256: guard.sha256().into(),
        slots: guard.owner().dependency_sockets.ok_or_else(refused)?.slots,
    };
    let result = inspect_scope(&journal(candidate), &scope, &guard.owner().short_home)?;
    guard.verify(candidate)?;
    Ok(result)
}

/// Explicit inode-selected recovery. A committed, separate journal precedes every
/// unlink; each effect rechecks the held quiescence proof. A partial retry accepts
/// exact remaining inodes or absence, and never restarts the VM or edits its Owner.
#[cfg(target_os = "macos")]
pub fn recover(candidate: &Candidate, expected: &str) -> Result<Value, CandidateError> {
    if !hex(expected) {
        return Err(refused());
    }
    let guard = crate::provider::graph::quiescent_dependency_recovery::Guard::acquire(candidate)?;
    let scope = Scope {
        version: 1,
        quiescence_sha256: guard.sha256().into(),
        slots: guard.owner().dependency_sockets.ok_or_else(refused)?.slots,
    };
    recover_scope(
        &journal(candidate),
        &scope,
        &guard.owner().short_home,
        expected,
        || guard.verify(candidate),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn inspect(_: &Candidate) -> Result<Value, CandidateError> {
    Err(refused())
}
#[cfg(not(target_os = "macos"))]
pub fn recover(_: &Candidate, _: &str) -> Result<Value, CandidateError> {
    Err(refused())
}

#[cfg(test)]
#[path = "quiescent_recovery_tests.rs"]
mod tests;
