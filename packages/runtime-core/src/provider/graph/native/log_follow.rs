//! Native-authored read-only selection uses no foreground control request or lock.
use super::*;
use crate::provider::engine::{Observer, log_follow};
use crate::provider::graph::log_follow::{LogFollowOptions, changed, validate_state};

pub(in crate::provider::graph) fn follow_logs(
    candidate: &Candidate,
    options: &LogFollowOptions<'_>,
) -> Result<(), CandidateError> {
    let observer = Observer::connect(candidate)?;
    let read = || {
        journal::load(
            candidate,
            options.run,
            observer.incarnation(),
            observer.guest().boot_id()?,
        )
    };
    let (receipt, _) = read()?;
    let scope = receipt.review.scope();
    if receipt.owner != options.owner
        || receipt.review.review_id() != options.plan
        || scope.namespace != options.namespace
    {
        return Err(changed());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{}", options.service))
        .ok_or_else(changed)?;
    if resource.kind != Kind::Container || !receipt.readiness.contains_key(options.service) {
        return Err(changed());
    }
    let container = resource
        .id
        .as_deref()
        .filter(|id| hex(id, 64))
        .ok_or_else(changed)?;
    let state = || {
        // The pinned ID/labels remain the read authority while down advances its
        // journal. This observation grants no cleanup or replacement authority.
        match observer.get(&format!("/v1.53/containers/{container}/json")) {
            Ok(value) => {
                runtime::ownership(&receipt, resource, &value)?;
                Ok(Some(value))
            }
            Err(error) if error.code == "engine_not_found" => Ok(None),
            Err(error) => Err(error),
        }
    };
    let initial = state()?.ok_or_else(changed)?;
    let generation = initial["State"]["StartedAt"].clone();
    log_follow::follow(
        &observer,
        container,
        options.service,
        options.tail,
        options.since,
        || {
            observer.guest().verify()?;
            validate_state(state()?, &generation)
        },
    )
}
