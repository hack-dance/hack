//! Re-review only the live owner's admitted selectors. Never replay an uncertain
//! response or admit a caller-selected port, executable, environment or PID.
use super::*;
use std::os::unix::net::UnixStream;
use transport::DependencyRefreshRequest;

fn selection(candidate: &Candidate, run: &str) -> Result<DependencyRefreshRequest, CandidateError> {
    let engine = Engine::connect(candidate)?;
    let (receipt, _) = super::super::load(candidate, &engine, run)?;
    if receipt.phase != "ready-observed" {
        return Err(refused());
    }
    Ok(DependencyRefreshRequest {
        plan: receipt.plan_id.clone(),
        generation: redelivery::generation(&receipt)?,
        boot: engine.guest().boot_id().to_owned(),
    })
}

pub fn request(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let selected = selection(candidate, run)?;
    let expected_plan = selected.plan.clone();
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    transport::write(
        &mut stream,
        &WireRequest {
            version: 1,
            run: run.into(),
            remove_data: None,
            job: None,
            restore: None,
            refresh_dependencies: Some(selected),
        },
        Duration::from_secs(5),
    )?;
    let response = validate_owner_response(
        transport::read(&mut stream, Duration::from_secs(175), 256 * 1024)?,
        run,
    )?;
    if response["plan"] != expected_plan
        || !response["generation"]
            .as_str()
            .is_some_and(|value| super::super::hex(value, 64))
    {
        return Err(refused());
    }
    Ok(response)
}

pub(super) fn handle(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    run: &str,
    selected: DependencyRefreshRequest,
    stream: &UnixStream,
    signals: &signals::Events,
) -> Result<Value, CandidateError> {
    let current = selection(candidate, run)?;
    if selected.plan != current.plan
        || selected.generation != current.generation
        || selected.boot != current.boot
    {
        return Err(refused());
    }
    let watch = transport::ClientWatch::new(stream)?;
    let deadline = Instant::now() + Duration::from_secs(170);
    runtime.refresh_dependencies(candidate, run, &selected.generation, || {
        signals.pending() || watch.disconnected() || Instant::now() >= deadline
    })
}

pub(super) fn automatic(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    run: &str,
    signals: &signals::Events,
) -> Result<Value, CandidateError> {
    // An authenticated guest request can still hold the provider lease while its
    // failed stream unwinds. Keep this one notice until bounded acquisition;
    // there is no idle retry loop or replay of the application request.
    let selected = {
        let engine =
            Engine::connect_until(candidate, Instant::now() + Duration::from_secs(15), || {
                signals.pending()
            })?;
        let (receipt, _) = super::super::load(candidate, &engine, run)?;
        if receipt.phase != "ready-observed" {
            return Err(refused());
        }
        DependencyRefreshRequest {
            plan: receipt.plan_id.clone(),
            generation: redelivery::generation(&receipt)?,
            boot: engine.guest().boot_id().to_owned(),
        }
    };
    let deadline = Instant::now() + Duration::from_secs(170);
    runtime.refresh_dependencies(candidate, run, &selected.generation, || {
        signals.pending() || Instant::now() >= deadline
    })
}
