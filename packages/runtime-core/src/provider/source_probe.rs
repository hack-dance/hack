//! A bounded direct-engine plumbing probe, separate from durable job acceptance.
use super::{engine::Engine, source_transfer::TransferReceipt, state};
use crate::{Candidate, CandidateError};
use reqwest::Method;
use serde::Serialize;
use serde_json::{Value, json};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
pub struct ProbeReceipt {
    pub operation_id: String,
    pub namespace: String,
    pub revision: String,
    pub phase: String,
    pub image_id: Option<String>,
    pub container_id: Option<String>,
    pub captured_file_hashes_verified: bool,
    pub source_write_rejected: bool,
    pub container_absent: bool,
    pub image_absent: bool,
    pub failure_code: Option<String>,
}

fn problem(message: &str) -> CandidateError {
    CandidateError::new("source_probe", message)
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn image_id(value: &Value) -> Result<String, CandidateError> {
    value["Id"]
        .as_str()
        .filter(|s| s.strip_prefix("sha256:").is_some_and(|s| hex(s, 64)))
        .map(str::to_owned)
        .ok_or_else(|| problem("Invalid probe image identity."))
}
pub(super) fn container_id(value: &Value) -> Result<String, CandidateError> {
    value["Id"]
        .as_str()
        .filter(|s| hex(s, 64))
        .map(str::to_owned)
        .ok_or_else(|| problem("Invalid probe container identity."))
}
pub(super) fn labels_match(value: &Value, receipt: &ProbeReceipt) -> bool {
    let labels = &value["Config"]["Labels"];
    labels["io.hack-local.owner"] == receipt.namespace
        && labels["io.hack-local.probe"] == receipt.operation_id
        && labels["io.hack-local.fixture"] == "source-probe-v1"
}

fn inspect_optional(engine: &Engine<'_>, path: &str) -> Result<Option<Value>, CandidateError> {
    match engine.request(Method::GET, path, None) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code == "engine_not_found" => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn prepare_image(
    engine: &Engine<'_>,
    record: &ProbeReceipt,
    program: Option<&str>,
) -> Result<(), CandidateError> {
    let image = format!("hack-local-source-probe:{}", record.operation_id);
    engine.guest().execute(r#"
umask 077
for directory in /storage/hack-source "/storage/hack-source/$1"; do
  test ! -L "$directory"
  if test ! -e "$directory"; then mkdir "$directory"; fi
  test "$(stat -c %u:%a "$directory")" = 0:700
done
stage="/storage/hack-source/$1/.probe-image-$2"
mkdir "$stage"
mkdir "$stage/bin" "$stage/lib"
cp /bin/busybox "$stage/bin/busybox"
cp /lib/ld-musl-aarch64.so.1 "$stage/lib/ld-musl-aarch64.so.1"
ln -s ld-musl-aarch64.so.1 "$stage/lib/libc.musl-aarch64.so.1"
cat > "$stage/observer"
chown -R 0:0 "$stage"
chmod 755 "$stage/bin" "$stage/lib" "$stage/bin/busybox" "$stage/lib/ld-musl-aarch64.so.1" "$stage/observer"
test "$(stat -c %u:%g:%a "$stage/bin/busybox")" = 0:0:755
tar -C "$stage" -cf - bin lib observer |
  /opt/hack-engine/docker --host unix:///run/hack-local/docker.sock image import \
    --change "LABEL io.hack-local.owner=$1 io.hack-local.probe=$2 io.hack-local.fixture=source-probe-v1" - "$3"
"#, &[&record.namespace, &record.operation_id, &image], Some(program.unwrap_or("#!/bin/busybox sh\nexit 0\n")))?;
    Ok(())
}

fn execute(
    engine: &Engine<'_>,
    transfer: &TransferReceipt,
    record: &mut ProbeReceipt,
    path: &Path,
) -> Result<(), CandidateError> {
    let image = format!("hack-local-source-probe:{}", record.operation_id);
    let name = format!("hack-source-probe-{}", record.operation_id);
    let base = format!(
        "/storage/hack-source/{}/{}",
        record.namespace, record.revision
    );
    engine.guest().execute(
        r#"
test ! -L "$1"
test "$(cat "$1/archive.sha256")" = "$2"
"#,
        &[&base, &transfer.archive_sha256],
        None,
    )?;
    prepare_image(engine, record, None)?;
    let inspected = engine.request(Method::GET, &format!("/v1.53/images/{image}/json"), None)?;
    if !labels_match(&inspected, record) {
        return Err(problem("Probe image ownership differs from intent."));
    }
    record.image_id = Some(image_id(&inspected)?);
    record.phase = "creating-container".into();
    state::write(path, record)?;
    let config = json!({
        "Image": record.image_id,
        "WorkingDir": "/input",
        "Entrypoint": ["/bin/busybox", "sh", "-c"],
        "Cmd": ["set -eu; /bin/busybox sha256sum -c /manifest >/dev/null; if /bin/busybox sh -c 'echo write-probe > /input/.hack-source-write-probe' 2>/dev/null; then exit 90; fi"],
        "Labels": {"io.hack-local.owner":record.namespace,"io.hack-local.probe":record.operation_id,"io.hack-local.fixture":"source-probe-v1"},
        "HostConfig": {"ReadonlyRootfs":true,"NetworkMode":"none","Memory":67108864,"NanoCpus":1000000000_u64,
            "PidsLimit":32,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],
            "Mounts":[{"Type":"bind","Source":transfer.guest_path,"Target":"/input","ReadOnly":true},
                {"Type":"bind","Source":format!("{base}/files.sha256"),"Target":"/manifest","ReadOnly":true}]}
    });
    let created = engine.request(
        Method::POST,
        &format!("/v1.53/containers/create?name={name}"),
        Some(&config),
    )?;
    let id = container_id(&created)?;
    record.container_id = Some(id.clone());
    record.phase = "starting-container".into();
    state::write(path, record)?;
    let inspected = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
    if !labels_match(&inspected, record) || inspected["HostConfig"]["ReadonlyRootfs"] != true {
        return Err(problem(
            "Created probe container differs from owned read-only intent.",
        ));
    }
    let mounts = inspected["Mounts"]
        .as_array()
        .ok_or_else(|| problem("Missing source-probe mounts."))?;
    for (destination, source) in [
        ("/input", transfer.guest_path.as_str()),
        ("/manifest", &format!("{base}/files.sha256")),
    ] {
        if !mounts.iter().any(|m| {
            m["Destination"] == destination
                && m["Source"] == source
                && m["RW"] == false
                && m["Type"] == "bind"
        }) {
            return Err(problem(
                "Source-probe mount was not independently confirmed read-only.",
            ));
        }
    }
    engine.request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = engine.request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)?;
        if !labels_match(&value, record) {
            return Err(problem("Probe container ownership changed."));
        }
        if value["State"]["Status"] == "exited" {
            if value["State"]["ExitCode"] != 0 || value["State"]["OOMKilled"] != false {
                return Err(problem(
                    "Captured-source hash/read-only probe failed inside its container.",
                ));
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err(problem("Source-probe container exceeded its deadline."));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    record.captured_file_hashes_verified = true;
    record.source_write_rejected = true;
    record.phase = "cleaning-up".into();
    state::write(path, record)
}

pub(super) fn cleanup(
    engine: &Engine<'_>,
    record: &mut ProbeReceipt,
) -> Result<(), CandidateError> {
    // Unique intended names plus exact persisted operation labels reconcile lost creation
    // acknowledgements. A foreign resource at either name is never adopted or removed.
    let name = format!("hack-source-probe-{}", record.operation_id);
    if let Some(value) = inspect_optional(engine, &format!("/v1.53/containers/{name}/json"))? {
        if !labels_match(&value, record) {
            return Err(problem(
                "Foreign container at the probe name; no cleanup authority.",
            ));
        }
        let id = container_id(&value)?;
        if record
            .container_id
            .as_ref()
            .is_some_and(|expected| *expected != id)
        {
            return Err(problem("Probe container ID changed."));
        }
        record.container_id = Some(id.clone());
        engine.request(
            Method::DELETE,
            &format!("/v1.53/containers/{id}?force=true"),
            None,
        )?;
        if inspect_optional(engine, &format!("/v1.53/containers/{id}/json"))?.is_some() {
            return Err(problem("Probe container still exists after cleanup."));
        }
    }
    record.container_absent = true;
    let image = format!("hack-local-source-probe:{}", record.operation_id);
    if let Some(value) = inspect_optional(engine, &format!("/v1.53/images/{image}/json"))? {
        if !labels_match(&value, record) {
            return Err(problem(
                "Foreign image at the probe tag; no cleanup authority.",
            ));
        }
        let id = image_id(&value)?;
        if record
            .image_id
            .as_ref()
            .is_some_and(|expected| *expected != id)
        {
            return Err(problem("Probe image ID changed."));
        }
        record.image_id = Some(id.clone());
        engine.request(Method::DELETE, &format!("/v1.53/images/{id}"), None)?;
        if inspect_optional(engine, &format!("/v1.53/images/{id}/json"))?.is_some() {
            return Err(problem("Probe image still exists after cleanup."));
        }
    }
    record.image_absent = true;
    engine.guest().execute(
        r#"
stage="/storage/hack-source/$1/.probe-image-$2"
if test -e "$stage" || test -L "$stage"; then
  test ! -L "$stage"
  test "$(stat -c %u:%a "$stage")" = 0:700
  for dir in bin lib; do test ! -L "$stage/$dir"; done
  rm -f "$stage/bin/busybox" "$stage/lib/ld-musl-aarch64.so.1" "$stage/lib/libc.musl-aarch64.so.1" "$stage/observer"
  rmdir "$stage/bin" "$stage/lib" "$stage"
fi
"#,
        &[&record.namespace, &record.operation_id],
        None,
    )?;
    Ok(())
}

pub(super) fn new_record(
    candidate: &Candidate,
    namespace: &str,
    revision: &str,
) -> Result<(ProbeReceipt, std::path::PathBuf), CandidateError> {
    if !hex(namespace, 64) || !hex(revision, 64) {
        return Err(problem("Invalid probe source identity."));
    }
    let mut bytes = [0_u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|_| problem("Cannot create a source-probe operation identity."))?;
    let operation_id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let directory = candidate.state_root.join("run/source-probes");
    state::private_directory(&directory)?;
    let path = directory.join(format!("{operation_id}.json"));
    if path.try_exists().map_err(state::io)? {
        return Err(problem(
            "Source-probe operation path already exists; no overwrite.",
        ));
    }
    let receipt = ProbeReceipt {
        operation_id,
        namespace: namespace.into(),
        revision: revision.into(),
        phase: "preparing-image".into(),
        image_id: None,
        container_id: None,
        captured_file_hashes_verified: false,
        source_write_rejected: false,
        container_absent: false,
        image_absent: false,
        failure_code: None,
    };
    state::write(&path, &receipt)?;
    Ok((receipt, path))
}

pub fn verify(
    candidate: &Candidate,
    transfer: &TransferReceipt,
) -> Result<ProbeReceipt, CandidateError> {
    if !hex(&transfer.namespace, 64)
        || !hex(&transfer.revision, 64)
        || !hex(&transfer.archive_sha256, 64)
        || transfer.guest_path
            != format!(
                "/storage/hack-source/{}/{}/tree",
                transfer.namespace, transfer.revision
            )
    {
        return Err(problem(
            "Source probe requires an owned content-transfer receipt.",
        ));
    }
    let engine = Engine::connect(candidate)?;
    let (mut receipt, path) = new_record(candidate, &transfer.namespace, &transfer.revision)?;
    let result = execute(&engine, transfer, &mut receipt, &path);
    if let Err(error) = &result {
        receipt.failure_code = Some(error.code.into());
    }
    let cleaned = cleanup(&engine, &mut receipt);
    receipt.phase = if cleaned.is_err() {
        "cleanup-uncertain"
    } else if result.is_err() {
        "failed-cleaned"
    } else {
        "verified-cleaned"
    }
    .into();
    state::write(&path, &receipt)?;
    cleaned?;
    result?;
    Ok(receipt)
}
