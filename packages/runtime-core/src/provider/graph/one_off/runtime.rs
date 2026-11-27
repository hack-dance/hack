//! Transient resources are enrolled in the parent receipt before creation, so
//! ordinary owned graph cleanup can find them after a foreground-owner failure.
use super::*;
use crate::provider::{
    environment::{EnvironmentLease, PendingEnvironment},
    managed_environment::Managed,
};

pub struct ActiveJob {
    pub job: String,
    pub service: String,
    pub root: PathBuf,
    pub original: Receipt,
    pub leases: BTreeMap<String, EnvironmentLease>,
}
/// The caller's bounded wait for the provider lease: its deadline, and its check
/// (owner signals, client disconnect) that runs before every attempt.
pub struct LeaseWait<'a> {
    pub deadline: std::time::Instant,
    pub check: &'a dyn Fn() -> Result<(), CandidateError>,
}

pub fn begin(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    selection: &ServiceSelection,
    argv: &[String],
    workdir: Option<&str>,
    managed: &Managed,
    lease: LeaseWait<'_>,
) -> Result<ActiveJob, CandidateError> {
    // Waits out a brief holder of the provider lease until the caller's shared
    // bound; `check` (owner signals, client disconnect) runs before every attempt
    // and once more after acquisition. Waiting admits nothing: the job is
    // reserved only after acquisition (HACK-2669).
    let engine = Engine::connect_command(candidate, lease.deadline, lease.check)?;
    let (original, root) = load(candidate, &engine, &selection.run)?;
    if selection.boot != engine.guest().boot_id() || original.phase != "ready-observed" {
        return Err(refused());
    }
    managed.validate_binding(&original.plan_id, &original.run)?;
    let engine = engine.with_admission_deadline(managed.deadline());
    if managed.values().keys().any(|key| key != &selection.service) {
        return Err(refused());
    }
    let job = probes::token()?;
    let service = format!("job-{job}");
    let key = format!("container:{service}");
    let name = (0..32)
        .map(|index| format!("hkg-{}-container-{index}", original.run))
        .find(|name| original.resources.values().all(|r| &r.name != name))
        .ok_or_else(refused)?;
    let resource = job_resource(
        original
            .resources
            .get(&format!("container:{}", selection.service))
            .ok_or_else(refused)?,
        &service,
        name,
    );
    let template = runtime.job_template(&selection.service)?;
    let config = config::prepare(&template, &original, &resource, argv, workdir)?;
    let mut configs = BTreeMap::from([(service.clone(), config)]);
    admission::check(candidate, &engine, None, &configs)?;
    let values = managed.values().get(&selection.service);
    let private = if values.is_some_and(|v| !v.is_empty()) {
        BTreeSet::from([service.clone()])
    } else {
        BTreeSet::new()
    };
    let expected_environment = verify_images(
        &engine,
        &config::verification_resources(&original, &key, &resource),
        &mut configs,
        &private,
        &BTreeSet::new(),
        None,
    )?;
    let mut environments = BTreeMap::new();
    if let Some(values) = values.filter(|v| !v.is_empty()) {
        environments.insert(
            service.clone(),
            PendingEnvironment::until(&service, values, managed.deadline())?,
        );
    }
    let launcher = if environments.is_empty() {
        None
    } else {
        Some(launcher::publish(&engine)?)
    };
    managed.remaining()?;
    JobIntent::reserve(
        &root,
        &original,
        selection,
        &job,
        &resource.name,
        &configs[&service],
    )?;
    let mut receipt = original.clone();
    receipt.resources.insert(key, resource);
    receipt
        .readiness
        .insert(service.clone(), Condition::Started);
    receipt.set_phase("restoring");
    state::write(&root.join("state.json"), &receipt)?;
    super::super::startup_failure::clear_after_started(&root)?;
    runtime.enroll_job(&engine, &mut receipt, &root, &selection.service, &service)?;
    // HACK-2759: read the job's output from an attach opened right before its start,
    // not from its rotating 1 MB log after it exits, which kept only the end. The
    // bound covers the longest job (300 s) and its observation.
    runtime.capture_output_of(
        &service,
        std::time::Instant::now() + Duration::from_secs(330),
    );
    let mut session = Session {
        startup: Some(runtime),
        engine,
        root: root.clone(),
        receipt,
        configs,
        default_health_cadence: BTreeMap::new(),
        expected_environment,
        restarting: false,
        fresh_cache_completion: false,
        cache_initializers: BTreeMap::new(),
        environments,
        leases: BTreeMap::new(),
        probe_findings: BTreeMap::new(),
        launcher,
    };
    session.record(Event::StartIntent { service: &service })?;
    session.start(&service)?;
    session.record(Event::Started { service: &service })?;
    let leases = std::mem::take(&mut session.leases);
    Ok(ActiveJob {
        job,
        service,
        root,
        original,
        leases,
    })
}

