//! Fresh normalized admission; public bytes and private stdin retain separate lifetimes.
use super::{BTreeMap, Candidate, CandidateError, graph};
use serde_json::Value;
use std::time::{Duration, Instant};

pub(super) fn command(
    candidate: &Candidate,
    action: &str,
    options: graph::NormalizedRunOptions<'_>,
    singles: &BTreeMap<&str, &str>,
    route_slots: &BTreeMap<String, u8>,
    environment_stdin: bool,
) -> Result<Value, CandidateError> {
    let report = hack_runtime_core::project::plan_normalized(candidate, options.compose)?;
    if report.plan_id != options.run.expected_plan {
        return Err(CandidateError::new(
            "stale_plan",
            "Normalized graph requires its current reviewed plan ID.",
        ));
    }
    let encode = |receipt| {
        serde_json::to_value(receipt)
            .map_err(|_| CandidateError::new("graph_output", "Cannot encode graph receipt."))
    };
    if action == "run" {
        graph::compile_normalized_inputs(candidate, &options, &BTreeMap::new())?;
        return encode(graph::run_normalized(
            candidate,
            options,
            &BTreeMap::new(),
            Instant::now() + Duration::from_secs(120),
        )?);
    }
    #[cfg(target_os = "macos")]
    {
        use super::invalid;
        use std::{
            os::fd::{FromRawFd, OwnedFd},
            path::Path,
        };
        let generation = if action == "serve-restore" {
            let expected = singles
                .get("--expect-generation")
                .copied()
                .ok_or_else(invalid)?;
            if expected.len() != 64
                || !expected
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid());
            }
            let selected = graph::foreground::restore_selection(candidate, options.run.run_id)?;
            if selected["generation"] != expected
                || selected["plan"] != options.run.expected_plan
                || selected["normalized_input"]["namespace"] != report.plan.namespace
                || selected["normalized_input"]["original_compose_sha256"]
                    != options.compose.expected_compose_sha256
                || selected["normalized_input"]["normalized_compose_sha256"]
                    != report.plan.compose_sha256
            {
                return Err(invalid());
            }
            Some(expected)
        } else {
            None
        };
        let managed = if environment_stdin {
            // SAFETY: validity is checked before transferring this explicitly requested stdin descriptor.
            if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
                return Err(invalid());
            }
            // SAFETY: the receiver takes ownership once and validates descriptor type, bounds and EOF.
            Some(super::environment::receive(
                unsafe { OwnedFd::from_raw_fd(0) },
                options.run.expected_plan,
                options.run.run_id,
            )?)
        } else {
            None
        };
        let empty = BTreeMap::new();
        let values = managed.as_ref().map_or(&empty, |managed| managed.values());
        let inputs = graph::compile_normalized_inputs(candidate, &options, values)?;
        if let Some(managed) = &managed {
            managed.remaining()?;
        }
        let runtime = super::relay::runtime(
            candidate,
            Path::new(singles.get("--dependencies").copied().ok_or_else(invalid)?),
            options.run.expected_plan,
            singles
                .get("--expect-dependencies")
                .copied()
                .ok_or_else(invalid)?,
            &inputs.executable,
            options.run.run_id,
        )?;
        let deadline = managed.as_ref().map_or_else(
            || Instant::now() + Duration::from_secs(120),
            |managed| managed.deadline(),
        );
        if let Some(generation) = generation {
            encode(graph::foreground::serve_restore_normalized_with_routes(
                candidate,
                options,
                runtime,
                values,
                deadline,
                route_slots,
                generation,
            )?)
        } else {
            encode(graph::foreground::serve_normalized_with_routes(
                candidate,
                options,
                runtime,
                values,
                deadline,
                route_slots,
            )?)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (singles, route_slots, environment_stdin);
        Err(CandidateError::new(
            "unsupported_host",
            "Normalized foreground graph requires macOS.",
        ))
    }
}
