//! Explicit foreground lifetime; discovery is not authority to recover a dead owner.
use super::{Candidate, CandidateError, Engine, HostRelayRuntime, Receipt, RunOptions, startup};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Write,
    time::{Duration, Instant},
};
#[cfg(all(test, feature = "environment-launcher"))]
mod native_test;
mod publishers;
pub(in crate::provider::graph) mod redelivery;
mod retained_data;
mod signals;
#[cfg(test)]
mod tests;
mod transport;
use transport::{Publication, WireRequest};
fn refused() -> CandidateError {
    CandidateError::new(
        "graph_owner_recovery",
        "Foreground graph owner unavailable or uncertain; explicit recovery is required.",
    )
}
// Only this process's never-admitted attempt may discard its publication without
// guest cleanup. Any graph path (including a symlink) preserves recovery evidence.
fn finish_before_admission(
    publication: &mut Publication,
    candidate: &Candidate,
    run: &str,
    admitted: bool,
) -> Result<bool, CandidateError> {
    if admitted {
        return Ok(false);
    }
    match std::fs::symlink_metadata(super::directory(candidate, run)?) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            publication.finish()?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}
/// Runs startup and retains the relay runtime until authenticated local cleanup or
/// TERM/INT. A ready line is listener/application startup evidence, not daemonization.
/// Caller must keep this foreground process supervised; no detached child is spawned.
pub fn serve(
    candidate: &Candidate,
    options: RunOptions<'_>,
    runtime: HostRelayRuntime,
) -> Result<Receipt, CandidateError> {
    serve_with_environment(
        candidate,
        options,
        runtime,
        &BTreeMap::new(),
        Instant::now() + Duration::from_secs(120),
    )
}
/// Explicit in-memory delivery with an ingress-anchored deadline. Expiry prevents
/// new delivery/exec; it does not revoke environment already held by an application.
pub fn serve_with_environment(
    candidate: &Candidate,
    options: RunOptions<'_>,
    runtime: HostRelayRuntime,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: Instant,
) -> Result<Receipt, CandidateError> {
    serve_with_routes(
        candidate,
        options,
        runtime,
        managed,
        deadline,
        &BTreeMap::new(),
    )
}
/// Explicit route slots belong to this foreground owner; publication readiness is
/// additional to application readiness. TLS is provided by a separate authority.
pub fn serve_with_routes(
    candidate: &Candidate,
    options: RunOptions<'_>,
    mut runtime: HostRelayRuntime,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: Instant,
    route_slots: &BTreeMap<String, u8>,
) -> Result<Receipt, CandidateError> {
    if options.routing_enrolled != !route_slots.is_empty() {
        return Err(refused());
    }
    if !managed.is_empty() {
        // Refuse invalid scoped ownership or payload before publishing an owner.
        // Runtime admission compiles again to detect intervening project changes.
        super::compile_environment_inputs_until(candidate, &options, managed, deadline)?;
    }
    let run_id = options.run_id.to_owned();
    let mut publication = Publication::bind(candidate, options.run_id)?;
    let signals = match signals::Events::new(&publication) {
        Ok(signals) => signals,
        Err(error) => {
            finish_before_admission(&mut publication, candidate, &run_id, false)?;
            return Err(error);
        }
    };
    runtime.set_startup_cancellation(Some(signals::startup_pending));
    let attempt = super::run_with_host_dependencies_until(
        candidate,
        redelivery::options(&options),
        &mut runtime,
        managed,
        deadline,
    );
    runtime.set_startup_cancellation(None);
    let receipt = match attempt {
        Ok(receipt) => receipt,
        Err(error) => {
            if !finish_before_admission(
                &mut publication,
                candidate,
                &run_id,
                runtime.admission_started(),
            )? && runtime.cleanup(candidate, false).is_ok()
            {
                publication.finish()?;
            }
            return Err(error);
        }
    };
    let mut publishers = publishers::Publishers::default();
    let mut cleanup_attempted = false;
    let mut restore_recovery_error = None;
    let result = (|| {
        if signals.pending() {
            cleanup_attempted = true;
            return runtime.cleanup(candidate, false);
        }
        publishers.start(candidate, &receipt, &signals, deadline, route_slots)?;
        let ready =
            json!({"kind":"graph_foreground_ready","run":receipt.run,"phase":receipt.phase});
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &ready).map_err(|_| refused())?;
        writeln!(stdout)
            .and_then(|_| stdout.flush())
            .map_err(|_| refused())?;
        drop(stdout);
        loop {
            if signals.wait()? {
                cleanup_attempted = true;
                return runtime.cleanup(candidate, false);
            }
            let Some(mut stream) = publication.accept()? else {
                continue;
            };
            let request: WireRequest = match transport::read(
                &mut stream,
                Duration::from_secs(5),
                transport::REQUEST_LIMIT,
            ) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if request.version != 1 || request.run != receipt.run {
                continue;
            }
            publication.verify()?;
            if let Some(restore) = request.restore {
                if request.remove_data.is_some() {
                    continue;
                }
                let mut effects_started = false;
                let restored = redelivery::restore(
                    candidate,
                    &options,
                    &mut runtime,
                    &restore,
                    &mut effects_started,
                )
                .and_then(|restored| {
                    publishers
                        .reap_after_cleanup(&signals, Instant::now() + Duration::from_secs(5))?;
                    cleanup_attempted = false;
                    publishers.start(
                        candidate,
                        &restored,
                        &signals,
                        Instant::now() + options.timeout.min(Duration::from_secs(120)),
                        route_slots,
                    )?;
                    Ok(restored)
                });
                let response = match restored {
                    Ok(restored) => {
                        restore_recovery_error = None;
                        json!({"ok":true,"run":restored.run,"phase":restored.phase,"plan":restored.plan_id,"generation":redelivery::generation(&restored)?,"receipt":restored})
                    }
                    Err(error) => {
                        cleanup_attempted |= effects_started;
                        if effects_started {
                            restore_recovery_error = Some(error.code);
                        }
                        let current = super::inspect(candidate, &receipt.run).ok();
                        json!({"ok":false,"run":receipt.run,"code":error.code,"phase":current.as_ref().map(|snapshot| &snapshot.receipt.phase),"recovery_required":effects_started})
                    }
                };
                let _ = transport::write(&mut stream, &response, Duration::from_secs(5));
                continue;
            }
            if let Some(remove_data) = request.remove_data {
                cleanup_attempted = true;
                match runtime.cleanup(candidate, remove_data) {
                    Ok(cleaned) => {
                        publishers.reap_after_cleanup(
                            &signals,
                            Instant::now() + Duration::from_secs(5),
                        )?;
                        // A lost reply cannot undo cleanup; completion is also returned to
                        // the foreground caller and retained in the graph journal.
                        let _ = transport::write(
                            &mut stream,
                            &json!({"ok":true,"run":cleaned.run,"phase":cleaned.phase,"receipt":cleaned}),
                            Duration::from_secs(5),
                        );
                        return Ok(cleaned);
                    }
                    Err(error) => {
                        let _ = transport::write(
                            &mut stream,
                            &json!({"ok":false,"code":error.code}),
                            Duration::from_secs(5),
                        );
                        continue;
                    }
                }
            }
            let status = (|| {
                if let Some(code) = restore_recovery_error {
                    return Ok(
                        json!({"ok":false,"run":receipt.run,"code":code,"foreground_alive":true,"recovery_required":true}),
                    );
                }
                // inspect releases its Engine lease before the fresh runtime check.
                publishers.verify_live(candidate)?;
                let snapshot = super::inspect(candidate, &receipt.run)?;
                let engine = Engine::connect(candidate)?;
                let checked = startup::Driver::verify(&mut runtime, &engine, &snapshot.receipt);
                Ok::<_, CandidateError>(
                    json!({"ok":true,"run":snapshot.receipt.run,"phase":snapshot.receipt.phase,"plan":snapshot.receipt.plan_id,"generation":redelivery::generation(&snapshot.receipt)?,"foreground_alive":true,"runtime_verified":checked.is_ok(),"runtime_error":checked.err().map(|error|error.code)}),
                )
            })();
            let value = match status {
                Ok(value) => value,
                Err(error) => json!({"ok":false,"code":error.code}),
            };
            let _ = transport::write(&mut stream, &value, Duration::from_secs(5));
        }
    })();
    match result {
        Ok(cleaned) => {
            publishers.reap_after_cleanup(&signals, Instant::now() + Duration::from_secs(5))?;
            publication.finish()?;
            Ok(cleaned)
        }
        // A failed explicit cleanup may already have an EffectStarted journal; do
        // not replay it here. Retain publication and graph evidence for recovery.
        Err(error) => {
            if !cleanup_attempted && runtime.cleanup(candidate, false).is_ok() {
                publishers.reap_after_cleanup(&signals, Instant::now() + Duration::from_secs(5))?;
                publication.finish()?;
            }
            Err(error)
        }
    }
}
/// Explicit cleanup keeps the live-owner path; only cleanly retired publication
/// under its existing lock permits the independently journaled data-only operation.
pub fn cleanup_request(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
) -> Result<Value, CandidateError> {
    if remove_data {
        if let Some(guard) = transport::Retired::acquire(candidate, run)? {
            return retained_data::remove(candidate, run, guard);
        }
    }
    request(candidate, run, Some(remove_data))
}

