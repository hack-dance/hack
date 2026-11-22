//! The provider and engine trees between their content proof and the startup lease.
//!
//! `start_pool` proves both prepared trees by content (`artifact::verify_witnessed`) before it
//! takes the startup lease, so the proof fills the admission window instead of lengthening
//! the start. Nothing fences the trees in that interval: `prepare`, `prepare_engine` and
//! `repair_tree` take the same lease, and any other writer ignores it. A tree that changed
//! after its proof would otherwise be booted from, and refused only by the next command's
//! tree check (`running_start::verify_trees`).
//!
//! [`recheck`] closes that interval with the rule a running pool's start already uses. Under
//! the lease, each tree's metadata digest (`tree_witness`) is recomputed and compared with
//! the digest its proof returned. `verify_witnessed` takes that digest before the content
//! hash and requires the same digest after it, so the proof's digest describes the tree on
//! both sides of the hash and a change made while the tree was being hashed is not missed.
//!
//! - Equal digests, an unchanged content anchor and a qualified filesystem
//!   (`tree_witness::qualified_digest`): the content proof stands. Nothing is hashed.
//! - Anything else, including a tree off a qualified filesystem: the tree is proven by
//!   content again, under the lease, and that proof replaces the earlier one. A change that
//!   kept the bytes (a touch, or a repair that reinstalled the recorded content) therefore
//!   continues; a changed byte refuses `artifact_digest_mismatch`.
//!
//! The proofs this leaves in the map are the ones a successful boot records as its witness
//! (`tree_witness::record_boot`), so the witness names what was verified under the lease.
//!
//! Limits, as for every tree check (`tree_witness`): this narrows the unfenced interval to
//! the time from this recheck to `machine start`; it does not stop a writer that ignores the
//! lease after the recheck, and the metadata comparison gives up what that module lists.
use super::*;
use crate::provider::tree_witness;
use std::collections::BTreeMap;

/// Under the startup `lease`, before anything reads or executes a prepared tree: make
/// `proven` hold, for the provider and engine trees, a content proof that describes the tree
/// as it is now. Refuses with the content proof's own error when a tree no longer matches
/// its record; nothing was started and the caller's lease is released as it unwinds.
pub(super) fn recheck(
    candidate: &Candidate,
    _lease: &state::Lock,
    proven: &mut BTreeMap<String, tree_witness::Proven>,
) -> Result<(), CandidateError> {
    let pins = [
        (tree_witness::SMOLVM, &artifact::SMOLVM),
        (tree_witness::ENGINE, &artifact::ENGINE),
    ];
    // Paths and pins before any walk, as `running_start::verify_trees`: an aliased tree
    // refuses without being followed, and a record for another pin keeps its diagnostic.
    let [smolvm_record, engine_record] =
        pins.map(|(_, pin)| artifact::verify_record(candidate, pin));
    let anchors = [smolvm_record?.tree_sha256, engine_record?.tree_sha256];
    let [smolvm_metadata, engine_metadata] = pins
        .map(|(_, pin)| tree_witness::qualified_digest(&artifact::tree_root(candidate, pin), None));
    let metadata = [smolvm_metadata?, engine_metadata?];
    // Metadata is trusted only when both trees are on a qualified filesystem; one walk gives
    // the digest and the qualification.
    let qualified = metadata.iter().all(Option::is_some);
    for (((name, pin), metadata), anchor) in pins.into_iter().zip(metadata).zip(anchors) {
        let stands = qualified
            && proven.get(name).is_some_and(|proof| {
                Some(&proof.metadata) == metadata.as_ref() && proof.content == anchor
            });
        if !stands {
            proven.insert(name.to_owned(), artifact::verify_witnessed(candidate, pin)?);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
