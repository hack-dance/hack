//! Explicit legacy device-number migration for an offline stock pool.
//!
//! Old receipts have neither a host boot UUID nor a filesystem volume UUID. Calendar start
//! time, unchanged inode/size/ext4 UUID and exact paths constrain this migration, but cannot
//! establish original volume continuity. Only an explicitly accepted, hash-selected inspection
//! may update the owner. Normal runtime operations retain their strict identity comparisons.
use super::{Owner, binary, identity, lock_absent_disks, root, state};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::MetadataExt, path::Path};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Inspection {
    pub schema: &'static str,
    pub selection_sha256: String,
    pub owner_sha256: String,
    pub machine: String,
    pub host_boot_micros: u64,
    pub provider_start_micros: u64,
    pub old_device: u64,
    pub new_device: u64,
    pub pool_inode: u64,
    pub storage: identity::DiskIdentity,
    pub overlay: identity::DiskIdentity,
    pub project_share: Option<crate::provider::ProjectShareIntent>,
    pub qualification: &'static str,
}

fn refused(detail: &str) -> CandidateError {
    CandidateError::new(
        "host_filesystem_recovery",
        format!("{detail}; no identity was changed."),
    )
}

#[cfg(target_os = "macos")]
fn host_boot_micros() -> Result<u64, CandidateError> {
    let mut time = std::mem::MaybeUninit::<libc::timeval>::zeroed();
    let mut length = std::mem::size_of::<libc::timeval>();
    // SAFETY: read-only sysctl writes an exactly sized timeval; no input or retained pointers.
    if unsafe {
        libc::sysctlbyname(
            c"kern.boottime".as_ptr(),
            time.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || length != std::mem::size_of::<libc::timeval>()
    {
        return Err(refused("Native host boot time is unavailable"));
    }
    // SAFETY: a complete timeval was returned above.
    let time = unsafe { time.assume_init() };
    let seconds = u64::try_from(time.tv_sec).map_err(|_| refused("Invalid host boot time"))?;
    let micros = u64::try_from(time.tv_usec).map_err(|_| refused("Invalid host boot time"))?;
    if micros >= 1_000_000 {
        return Err(refused("Invalid host boot time"));
    }
    seconds
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(micros))
        .filter(|v| *v > 0)
        .ok_or_else(|| refused("Invalid host boot time"))
}

#[cfg(not(target_os = "macos"))]
fn host_boot_micros() -> Result<u64, CandidateError> {
    Err(CandidateError::new(
        "unsupported_host",
        "Legacy filesystem recovery requires macOS.",
    ))
}

fn no_auxiliary_update(candidate: &Candidate) -> Result<(), CandidateError> {
    crate::provider::network_update::require_complete(candidate)?;
    for name in [
        "owner.pending",
        "prepared-base.json",
        "prepared-base.json.pending",
    ] {
        match fs::symlink_metadata(root(candidate).join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                return Err(refused(
                    "Pending owner or prepared-base state requires separate recovery",
                ));
            }
        }
    }
    Ok(())
}

fn dead_provider(candidate: &Candidate, owner: &Owner, boot: u64) -> Result<(), CandidateError> {
    let process = owner
        .process
        .as_ref()
        .ok_or_else(|| refused("No recorded provider identity"))?;
    // SAFETY: geteuid has no preconditions.
    identity::verify(process, process, &binary(candidate), unsafe {
        libc::geteuid()
    })?;
    if !owner.created
        || process.start_micros >= boot
        || identity::alive(process.pid)?
        || identity::executable_running(&binary(candidate))?
    {
        return Err(refused(
            "Provider must be absent and its recorded start must predate this host boot",
        ));
    }
    Ok(())
}

fn same_disk(before: &identity::DiskIdentity, after: &identity::DiskIdentity) -> bool {
    before.device != after.device
        && before.inode == after.inode
        && before.bytes == after.bytes
        && before.uuid == after.uuid
}

/// A retained flock cannot fence a writer that opens a substituted lock pathname.
fn bound_locks(
    candidate: &Candidate,
    owner: &Owner,
    operation: &state::Lock,
    vm: &fs::File,
) -> Result<(), CandidateError> {
    let check = |path: &Path, expected: (u64, u64)| -> Result<(), CandidateError> {
        let metadata = fs::symlink_metadata(path).map_err(state::io)?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || (metadata.dev(), metadata.ino()) != expected
        {
            return Err(refused("Held lock pathname was replaced"));
        }
        Ok(())
    };
    check(
        &root(candidate).join("operation.lock"),
        operation.identity()?,
    )?;
    let metadata = vm.metadata().map_err(state::io)?;
    check(
        &owner.real_data_dir(candidate)?.join("vm.lock"),
        (metadata.dev(), metadata.ino()),
    )
}

