//! Live supervisor-loss containment and explicit unknown-outcome reconciliation.
use super::{
    SourceJob, SyncSession, engine::Engine, source_job_test::request, source_probe,
    source_transfer, state,
};
use crate::{
    Candidate, CandidateError,
    node::{self, Mutation, Request, Store},
    project,
};
use reqwest::Method;
use serde_json::json;
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn failure(message: &str) -> CandidateError {
    CandidateError::new("supervisor_loss_test", message)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

/// The test owns these unreaped subprocess handles; no recorded PID authorizes a signal.
struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
#[ignore = "Manual owned development VM only; requires source fixture, pinned image and external watchdog"]
fn owned_supervisor_loss_live() -> Result<(), CandidateError> {
    use std::process::{Command, Stdio};
    use std::time::Instant;
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").map_err(|_| failure("Candidate root required."))?,
    ))?;
    let source = std::path::PathBuf::from(
        std::env::var("HACK_LOCAL_TEST_PROJECT").map_err(|_| failure("Project required."))?,
    );
    let status = super::status(&candidate)?;
    if status.phase != "running" || status.profile != Some(super::Profile::Development) {
        return Err(failure("Owned development VM required."));
    }
    let root = node::root(&candidate);
    node::private_directory(&root, true)?;
    let lock =
        node::try_lock(&root.join("node.lock"))?.ok_or_else(|| failure("Node already active."))?;
    let mut store = Store::open(&root, true)?;
    if store
        .list()?
        .iter()
        .any(|r| !r.terminal() || r.state == "quarantined")
    {
        return Err(failure("Existing work must not overlap this fixture."));
    }
    let report = project::plan(
        &candidate,
        project::PlanOptions {
            project: &source,
            compose_file: Path::new(".hack/docker-compose.yml"),
            profiles: &[],
        },
    )?;
    let env_files = report
        .plan
        .services
        .values()
        .flat_map(|s| s.environment_files.iter().cloned())
        .collect();
    let snapshot = project::snapshot::capture(
        &source,
        &env_files,
        &report.plan.source_selection.metadata_sha256,
    )?;
    let namespace = &report.plan.namespace;
    SyncSession::open(&candidate, namespace, &source)?.apply(&snapshot, false)?;
    source_transfer::publish(&candidate, namespace, &snapshot)?;
    let spec = SourceJob {
        namespace: namespace.clone(), revision: snapshot.receipt().revision.clone(),
        image: std::env::var("HACK_LOCAL_TEST_IMAGE").map_err(|_| failure("Pinned image required."))?,
        argv: vec!["/usr/local/bin/bun".into(), "-e".into(),
            "const child = Bun.spawn(['/usr/local/bin/bun', '-e', 'await Bun.sleep(60000)']); console.log('live-descendant=' + child.pid); await Bun.sleep(60000)".into()],
        memory_bytes: 512 * 1024 * 1024,
    };
    let operation = format!("supervisor-loss-{}", node::now());
    let mut submitted = request(&mut store, &candidate, &operation, spec.clone())?;
    if let Request::SubmitSource {
        execution_timeout_ms,
        ..
    } = &mut submitted
    {
        *execution_timeout_ms = 8000;
    }
    let submitted = submitted.seal()?;
    let acceptance =
        store.handle_for_candidate(&submitted, unsafe { libc::geteuid() }, &candidate)?;
    let job = acceptance["job_id"].as_str().expect("job");
    store.update(job, |r| {
        r.state = "preparing".into();
        Ok(())
    })?;
    let since = now();
    let mut supervisor = OwnedChild(
        Command::new(
            candidate
                .state_root
                .join("target/release/hack-runtime-candidate"),
        )
        .arg("--candidate-root")
        .arg(&candidate.checkout)
        .arg("__job_supervisor")
        .arg(&root)
        .arg(job)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failure("Cannot start owned supervisor."))?,
    );
    let name = format!("hack-source-job-{job}");
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if store.get(job)?.starts == 1 {
                break;
            }
            if Instant::now() >= deadline
                || supervisor
                    .0
                    .try_wait()
                    .map_err(|_| failure("Cannot observe supervisor."))?
                    .is_some()
            {
                return Err(failure("Live workload and descendant were not observed."));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // The supervisor retains the mutation lock; read-only inspection must still work.
        let busy = Engine::connect(&candidate)
            .err()
            .ok_or_else(|| failure("Supervisor mutation lock was not retained."))?;
        if busy.code != "provider_busy" {
            return Err(failure("Unexpected mutation-lock refusal."));
        }
        let cli = Command::new(
            candidate
                .state_root
                .join("target/release/hack-runtime-candidate"),
        )
        .env_clear()
        .args([
            "--candidate-root",
            candidate.checkout.to_str().unwrap(),
            "runtime",
            "engine-info",
            "--json",
        ])
        .output()
        .map_err(|_| failure("Cannot inspect engine through CLI."))?;
        if !cli.status.success() {
            return Err(failure(
                "Read-only CLI observation contended with the live supervisor.",
            ));
        }
        let observed = super::engine::info(&candidate)?;
        if observed.architecture != "arm64" {
            return Err(failure(
                "Concurrent engine observation returned the wrong provider.",
            ));
        }
        supervisor
            .0
            .kill()
            .map_err(|_| failure("Cannot kill owned supervisor."))?;
        supervisor
            .0
            .wait()
            .map_err(|_| failure("Cannot reap owned supervisor."))?;
        let lost_at = Instant::now();
        let running = loop {
            let engine = Engine::connect(&candidate)?;
            let value =
                engine.request(Method::GET, &format!("/v1.53/containers/{name}/json"), None)?;
            let id = source_probe::container_id(&value)?;
            let (stdout, _, _) = engine.logs(&id)?;
            if value["State"]["Running"] == true && stdout.contains("live-descendant=") {
                break value;
            }
            if lost_at.elapsed() > Duration::from_secs(5) || value["State"]["Running"] == false {
                return Err(failure(
                    "Live workload and descendant were not observed after supervisor loss.",
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let stopped = loop {
            let engine = Engine::connect(&candidate)?;
            let value =
                engine.request(Method::GET, &format!("/v1.53/containers/{name}/json"), None)?;
            if value["State"]["Running"] == false {
                break value;
            }
            if lost_at.elapsed() > Duration::from_secs(12) {
                return Err(failure("Container outlived its independent deadline."));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let containment_seconds = lost_at.elapsed().as_secs_f64();
        if stopped["State"]["ExitCode"] == 0 {
            return Err(failure("Killed workload unexpectedly succeeded."));
        }
        drop(lock);
        let _node = OwnedChild(
            Command::new(
                candidate
                    .state_root
                    .join("target/release/hack-runtime-candidate"),
            )
            .arg("--candidate-root")
            .arg(&candidate.checkout)
            .args(["node", "serve"])
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| failure("Cannot restart node."))?,
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while store.get(job)?.state != "quarantined" {
            if Instant::now() >= deadline {
                return Err(failure("Node did not quarantine lost supervisor."));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if store.handle_for_candidate(&submitted, unsafe { libc::geteuid() }, &candidate)?
            != acceptance
        {
            return Err(failure("Lost-supervisor retry changed acceptance."));
        }
        let current = store.handle_for_candidate(
            &Request::Status { version: 1 },
            unsafe { libc::geteuid() },
            &candidate,
        )?;
        let reconcile = Request::ReconcileSource {
            version: 1,
            job_id: job.into(),
            mutation: Mutation {
                operation_id: format!("{operation}-reconcile"),
                expected_generation: current["generation"].as_i64().expect("generation"),
                target: store.target.clone(),
                principal: unsafe { libc::geteuid() },
                request_digest: String::new(),
                required_capabilities: vec!["source_job_reconciliation_v1".into()],
            },
        }
        .seal()?;
        let ack = store.handle_for_candidate(&reconcile, unsafe { libc::geteuid() }, &candidate)?;
        if store.handle_for_candidate(&reconcile, unsafe { libc::geteuid() }, &candidate)? != ack {
            return Err(failure("Reconciliation retry changed acknowledgement."));
        }
        let receipt = store.get(job)?;
        let engine = Engine::connect(&candidate)?;
        let absent = engine
            .request(Method::GET, &format!("/v1.53/containers/{name}/json"), None)
            .expect_err("container remains");
        std::thread::sleep(Duration::from_millis(1100));
        let events = engine.job_events(job, since, now())?;
        if receipt.state != "reconciled_unknown"
            || receipt.exit_code.is_some()
            || receipt.starts != 1
            || absent.code != "engine_not_found"
            || events.iter().filter(|e| e.as_str() == "start").count() != 1
        {
            return Err(failure("Cleanup or unknown-outcome contract failed."));
        }
        Ok(
            json!({"running_id":running["Id"], "stopped_state":stopped["State"],
            "receipt":receipt,"events":events,"container_absent":true,"retry_identical":true,
            "containment_seconds":containment_seconds,"concurrent_read_only_cli":true,"concurrent_mutation_refused":true}),
        )
    })();
    drop(supervisor);
    let cleanup = super::reconcile_source_job(&candidate, job, &spec);
    let directory = candidate.state_root.join("review/wu06");
    state::private_directory(&directory)?;
    state::write(
        &directory.join("supervisor-loss.json"),
        &json!({
            "passed":result.is_ok() && cleanup.is_ok(),"evidence":result.as_ref().ok(),
            "failure":result.as_ref().err().map(|e| &e.message),"cleanup_confirmed":cleanup.is_ok()
        }),
    )?;
    cleanup?;
    result.map(|_| ())
}
