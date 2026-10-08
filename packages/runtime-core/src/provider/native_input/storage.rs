//! Isolated native preparation evidence; current Compose inventory/owner paths stay untouched.
use super::super::state;
use super::*;
use crate::Candidate;
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::PathBuf,
};

const MAX_RETAINED_INPUTS: usize = 64;

fn retention_available(parent: &std::path::Path) -> Result<(), CandidateError> {
    let entries = fs::read_dir(parent).map_err(|_| artifact_refused())?;
    let mut count = 0;
    for entry in entries.take(MAX_RETAINED_INPUTS + 2) {
        let entry = entry.map_err(|_| artifact_refused())?;
        if entry.file_name() == "operation.lock" {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| artifact_refused())?;
        if !hex(&name, 32) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            return Err(artifact_refused());
        }
        count += 1;
        if count >= MAX_RETAINED_INPUTS {
            return Err(artifact_refused());
        }
    }
    Ok(())
}

pub(super) fn directory(
    candidate: &Candidate,
    scope: Scope<'_>,
) -> Result<PathBuf, CandidateError> {
    if !valid_scope(scope) {
        return Err(refused());
    }
    Ok(candidate
        .state_root
        .join("run/native-inputs")
        .join(scope.namespace)
        .join(scope.run))
}

/// Publish once under a fresh attempt directory. state::write commits by synced rename;
/// an error/crash retains the private directory/pending evidence and never grants execution.
/// A same-user adversary replacing paths during publication is outside existing state helpers' contract.
pub fn publish(candidate: &Candidate, prepared: &Prepared) -> Result<Receipt, CandidateError> {
    prepared.remaining()?;
    let review = prepared.review();
    let scope = review.scope();
    review.validate(scope)?;
    let receipt = Receipt {
        version: 2,
        kind: ArtifactKind::NativeGraphPreparation,
        phase: Phase::Prepared,
        review: review.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&receipt).map_err(|_| artifact_refused())?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err(artifact_refused());
    }
    let root = directory(candidate, scope)?;
    let parent = root.parent().ok_or_else(artifact_refused)?;
    state::private_directory(parent).map_err(|_| artifact_refused())?;
    let _lock = state::Lock::acquire(parent).map_err(|_| artifact_refused())?;
    retention_available(parent)?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(|_| artifact_refused())?;
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|_| artifact_refused())?;
    prepared.remaining()?;
    state::write(&root.join("input.json"), &receipt).map_err(|_| artifact_refused())?;
    Ok(receipt)
}

/// Read-only bounded provenance match. This never reacquires values or renews a delivery deadline.
/// The caller must obtain expected provenance from a fresh public compiler review.
pub fn load(
    candidate: &Candidate,
    scope: Scope<'_>,
    expected: &Review,
) -> Result<Receipt, CandidateError> {
    expected.validate(scope)?;
    let root = directory(candidate, scope)?;
    for path in root
        .ancestors()
        .take_while(|path| path.starts_with(&candidate.state_root))
    {
        state::check_private_directory(path).map_err(|_| artifact_refused())?;
    }
    match fs::symlink_metadata(root.join("input.pending")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(artifact_refused()),
    }
    // Existing state::read_bounded lacks O_NONBLOCK, so use a bounded descriptor read here
    // to refuse FIFOs/devices before any read instead of blocking on open.
    let path = root.join("input.json");
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|_| artifact_refused())?;
    let before = file.metadata().map_err(|_| artifact_refused())?;
    // SAFETY: geteuid has no preconditions.
    if !before.is_file()
        || before.len() == 0
        || before.len() > MAX_ARTIFACT_BYTES as u64
        || before.nlink() != 1
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o777 != 0o600
    {
        return Err(artifact_refused());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take((MAX_ARTIFACT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| artifact_refused())?;
    let after = file.metadata().map_err(|_| artifact_refused())?;
    let current = fs::symlink_metadata(&path).map_err(|_| artifact_refused())?;
    if bytes.len() as u64 != before.len()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
        || current.dev() != before.dev()
        || current.ino() != before.ino()
        || current.nlink() != 1
    {
        return Err(artifact_refused());
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| artifact_refused())?;
    receipt.validate(scope, expected)?;
    Ok(receipt)
}