/// Observe a bounded command without retaining the VM mutation lease between
/// polls. Caller cancellation and timeout both proceed to exact owned cleanup.
pub(in crate::provider) fn observe(
    candidate: &Candidate,
    active: &ActiveJob,
    deadline: std::time::Instant,
    mut cancelled: impl FnMut() -> bool,
    output: Option<std::thread::JoinHandle<Result<crate::provider::engine::Capture, ()>>>,
) -> Result<ServiceExecResult, CandidateError> {
    let mut output = output;
    use base64::Engine as _;
    loop {
        if cancelled() || std::time::Instant::now() >= deadline {
            return Err(error(
                "graph_one_off_cancelled",
                "One-off command cancelled or exceeded its deadline; owned cleanup is required.",
            ));
        }
        {
            let engine = Engine::connect_cleanup(candidate)?;
            let (receipt, _) = load(candidate, &engine, &active.original.run)?;
            let resource = receipt
                .resources
                .get(&format!("container:{}", active.service))
                .ok_or_else(refused)?;
            let value = inspect_resource(&engine, &receipt, resource)?.ok_or_else(refused)?;
            if value["State"]["Running"] == false {
                let code = value["State"]["ExitCode"]
                    .as_i64()
                    .filter(|v| (0..=255).contains(v))
                    .ok_or_else(refused)? as i32;
                let (stdout, stderr, truncated) = match output.take() {
                    Some(reader) => attached_output(reader)?,
                    // No attach was opened (an engine that refused it): the log.
                    None => engine.job_logs(resource.id.as_deref().ok_or_else(refused)?)?,
                };
                return Ok(ServiceExecResult {
                    exit_code: code,
                    stdout_base64: base64::engine::general_purpose::STANDARD.encode(stdout),
                    stderr_base64: base64::engine::general_purpose::STANDARD.encode(stderr),
                    truncated,
                });
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// How long an exited job's output reader may take to see its stream close.
const OUTPUT_SETTLE: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(10)
};
/// The attached output of an exited job. Its stream closes when the job exits, so
/// the reader ends promptly; one that does not, or failed, leaves the output
/// unconfirmed rather than silently short (HACK-2759).
fn attached_output(
    reader: std::thread::JoinHandle<Result<crate::provider::engine::Capture, ()>>,
) -> Result<(Vec<u8>, Vec<u8>, bool), CandidateError> {
    let unread = || {
        error(
            "graph_one_off_failed",
            "One-off output could not be read to its end; owned cleanup is required.",
        )
    };
    let settle = std::time::Instant::now() + OUTPUT_SETTLE;
    while !reader.is_finished() {
        if std::time::Instant::now() >= settle {
            return Err(unread());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let capture = reader.join().map_err(|_| unread())?.map_err(|_| unread())?;
    let truncated = capture.stdout_dropped + capture.stderr_dropped > 0;
    Ok((capture.stdout, capture.stderr, truncated))
}

/// Remove only the transient resource and its fresh private/dependency grants.
/// Parent volume/network resources never enter this deletion loop.
pub fn finish(
    candidate: &Candidate,
    runtime: &mut HostRelayRuntime,
    run: &str,
) -> Result<(), CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = load(candidate, &engine, run)?;
    recovery_selection(&root, &receipt, engine.guest().boot_id())?;
    retain_interrupted_cleanup(&root)?;
    let mut intent: JobIntent = state::read(&root.join(FILE))?;
    if intent.run != run
        || intent.owner != receipt.owner
        || intent.plan != receipt.plan_id
        || intent.boot != engine.guest().boot_id()
    {
        return Err(refused());
    }
    let service = format!("job-{}", intent.job);
    let key = format!("container:{service}");
    if let Some(resource) = receipt.resources.get(&key).cloned() {
        if resource.kind != Kind::Container || resource.name != intent.container_name {
            return Err(refused());
        }
        intent.advance(&root, JobPhase::CleanupIntent, resource.id.as_deref())?;
        if let Some(value) = inspect_resource(&engine, &receipt, &resource)? {
            let id = value["Id"]
                .as_str()
                .filter(|v| hex(v, 64))
                .ok_or_else(refused)?;
            if value["State"]["Running"] == true {
                match engine.stop_containers(&[(id.to_owned(), 5)]) {
                    Ok(()) => {}
                    Err(error)
                        if error.code == "engine_not_found"
                            && inspect_resource(&engine, &receipt, &resource)?.is_none() => {}
                    Err(error) => return Err(error),
                }
            }
            if let Some(stopped) = inspect_resource(&engine, &receipt, &resource)? {
                if stopped["State"]["Running"] != false {
                    return Err(refused());
                }
                match engine.request(
                    Method::DELETE,
                    &format!("/v1.53/containers/{id}?v=true"),
                    None,
                ) {
                    Ok(_) => {}
                    Err(error) if error.code == "engine_not_found" => {}
                    Err(error) => return Err(error),
                }
            }
        }
        if inspect_resource(&engine, &receipt, &resource)?.is_some() {
            return Err(refused());
        }
    } else {
        if !matches!(
            intent.phase,
            JobPhase::Reserved | JobPhase::CleanupIntent | JobPhase::Removed
        ) || receipt.phase != "ready-observed"
        {
            return Err(refused());
        }
        crate::provider::engine::require_container_absent(engine.guest(), &intent.container_name)?;
        if intent.phase != JobPhase::Removed {
            intent.advance(&root, JobPhase::CleanupIntent, None)?;
        }
    }
    runtime.retire_job(&engine, &service, &receipt)?;
    crate::provider::environment_recovery::archive_job(
        candidate,
        engine.guest(),
        run,
        &service,
        &intent.container_name,
        &root.join(format!("job-environment-{}", intent.job)),
    )?;
    receipt.resources.remove(&key);
    receipt.readiness.remove(&service);
    if let Some(startup) = receipt.relay_startup.as_mut() {
        startup.services.remove(&service);
    }
    receipt.environment_attached = intent.original_environment_attached;
    receipt.set_phase("ready-observed");
    state::write(&root.join("state.json"), &receipt)?;
    if intent.phase != JobPhase::Removed {
        intent.advance(&root, JobPhase::Removed, None)?;
    }
    let history = root.join("job-history");
    state::private_directory(&history)?;
    let target = history.join(format!("{}.json", intent.job));
    if target.symlink_metadata().is_ok() {
        return Err(refused());
    }
    fs::rename(root.join(FILE), target).map_err(state::io)?;
    for directory in [&root, &history] {
        fs::File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(state::io)?;
    }
    Ok(())
}

#[cfg(test)]
mod output_tests {
    use super::*;
    use crate::provider::engine::Capture;

    /// HACK-2759 (review M1): a Compose one-off's output comes from its attach
    /// reader, with truncation from the dropped counts; a reader that failed or
    /// never sees its stream close leaves the output unconfirmed, never short.
    #[test]
    fn a_compose_one_off_takes_its_attached_output_or_reports_it_unread() {
        let reader = std::thread::spawn(|| {
            let mut capture = Capture::default();
            capture.stdout = b"kept".to_vec();
            capture.stdout_dropped = 9_000_000;
            Ok(capture)
        });
        let (stdout, stderr, truncated) = attached_output(reader).unwrap();
        assert_eq!(
            (stdout.as_slice(), stderr.len(), truncated),
            (&b"kept"[..], 0, true)
        );

        let failed = std::thread::spawn(|| Err(()));
        assert_eq!(
            attached_output(failed).unwrap_err().code,
            "graph_one_off_failed"
        );

        let (release, wait) = std::sync::mpsc::channel::<()>();
        let stuck = std::thread::spawn(move || {
            let _ = wait.recv();
            Ok(Capture::default())
        });
        assert_eq!(
            attached_output(stuck).unwrap_err().code,
            "graph_one_off_failed"
        );
        drop(release);
    }
}
