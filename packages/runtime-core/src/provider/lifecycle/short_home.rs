//! Explicit two-phase recovery of the receipt-bound temporary HOME after host cleanup.
//!
//! No provider is launched and no existing alias is replaced. Durable disks and VM absence
//! are audited before restoring the short socket path; socket absence is then checked before
//! committing the recovered phase. A later refusal retains the exact alias and unchanged data.
use super::{
    Owner, RuntimeStatus, binary, finish_absent_locked, identity, lock_absent_disks, root, state,
    status, verify_disks,
};
use crate::{Candidate, CandidateError};

fn dead_provider(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    let process = owner.process.as_ref().ok_or_else(|| {
        CandidateError::new(
            "recovery_required",
            "Missing HOME recovery requires a recorded provider identity; nothing was changed.",
        )
    })?;
    // SAFETY: geteuid has no preconditions.
    identity::verify(process, process, &binary(candidate), unsafe {
        libc::geteuid()
    })?;
    if identity::alive(process.pid)? || identity::executable_running(&binary(candidate))? {
        return Err(CandidateError::new(
            "recovery_required",
            "Missing HOME recovery requires a confirmed dead provider and no active provider command; nothing was changed.",
        ));
    }
    if !owner.created || owner.storage.is_none() || owner.overlay.is_none() {
        return Err(CandidateError::new(
            "recovery_required",
            "Missing HOME recovery requires both previously identified disks; nothing was adopted.",
        ));
    }
    Ok(())
}

pub(super) fn recover(candidate: &Candidate) -> Result<RuntimeStatus, CandidateError> {
    let _operation = state::Lock::acquire_existing(&root(candidate))?;
    let mut owner = Owner::load_for_short_home_recovery(candidate)?;
    dead_provider(candidate, &owner)?;
    let vm_lock = lock_absent_disks(candidate, &owner)?;
    // Recheck immediately before the only new external effect. The locks fence cooperative
    // writers; no signal, disk adoption, overwrite or receipt update happens in this phase.
    dead_provider(candidate, &owner)?;
    verify_disks(candidate, &owner)?;
    owner.restore_missing_short_home(candidate)?;
    let mut finish = || -> Result<(), CandidateError> {
        let observed = Owner::load(candidate)?;
        if observed != owner {
            return Err(CandidateError::new(
                "foreign_state",
                "Provider receipt changed after HOME restoration.",
            ));
        }
        dead_provider(candidate, &owner)?;
        verify_disks(candidate, &owner)?;
        finish_absent_locked(candidate, &mut owner, "recovered-unclean", false, &vm_lock)
    };
    finish().map_err(|error| {
        CandidateError::new(
            "provider_home_restored_recovery_incomplete",
            format!("Owned HOME alias restored; runtime recovery is incomplete ({}). Data retained; inspect and retry runtime recover.", error.code),
        )
    })?;
    status(candidate)
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
