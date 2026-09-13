//! Live writable-output bounds and immutable publication reuse.
use super::{SourceJob, SyncSession, engine::Engine, source_transfer, state};
use crate::{Candidate, CandidateError, project};
use reqwest::Method;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

fn failure(message: &str) -> CandidateError {
    CandidateError::new("source_output_test", message)
}

#[test]
#[ignore = "Manual owned development VM only; requires selected source, pinned image and external watchdog"]
fn owned_source_output_live() -> Result<(), CandidateError> {
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
    let publication = source_transfer::publish(&candidate, namespace, &snapshot)?;
    let inode = || -> Result<String, CandidateError> {
        Engine::connect(&candidate)?.guest().execute(
            "test ! -L \"$1\"; stat -c %d:%i \"$1\" \"$1/package.json\"",
            &[&publication.guest_path],
            None,
        )
    };
    let before = inode()?;
    let reused = source_transfer::publish(&candidate, namespace, &snapshot)?;
    if publication.archive_sha256 != reused.archive_sha256 || before != inode()? {
        return Err(failure(
            "Reused publication changed content identity or copied its tree.",
        ));
    }
    let job = format!(
        "{:x}",
        Sha256::digest(format!("output-{}", crate::node::now()).as_bytes())
    );
    let spec = SourceJob {
        namespace: namespace.clone(), revision: snapshot.receipt().revision.clone(),
        image: std::env::var("HACK_LOCAL_TEST_IMAGE").map_err(|_| failure("Pinned image required."))?,
        argv: vec!["/usr/local/bin/bun".into(), "-e".into(), r#"
import {writeFileSync, readFileSync, unlinkSync} from 'node:fs';
writeFileSync('/output/marker', 'owned-output');
if (readFileSync('/output/marker', 'utf8') !== 'owned-output') throw Error('output unavailable');
try { writeFileSync('/input/forbidden-output', 'forbidden'); throw Error('input writable'); }
catch (e) { if (e.code !== 'EROFS') throw e; }
try { writeFileSync('/output/oversized', Buffer.alloc(70 * 1024 * 1024)); throw Error('output unbounded'); }
catch (e) { if (e.code !== 'ENOSPC') throw e; }
unlinkSync('/output/oversized');
writeFileSync('/output/after-full', 'still-usable');
console.log('output-limit-observed');
process.stdout.write('x'.repeat(40000));
process.stderr.write('y'.repeat(40000));
"#.into()],
        memory_bytes: 512 * 1024 * 1024,
    };
    let _admission = spec.admit(&candidate)?;
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let mut starts = 0;
    let result = super::run_source_job(&candidate, &job, &spec, 30000, |event| {
        if matches!(event, super::SourceJobEvent::Started) {
            starts += 1;
        }
        Ok(false)
    })?;
    let engine = Engine::connect(&candidate)?;
    let absent = engine
        .request(
            Method::GET,
            &format!("/v1.53/containers/hack-source-job-{job}/json"),
            None,
        )
        .expect_err("output container remains");
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let until = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let events = engine.job_events(&job, since, until)?;
    let passed = result.state == "succeeded"
        && result.exit_code == Some(0)
        && starts == 1
        && result.truncated
        && result.stdout.starts_with("output-limit-observed\n")
        && result.stdout.len() <= 16384
        && result.stderr.len() <= 16384
        && absent.code == "engine_not_found"
        && events.iter().filter(|e| e.as_str() == "start").count() == 1;
    let directory = candidate.state_root.join("review/wu06");
    state::private_directory(&directory)?;
    state::write(
        &directory.join("source-output.json"),
        &json!({
            "passed":passed,"publication_reused_without_copy":true,"inode_identity":before,
            "state":result.state,"exit_code":result.exit_code,"starts":starts,
            "truncated":result.truncated,"stdout_bytes":result.stdout.len(),"stderr_bytes":result.stderr.len(),
            "container_absent":absent.code == "engine_not_found","events":events,
            "scope":"64 MiB ephemeral output ENOSPC, immutable input, bounded retained logs; no durable artifact export"
        }),
    )?;
    if !passed {
        return Err(failure("Output bounds, reuse or cleanup control failed."));
    }
    Ok(())
}
