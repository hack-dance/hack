//! Manual real-source revision and durable acceptance checks under an external VM watchdog.
use super::{SourceJob, SyncSession, engine::Engine, source_probe, source_transfer, state};
use crate::{
    Candidate, CandidateError,
    node::{self, Mutation, Request, Store},
    project,
};
use reqwest::Method;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn failure(message: &str) -> CandidateError {
    CandidateError::new("source_job_test", message)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}
fn request(
    store: &mut Store,
    candidate: &Candidate,
    id: &str,
    source: SourceJob,
) -> Result<Request, CandidateError> {
    let status = store.handle_for_candidate(
        &Request::Status { version: 1 },
        unsafe { libc::geteuid() },
        candidate,
    )?;
    Request::SubmitSource {
        version: 1,
        mutation: Mutation {
            operation_id: id.into(),
            expected_generation: status["generation"].as_i64().expect("generation"),
            target: store.target.clone(),
            principal: unsafe { libc::geteuid() },
            request_digest: String::new(),
            required_capabilities: vec!["immutable_source_jobs_v1".into()],
        },
        source,
        queue_timeout_ms: 30_000,
        execution_timeout_ms: 30_000,
    }
    .seal()
}

fn stopping_control(
    candidate: &Candidate,
    store: &mut Store,
    source: &SourceJob,
    operation: &str,
    cancel: bool,
) -> Result<serde_json::Value, CandidateError> {
    let mut request = request(
        store,
        candidate,
        operation,
        SourceJob {
            argv: vec!["/bin/busybox".into(), "sleep".into(), "60".into()],
            ..source.clone()
        },
    )?;
    if let Request::SubmitSource {
        execution_timeout_ms,
        ..
    } = &mut request
    {
        *execution_timeout_ms = if cancel { 30_000 } else { 100 };
    }
    let request = request.seal()?;
    let accepted = store.handle_for_candidate(&request, unsafe { libc::geteuid() }, candidate)?;
    let id = accepted["job_id"]
        .as_str()
        .expect("stopping job")
        .to_owned();
    store.update(&id, |r| {
        r.state = "preparing".into();
        Ok(())
    })?;
    let canceller = if cancel {
        let root = node::root(candidate);
        let checkout = candidate.checkout.clone();
        let job = id.clone();
        let operation = format!("{operation}-cancel");
        Some(std::thread::spawn(move || -> Result<(), CandidateError> {
            let candidate = Candidate::discover(&checkout)?;
            let mut store = Store::open(&root, false)?;
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while store.get(&job)?.starts == 0 {
                if std::time::Instant::now() >= deadline {
                    return Err(failure("Cancellation control did not observe a start."));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let status = store.handle_for_candidate(
                &Request::Status { version: 1 },
                unsafe { libc::geteuid() },
                &candidate,
            )?;
            let cancel = Request::Cancel {
                version: 1,
                job_id: job,
                mutation: Mutation {
                    operation_id: operation,
                    expected_generation: status["generation"].as_i64().expect("generation"),
                    target: store.target.clone(),
                    principal: unsafe { libc::geteuid() },
                    request_digest: String::new(),
                    required_capabilities: vec!["immutable_source_jobs_v1".into()],
                },
            }
            .seal()?;
            store.handle_for_candidate(&cancel, unsafe { libc::geteuid() }, &candidate)?;
            Ok(())
        }))
    } else {
        None
    };
    let result = node::supervise(
        &node::root(candidate),
        &candidate.executable,
        &candidate.checkout,
        &id,
    );
    if let Some(canceller) = canceller {
        canceller
            .join()
            .map_err(|_| failure("Canceller panicked."))??;
    }
    result?;
    let receipt = store.get(&id)?;
    if receipt.state != if cancel { "cancelled" } else { "timed_out" } || receipt.starts != 1 {
        return Err(failure("Wrong stopping outcome or start count."));
    }
    let engine = Engine::connect(candidate)?;
    let absent = engine
        .request(
            Method::GET,
            &format!("/v1.53/containers/hack-source-job-{id}/json"),
            None,
        )
        .expect_err("stopped container remains");
    if absent.code != "engine_not_found" {
        return Err(failure("Stopped container absence was not confirmed."));
    }
    Ok(json!({"receipt":receipt,"container_absent":true}))
}

#[test]
#[ignore = "Manual owned development VM only; requires HACK_LOCAL_TEST_ROOT/PROJECT and external watchdog"]
fn owned_immutable_source_job_live() -> Result<(), CandidateError> {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").map_err(|_| failure("Candidate root required."))?,
    ))?;
    let source = std::path::PathBuf::from(
        std::env::var("HACK_LOCAL_TEST_PROJECT")
            .map_err(|_| failure("Selected project required."))?,
    );
    let compose =
        std::env::var("HACK_LOCAL_TEST_COMPOSE").unwrap_or_else(|_| "compose.yaml".into());
    let status = super::status(&candidate)?;
    if status.phase != "running" || status.profile != Some(super::Profile::Development) {
        return Err(failure("Owned development VM required."));
    }
    let root = node::root(&candidate);
    node::private_directory(&root, true)?;
    let _node_lock = node::try_lock(&root.join("node.lock"))?
        .ok_or_else(|| failure("The node service is already active."))?;
    let mut store = Store::open(&root, true)?;
    if store.list()?.iter().any(|r| !r.terminal()) {
        return Err(failure(
            "Existing nonterminal jobs must not overlap this fixture.",
        ));
    }
    let initial_job_count = store.list()?.len();
    let plan = || {
        project::plan(
            &candidate,
            project::PlanOptions {
                project: &source,
                compose_file: Path::new(&compose),
                profiles: &[],
            },
        )
    };
    let report = plan()?;
    let namespace = report.plan.namespace.clone();
    let capture = || {
        let report = plan()?;
        if report.plan.namespace != namespace {
            return Err(failure("Selected project identity changed."));
        }
        let env_files = report
            .plan
            .services
            .values()
            .flat_map(|s| s.environment_files.iter().cloned())
            .collect();
        project::snapshot::capture(
            &source,
            &env_files,
            &report.plan.source_selection.metadata_sha256,
        )
    };
    let (mut image_record, image_record_path) =
        source_probe::new_record(&candidate, &namespace, &"0".repeat(64))?;
    let marker_name = format!("hkl-job-{}.txt", image_record.operation_id);
    let marker = source.join(&marker_name);
    if marker.symlink_metadata().is_ok() {
        return Err(failure("Owned fixture marker already exists."));
    }
    let mut created_marker = false;
    let mut evidence = json!({});
    let result = (|| {
        let snapshot_a = capture()?;
        let revision_a = snapshot_a.receipt().revision.clone();
        SyncSession::open(&candidate, &namespace, &source)?.apply(&snapshot_a, false)?;
        source_transfer::publish(&candidate, &namespace, &snapshot_a)?;
        image_record.revision = revision_a.clone();
        state::write(&image_record_path, &image_record)?;
        {
            let engine = Engine::connect(&candidate)?;
            source_probe::prepare_image(&engine, &image_record, None)?;
            let image = engine.request(
                Method::GET,
                &format!(
                    "/v1.53/images/hack-local-source-probe:{}/json",
                    image_record.operation_id
                ),
                None,
            )?;
            if !source_probe::labels_match(&image, &image_record) {
                return Err(failure("Fixture image ownership mismatch."));
            }
            image_record.image_id = Some(source_probe::image_id(&image)?);
            state::write(&image_record_path, &image_record)?;
        }
        let spec = SourceJob {
            namespace: namespace.clone(),
            revision: revision_a.clone(),
            image: image_record.image_id.clone().expect("image"),
            argv: vec![
                "/bin/busybox".into(),
                "sh".into(),
                "-c".into(),
                format!(
                    "set -eu; test ! -e /input/{marker_name}; if printf forbidden > /input/{marker_name} 2>/dev/null; then exit 81; fi; printf 'accepted-A\\n'; printf 'separate-stderr\\n' >&2"
                ),
            ],
            memory_bytes: 64 * 1024 * 1024,
        };
        let operation = format!("wu06-{}", image_record.operation_id);
        let accepted_request = request(&mut store, &candidate, &operation, spec.clone())?;
        let since = now();
        let acceptance = store.handle_for_candidate(
            &accepted_request,
            unsafe { libc::geteuid() },
            &candidate,
        )?;
        let job = acceptance["job_id"].as_str().expect("job").to_owned();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&marker)
            .map_err(|_| failure("Cannot create owned B marker."))?;
        created_marker = true;
        file.write_all(b"B\n")
            .map_err(|_| failure("Cannot initialize owned B marker."))?;
        drop(file);
        let snapshot_b = capture()?;
        let revision_b = snapshot_b.receipt().revision.clone();
        SyncSession::open(&candidate, &namespace, &source)?.apply(&snapshot_b, false)?;
        if revision_a == revision_b {
            return Err(failure(
                "Negative control did not change the source revision.",
            ));
        }
        let stale_operation = format!("{operation}-stale");
        let stale = request(&mut store, &candidate, &stale_operation, spec.clone())?;
        let rejected = store
            .handle_for_candidate(&stale, unsafe { libc::geteuid() }, &candidate)
            .expect_err("stale source accepted");
        if rejected.code != "stale_source_revision" {
            return Err(failure("Wrong stale-source refusal."));
        }
        let unpublished_operation = format!("{operation}-unpublished");
        let unpublished = request(
            &mut store,
            &candidate,
            &unpublished_operation,
            SourceJob {
                revision: revision_b.clone(),
                ..spec.clone()
            },
        )?;
        let unready = store
            .handle_for_candidate(&unpublished, unsafe { libc::geteuid() }, &candidate)
            .expect_err("unpublished source accepted");
        if unready.code != "source_not_published" {
            return Err(failure("Wrong unpublished-source refusal."));
        }
        // Reopen the durable journal; a retry of accepted A remains the same operation after B.
        drop(store);
        store = Store::open(&root, false)?;
        let replay = store.handle_for_candidate(
            &accepted_request,
            unsafe { libc::geteuid() },
            &candidate,
        )?;
        if replay != acceptance || store.list()?.len() != initial_job_count + 1 {
            return Err(failure("Accepted retry duplicated or changed the job."));
        }
        store.update(&job, |r| {
            r.state = "preparing".into();
            Ok(())
        })?;
        node::supervise(&root, &candidate.executable, &candidate.checkout, &job)?;
        let receipt = store.get(&job)?;
        if receipt.state != "succeeded"
            || receipt.stdout != "accepted-A\n"
            || !receipt.stderr.ends_with("separate-stderr\n")
            || receipt.starts != 1
        {
            evidence = json!({"acceptance":acceptance,"receipt":receipt});
            return Err(failure(
                "Accepted A did not execute with immutable input and separated output.",
            ));
        }
        std::thread::sleep(Duration::from_millis(1100));
        let engine = Engine::connect(&candidate)?;
        let positive_events = engine.job_events(&job, since, now())?;
        let stale_events = engine.job_events(
            &format!("{:x}", Sha256::digest(stale_operation.as_bytes())),
            since,
            now(),
        )?;
        let unpublished_events = engine.job_events(
            &format!("{:x}", Sha256::digest(unpublished_operation.as_bytes())),
            since,
            now(),
        )?;
        if !positive_events.iter().any(|s| s == "start")
            || !stale_events.is_empty()
            || !unpublished_events.is_empty()
        {
            return Err(failure(
                "Independent engine events did not prove the positive and rejected launch controls.",
            ));
        }
        drop(engine);
        if fs::read(&marker).map_err(|_| failure("Owned B marker changed."))? != b"B\n" {
            return Err(failure("Unexpected edit to owned B marker."));
        }
        fs::remove_file(&marker).map_err(|_| failure("Cannot remove owned B marker."))?;
        created_marker = false;
        let restored = capture()?;
        SyncSession::open(&candidate, &namespace, &source)?.apply(&restored, false)?;
        evidence = json!({"scope":"actual selected source and durable journal; busybox job, not Event Agent service startup",
            "revision_a":revision_a,"revision_b":revision_b,"acceptance":acceptance,"receipt":receipt,
            "retry_identical":true,"stale_refusal":rejected.code,"unpublished_refusal":unready.code,
            "positive_events":positive_events,"stale_events":stale_events,"unpublished_events":unpublished_events});
        // Model supervisor loss after create but before start. Reconciliation must only remove it.
        let recovery_request = request(
            &mut store,
            &candidate,
            &format!("{operation}-recovery"),
            spec.clone(),
        )?;
        let recovery = store.handle_for_candidate(
            &recovery_request,
            unsafe { libc::geteuid() },
            &candidate,
        )?;
        let recovery_id = recovery["job_id"].as_str().expect("recovery job");
        let recovery_name = format!("hack-source-job-{recovery_id}");
        let engine = Engine::connect(&candidate)?;
        engine.request(Method::POST, &format!("/v1.53/containers/create?name={recovery_name}"), Some(&json!({
            "Image":spec.image, "Entrypoint":["/bin/busybox","true"], "Cmd":[],
            "Labels":{"io.hack-local.job":recovery_id,"io.hack-local.owner":spec.namespace,"io.hack-local.source":spec.revision},
            "HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"Memory":64*1024*1024,"MemorySwap":64*1024*1024}
        })))?;
        drop(engine);
        store.update(recovery_id, |r| {
            r.state = "quarantined".into();
            Ok(())
        })?;
        let status = store.handle_for_candidate(
            &Request::Status { version: 1 },
            unsafe { libc::geteuid() },
            &candidate,
        )?;
        let reconciliation = Request::ReconcileSource {
            version: 1,
            job_id: recovery_id.into(),
            mutation: Mutation {
                operation_id: format!("{operation}-reconcile"),
                expected_generation: status["generation"].as_i64().expect("generation"),
                target: store.target.clone(),
                principal: unsafe { libc::geteuid() },
                request_digest: String::new(),
                required_capabilities: vec!["source_job_reconciliation_v1".into()],
            },
        }
        .seal()?;
        let held = node::try_lock(&store.lock_path(recovery_id)?)?.expect("test supervisor lock");
        let active = store
            .handle_for_candidate(&reconciliation, unsafe { libc::geteuid() }, &candidate)
            .expect_err("active supervisor reconciled");
        if !active.message.contains("still active") {
            return Err(failure("Unexpected active-supervisor refusal."));
        }
        drop(held);
        let reconciled =
            store.handle_for_candidate(&reconciliation, unsafe { libc::geteuid() }, &candidate)?;
        if store.handle_for_candidate(&reconciliation, unsafe { libc::geteuid() }, &candidate)?
            != reconciled
        {
            return Err(failure("Reconciliation retry changed its acknowledgement."));
        }
        let recovered = store.get(recovery_id)?;
        let engine = Engine::connect(&candidate)?;
        let absent = engine
            .request(
                Method::GET,
                &format!("/v1.53/containers/{recovery_name}/json"),
                None,
            )
            .expect_err("container remains");
        std::thread::sleep(Duration::from_millis(1100));
        let recovery_events = engine.job_events(recovery_id, since, now())?;
        if absent.code != "engine_not_found"
            || recovered.state != "reconciled_unknown"
            || recovered.starts != 0
            || recovery_events.iter().any(|e| e == "start")
        {
            return Err(failure(
                "Reconciliation failed to preserve unknown outcome and zero starts.",
            ));
        }
        drop(engine);
        evidence["reconciliation"] = json!({"receipt":recovered,"retry_identical":true,"container_absent":true,"events":recovery_events});
        evidence["cancellation"] = stopping_control(
            &candidate,
            &mut store,
            &spec,
            &format!("{operation}-cancellation"),
            true,
        )?;
        evidence["timeout"] = stopping_control(
            &candidate,
            &mut store,
            &spec,
            &format!("{operation}-timeout"),
            false,
        )?;
        // Deliberately add an unexpected guest-only leaf after admission, then restore it.
        let tamper_request = request(
            &mut store,
            &candidate,
            &format!("{operation}-tamper"),
            spec.clone(),
        )?;
        let tamper_accepted =
            store.handle_for_candidate(&tamper_request, unsafe { libc::geteuid() }, &candidate)?;
        let tamper_id = tamper_accepted["job_id"].as_str().expect("tamper job");
        let tree = format!(
            "/storage/hack-source/{}/{}/tree",
            spec.namespace, spec.revision
        );
        let extra = format!("{tree}/hkl-tamper-{}", image_record.operation_id);
        {
            let engine = Engine::connect(&candidate)?;
            engine.guest().execute("test ! -L \"$1\"; test -d \"$1\"; test ! -e \"$2\"; chmod 755 \"$1\"; (set -C; printf tampered > \"$2\"); chmod 555 \"$1\"", &[&tree,&extra],None)?;
        }
        store.update(tamper_id, |r| {
            r.state = "preparing".into();
            Ok(())
        })?;
        let tampered =
            node::supervise(&root, &candidate.executable, &candidate.checkout, tamper_id);
        {
            let engine = Engine::connect(&candidate)?;
            engine.guest().execute("test ! -L \"$2\"; test \"$(cat \"$2\")\" = tampered; chmod 755 \"$1\"; rm -- \"$2\"; chmod 555 \"$1\"", &[&tree,&extra],None)?;
        }
        let tampered_receipt = store.get(tamper_id)?;
        if tampered.is_ok() || tampered_receipt.state != "failed" || tampered_receipt.starts != 0 {
            return Err(failure(
                "Guest source tampering was not rejected before launch.",
            ));
        }
        let engine = Engine::connect(&candidate)?;
        let tamper_events = engine.job_events(tamper_id, since, now())?;
        if !tamper_events.is_empty() {
            return Err(failure("Tampered input produced container events."));
        }
        drop(engine);
        evidence["tampered_input"] =
            json!({"receipt":tampered_receipt,"events":tamper_events,"restored":true});
        if let Ok(image) = std::env::var("HACK_LOCAL_TEST_IMAGE") {
            let argv: Vec<String> = serde_json::from_str(
                &std::env::var("HACK_LOCAL_TEST_ARGV")
                    .map_err(|_| failure("Explicit real-project test argv required."))?,
            )
            .map_err(|_| failure("Invalid real-project test argv."))?;
            let application = SourceJob {
                image,
                argv,
                memory_bytes: 512 * 1024 * 1024,
                revision: restored.receipt().revision.clone(),
                ..spec
            };
            let application_request = request(
                &mut store,
                &candidate,
                &format!("{operation}-application"),
                application,
            )?;
            let application_acceptance = store.handle_for_candidate(
                &application_request,
                unsafe { libc::geteuid() },
                &candidate,
            )?;
            let application_id = application_acceptance["job_id"]
                .as_str()
                .expect("application job");
            store.update(application_id, |r| {
                r.state = "preparing".into();
                Ok(())
            })?;
            node::supervise(
                &root,
                &candidate.executable,
                &candidate.checkout,
                application_id,
            )?;
            let application_receipt = store.get(application_id)?;
            evidence["application_test"] =
                json!({"acceptance":application_acceptance,"receipt":application_receipt});
            if application_receipt.state != "succeeded" || application_receipt.starts != 1 {
                return Err(failure(
                    "The real-project command failed; its receipt is retained.",
                ));
            }
        }
        Ok(())
    })();
    if created_marker
        && marker.symlink_metadata().is_ok_and(|m| m.is_file())
        && fs::read(&marker).is_ok_and(|b| b == b"B\n")
    {
        let _ = fs::remove_file(&marker);
    }
    let cleanup = Engine::connect_cleanup(&candidate)
        .and_then(|engine| source_probe::cleanup(&engine, &mut image_record));
    image_record.phase = if cleanup.is_ok() {
        "immutable-job-image-cleaned"
    } else {
        "cleanup-uncertain"
    }
    .into();
    state::write(&image_record_path, &image_record)?;
    evidence["image_record"] = json!(image_record);
    evidence["passed"] = json!(result.is_ok() && cleanup.is_ok());
    let directory = candidate.state_root.join("review/wu06");
    state::private_directory(&directory)?;
    state::write(&directory.join("immutable-source-job.json"), &evidence)?;
    cleanup?;
    result
}
