//! `runtime up` on a pool that is already running and owned by this home.
//!
//! Every frontend `up` and `restart` calls `runtime up` before it serves the project, and on
//! a warm machine the pool is usually already running. The general start path samples host
//! admission before anything else: for Development one probe, a window of three samples one
//! second apart, the startup lease, then a second three-sample window (four one-second
//! pauses); for Research one window of three samples fifteen seconds apart (thirty seconds).
//! Each sample guards an allocation: free memory and memory pressure for the guest's memory,
//! swapout stability across the window, thermal state, and disk headroom for disks a fresh
//! pool would create or a stopped pool would reuse. A running pool allocates none of these:
//! its VM memory and disks are already held, and this start only re-verifies and reports it.
//! The general path also proved the SmolVM and engine trees by content (about 1.25 s) on every
//! call.
//!
//! This path keeps every check that still matters for a running pool and skips the rest:
//!
//! - Ownership and identity: the receipt names this home's machine, its recorded provider is
//!   alive with the receipt's PID, start time, executable and user, and both disks keep their
//!   recorded identities and declared sizes ([`select`], again under the lease).
//! - The request ([`StartRequest`]): bridges, dependency sockets, network, project share
//!   (including its live directory) and translation, checked before selection by `start_pool`
//!   and again under the lease against the receipt this path holds. The general path checks
//!   the same request under its lease with its own, stricter bindings.
//! - Pending owner updates, the owner registry and dependency sockets, as before.
//! - The provider configuration audit (`audit_boot`), as before.
//! - Provider trees: each record must name this executor's pin, and each tree (SmolVM, engine
//!   and, newly, the guest rootfs copy) must match what its boot witnessed by content, or be
//!   proven by content again (`tree_witness`). A drifted rootfs is now refused here; the
//!   general path's running branch never checked it.
//!
//! It skips the admission windows and writes no admission record. That changes behaviour in
//! one visible way: a running Research pool was sampled on the fresh-pool budget, which counts
//! the pool's own memory against the floor, so a busy host could refuse `runtime up` on a pool
//! that was already running. It is now reported like any running pool. A pool that is not
//! running, not of the requested profile, or missing its creation or disks takes the general
//! path, which is unchanged; a running pool whose provider identity does not verify is refused
//! here exactly as the general path refuses it.
use super::*;
use crate::provider::tree_witness;
use std::collections::BTreeMap;

/// A running pool of the requested profile whose provider and disks verified. Only
/// [`select`] issues it.
pub(super) struct Running {
    owner: Owner,
}

/// What a `runtime up` asks of an existing pool. Checked against the receipt by both start
/// paths: before selection, and on this path again under the lease.
#[derive(Clone, Copy)]
pub(super) struct StartRequest<'a> {
    pub(super) bridges: super::super::bridge::Request,
    pub(super) network: Option<&'a super::super::NetworkIntent>,
    pub(super) dependencies: super::super::dependency_socket::Request,
    pub(super) project_share: Option<&'a super::super::ProjectShareIntent>,
    pub(super) amd64_emulation: bool,
}

impl StartRequest<'_> {
    /// The request fits the existing pool `owner` records; nothing is resized or replaced.
    /// `project_share::check_request` also re-validates the requested share's live directory.
    pub(super) fn check(&self, owner: &Owner) -> Result<(), CandidateError> {
        check_amd64_emulation_request(owner, self.amd64_emulation)?;
        super::super::project_share::check_request(&owner.project_shares(), self.project_share)?;
        self.bridges.check(owner.application_bridge)?;
        super::super::network_intent::check_request(&owner.network, self.network)?;
        self.dependencies.check(owner.dependency_sockets)
    }
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
    request: &StartRequest<'_>,
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
    request.check(&owner)?;
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
    lease: &state::Lock,
) -> Result<(), CandidateError> {
    let process = owner.process.as_ref().ok_or_else(changed)?;
    let pins = [
        (tree_witness::SMOLVM, &artifact::SMOLVM),
        (tree_witness::ENGINE, &artifact::ENGINE),
    ];
    let metadata = pins
        .map(|(_, pin)| tree_witness::qualified_digest(&artifact::tree_root(candidate, pin), None));
    let [smolvm_metadata, engine_metadata] = metadata;
    let metadata = [smolvm_metadata?, engine_metadata?];
    let rootfs = root(candidate).join("rootfs");
    reject_aliased_state(&rootfs)?;
    let marker = rootfs_marker(owner)?;
    let rootfs_metadata = tree_witness::qualified_digest(&rootfs, Some(&marker))?;
    // Qualification shares each tree's metadata walk. If any tree crosses a filesystem
    // boundary, accept no witness and publish none, while retaining full content proofs.
    let qualified = rootfs_metadata.is_some() && metadata.iter().all(Option::is_some);
    let mut proven = BTreeMap::new();
    let mut reproven = false;
    for ((name, pin), metadata) in pins.into_iter().zip(metadata) {
        let anchor = artifact::verify_record(candidate, pin)?.tree_sha256;
        let tree = if qualified
            && let Some(metadata) = metadata
            && tree_witness::matches(candidate, process, name, &metadata, &anchor)
        {
            tree_witness::Proven {
                metadata,
                content: anchor,
            }
        } else {
            reproven = true;
            artifact::verify_witnessed(candidate, pin)?
        };
        proven.insert(name.to_owned(), tree);
    }
    let anchor = owner.rootfs_digest.clone().ok_or_else(changed)?;
    let metadata = if qualified
        && let Some(metadata) = rootfs_metadata
        && tree_witness::matches(candidate, process, tree_witness::ROOTFS, &metadata, &anchor)
    {
        metadata
    } else {
        reproven = true;
        prove_rootfs(&rootfs, &marker, Some(&anchor))?
    };
    proven.insert(
        tree_witness::ROOTFS.to_owned(),
        tree_witness::Proven {
            metadata,
            content: anchor,
        },
    );
    if reproven && qualified && super::witness_qualified(candidate) {
        // Best effort, as at boot: without a witness the next command proves by content.
        let _ = tree_witness::record(candidate, lease, process, proven);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
