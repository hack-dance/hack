//! Experimental attachment reservation; automatic managed-input startup remains gated.
use super::*;
use crate::provider::{
    environment::{EnvironmentLease, PendingEnvironment},
    environment_recovery::{self, GraphBinding},
};

/// Stages a bounded environment for an existing, reserved graph container. This does not create
/// or start that container, choose a credential provider, or authorize renewal after interruption.
/// The graph and service identities are persisted in the value-free intent before guest effects.
pub fn stage_environment(
    candidate: &Candidate,
    run: &str,
    pending: PendingEnvironment,
) -> Result<EnvironmentLease, CandidateError> {
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != super::super::Profile::Development {
        return Err(error(
            "graph_profile",
            "Environment attachment requires the development VM profile.",
        ));
    }
    let (mut receipt, root) = load(candidate, &engine, run)?;
    if root.join("state.pending").symlink_metadata().is_ok() || receipt.phase != "preparing" {
        return Err(error(
            "graph_environment_phase",
            "Environment attachment requires a committed preparing graph.",
        ));
    }
    let service = pending.service();
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .filter(|r| r.kind == Kind::Container && r.phase == "reserved" && r.id.is_none())
        .ok_or_else(|| {
            error(
                "graph_environment_service",
                "Environment attachment requires its reserved graph service.",
            )
        })?;
    let existing = environment_recovery::graph_slots(candidate, engine.guest(), run)?;
    if existing.iter().any(|(_, name, _)| name == service) {
        return Err(error(
            "graph_environment_replay",
            "A recorded graph environment cannot be reallocated or renewed.",
        ));
    }
    super::super::engine::require_container_absent(engine.guest(), &resource.name)?;
    receipt.environment_attached = true;
    state::write(&root.join("state.json"), &receipt)?;
    pending.stage_bound(
        engine.guest(),
        Some(GraphBinding {
            run: run.into(),
            container: resource.name.clone(),
        }),
    )
}

pub(super) fn cleanup_slots(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<Vec<String>, CandidateError> {
    // The marker is durable before any bound intent; ordinary graphs need no intent scan.
    if !receipt.environment_attached {
        return Ok(Vec::new());
    }
    let mut slots = Vec::new();
    for (slot, service, binding) in
        environment_recovery::graph_slots(candidate, engine.guest(), &receipt.run)?
    {
        if !receipt
            .resources
            .get(&format!("container:{service}"))
            .is_some_and(|r| r.kind == Kind::Container && r.name == binding.container)
        {
            return Err(error(
                "graph_environment_identity",
                "Recorded environment does not match this graph container.",
            ));
        }
        slots.push(slot);
    }
    Ok(slots)
}

pub(super) fn require_replay_supported(receipt: &Receipt) -> Result<(), CandidateError> {
    if receipt.environment_attached {
        return Err(error(
            "graph_environment_redelivery_required",
            "Environment-bound graphs require qualified redelivery; restart, restore and export remain gated.",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests;
