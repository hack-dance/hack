//! One authored service exec. The live owner retains all generation and input fences.
use super::*;
use base64::Engine as _;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct ExecSelection {
    pub service: String,
    pub argv: Vec<String>,
    pub workdir: Option<String>,
}
impl ExecSelection {
    pub(in crate::provider::graph::native) fn valid(&self) -> bool {
        valid_selection(&self.service, &self.argv, self.workdir.as_deref())
    }
}
/// The closed noninteractive command domain shared by exec and one-off run.
pub(super) fn valid_selection(service: &str, argv: &[String], workdir: Option<&str>) -> bool {
    !service.is_empty()
        && service.len() <= 128
        && service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        && !argv.is_empty()
        && argv.len() <= 256
        && !argv[0].is_empty()
        && argv
            .iter()
            .all(|s| !s.contains('\0') && s.len() <= 16 * 1024)
        && argv.iter().map(String::len).sum::<usize>() <= 64 * 1024
        && workdir.is_none_or(|p| p.starts_with('/') && !p.contains('\0') && p.len() <= 4096)
}
/// One finite base64 stream of at most 1 MiB in canonical encoding.
pub(super) fn valid_stream(text: &str) -> bool {
    text.len() <= 1_398_104
        && base64::engine::general_purpose::STANDARD
            .decode(text)
            .is_ok_and(|bytes| {
                bytes.len() <= 1024 * 1024
                    && base64::engine::general_purpose::STANDARD.encode(bytes) == *text
            })
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::provider::graph::native) struct ServiceExec {
    pub receipt: Receipt,
    pub service: String,
    pub container: String,
    pub exit_code: i32,
    pub stdout_base64: String,
    pub stderr_base64: String,
    pub truncated: bool,
}
impl ServiceExec {
    pub(in crate::provider::graph::native) fn valid(&self, selected: &ExecSelection) -> bool {
        self.service == selected.service
            && self.receipt.phase == Phase::ReadyObserved
            && self.receipt.readiness.contains_key(&selected.service)
            && self
                .receipt
                .resources
                .get(&format!("container:{}", selected.service))
                .and_then(|r| r.id.as_deref())
                == Some(self.container.as_str())
            && (0..=255).contains(&self.exit_code)
            && valid_stream(&self.stdout_base64)
            && valid_stream(&self.stderr_base64)
    }
}
#[cfg(target_os = "macos")]
pub(in crate::provider::graph::native) fn execute(
    candidate: &Candidate,
    expected: &Receipt,
    selected: &ExecSelection,
    guard: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<ServiceExec, CandidateError> {
    if !selected.valid() {
        return Err(refused());
    }
    guard()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let engine = Engine::connect_command_until(candidate, deadline)?;
    let (receipt, _) = journal::load(
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
    let result = execute_with(&backend, receipt, selected, deadline)?;
    journal::read_control(candidate, &expected.review)?.check_binding(expected)?;
    guard()?;
    managed_environment::remaining_until(deadline)?;
    Ok(result)
}
/// The exact running member's start generation; a restart changes it.
pub(super) fn generation(value: &Value) -> Result<String, CandidateError> {
    if value["State"]["Running"] != true
        || value["State"]["Paused"] != false
        || value["State"]["Restarting"] != false
    {
        return Err(refused());
    }
    value["State"]["StartedAt"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .map(str::to_owned)
        .ok_or_else(refused)
}
pub(super) fn member<B: Backend>(
    backend: &B,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<String, CandidateError> {
    generation(&inspected(backend, receipt, resource)?.ok_or_else(refused)?)
}
pub(super) fn execute_with<B: Backend>(
    backend: &B,
    receipt: Receipt,
    selected: &ExecSelection,
    deadline: Instant,
) -> Result<ServiceExec, CandidateError> {
    managed_environment::remaining_until(deadline)?;
    if !selected.valid()
        || receipt.phase != Phase::ReadyObserved
        || !receipt.readiness.contains_key(&selected.service)
    {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{}", selected.service))
        .filter(|r| r.kind == Kind::Container)
        .ok_or_else(refused)?;
    let container = resource.id.clone().ok_or_else(refused)?;
    snapshot_until(backend, receipt.clone(), Some(deadline))?;
    let generation = member(backend, &receipt, resource)?;
    // Recheck the complete current selection immediately before each create/start
    // transport, and after each response. A failed post-effect proof withholds output.
    let fresh = || {
        managed_environment::remaining_until(deadline)?;
        snapshot_until(backend, receipt.clone(), Some(deadline))?;
        if member(backend, &receipt, resource)? != generation {
            return Err(refused());
        }
        Ok(())
    };
    fresh()?;
    let (exit_code, stdout, stderr, truncated) =
        backend.exec(&container, selected, deadline, &fresh)?;
    fresh()?;
    let result = ServiceExec {
        receipt,
        service: selected.service.clone(),
        container,
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
