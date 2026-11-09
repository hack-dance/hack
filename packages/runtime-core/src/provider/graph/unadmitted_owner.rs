//! Retire a retained restore whose foreground owner died before admission.
//!
//! A fresh retained restore publishes its foreground owner (`owner.json`,
//! `control.sock`) and, before that, starts its relay owner and may reserve
//! dependency transports. Its first durable graph write (the `restoring`
//! receipt with its startup enrollment) is admission. An owner that dies before
//! that write leaves the acknowledged `stopped-data-retained` receipt exactly as
//! it was, so every guest resource is still the retained stop's. Retirement is
//! the same thing the owner itself does when its own pre-admission attempt
//! fails: release what it published and keep the data.
//!
//! Authority comes only from these held proofs, each rechecked before every
//! effect: the publication gate and provider lease (no concurrent start,
//! restore or recovery), the held publication lock of the exact dead owner
//! record with no listener, the caller-selected digest of the unchanged receipt,
//! and the full offline retained-start eligibility of that receipt. The relay
//! publication and dependency reservation are released only when they name
//! that same dead process. Nothing in the guest is stopped, created or removed.
use super::*;
use crate::provider::{identity::ProcessIdentity, lifecycle, relay_owner::publication::dead};
use sha2::{Digest, Sha256};
use std::path::Path;

fn refused() -> CandidateError {
    error(
        "graph_unadmitted_owner_recovery",
        "Retiring an unadmitted foreground owner requires the unchanged acknowledged retained receipt, a dead owner with its publication lock held, and relay and reservation records of that same process; evidence and data were retained.",
    )
}

fn present(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(refused()),
    }
}

/// The retained-start eligibility of `run`, bound to the exact receipt bytes the
/// caller selected. Recomputed at every effect boundary.
fn verify_receipt(candidate: &Candidate, run: &str, expected: &str) -> Result<(), CandidateError> {
    let (_, receipt) = retained_startup::checked(candidate, run).map_err(|_| refused())?;
    let root = directory(candidate, run)?;
    let bytes = host_pin_recovery::read_raw(&root.join("state.json"), 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected
        || receipt.phase != "stopped-data-retained"
        || receipt.normalized_input.is_none()
        || live_owner_cleanup::resumable_selection(candidate, &root, &receipt, true)?.is_some()
    {
        return Err(refused());
    }
    Ok(())
}

/// The relay owner publication the dead foreground process bound at its
/// run-scoped control root for the current boot. Selection only.
struct Relay {
    root: PathBuf,
    context: crate::provider::relay_owner::Context,
    selected: dead::Selection,
    lock: (u64, u64),
}
fn select_relay(
    candidate: &Candidate,
    run: &str,
    process: &ProcessIdentity,
) -> Result<Option<Relay>, CandidateError> {
    let owner = state::Owner::load(candidate)?;
    let boot = owner
        .guest_boot_id
        .as_deref()
        .filter(|boot| !boot.is_empty())
        .ok_or_else(refused)?;
    let root = startup::control_root(&candidate.state_root, &owner.token, Some(boot), Some(run))?;
    let control = root.join("relay-control");
    if !present(&control.join("owner.json"))? && !present(&control.join("control.sock"))? {
        return Ok(None);
    }
    let context = host_relay::context(&owner.token, boot)?;
    let witness = dead::CleanupWitness::acquire(&root, context, process).map_err(|_| refused())?;
    let (Some(selected), lock) = (witness.present_selection(), witness.lock_identity()?) else {
        return Err(refused());
    };
    witness.verify().map_err(|_| refused())?;
    Ok(Some(Relay {
        root,
        context,
        selected,
        lock,
    }))
}

/// `hack down --recover` for a retained run whose foreground owner died before
/// its restore was admitted. `expected` is the SHA-256 of the exact receipt
/// bytes the caller observed (`graph foreground-owner`). Retains all data.
pub fn retire_unadmitted_owner(
    candidate: &Candidate,
    run: &str,
    expected: &str,
) -> Result<Value, CandidateError> {
    if !hex(run, 32) || !hex(expected, 64) {
        return Err(refused());
    }
    // Gate before lease, as recovery orders them: no relay admission or new
    // publication starts while this runs; no graph operation holds the lease.
    let gate = publication_gate::Guard::acquire(candidate)?;
    let _lease = state::Lock::acquire_existing_waiting(
        &candidate.state_root.join("run/smolvm"),
        lifecycle::STARTUP_LEASE_WAIT,
    )?;
    let verify = || {
        gate.verify(candidate)?;
        verify_receipt(candidate, run, expected)
    };
    verify()?;
    let Ok(foreground) = foreground::DeadOwner::acquire(candidate, run) else {
        // Only an exact journaled retirement interrupted between its two renames
        // resumes here; every other partial or live publication is refused.
        foreground::transport::resume_recovered_publisher(candidate, run, expected, &verify)
            .map_err(|_| refused())?;
        return Ok(retired(run, false, false));
    };
    foreground
        .verify_retirement_ready()
        .map_err(|_| refused())?;
    let process = foreground.process().clone();
    let fenced = || {
        foreground.verify_retirement_ready()?;
        verify()
    };
    // Select and prove everything before the first effect.
    let relay = select_relay(candidate, run, &process)?;
    dependency_slots::unadmitted_reservation(candidate, run, &process)?;
    fenced()?;
    if let Some(relay) = &relay {
        // The retirement reacquires the control lock, pinned by its identity.
        dead::retire_checked(
            &relay.root,
            relay.context,
            &relay.selected,
            Some(relay.lock),
            &fenced,
        )
        .map_err(|_| refused())?;
    }
    fenced()?;
    let reservation = dependency_slots::recover_unadmitted(candidate, run, &process)?;
    fenced()?;
    // Last: until it is retired the publication keeps this state discoverable
    // and its held lock excludes a new owner of the run.
    foreground
        .retire(candidate, run, expected, &verify)
        .map_err(|_| refused())?;
    verify()?;
    Ok(retired(run, relay.is_some(), reservation))
}

fn retired(run: &str, relay: bool, reservation: bool) -> Value {
    json!({"version":1,"run":run,"phase":"stopped-data-retained","recovered":true,
        "data_retained":true,"publisher_retired":true,"relay_retired":relay,
        "dependency_reservation_released":reservation})
}

/// Bind a relay owner publication for `run` as a foreground restore owner does
/// before it publishes, owned by this process until it exits.
#[cfg(test)]
pub(in crate::provider::graph) fn fixture_relay_publication(
    candidate: &Candidate,
    run: &str,
) -> crate::provider::relay_owner::publication::ControlListener {
    let owner = state::Owner::load(candidate).unwrap();
    let boot = owner.guest_boot_id.clone().unwrap();
    let root =
        startup::control_root(&candidate.state_root, &owner.token, Some(&boot), Some(run)).unwrap();
    state::private_directory(&root).unwrap();
    let mut relay = crate::provider::relay_owner::RelayOwner::new(
        host_relay::context(&owner.token, &boot).unwrap(),
        crate::provider::relay_owner::OwnerLimits {
            registrations: 2,
            controls: 2,
            relay: crate::provider::relay_loop::Limits {
                max_flows: 2,
                connect_timeout: std::time::Duration::from_secs(1),
                idle_timeout: std::time::Duration::from_secs(2),
            },
        },
    )
    .unwrap();
    crate::provider::relay_owner::publication::ControlListener::bind(&root, &mut relay).unwrap()
}

#[cfg(test)]
mod tests;
