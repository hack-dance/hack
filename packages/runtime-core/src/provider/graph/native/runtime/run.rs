//! One authored one-off service command in a fresh container. The live owner retains
//! all generation and input fences; the one-off never joins the service's membership.
use super::*;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::path::Path;

const RECORDS: &str = "one-off";
const RECORD_LIMIT: usize = 16 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct RunSelection {
    pub service: String,
    pub argv: Vec<String>,
    pub workdir: Option<String>,
}
impl RunSelection {
    pub(in crate::provider::graph::native) fn valid(&self) -> bool {
        exec::valid_selection(&self.service, &self.argv, self.workdir.as_deref())
    }
}

/// Known completion of one reaped one-off container. `member` is the canonical
/// service container the one-off was derived from and shared its network with.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct ServiceRun {
    pub receipt: Receipt,
    pub service: String,
    pub member: String,
    pub container: String,
    pub name: String,
    pub exit_code: i32,
    pub stdout_base64: String,
    pub stderr_base64: String,
    pub truncated: bool,
}
impl ServiceRun {
    pub(in crate::provider::graph::native) fn valid(&self, selected: &RunSelection) -> bool {
        self.service == selected.service
            && self.receipt.phase == Phase::ReadyObserved
            && self.receipt.readiness.contains_key(&selected.service)
            && self
                .receipt
                .resources
                .get(&format!("container:{}", selected.service))
                .and_then(|r| r.id.as_deref())
                == Some(self.member.as_str())
            && hex(&self.container, 64)
            && self.container != self.member
            && valid_name(self.receipt.review.scope().run, &self.name)
            && (0..=255).contains(&self.exit_code)
            && exec::valid_stream(&self.stdout_base64)
            && exec::valid_stream(&self.stderr_base64)
    }
}

fn valid_name(run: &str, name: &str) -> bool {
    name.strip_prefix(&format!("hkn-{run}-oneoff-"))
        .is_some_and(|token| hex(token, 32))
}
fn token_of<'a>(run: &str, name: &'a str) -> Option<&'a str> {
    valid_name(run, name).then(|| &name[name.len() - 32..])
}
/// Durable intent for one one-off container, keyed by its unique name so an
/// interrupted create is still reapable. Argv, values and output are never recorded.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    kind: RecordKind,
    run: String,
    review: String,
    service: String,
    member: String,
    name: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RecordKind {
    NativeGraphOneOff,
}
impl Record {
    fn valid(&self, receipt: &Receipt) -> bool {
        self.version == 1
            && self.run == receipt.review.scope().run
            && self.review == receipt.review.review_id()
            && receipt.readiness.contains_key(&self.service)
            && receipt
                .resources
                .get(&format!("container:{}", self.service))
                .and_then(|r| r.id.as_deref())
                == Some(self.member.as_str())
            && valid_name(&self.run, &self.name)
    }
}
fn records_directory(root: &Path) -> Result<PathBuf, CandidateError> {
    let directory = root.join(RECORDS);
    state::private_directory(&directory)?;
    Ok(directory)
}
fn record_path(root: &Path, run: &str, name: &str) -> Result<PathBuf, CandidateError> {
    let token = token_of(run, name).ok_or_else(refused)?;
    Ok(records_directory(root)?.join(format!("{token}.json")))
}
fn sync_directory(path: &Path) -> Result<(), CandidateError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(state::io)
}
fn record(
    root: &Path,
    receipt: &Receipt,
    service: &str,
    member: &str,
    name: &str,
) -> Result<(), CandidateError> {
    let record = Record {
        version: 1,
        kind: RecordKind::NativeGraphOneOff,
        run: receipt.review.scope().run.into(),
        review: receipt.review.review_id().into(),
        service: service.into(),
        member: member.into(),
        name: name.into(),
    };
    if !record.valid(receipt) {
        return Err(refused());
    }
    let path = record_path(root, &record.run, name)?;
    if fs::symlink_metadata(&path).is_ok() {
        return Err(refused());
    }
    state::write(&path, &record)
}
fn discard(root: &Path, run: &str, name: &str) -> Result<(), CandidateError> {
    let path = record_path(root, run, name)?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    sync_directory(path.parent().ok_or_else(refused)?)
}
fn records(root: &Path, receipt: &Receipt) -> Result<Vec<Record>, CandidateError> {
    let directory = root.join(RECORDS);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(state::io(error)),
    };
    state::check_private_directory(&directory)?;
    let mut records = Vec::new();
    for entry in entries {
        let path = entry.map_err(state::io)?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(refused)?;
        if name.ends_with(".pending") {
            // An interrupted record publication proves nothing about an effect.
            return Err(refused());
        }
        let token = name.strip_suffix(".json").ok_or_else(refused)?;
        let bytes = native_input::read_file(&path, RECORD_LIMIT)?;
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if !record.valid(receipt) || token_of(&record.run, &record.name) != Some(token) {
            return Err(refused());
        }
        records.push(record);
    }
    Ok(records)
}

