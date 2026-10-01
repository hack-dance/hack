//! A host-reserve budget is valid only for one independently verified live pool.
use super::{Owner, admission, io, root, verify_disk_allocation, verify_live};
use crate::{Candidate, CandidateError};
use std::fs;

pub(super) struct Selection(Owner);

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
    if owner.profile != profile || owner.phase != "running" {
        return Ok(None);
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
    Ok(Some(Selection(owner)))
}

fn changed() -> CandidateError {
    CandidateError::new(
        "admission_owner_changed",
        "Verified live admission ownership changed; no create or boot was admitted.",
    )
}

impl Selection {
    pub(super) fn reverify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let current = Owner::load(candidate)?;
        if current != self.0 || current.phase != "running" {
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

pub(super) fn probe(
    candidate: &Candidate,
    profile: crate::provider::Profile,
    selected: Option<&Selection>,
) -> Result<admission::Admission, CandidateError> {
    match selected {
        None => admission::probe_for(&candidate.checkout, profile),
        Some(selected) => {
            selected.reverify(candidate)?;
            let observed = admission::probe_owned_development(&candidate.checkout)?;
            selected.reverify(candidate)?;
            Ok(observed)
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
