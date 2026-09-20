//! Authenticated explicit replacement of a control-only graph with fresh values.
use super::*;
use crate::provider::managed_environment;

pub(in crate::provider::graph) fn generation(receipt: &Receipt) -> Result<String, CandidateError> {
    // Receipts contain identities and phases, never environment values.
    super::super::service_exec_generation(receipt)
}
pub(in crate::provider::graph) fn check_generation(
    receipt: &Receipt,
    expected: &str,
) -> Result<(), CandidateError> {
    if !super::super::hex(expected, 64) || generation(receipt)? != expected {
        return Err(CandidateError::new(
            "graph_restore_generation",
            "The selected graph execution changed; inspect its current state before another explicit request.",
        ));
    }
    Ok(())
}
pub(super) fn options<'a>(original: &RunOptions<'a>) -> RunOptions<'a> {
    RunOptions {
        live_source: original.live_source,
        release_initializer_cache: original.release_initializer_cache.clone(),
        routing_enrolled: original.routing_enrolled,
        project: crate::project::PlanOptions {
            project: original.project.project,
            compose_file: original.project.compose_file,
            profiles: original.project.profiles,
        },
        expected_plan: original.expected_plan,
        source_revision: original.source_revision,
        non_secret_values: original.non_secret_values,
        readiness: original.readiness,
        run_id: original.run_id,
        timeout: original.timeout,
    }
}
pub(super) fn restore(
    candidate: &Candidate,
    original: &RunOptions<'_>,
    runtime: &mut HostRelayRuntime,
    request: &transport::RestoreRequest,
    effects_started: &mut bool,
) -> Result<Receipt, CandidateError> {
    if request.plan != original.expected_plan {
        return Err(refused());
    }
    let managed = managed_environment::receive_forwarded(
        request.environment.as_bytes(),
        original.expected_plan,
        original.run_id,
    )?;
    // Authentication retains the original owner plan; live execution is freshly
    // reviewed and then checked against the retained semantic source contract.
    let current_plan = if original.live_source {
        Some(crate::project::plan(
            candidate,
            crate::project::PlanOptions {
                project: original.project.project,
                compose_file: original.project.compose_file,
                profiles: original.project.profiles,
            },
        )?)
    } else {
        None
    };
    let mut replay = options(original);
    if let Some(current) = &current_plan {
        replay.expected_plan = &current.plan_id;
    }
    let (inputs, _) = super::super::compile_environment_inputs_until(
        candidate,
        &replay,
        managed.values(),
        managed.deadline(),
    )?;
    {
        let engine = Engine::connect(candidate)?;
        let (receipt, _) = super::super::load(candidate, &engine, original.run_id)?;
        check_generation(&receipt, &request.generation)?;
        if receipt.phase != "ready-observed"
            || receipt.plan_id != original.expected_plan
            || !receipt
                .relay_startup
                .as_ref()
                .is_some_and(|s| s.control_only && s.services.is_empty())
        {
            return Err(refused());
        }
        startup::Driver::verify(runtime, &engine, &receipt)?;
        super::super::source::prepare_replay(
            &engine,
            &inputs,
            &receipt,
            original.source_revision,
            original.live_source,
            original.non_secret_values,
        )?;
    }
    managed.remaining()?;
    // Recheck generation inside cleanup's engine lease. Failure retains evidence;
    // neither this helper nor the foreground error handler retries the effect.
    *effects_started = true;
    let cleaned =
        runtime.cleanup_for_restore(candidate, &request.generation, managed.deadline())?;
    if cleaned.phase != "stopped-data-retained" {
        return Err(refused());
    }
    super::super::restore::restore_with_foreground(
        candidate,
        replay,
        managed.values(),
        managed.deadline(),
        runtime,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_generation_changes_for_compute_or_cleanup_state() {
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},"resources":{}})).unwrap();
        let first = generation(&receipt).unwrap();
        check_generation(&receipt, &first).unwrap();
        assert!(check_generation(&receipt, "invalid").is_err());
        receipt.phase = "stopped-data-retained".into();
        assert_eq!(
            check_generation(&receipt, &first).unwrap_err().code,
            "graph_restore_generation"
        );
        receipt.phase = "ready-observed".into();
        receipt.owner = "e".repeat(32);
        assert!(check_generation(&receipt, &first).is_err());
    }
}