/// Unique one-off container name; uniqueness, not secrecy, is required because the
/// engine identity and ownership labels are verified separately.
fn one_off_name(run: &str, member: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut hasher = Sha256::new();
    hasher.update(b"hack.native-graph-one-off/v1\0");
    hasher.update(run.as_bytes());
    hasher.update(member.as_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(NEXT.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    hasher.update(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
            .to_le_bytes(),
    );
    let digest = hasher.finalize();
    let token = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("hkn-{run}-oneoff-{token}")
}
fn one_off_labels(receipt: &Receipt, service: &str, token: &str) -> Value {
    let scope = receipt.review.scope();
    json!({
        "io.hack-local.owner":receipt.owner,"io.hack-local.graph":scope.run,
        "io.hack-local.namespace":scope.namespace,"io.hack-local.plan":receipt.review.review_id(),
        "io.hack-local.kind":"one-off","io.hack-local.resource":service,
        "io.hack-local.input-kind":"native","io.hack-local.one-off":token
    })
}
fn one_off_labels_match(receipt: &Receipt, record: &Record, value: &Value) -> bool {
    let Some(token) = token_of(&record.run, &record.name) else {
        return false;
    };
    let expected = one_off_labels(receipt, &record.service, token);
    let observed = &value["Config"]["Labels"];
    value["Name"]
        .as_str()
        .is_some_and(|name| name.trim_start_matches('/') == record.name)
        && expected
            .as_object()
            .expect("one-off labels")
            .iter()
            .all(|(key, expected)| observed.get(key) == Some(expected))
}

/// Derive the one-off create configuration from the exact admitted member: its
/// image, effective environment, entrypoint, user and working directory, with the
/// member's network namespace. Mounted, private-delivery and storage members refuse.
fn one_off_config(
    receipt: &Receipt,
    resource: &Resource,
    observed: &Value,
    selected: &RunSelection,
    token: &str,
) -> Result<Value, CandidateError> {
    let image = resource.image.as_deref().ok_or_else(refused)?;
    let member = resource.id.as_deref().ok_or_else(refused)?;
    let process = &observed["Config"];
    if observed["Image"] != image
        || !observed["HostConfig"]["Mounts"]
            .as_array()
            .is_none_or(|mounts| mounts.is_empty())
        || !observed["Mounts"]
            .as_array()
            .is_none_or(|mounts| mounts.is_empty())
        || !process["Env"]
            .as_array()
            .is_none_or(|env| env.iter().all(Value::is_string))
        || !process["Entrypoint"]
            .as_array()
            .is_none_or(|entry| entry.iter().all(Value::is_string))
        || !(process["User"].is_null() || process["User"].is_string())
        || !(process["WorkingDir"].is_null() || process["WorkingDir"].is_string())
    {
        return Err(refused());
    }
    let mut config =
        config::container_base(image, one_off_labels(receipt, &selected.service, token));
    config["Cmd"] = json!(selected.argv);
    config["OpenStdin"] = json!(false);
    config["Tty"] = json!(false);
    if let Some(entry) = process["Entrypoint"].as_array() {
        config["Entrypoint"] = json!(entry);
    }
    if let Some(env) = process["Env"].as_array() {
        config["Env"] = json!(env);
    }
    if let Some(user) = process["User"].as_str().filter(|user| !user.is_empty()) {
        config["User"] = json!(user);
    }
    if let Some(workdir) = selected.workdir.as_deref().or_else(|| {
        process["WorkingDir"]
            .as_str()
            .filter(|directory| !directory.is_empty())
    }) {
        config["WorkingDir"] = json!(workdir);
    }
    if let Some(init) = observed["HostConfig"]["Init"].as_bool() {
        config["HostConfig"]["Init"] = json!(init);
    }
    config["HostConfig"]["NetworkMode"] = json!(format!("container:{member}"));
    config["HostConfig"]["AutoRemove"] = json!(false);
    Ok(config)
}

#[cfg(target_os = "macos")]
pub(in crate::provider::graph::native) fn execute(
    candidate: &Candidate,
    expected: &Receipt,
    selected: &RunSelection,
    guard: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<ServiceRun, CandidateError> {
    if !selected.valid() {
        return Err(refused());
    }
    guard()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let engine = Engine::connect_command_until(candidate, deadline)?;
    let (receipt, root) = journal::load(
        candidate,
        expected.review.scope().run,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    receipt.check_binding(expected)?;
    let owned = OwnedBackend {
        engine,
        launcher: None,
        leases: BTreeMap::new(),
    };
    let backend = GuardedBackend {
        backend: &owned,
        guard: Some(guard),
    };
    let result = execute_with(&backend, receipt, &root, selected, deadline)?;
    journal::read_control(candidate, &expected.review)?.check_binding(expected)?;
    guard()?;
    managed_environment::remaining_until(deadline)?;
    Ok(result)
}
/// A record is published before the create effect and discarded only after the
/// one-off's proven removal; any interruption retains it for cleanup or recovery.
pub(super) fn execute_with<B: Backend>(
    backend: &B,
    receipt: Receipt,
    root: &Path,
    selected: &RunSelection,
    deadline: Instant,
) -> Result<ServiceRun, CandidateError> {
    managed_environment::remaining_until(deadline)?;
    if !selected.valid()
        || receipt.phase != Phase::ReadyObserved
        || !receipt.readiness.contains_key(&selected.service)
        || receipt.source.is_some()
        || receipt.data_mounts.contains_key(&selected.service)
    {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{}", selected.service))
        .filter(|r| r.kind == Kind::Container)
        .ok_or_else(refused)?;
    let member = resource.id.clone().ok_or_else(refused)?;
    snapshot_until(backend, receipt.clone(), Some(deadline))?;
    let observed = inspected(backend, &receipt, resource)?.ok_or_else(refused)?;
    let generation = exec::generation(&observed)?;
    let run = receipt.review.scope().run.to_owned();
    let name = one_off_name(&run, &member);
    let token = token_of(&run, &name).ok_or_else(refused)?;
    let config = one_off_config(&receipt, resource, &observed, selected, token)?;
    // Recheck the complete current selection immediately before each create/start
    // transport, and after each response. A failed post-effect proof withholds output.
    let fresh = || {
        managed_environment::remaining_until(deadline)?;
        snapshot_until(backend, receipt.clone(), Some(deadline))?;
        if exec::member(backend, &receipt, resource)? != generation {
            return Err(refused());
        }
        Ok(())
    };
    fresh()?;
    record(root, &receipt, &selected.service, &member, &name)?;
    let (container, exit_code, stdout, stderr, truncated) =
        backend.one_off(&name, &config, deadline, &fresh)?;
    fresh()?;
    discard(root, &run, &name)?;
    let result = ServiceRun {
        receipt,
        service: selected.service.clone(),
        member,
        container,
        name,
        exit_code,
        stdout_base64: base64::engine::general_purpose::STANDARD.encode(stdout),
        stderr_base64: base64::engine::general_purpose::STANDARD.encode(stderr),
        truncated,
    };
    if !result.valid(selected) {
        return Err(refused());
    }
    Ok(result)
}

/// Remove every recorded one-off of this run before the canonical members change.
/// Presence requires the exact one-off labels; absence discards the record. An
/// unproven removal keeps the record and refuses, never deleting a foreign container.
pub(super) fn reap<B: Backend>(
    backend: &B,
    receipt: &Receipt,
    root: &Path,
) -> Result<(), CandidateError> {
    for record in records(root, receipt)? {
        let path = format!("/v1.53/containers/{}/json", record.name);
        let observed = match backend.request(Method::GET, &path, None) {
            Ok(value) => Some(value),
            Err(error) if error.code == "engine_not_found" => None,
            Err(error) => return Err(error),
        };
        if let Some(value) = observed {
            let id = value["Id"]
                .as_str()
                .filter(|id| hex(id, 64))
                .ok_or_else(refused)?
                .to_owned();
            if !one_off_labels_match(receipt, &record, &value) {
                return Err(refused());
            }
            backend.request(
                Method::DELETE,
                &format!("/v1.53/containers/{id}?force=true&v=true"),
                None,
            )?;
            match backend.request(Method::GET, &path, None) {
                Err(error) if error.code == "engine_not_found" => {}
                Err(error) => return Err(error),
                Ok(_) => return Err(refused()),
            }
        }
        discard(root, &record.run, &record.name)?;
    }
    Ok(())
}
