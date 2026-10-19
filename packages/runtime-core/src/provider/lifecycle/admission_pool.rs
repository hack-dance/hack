//! A host-reserve disk budget is valid only for one independently verified pool whose
//! declared disks already exist: a live running pool, or an exactly clean stopped
//! Development pool that a restart reuses without `machine create`.
//!
//! Every stopped-pool refusal keeps the unchanged fresh-allocation budget, so an
//! ineligible owner is never admitted on the reserve and the later restart checks still
//! decide. The startup lease, not this module, proves exclusive provider ownership; the
//! VM-lock, open-handle and listener probes here only establish that the provider the
//! receipt names released its machine.
use super::{
    Owner, admission, binary, io, lock_absent_disks, root, sockets_absent, verify_disk_allocation,
    verify_disks, verify_live,
};
use crate::provider::identity;
use crate::{Candidate, CandidateError};
use serde_json::Value;
use std::fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Basis {
    Running,
    Stopped,
}

pub(super) struct Selection {
    owner: Owner,
    basis: Basis,
}

/// Closed reasons a stopped Development owner cannot use the host-reserve budget.
/// Codes are fixed labels without paths, identities or provider output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StoppedRefusal {
    /// The receipt names another machine, executable, user or unsafe VM lock.
    Foreign,
    /// A provider process, VM lock holder, disk handle or listener may remain.
    Active,
    /// The last stop was interrupted, unclean, unquiesced, or an owner update is pending.
    Dirty,
    /// Creation, disk identities, sizes, rootfs or boot identity are missing or drifted.
    Stale,
}

impl StoppedRefusal {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Foreign => "retained_reserve_foreign_owner",
            Self::Active => "retained_reserve_active_owner",
            Self::Dirty => "retained_reserve_dirty_owner",
            Self::Stale => "retained_reserve_stale_owner",
        }
    }

    fn error(self) -> CandidateError {
        CandidateError::new(
            self.code(),
            "Stopped development ownership is not exactly clean; the retained-disk host reserve was not admitted.",
        )
    }

    /// Classify a lifecycle verification failure into a closed refusal. Missing, replaced
    /// or mis-sized state is stale; any other failure, including an absence probe that
    /// could not complete (for example a slow `lsof`), leaves the provider possibly active.
    fn from_check(error: &CandidateError) -> Self {
        match error.code {
            "foreign_state" => Self::Foreign,
            "provider_state" | "disk_identity_mismatch" | "disk_allocation_mismatch" => Self::Stale,
            _ => Self::Active,
        }
    }
}

