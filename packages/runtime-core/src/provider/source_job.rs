//! Snapshot-bound jobs use explicit immutable image and source identities.
use super::{engine::Engine, source_sync::SourceAdmission, source_transfer};
use crate::{Candidate, CandidateError};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const LAUNCH_SCRIPT: &str = r#"set -eu
hkl() { /hack-tools/ld-musl-aarch64.so.1 --library-path /hack-tools /hack-tools/busybox "$@"; }
sha256sum() { hkl sha256sum "$@"; }
find() { hkl find "$@"; }
sort() { hkl sort "$@"; }
cut() { hkl cut "$@"; }
readlink() { hkl readlink "$@"; }
cd /input
. /input-verifier
exec "$@"
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceJob {
    pub namespace: String,
    pub revision: String,
    /// A local engine content ID; tags and implicit pulls cannot change accepted input.
    pub image: String,
    pub argv: Vec<String>,
    pub memory_bytes: u64,
}

fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn error(message: &str) -> CandidateError {
    CandidateError::new("source_job", message)
}

impl SourceJob {
    pub fn validate(&self) -> Result<(), CandidateError> {
        if !hex(&self.namespace)
            || !hex(&self.revision)
            || !self.image.strip_prefix("sha256:").is_some_and(hex)
            || self.argv.is_empty()
            || self.argv.len() > 128
            || self.argv.iter().any(|arg| arg.contains('\0'))
            || self.argv.iter().map(String::len).sum::<usize>() > 32 * 1024
            || !self.argv[0].starts_with('/')
            || !(64 * 1024 * 1024..=2 * 1024 * 1024 * 1024).contains(&self.memory_bytes)
            || serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > 48 * 1024)
        {
            return Err(error(
                "Source jobs require exact source/image identities, bounded argv with an absolute executable, and 64 MiB to 2 GiB memory.",
            ));
        }
        Ok(())
    }

    pub fn admit(&self, candidate: &Candidate) -> Result<SourceAdmission, CandidateError> {
        self.validate()?;
        let guard = SourceAdmission::acquire(candidate, &self.namespace, &self.revision)?;
        let engine = Engine::connect(candidate)?;
        super::graph::check_reservations(candidate, &engine, None)?;
        check_reservations(&engine)?;
        let publication = source_transfer::load(candidate, &self.namespace, &self.revision)?;
        source_transfer::verify_published(engine.guest(), &publication)?;
        let image = engine.request(
            Method::GET,
            &format!("/v1.53/images/{}/json", self.image),
            None,
        )?;
        if image["Id"] != self.image || image["Architecture"] != "arm64" || image["Os"] != "linux" {
            return Err(error(
                "Accepted image is missing or incompatible with the current provider architecture.",
            ));
        }
        Ok(guard)
    }
}

pub enum SourceJobEvent {
    CheckCancellation,
    Started,
}

pub struct SourceJobResult {
    pub state: &'static str,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub exit_code: Option<i32>,
}

fn owned(value: &Value, job: &str, source: &SourceJob) -> bool {
    value["Config"]["Labels"]["io.hack-local.job"] == job
        && value["Config"]["Labels"]["io.hack-local.owner"] == source.namespace
        && value["Config"]["Labels"]["io.hack-local.source"] == source.revision
        && value["Image"] == source.image
}

fn inspect(engine: &Engine<'_>, name: &str) -> Result<Option<Value>, CandidateError> {
    match engine.request(Method::GET, &format!("/v1.53/containers/{name}/json"), None) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.code == "engine_not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// Explicit operator reconciliation only deallocates a verified owned container.
/// Absence proves resource cleanup, never the outcome of the earlier application command.
pub fn reconcile_source_job(
    candidate: &Candidate,
    job: &str,
    source: &SourceJob,
) -> Result<(), CandidateError> {
    source.validate()?;
    if !hex(job) {
        return Err(error("Invalid source job identity."));
    }
    cleanup(candidate, job, source)
}

fn cleanup(candidate: &Candidate, job: &str, source: &SourceJob) -> Result<(), CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let name = format!("hack-source-job-{job}");
    if let Some(value) = inspect(&engine, &name)? {
        if !owned(&value, job, source) {
            return Err(error("Container ownership mismatch; cleanup refused."));
        }
        let id = super::source_probe::container_id(&value)?;
        engine.request(
            Method::DELETE,
            &format!("/v1.53/containers/{id}?force=true&v=true"),
            None,
        )?;
    }
    if inspect(&engine, &name)?.is_some() {
        return Err(error("Owned job container remains after cleanup."));
    }
    Ok(())
}

