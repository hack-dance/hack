//! The guest completion commit precedes dependency release. Publisher retirement
//! must finish this tail too, including after its own paths have been renamed.
//! Every caller must first complete real publication retirement: missing active
//! paths alone grant no authority, and a missing retirement journal refuses.
use super::*;
use crate::provider::graph::host_pin_recovery::{self, Witness};

pub(super) fn finish(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    intent: &Intent,
    legacy: Option<&Witness>,
) -> Result<(), CandidateError> {
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    let retired =
        foreground::transport::Retired::acquire(candidate, &receipt.run)?.ok_or_else(refused)?;
    let verify_retired = || {
        engine.guest().verify()?;
        let (current, root) = load(candidate, engine, &receipt.run)?;
        if selected(&current)? != complete || !current_completed_precedence(&root, &current)? {
            return Err(refused());
        }
        if let Some(enrollment) = &intent.enrollment {
            enrollment.verify_raw(&intent.original)?;
        }
        retired.verify_recovery_with_rebind(
            candidate,
            &receipt.run,
            &intent.owner_sha256,
            complete,
            legacy.map(Witness::rebind),
        )
    };
    verify_retired()?;
    let process = retired.publisher_process_with_rebind(
        candidate,
        &receipt.run,
        &intent.owner_sha256,
        complete,
        legacy.map(Witness::rebind),
    )?;
    // A legacy device translation is authority only with its original full
    // cleanup guard, exact reservation bytes and current host/provider proof.
    let guard = if dependency_slots::reservation_recorded(candidate, &receipt.run)? {
        legacy
            .map(|witness| {
                host_pin_recovery::acquire_for_cleanup(
                    candidate,
                    &receipt.run,
                    engine,
                    host_pin_recovery::CleanupProof {
                        original: &intent.original,
                        sha256: &intent.original_sha256,
                        current_is_original: false,
                        allow_absent_reservation: true,
                        publisher_may_be_partial: true,
                    },
                    witness.clone(),
                )
            })
            .transpose()?
    } else {
        None
    };
    dependency_slots::recover_cleaned_fenced(
        candidate,
        receipt,
        &process,
        guard.as_ref().and_then(|guard| {
            guard
                .witness()
                .reservation()
                .map(|reservation| (guard.witness().rebind(), reservation))
        }),
        &|| {
            verify_retired()?;
            if let Some(guard) = &guard {
                guard.verify_lock()?;
            }
            Ok(())
        },
    )
}