pub(super) fn select(
    candidate: &Candidate,
    profile: crate::provider::Profile,
) -> Result<Option<Selection>, CandidateError> {
    if profile != crate::provider::Profile::Development {
        return Ok(None);
    }
    match fs::symlink_metadata(root(candidate).join("owner.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(e)),
        Ok(_) => {}
    }
    let owner = Owner::load(candidate)?;
    if owner.profile != profile {
        return Ok(None);
    }
    if owner.phase != "running" {
        return Ok(stopped(candidate, &owner).ok().map(|()| Selection {
            owner,
            basis: Basis::Stopped,
        }));
    }
    if !owner.created || owner.storage.is_none() || owner.overlay.is_none() {
        return Err(changed());
    }
    verify_live(candidate, &owner)?;
    verify_disk_allocation(
        owner.storage.as_ref().unwrap(),
        owner.overlay.as_ref().unwrap(),
        profile,
    )?;
    Ok(Some(Selection {
        owner,
        basis: Basis::Running,
    }))
}

/// Whether `owner` is an exactly clean stopped Development pool with its retained disks.
///
/// Clean means the receipt reached `stopped` through a quiesced stop of its last boot:
/// interrupted, unclean, before-engine or failed-boot stops never qualify, even when a
/// later refused start rewrote the phase. Read-only; it never repairs or adopts state.
pub(super) fn stopped(candidate: &Candidate, owner: &Owner) -> Result<(), StoppedRefusal> {
    if owner.profile != crate::provider::Profile::Development {
        return Err(StoppedRefusal::Foreign);
    }
    match fs::symlink_metadata(root(candidate).join("owner.pending")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(StoppedRefusal::Dirty),
    }
    if owner.phase != "stopped" {
        return Err(StoppedRefusal::Dirty);
    }
    let (Some(storage), Some(overlay), Some(process), Some(boot), Some(daemon), Some(start)) = (
        owner.storage.as_ref(),
        owner.overlay.as_ref(),
        owner.process.as_ref(),
        owner.guest_boot_id.as_deref(),
        owner.daemon_pid,
        owner.daemon_start,
    ) else {
        return Err(StoppedRefusal::Stale);
    };
    if !owner.created || owner.rootfs_digest.is_none() {
        return Err(StoppedRefusal::Stale);
    }
    // Only `down` writes this receipt, after the guest engine quiesced in this boot.
    let quiesced = crate::provider::state::read::<Value>(&root(candidate).join("quiescence.json"))
        .ok()
        .is_some_and(|receipt| {
            receipt["guest_boot_id"].as_str() == Some(boot)
                && receipt["daemon_pid"].as_u64() == Some(u64::from(daemon))
                && receipt["daemon_start"].as_u64() == Some(start)
                && receipt["result"]
                    .as_str()
                    .is_some_and(|result| result.starts_with("quiesced"))
        });
    if !quiesced {
        return Err(StoppedRefusal::Dirty);
    }
    if process.executable != binary(candidate) || process.uid != unsafe { libc::geteuid() } {
        return Err(StoppedRefusal::Foreign);
    }
    // A live or unobservable recorded PID (including reuse) is never proven absent.
    if identity::alive(process.pid).unwrap_or(true) {
        return Err(StoppedRefusal::Active);
    }
    verify_disks(candidate, owner).map_err(|error| StoppedRefusal::from_check(&error))?;
    verify_disk_allocation(storage, overlay, owner.profile)
        .map_err(|error| StoppedRefusal::from_check(&error))?;
    // The VM lock guard is released on return; the provider's own start reacquires it.
    lock_absent_disks(candidate, owner).map_err(|error| StoppedRefusal::from_check(&error))?;
    sockets_absent(owner).map_err(|error| StoppedRefusal::from_check(&error))
}

fn changed() -> CandidateError {
    CandidateError::new(
        "admission_owner_changed",
        "Verified admission ownership changed; no create or boot was admitted.",
    )
}

impl Selection {
    pub(super) fn is_stopped(&self) -> bool {
        self.basis == Basis::Stopped
    }

    /// The selected receipt is unchanged and its basis is still independently proven.
    pub(super) fn reverify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let current = Owner::load(candidate)?;
        if current != self.owner {
            return Err(changed());
        }
        match self.basis {
            Basis::Stopped => stopped(candidate, &current).map_err(StoppedRefusal::error),
            Basis::Running => {
                if current.phase != "running" {
                    return Err(changed());
                }
                verify_live(candidate, &current)?;
                verify_disk_allocation(
                    current.storage.as_ref().ok_or_else(changed)?,
                    current.overlay.as_ref().ok_or_else(changed)?,
                    current.profile,
                )
            }
        }
    }
}

pub(super) fn probe(
    candidate: &Candidate,
    profile: crate::provider::Profile,
    selected: Option<&Selection>,
) -> Result<admission::Admission, CandidateError> {
    match selected {
        None => admission::probe_for(&candidate.checkout, profile),
        Some(selected) => {
            selected.reverify(candidate)?;
            let observed = admission::probe_owned_development(
                &candidate.checkout,
                match selected.basis {
                    Basis::Running => admission::OwnedPool::Running,
                    Basis::Stopped => admission::OwnedPool::Stopped,
                },
            )?;
            selected.reverify(candidate)?;
            Ok(observed)
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
