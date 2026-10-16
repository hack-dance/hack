//! Manual kernel-event observer; this does not execute the selected application's code.
use super::{SyncSession, engine::Engine, source_probe, state};
use crate::{Candidate, CandidateError, project};
use reqwest::Method;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

const OBSERVER: &str = r#"#!/bin/busybox sh
set -eu
test "$#" -ge 3 || exit 0
test "$3" = "$WATCH_FILENAME" || exit 0
if test -f "/input/$WATCH_FILENAME"; then
  value=$(/bin/busybox sha256sum "/input/$WATCH_FILENAME" | /bin/busybox cut -d ' ' -f 1)
else
  value=absent
fi
printf '%s\n' "$value" > /output/value.next
/bin/busybox mv /output/value.next /output/value
printf '%s\n' "$1" >> /output/events
"#;

fn fail(message: &str) -> CandidateError {
    CandidateError::new("watch_observer", message)
}

fn start(
    candidate: &Candidate,
    record: &mut source_probe::ProbeReceipt,
    path: &Path,
    name: &str,
) -> Result<(), CandidateError> {
    let engine = Engine::connect(candidate)?;
    source_probe::prepare_image(&engine, record, Some(OBSERVER))?;
    let image = engine.request(
        Method::GET,
        &format!(
            "/v1.53/images/hack-local-source-probe:{}/json",
            record.operation_id
        ),
        None,
    )?;
    if !source_probe::labels_match(&image, record) {
        return Err(fail("Observer image ownership mismatch."));
    }
    record.image_id = Some(source_probe::image_id(&image)?);
    state::write(path, record)?;
    let config = json!({
        "Image": record.image_id,
        "Entrypoint": ["/bin/busybox","inotifyd","/observer","/input:cwmdny"],
        "Env": [format!("WATCH_FILENAME={name}")],
        "Labels":{"io.hack-local.owner":record.namespace,"io.hack-local.probe":record.operation_id,"io.hack-local.fixture":"source-probe-v1"},
        "HostConfig":{"ReadonlyRootfs":true,"NetworkMode":"none","Memory":67108864,"NanoCpus":1000000000_u64,
            "PidsLimit":32,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
            "Tmpfs":{"/output":"rw,noexec,nosuid,size=1048576,mode=1777"},
            "Mounts":[{"Type":"bind","Source":format!("/storage/hack-workspaces/{}/tree",record.namespace),"Target":"/input","ReadOnly":true}]}
    });
    let created = engine.request(
        Method::POST,
        &format!(
            "/v1.53/containers/create?name=hack-source-probe-{}",
            record.operation_id
        ),
        Some(&config),
    )?;
    let id = source_probe::container_id(&created)?;
    record.container_id = Some(id.clone());
    record.phase = "starting-application-observer".into();
    state::write(path, record)?;
    let inspected = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    if !source_probe::labels_match(&inspected, record)
        || !inspected["Mounts"].as_array().is_some_and(|mounts| {
            mounts
                .iter()
                .any(|m| m["Destination"] == "/input" && m["RW"] == false)
        })
    {
        return Err(fail(
            "Observer input is not independently confirmed read-only.",
        ));
    }
    engine.request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
    drop(engine);
    // Read kernel watch registration, not a marker written before inotify setup.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let engine = Engine::connect(candidate)?;
        let result = engine.guest().execute(
            r#"
/opt/hack-engine/docker --host unix:///run/hack-local/docker.sock exec "$1" /bin/busybox sh -c '
for file in /proc/1/fdinfo/*; do
  if /bin/busybox grep -q "^inotify " "$file"; then printf registered; exit 0; fi
done
exit 1'
"#,
            &[&id],
            None,
        );
        if matches!(result.as_deref(), Ok("registered")) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(fail(
                "Application did not register a kernel filesystem watch.",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    record.phase = "watching-application".into();
    state::write(path, record)
}

fn observed(
    candidate: &Candidate,
    record: &source_probe::ProbeReceipt,
) -> Result<String, CandidateError> {
    let engine = Engine::connect(candidate)?;
    let id = record
        .container_id
        .as_deref()
        .ok_or_else(|| fail("Observer container identity missing."))?;
    let inspected = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    if !source_probe::labels_match(&inspected, record) || inspected["State"]["Running"] != true {
        return Err(fail("Owned application observer is not running."));
    }
    // Read only materialized output, never the source, to answer a check.
    let value = engine.guest().execute(
        r#"
/opt/hack-engine/docker --host unix:///run/hack-local/docker.sock exec "$1" /bin/busybox sh -c '
if test -f /output/value; then /bin/busybox cat /output/value; else printf unobserved; fi'
"#,
        &[id],
        None,
    )?;
    let value = value.trim();
    if !["unobserved", "absent"].contains(&value)
        && !(value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    {
        return Err(fail("Invalid materialized application observation."));
    }
    Ok(value.into())
}

#[test]
#[ignore = "Manual owned development VM only; requires HACK_LOCAL_TEST_ROOT, HACK_LOCAL_TEST_PROJECT, and external watchdog"]
fn owned_source_watch_live() -> Result<(), CandidateError> {
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").map_err(|_| fail("Candidate root required."))?,
    ))?;
    let source = std::path::PathBuf::from(
        std::env::var("HACK_LOCAL_TEST_PROJECT").map_err(|_| fail("Project required."))?,
    );
    let compose =
        std::env::var("HACK_LOCAL_TEST_COMPOSE").unwrap_or_else(|_| "compose.yaml".into());
    let status = super::status(&candidate)?;
    if status.phase != "running" || status.profile != Some(super::Profile::Development) {
        return Err(fail("Owned development fixture is not running."));
    }
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
    let (mut record, path) =
        source_probe::new_record(&candidate, &report.plan.namespace, &"0".repeat(64))?;
    let name = format!("hkl-watch-{}.txt", record.operation_id);
    let marker = source.join(&name);
    let temporary = source.join(format!("hkl-watch-{}.temporary", record.operation_id));
    let mut receipts = Vec::new();
    let mut observations = Vec::new();
    let result = (|| -> Result<(), CandidateError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&marker)
            .map_err(|_| fail("Cannot exclusively create owned watch marker."))?;
        file.write_all(b"A\n")
            .map_err(|_| fail("Cannot initialize watch marker."))?;
        drop(file);
        let mut writer = SyncSession::open(&candidate, &record.namespace, &source)?;
        let capture = || {
            let report = plan()?;
            let environment_files = report
                .plan
                .services
                .values()
                .flat_map(|s| s.environment_files.iter().cloned())
                .collect();
            project::snapshot::capture(
                &source,
                &environment_files,
                &report.plan.source_selection.metadata_sha256,
            )
        };
        let snapshot = capture()?;
        if !snapshot.receipt().entries.iter().any(|e| e.path == name) {
            return Err(fail("Owned marker is excluded by project source policy."));
        }
        record.revision = snapshot.receipt().revision.clone();
        state::write(&path, &record)?;
        receipts.push(writer.apply(&snapshot, false)?);
        drop(snapshot);
        start(&candidate, &mut record, &path, &name)?;
        if observed(&candidate, &record)? != "unobserved" {
            return Err(fail("Observer read source before receiving a change."));
        }
        for value in [Some(b"B\n".as_slice()), None, Some(b"C\n".as_slice())] {
            let expected = if let Some(value) = value {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)
                    .map_err(|_| fail("Cannot create atomic marker replacement."))?;
                file.write_all(value)
                    .map_err(|_| fail("Cannot write marker replacement."))?;
                drop(file);
                fs::rename(&temporary, &marker)
                    .map_err(|_| fail("Cannot replace owned marker."))?;
                format!("{:x}", Sha256::digest(value))
            } else {
                fs::remove_file(&marker).map_err(|_| fail("Cannot delete owned marker."))?;
                "absent".into()
            };
            let snapshot = capture()?;
            receipts.push(writer.apply(&snapshot, false)?);
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if observed(&candidate, &record)? == expected {
                    observations.push(expected.clone());
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(fail(
                        "Application watcher did not materialize acknowledged source.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        fs::remove_file(&marker).map_err(|_| fail("Cannot remove final owned marker."))?;
        let snapshot = capture()?;
        receipts.push(writer.apply(&snapshot, false)?);
        Ok(())
    })();
    for file in [&marker, &temporary] {
        if let Ok(metadata) = fs::symlink_metadata(file) {
            if metadata.is_file()
                && fs::read(file).is_ok_and(|bytes| {
                    [b"A\n".as_slice(), b"B\n", b"C\n"].contains(&bytes.as_slice())
                })
            {
                let _ = fs::remove_file(file);
            }
        }
    }
    let cleanup = Engine::connect_cleanup(&candidate)
        .and_then(|engine| source_probe::cleanup(&engine, &mut record));
    record.phase = if cleanup.is_err() {
        "cleanup-uncertain"
    } else if result.is_err() {
        "watch-failed-cleaned"
    } else {
        "watch-verified-cleaned"
    }
    .into();
    state::write(&path, &record)?;
    let evidence = candidate
        .state_root
        .join("review/wu05/application-watch.json");
    state::write(
        &evidence,
        &json!({"scope":"container inotify callback over actual selected source; not Event Agent service startup",
        "source":source,"marker":name,"receipts":receipts,"observations":observations,
        "record":record,"passed":result.is_ok() && cleanup.is_ok()}),
    )?;
    cleanup?;
    result
}