fn prepare_tools(engine: &Engine<'_>) -> Result<String, CandidateError> {
    let path = format!("/storage/hack-job-tools-{}", engine.guest().incarnation());
    engine.guest().execute(r#"
test ! -L "$1"
if test ! -e "$1"; then
  mkdir "$1"
  cp /opt/hack-engine/docker-init "$1/init"
  cp /bin/busybox "$1/busybox"
  cp /lib/ld-musl-aarch64.so.1 "$1/ld-musl-aarch64.so.1"
  cat > "$1/launch.sh"
  ln -s ld-musl-aarch64.so.1 "$1/libc.musl-aarch64.so.1"
  chown -R 0:0 "$1"
  chmod 555 "$1" "$1/init" "$1/busybox" "$1/ld-musl-aarch64.so.1" "$1/launch.sh"
fi
test "$(stat -c %u:%g:%a "$1")" = 0:0:555
for name in init busybox ld-musl-aarch64.so.1 launch.sh; do
  test ! -L "$1/$name"
  test "$(stat -c %u:%g:%a "$1/$name")" = 0:0:555
done
test "$(sha256sum "$1/init" | cut -d ' ' -f 1)" = "$(sha256sum /opt/hack-engine/docker-init | cut -d ' ' -f 1)"
test "$(sha256sum "$1/busybox" | cut -d ' ' -f 1)" = "$(sha256sum /bin/busybox | cut -d ' ' -f 1)"
test "$(sha256sum "$1/ld-musl-aarch64.so.1" | cut -d ' ' -f 1)" = "$(sha256sum /lib/ld-musl-aarch64.so.1 | cut -d ' ' -f 1)"
test "$(readlink "$1/libc.musl-aarch64.so.1")" = ld-musl-aarch64.so.1
test "$(sha256sum "$1/launch.sh" | cut -d ' ' -f 1)" = "$2"
"#, &[&path, &format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(LAUNCH_SCRIPT.as_bytes()))], Some(LAUNCH_SCRIPT))?;
    Ok(path)
}

/// Accepted input is reverified at launch without requiring the development tree
/// to remain at the accepted revision. Lost starts are never transparently retried.
pub fn run_source_job(
    candidate: &Candidate,
    job: &str,
    source: &SourceJob,
    timeout_ms: u64,
    mut progress: impl FnMut(SourceJobEvent) -> Result<bool, CandidateError>,
) -> Result<SourceJobResult, CandidateError> {
    source.validate()?;
    if !hex(job) || !(100..=300_000).contains(&timeout_ms) {
        return Err(error("Invalid source job identity or deadline."));
    }
    let result = (|| {
        let engine = Engine::connect(candidate)?;
        super::graph::check_reservations(candidate, &engine, None)?;
        check_reservations(&engine)?;
        let publication = source_transfer::load(candidate, &source.namespace, &source.revision)?;
        source_transfer::verify_published(engine.guest(), &publication)?;
        let image = engine.request(
            Method::GET,
            &format!("/v1.53/images/{}/json", source.image),
            None,
        )?;
        if image["Id"] != source.image || image["Architecture"] != "arm64" || image["Os"] != "linux"
        {
            return Err(error(
                "Accepted image is unavailable or incompatible at launch.",
            ));
        }
        let name = format!("hack-source-job-{job}");
        if inspect(&engine, &name)?.is_some() {
            return Err(error(
                "Job container already exists; an uncertain start cannot be replayed.",
            ));
        }
        let tools = prepare_tools(&engine)?;
        let input = format!(
            "/storage/hack-source/{}/{}/tree",
            source.namespace, source.revision
        );
        let verifier = format!(
            "/storage/hack-source/{}/{}/verify.sh",
            source.namespace, source.revision
        );
        // Tini remains PID 1; timeout's child can kill the application process,
        // then init exit tears down remaining container descendants after client loss.
        let mut argv = vec![
            "/hack-tools/init".to_owned(),
            "--".into(),
            "/hack-tools/ld-musl-aarch64.so.1".into(),
            "--library-path".into(),
            "/hack-tools".into(),
            "/hack-tools/busybox".into(),
            "timeout".into(),
            "-s".into(),
            "KILL".into(),
            timeout_ms.div_ceil(1000).to_string(),
        ];
        argv.extend(
            [
                "/hack-tools/ld-musl-aarch64.so.1",
                "--library-path",
                "/hack-tools",
                "/hack-tools/busybox",
                "sh",
                "/hack-tools/launch.sh",
            ]
            .map(str::to_owned),
        );
        argv.extend(source.argv.iter().cloned());
        let config = json!({
            "Image": source.image, "Entrypoint": argv, "Cmd": [], "WorkingDir": "/input",
            "Env": ["LD_PRELOAD=", "LD_LIBRARY_PATH="],
            "Labels": {"io.hack-local.job":job,"io.hack-local.owner":source.namespace,"io.hack-local.source":source.revision},
            "HostConfig": {"ReadonlyRootfs":true,"NetworkMode":"none","Memory":source.memory_bytes,
                "MemorySwap":source.memory_bytes,"NanoCpus":1_000_000_000_u64,"PidsLimit":128,
                "CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
                "LogConfig":{"Type":"local","Config":{"max-size":"1m","max-file":"1","compress":"false"}},
                "Tmpfs":{"/output":"rw,nosuid,noexec,size=67108864,mode=1777","/tmp":"rw,nosuid,noexec,size=16777216,mode=1777"},
                "Mounts":[{"Type":"bind","Source":input,"Target":"/input","ReadOnly":true},
                    {"Type":"bind","Source":verifier,"Target":"/input-verifier","ReadOnly":true},
                    {"Type":"bind","Source":tools,"Target":"/hack-tools","ReadOnly":true}]}
        });
        if progress(SourceJobEvent::CheckCancellation)? {
            return Ok(SourceJobResult {
                state: "cancelled",
                stdout: String::new(),
                stderr: String::new(),
                truncated: false,
                exit_code: None,
            });
        }
        let created = engine.request(
            Method::POST,
            &format!("/v1.53/containers/create?name={name}"),
            Some(&config),
        )?;
        let id = super::source_probe::container_id(&created)?;
        let inspected =
            inspect(&engine, &id)?.ok_or_else(|| error("Created job container disappeared."))?;
        if !owned(&inspected, job, source)
            || !inspected["Mounts"].as_array().is_some_and(|mounts| {
                ["/input", "/input-verifier", "/hack-tools"]
                    .iter()
                    .all(|target| {
                        mounts
                            .iter()
                            .any(|m| m["Destination"] == *target && m["RW"] == false)
                    })
            })
        {
            return Err(error(
                "Job identity or read-only input mounts differ from acceptance.",
            ));
        }
        if progress(SourceJobEvent::CheckCancellation)? {
            return Ok(SourceJobResult {
                state: "cancelled",
                stdout: String::new(),
                stderr: String::new(),
                truncated: false,
                exit_code: None,
            });
        }
        engine.request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
        progress(SourceJobEvent::Started)?;
        let started = Instant::now();
        drop(engine);
        loop {
            let cancelled = progress(SourceJobEvent::CheckCancellation)?;
            let engine = Engine::connect(candidate)?;
            let value = inspect(&engine, &id)?
                .ok_or_else(|| error("Started job container disappeared."))?;
            if !owned(&value, job, source) {
                return Err(error("Job container identity changed."));
            }
            let timeout = started.elapsed() >= Duration::from_millis(timeout_ms);
            if cancelled || timeout || value["State"]["Running"] == false {
                let (stdout, stderr, truncated) = engine.logs(&id)?;
                let exit_code = (value["State"]["Running"] == false)
                    .then(|| {
                        value["State"]["ExitCode"]
                            .as_i64()
                            .and_then(|n| i32::try_from(n).ok())
                    })
                    .flatten();
                let state = if cancelled {
                    "cancelled"
                } else if timeout {
                    "timed_out"
                } else if exit_code == Some(0) && value["State"]["OOMKilled"] == false {
                    "succeeded"
                } else {
                    "failed"
                };
                return Ok(SourceJobResult {
                    state,
                    stdout,
                    stderr,
                    truncated,
                    exit_code,
                });
            }
            drop(engine);
            std::thread::sleep(Duration::from_millis(100));
        }
    })();
    // Name plus immutable labels reconcile a lost create reply; no start is replayed.
    cleanup(candidate, job, source)?;
    result.map_err(|failure| {
        CandidateError::new(
            "source_job_failed_cleaned",
            format!(
                "Source job failed ({}); owned container absence confirmed.",
                failure.code
            ),
        )
    })
}

/// A source container keeps the bounded workload slot until explicit verified removal, even after
/// its client exits. The provider lease serializes this observation with create/start operations.
pub(super) fn check_reservations(engine: &Engine<'_>) -> Result<(), CandidateError> {
    let value = engine.request(
        Method::GET,
        "/v1.53/containers/json?all=true&limit=1&filters=%7B%22label%22%3A%5B%22io.hack-local.job%22%5D%7D",
        None,
    )?;
    match value.as_array() {
        Some(values) if values.is_empty() => Ok(()),
        Some(_) => Err(CandidateError::new(
            "source_capacity_reserved",
            "A source-job container retains the workload slot; reconcile it before allocating or restarting a workload.",
        )),
        None => Err(error("Cannot verify source-job reservation inventory.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn valid() -> SourceJob {
        SourceJob {
            namespace: "a".repeat(64),
            revision: "b".repeat(64),
            image: format!("sha256:{}", "c".repeat(64)),
            argv: vec!["/bin/true".into()],
            memory_bytes: 64 * 1024 * 1024,
        }
    }
    #[test]
    fn input_contract_rejects_mutable_images_unsafe_argv_and_unbounded_resources() {
        assert!(valid().validate().is_ok());
        for image in ["busybox:latest", "sha256:1234", "/tmp/image"] {
            assert!(
                SourceJob {
                    image: image.into(),
                    ..valid()
                }
                .validate()
                .is_err()
            );
        }
        for argv in [
            vec![],
            vec!["sh".into()],
            vec!["/bin/sh".into(), "bad\0argument".into()],
            vec!["/bin/sh".into(), "x".repeat(32768)],
        ] {
            assert!(SourceJob { argv, ..valid() }.validate().is_err());
        }
        assert!(
            SourceJob {
                memory_bytes: 3 * 1024 * 1024 * 1024,
                ..valid()
            }
            .validate()
            .is_err()
        );
    }
}
