//! `runtime up` on a pool that is already running and owned by this home.
//!
//! Every frontend `up` and `restart` calls `runtime up` before it serves the project, and on
//! a warm machine the pool is usually already running. The general start path samples host
//! admission before it acquires the startup lease and again after it: two windows of three
//! samples one second apart (Research: fifteen), four seconds of sleep per call. Each window
//! guards an allocation: free memory and memory pressure for the guest's memory, swapout
//! stability across the window, thermal state, and disk headroom for disks a fresh pool
//! would create or a stopped pool would reuse. A running pool allocates none of these. Its
//! VM memory and disks are already held; this start only re-verifies and reports it. The
//! general path also proved the SmolVM and engine trees by content, about 1.25 s, on every
//! call.
//!
//! This path keeps every check that still matters for a running pool and skips the rest:
//!
//! - Ownership and identity: the receipt names this home's machine, its recorded provider is
//!   alive with the receipt's PID, start time, executable and user, and both disks keep their
//!   recorded identities and declared sizes ([`select`], again under the lease).
//! - The request: the bridge, dependency socket, network, project share, profile and
//!   translation checks in `start_pool` run before this path and are bound to the receipt,
//!   which must be unchanged under the lease.
//! - Pending owner updates, the owner registry and dependency sockets, as before.
//! - The provider configuration audit (`audit_boot`), as before.
//! - Provider trees: the record must name this executor's pin, and each tree must match the
//!   metadata digest its boot witnessed by content, or it is proven by content again
//!   (`tree_witness`). The guest rootfs copy is checked the same way.
//!
//! It skips the admission windows and writes no admission record. A pool that is not
//! running, not of the requested profile, or missing its creation or disks takes the general
//! path, which is unchanged; a running pool whose provider identity does not verify is
//! refused here exactly as the general path refuses it.
use super::*;
use crate::provider::tree_witness;
use std::collections::BTreeMap;

/// A running pool of the requested profile whose provider and disks verified. Only
/// [`select`] issues it.
pub(super) struct Running {
    owner: Owner,
}

fn changed() -> CandidateError {
    CandidateError::new(
        "runtime_changed",
        "The running pool changed before the operation lock; nothing was started.",
    )
}

/// `Some` when this home's receipt records a running, created pool of `profile` with both
/// disks, and its recorded provider and disks verify. A pool in any other state is `None`
/// and takes the general start path. A running pool whose provider identity or disks do not
/// verify is refused with that verification's error, as the general path refuses it.
pub(super) fn select(
    candidate: &Candidate,
    profile: super::super::Profile,
) -> Result<Option<Running>, CandidateError> {
    reject_aliased_state(&root(candidate))?;
    match fs::symlink_metadata(root(candidate).join("owner.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io(error)),
        Ok(_) => {}
    }
    let owner = Owner::load(candidate)?;
    if !eligible(&owner, profile) {
        return Ok(None);
    }
    verify_running(candidate, &owner)?;
    Ok(Some(Running { owner }))
}

/// The receipt states that take this path: running, created, of the requested profile, with
/// a recorded provider and both disks. Everything else takes the general path.
fn eligible(owner: &Owner, profile: super::super::Profile) -> bool {
    owner.phase == "running"
        && owner.profile == profile
        && owner.created
        && owner.process.is_some()
        && owner.storage.is_some()
        && owner.overlay.is_some()
}

fn verify_running(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    verify_live(candidate, owner)?;
    verify_disk_allocation(
        owner.storage.as_ref().ok_or_else(changed)?,
        owner.overlay.as_ref().ok_or_else(changed)?,
        owner.profile,
    )
}

/// Re-verify a selected running pool under the startup lease and report it.
/// `verify_retained` rechecks a retained-startup guard, if the caller holds one.
pub(super) fn resume(
    candidate: &Candidate,
    running: Running,
    verify_retained: impl Fn() -> Result<(), CandidateError>,
) -> Result<RuntimeStatus, CandidateError> {
    let lock = startup_lease(&root(candidate), STARTUP_LEASE_WAIT)?;
    restore_released_short_home(candidate)?;
    verify_retained()?;
    super::super::network_update::require_complete(candidate)?;
    super::super::share_update::require_complete(candidate)?;
    let owner = Owner::load(candidate)?;
    if owner != running.owner {
        return Err(changed());
    }
    verify_running(candidate, &owner)?;
    super::super::graph::verify_owner_registry(candidate, &owner)?;
    super::super::dependency_socket::verify(candidate, &owner)?;
    verify_trees(candidate, &owner, &lock)?;
    super::super::network_tools::verify(candidate)?;
    verify_retained()?;
    audit_boot(candidate, &owner)?;
    status(candidate)
}

/// Provider trees of a running pool: the cheap witness check, or a content proof that then
/// refreshes the witness for this provider process under the lease.
fn verify_trees(
    candidate: &Candidate,
    owner: &Owner,
    _lease: &state::Lock,
) -> Result<(), CandidateError> {
    let process = owner.process.as_ref().ok_or_else(changed)?;
    let mut proven = BTreeMap::new();
    let mut reproven = false;
    for (name, pin) in [
        (tree_witness::SMOLVM, &artifact::SMOLVM),
        (tree_witness::ENGINE, &artifact::ENGINE),
    ] {
        artifact::verify_record(candidate, pin)?;
        let current = artifact::tree_metadata(candidate, pin)?;
        let digest = if tree_witness::matches(candidate, process, name, &current) {
            current
        } else {
            reproven = true;
            artifact::verify_witnessed(candidate, pin)?
        };
        proven.insert(name.to_owned(), digest);
    }
    let rootfs = root(candidate).join("rootfs");
    reject_aliased_state(&rootfs)?;
    let marker = rootfs_marker(owner)?;
    let current = tree_witness::metadata_digest(&rootfs, Some(&marker))?;
    let digest = if tree_witness::matches(candidate, process, tree_witness::ROOTFS, &current) {
        current
    } else {
        reproven = true;
        prove_rootfs(&rootfs, &marker, owner.rootfs_digest.as_deref())?
    };
    proven.insert(tree_witness::ROOTFS.to_owned(), digest);
    if reproven {
        tree_witness::record(candidate, process, proven)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
