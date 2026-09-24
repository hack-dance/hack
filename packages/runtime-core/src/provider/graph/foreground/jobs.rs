use super::*;
use crate::provider::{graph::one_off, managed_environment};
use transport::{JobCommand, JobRequest, PrivateText};

pub fn selection(candidate: &Candidate, run: &str, service: &str) -> Result<Value, CandidateError> {
    send(
        candidate,
        run,
        JobRequest {
            service: service.into(),
            command: None,
        },
        Duration::from_secs(30),
    )
}
pub struct CommandOptions<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub plan: &'a str,
    pub generation: &'a str,
    pub boot: &'a str,
    pub argv: Vec<String>,
    pub workdir: Option<String>,
    pub timeout_seconds: u64,
}
pub fn command(
    candidate: &Candidate,
    options: CommandOptions<'_>,
    managed: &managed_environment::Managed,
) -> Result<Value, CandidateError> {
    let environment = PrivateText::from_bytes(&managed.forward(options.plan, options.run)?)?;
    send(
        candidate,
        options.run,
        JobRequest {
            service: options.service.into(),
            command: Some(JobCommand {
                plan: options.plan.into(),
                generation: options.generation.into(),
                boot: options.boot.into(),
                argv: options.argv,
                workdir: options.workdir,
                timeout_seconds: options.timeout_seconds,
                environment,
            }),
        },
        Duration::from_secs(options.timeout_seconds + 20),
    )
}
fn send(
    candidate: &Candidate,
    run: &str,
    job: JobRequest,
    budget: Duration,
) -> Result<Value, CandidateError> {
    let pin = transport::Pin::load(candidate, run)?;
    let mut stream = pin.connect()?;
    transport::write(
        &mut stream,
        &WireRequest {
            version: 1,
            run: run.into(),
            remove_data: None,
            restore: None,
            job: Some(job),
        },
        Duration::from_secs(5),
    )?;
    let value: Value = transport::read(&mut stream, budget, 4 * 1024 * 1024)?;
    response(value, run)
}
fn response(value: Value, run: &str) -> Result<Value, CandidateError> {
    if value["ok"] == true && value["run"] == run {
        return Ok(value);
    }
    // The authenticated owner returns only its fixed error code. Keep the public
    // category stable, but expose a bounded token to distinguish refusal from
    // cleanup failure without forwarding arbitrary text from a wire response.
    let cause = if value["run"] == run {
        value["code"]
            .as_str()
            .filter(|code| {
                (1..=64).contains(&code.len())
                    && code.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
            .map(str::to_owned)
    } else {
        None
    };
    let detail = cause
        .as_deref()
        .map(|code| format!(" Owner code: {code}."))
        .unwrap_or_default();
    let error = CandidateError::new(
        "graph_one_off_failed",
        format!(
            "One-off request refused or cleanup is unconfirmed; inspect owned job state before retrying. No replay attempted.{detail}"
        ),
    );
    Err(match cause {
        Some(code) => error.with_cause_code(code),
        None => error,
    })
}
pub(super) fn handle(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    run: &str,
    request: JobRequest,
    stream: &std::os::unix::net::UnixStream,
    mut pending_cleanup: impl FnMut() -> bool,
) -> Result<Value, CandidateError> {
    let selected = super::super::service_selection(candidate, run, &request.service)?;
    // Selection must be supported by this live owner's admitted in-memory template.
    runtime.job_template(&request.service)?;
    let snapshot = super::super::inspect(candidate, run)?;
    if snapshot.receipt.phase != "ready-observed" {
        return Err(refused());
    }
    // A ready receipt alone cannot authorize traffic through a dependency that
    // has rotated since startup. Check this owner's live endpoints before
    // returning a selection or admitting a one-off container.
    {
        let engine = Engine::connect(candidate)?;
        let (mut receipt, root) = super::super::load(candidate, &engine, run)?;
        startup::Driver::verify(runtime, &engine, &mut receipt, &root)?;
    }
    let Some(command) = request.command else {
        let mut result = serde_json::to_value(selected).map_err(|_| refused())?;
        result["ok"] = json!(true);
        return Ok(result);
    };
    if command.plan != selected.plan
        || command.generation != selected.generation
        || command.boot != selected.boot
        || !(1..=300).contains(&command.timeout_seconds)
    {
        return Err(refused());
    }
    let managed =
        managed_environment::receive_forwarded(command.environment.as_bytes(), &command.plan, run)?;
    let watch = transport::ClientWatch::new(stream)?;
    let deadline = Instant::now() + Duration::from_secs(command.timeout_seconds);
    runtime.set_startup_cancellation(Some(signals::startup_pending));
    let active = one_off::runtime::begin(
        candidate,
        runtime,
        &selected,
        &command.argv,
        command.workdir.as_deref(),
        &managed,
    );
    runtime.set_startup_cancellation(None);
    let result = match active {
        Ok(active) => one_off::runtime::observe(candidate, &active, deadline, || {
            signals::startup_pending() || watch.disconnected() || pending_cleanup()
        })
        .map(|output| (active.job, output)),
        Err(error) => Err(error),
    };
    // A request refused before reservation has no cleanup effect.
    let root = super::super::directory(candidate, run)?;
    if root.join("one-off.json").symlink_metadata().is_ok() {
        one_off::runtime::finish(candidate, runtime, run)?;
    }
    let (job, output) = result?;
    let mut value = serde_json::to_value(output).map_err(|_| refused())?;
    value["ok"] = json!(true);
    value["run"] = json!(run);
    value["job"] = json!(job);
    value["cleanup_confirmed"] = json!(true);
    Ok(value)
}

/// Retain the authenticated cleanup caller until the active job has been removed.
/// Other requests cannot interrupt the job and receive an explicit busy response.
pub(super) fn pending_cleanup(
    mut stream: std::os::unix::net::UnixStream,
    run: &str,
) -> Option<(std::os::unix::net::UnixStream, super::WireRequest)> {
    let request: super::WireRequest = transport::read(
        &mut stream,
        Duration::from_secs(5),
        transport::REQUEST_LIMIT,
    )
    .ok()?;
    if request.version != 1 || request.run != run {
        return None;
    }
    if request.remove_data.is_some() && request.restore.is_none() && request.job.is_none() {
        return Some((stream, request));
    }
    let _ = transport::write(
        &mut stream,
        &json!({"ok":false,"run":run,"code":"graph_one_off_busy"}),
        Duration::from_secs(5),
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn failed_response_preserves_bounded_owner_code_without_replaying() {
        let error = response(
            json!({"ok":false,"run":"owned","code":"graph_job_cleanup"}),
            "owned",
        )
        .unwrap_err();
        assert_eq!(error.code, "graph_one_off_failed");
        assert!(error.message.contains("Owner code: graph_job_cleanup."));
        assert_eq!(error.cause_code.as_deref(), Some("graph_job_cleanup"));

        for value in [
            json!({"ok":false,"run":"owned","code":"bad\ncode"}),
            json!({"ok":false,"run":"owned","code":"a".repeat(65)}),
            json!({"ok":false,"run":"other","code":"graph_job_cleanup"}),
        ] {
            let error = response(value, "owned").unwrap_err();
            assert_eq!(error.code, "graph_one_off_failed");
            assert!(!error.message.contains("Owner code:"));
            assert!(error.cause_code.is_none());
        }
    }

    #[test]
    fn cleanup_waits_for_job_and_preserves_remove_data_choice() {
        for remove_data in [false, true] {
            let (mut client, server) = UnixStream::pair().unwrap();
            transport::write(
                &mut client,
                &json!({"version":1,"run":"owned","remove_data":remove_data}),
                Duration::from_secs(1),
            )
            .unwrap();
            let (mut server, request) = pending_cleanup(server, "owned").unwrap();
            assert_eq!(request.remove_data, Some(remove_data));
            transport::write(&mut server, &json!({"ok":true}), Duration::from_secs(1)).unwrap();
            let response: Value =
                transport::read(&mut client, Duration::from_secs(1), 1024).unwrap();
            assert_eq!(response["ok"], true);
        }
    }

    #[test]
    fn other_requests_cannot_cancel_active_job() {
        for request in [
            json!({"version":1,"run":"owned","remove_data":null}),
            json!({"version":1,"run":"owned","remove_data":true,"job":{"service":"web","command":null}}),
        ] {
            let (mut client, server) = UnixStream::pair().unwrap();
            transport::write(&mut client, &request, Duration::from_secs(1)).unwrap();
            assert!(pending_cleanup(server, "owned").is_none());
            let response: Value =
                transport::read(&mut client, Duration::from_secs(1), 1024).unwrap();
            assert_eq!(response["code"], "graph_one_off_busy");
        }
        for request in [
            json!({"version":2,"run":"owned","remove_data":true}),
            json!({"version":1,"run":"other","remove_data":true}),
        ] {
            let (mut client, server) = UnixStream::pair().unwrap();
            transport::write(&mut client, &request, Duration::from_secs(1)).unwrap();
            assert!(pending_cleanup(server, "owned").is_none());
        }
    }
}
