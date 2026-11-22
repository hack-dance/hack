use super::state::{self, Owner};
use crate::{Candidate, CandidateError, reject_aliased_state};
use serde_json::Value;

/// Observe reservation counts without changing any pool or graph records.
pub fn socket_usage(candidate: &Candidate) -> Result<Value, CandidateError> {
    let pool = candidate.state_root.join("run/smolvm");
    reject_aliased_state(&pool)?;
    let _lease = state::Lock::acquire(&pool)?;
    let owner = Owner::load(candidate)?;
    let bridges = super::graph::bridges::socket_counts(candidate, &owner)?;
    #[cfg(target_os = "macos")]
    let dependencies = super::graph::dependency_slots::socket_counts(candidate, &owner)?;
    #[cfg(not(target_os = "macos"))]
    let dependencies = std::collections::BTreeMap::<String, usize>::new();
    let runs = bridges
        .keys()
        .chain(dependencies.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let reservations = runs
        .into_iter()
        .map(|run| {
            serde_json::json!({
                "run": run,
                "bridges": bridges.get(run).copied().unwrap_or_default(),
                "dependencies": dependencies.get(run).copied().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "bridges": owner.application_bridge.map_or(0, |intent| intent.slots),
        "dependencies": owner.dependency_sockets.map_or(0, |intent| intent.slots),
        "reservations": reservations,
    }))
}