/// Status is None; cleanup is Some(remove_data). Missing/stale owners refuse; this
/// never substitutes ordinary graph cleanup or kills an observed PID.
pub fn request(
    candidate: &Candidate,
    run: &str,
    remove_data: Option<bool>,
) -> Result<Value, CandidateError> {
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    transport::write(
        &mut stream,
        &WireRequest {
            version: 1,
            run: run.to_owned(),
            remove_data,
            restore: None,
        },
        Duration::from_secs(5),
    )?;
    let response: Value = transport::read(&mut stream, Duration::from_secs(120), 256 * 1024)?;
    if response.get("ok") != Some(&Value::Bool(true))
        || response.get("run").and_then(Value::as_str) != Some(run)
    {
        return Err(refused());
    }
    Ok(response)
}

/// Explicit fresh private delivery to the exact live owner. No automatic retry:
/// a lost response requires status inspection and a new execution selection.
pub fn restore_request(
    candidate: &Candidate,
    run: &str,
    plan: &str,
    expected_generation: &str,
    managed: &crate::provider::managed_environment::Managed,
) -> Result<Value, CandidateError> {
    if !super::hex(expected_generation, 64) {
        return Err(refused());
    }
    let bytes = managed.forward(plan, run)?;
    let request = WireRequest {
        version: 1,
        run: run.into(),
        remove_data: None,
        restore: Some(transport::RestoreRequest {
            plan: plan.into(),
            generation: expected_generation.into(),
            environment: transport::PrivateText::from_bytes(&bytes)?,
        }),
    };
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    managed.remaining()?;
    transport::write(&mut stream, &request, Duration::from_secs(5))?;
    let response: Value = transport::read(&mut stream, Duration::from_secs(300), 256 * 1024)?;
    if response.get("ok") == Some(&Value::Bool(false))
        && response.get("run").and_then(Value::as_str) == Some(run)
    {
        return Err(CandidateError::new(
            "graph_foreground_restore_failed",
            if response.get("recovery_required") == Some(&Value::Bool(true)) {
                "Fresh restore did not complete; inspect the retained graph state before explicit recovery. No automatic retry was attempted."
            } else {
                "Fresh restore was refused before cleanup; inspect the current owner, plan, execution generation and fresh input."
            },
        ));
    }
    if response.get("ok") != Some(&Value::Bool(true))
        || response.get("run").and_then(Value::as_str) != Some(run)
        || response.get("plan").and_then(Value::as_str) != Some(plan)
        || !response
            .get("generation")
            .and_then(Value::as_str)
            .is_some_and(|value| super::hex(value, 64))
    {
        return Err(refused());
    }
    Ok(response)
}