/// Build a candidate owner in memory. This function neither adopts a new disk nor writes state.
fn selection(
    candidate: &Candidate,
    owner: &Owner,
    boot: u64,
) -> Result<(Inspection, Owner), CandidateError> {
    no_auxiliary_update(candidate)?;
    dead_provider(candidate, owner, boot)?;
    let data = owner.real_data_dir(candidate)?;
    let storage = identity::disk(&data.join("storage.raw"))?;
    let overlay = identity::disk(&data.join("overlay.raw"))?;
    let before = owner
        .storage
        .as_ref()
        .ok_or_else(|| refused("Storage identity is missing"))?;
    let prior_overlay = owner
        .overlay
        .as_ref()
        .ok_or_else(|| refused("Overlay identity is missing"))?;
    let metadata = fs::symlink_metadata(root(candidate)).map_err(state::io)?;
    if !same_disk(before, &storage)
        || !same_disk(prior_overlay, &overlay)
        || before.device != prior_overlay.device
        || storage.device != overlay.device
        || storage.device != metadata.dev()
    {
        return Err(refused(
            "Only a common device-number change with unchanged disk inode, size and UUID is accepted",
        ));
    }
    let mut next = owner.clone();
    if let Some(share) = &owner.project_share {
        let observed =
            crate::provider::ProjectShareIntent::approve(&share.project, share.unfiltered_source)?;
        let mut expected = share.clone();
        expected.device = storage.device;
        if share.device != before.device || observed != expected {
            return Err(refused(
                "Project share changed beyond the same filesystem device number",
            ));
        }
        next.project_share = Some(observed);
    }
    next.storage = Some(storage.clone());
    next.overlay = Some(overlay.clone());
    // The canonical read is bounded and validated independently of raw-byte hashing.
    let bytes = crate::provider::prepared_base::read_private(
        &root(candidate).join("owner.json"),
        1024 * 1024,
    )?;
    if Owner::load_for_short_home_recovery(candidate)? != *owner {
        return Err(refused("Owner selection changed"));
    }
    let mut inspection = Inspection {
        schema: "hack.host-filesystem-recovery/v1",
        selection_sha256: String::new(),
        owner_sha256: format!("{:x}", Sha256::digest(bytes)),
        machine: owner.machine.clone(),
        host_boot_micros: boot,
        provider_start_micros: owner
            .process
            .as_ref()
            .ok_or_else(|| refused("No process"))?
            .start_micros,
        old_device: before.device,
        new_device: storage.device,
        pool_inode: metadata.ino(),
        storage,
        overlay,
        project_share: next.project_share.clone(),
        qualification: "explicit-legacy-migration-original-volume-continuity-unproven",
    };
    inspection.selection_sha256 = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&inspection).map_err(|_| refused("Cannot encode selection"))?
        )
    );
    Ok((inspection, next))
}

/// Read-only inspection holds both existing locks and proves disks have no open handles.
pub fn inspect(candidate: &Candidate) -> Result<Inspection, CandidateError> {
    let operation = state::Lock::acquire_existing(&root(candidate))?;
    let owner = Owner::load_for_short_home_recovery(candidate)?;
    let (inspection, next) = selection(candidate, &owner, host_boot_micros()?)?;
    let vm = lock_absent_disks(candidate, &next)?;
    if selection(candidate, &owner, host_boot_micros()?)?.0 != inspection {
        return Err(refused("Inspection changed during absence verification"));
    }
    bound_locks(candidate, &owner, &operation, &vm)?;
    Ok(inspection)
}

/// Publish disk and source device changes in ONE atomic owner replacement. A crash leaves
/// old or new committed metadata; any unfinished owner.pending is preserved and blocks retry.
/// This does not launch, restore the alias, retire historical sockets, or rewrite graph receipts.
pub fn recover(candidate: &Candidate, expected: &str) -> Result<Inspection, CandidateError> {
    recover_with_boot(candidate, expected, host_boot_micros)
}

fn recover_with_boot(
    candidate: &Candidate,
    expected: &str,
    boot: impl Fn() -> Result<u64, CandidateError>,
) -> Result<Inspection, CandidateError> {
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(refused("An exact inspection SHA-256 is required"));
    }
    let operation = state::Lock::acquire_existing(&root(candidate))?;
    let owner = Owner::load_for_short_home_recovery(candidate)?;
    let (inspection, next) = selection(candidate, &owner, boot()?)?;
    if inspection.selection_sha256 != expected {
        return Err(refused("Inspection selection is stale"));
    }
    let vm = lock_absent_disks(candidate, &next)?;
    if selection(candidate, &owner, boot()?)?.0 != inspection {
        return Err(refused("Selected identities changed before publication"));
    }
    bound_locks(candidate, &owner, &operation, &vm)?;
    next.save(candidate)?;
    if Owner::load_for_short_home_recovery(candidate)? != next {
        return Err(CandidateError::new(
            "host_filesystem_recovery_incomplete",
            "Owner was published but changed during confirmation; retained state requires inspection.",
        ));
    }
    super::verify_disks(candidate, &next).map_err(|e| {
        CandidateError::new(
            "host_filesystem_recovery_incomplete",
            format!(
                "Owner was published but disk confirmation failed ({}); inspect retained state.",
                e.code
            ),
        )
    })?;
    if let Some(share) = &next.project_share {
        share.validate().map_err(|e| CandidateError::new(
            "host_filesystem_recovery_incomplete", format!("Owner was published but source confirmation failed ({}); inspect retained state.", e.code)
        ))?;
    }
    Ok(inspection)
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
