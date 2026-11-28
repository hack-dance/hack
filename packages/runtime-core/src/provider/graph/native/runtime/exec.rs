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
    /// Bytes past the 1 MiB cap of each stream, read and dropped (HACK-2759). Absent
    /// when nothing was dropped, and from an owner that predates them.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub stdout_dropped: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub stderr_dropped: u64,
}
#[allow(clippy::trivially_copy_pass_by_ref)]
pub(super) fn is_zero(count: &u64) -> bool {
    *count == 0
}
/// Dropped counts imply truncation and stay exact JSON integers for the CLI.
pub(super) fn valid_dropped(truncated: bool, stdout: u64, stderr: u64) -> bool {
    const SAFE: u64 = (1 << 53) - 1;
    stdout <= SAFE && stderr <= SAFE && (truncated || stdout + stderr == 0)
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
            && valid_dropped(self.truncated, self.stdout_dropped, self.stderr_dropped)
    }
}
/// The owner's answer code when its own lease wait for an authored exec expired
/// (HACK-2739). That wait is the first thing the owner does for the exec: no
/// journal was read, no container was touched and no command was started. The
/// wire carries only this code, which the requester forwards as the cause of its
/// `native_graph_foreground` refusal, so the CLI can say that nothing ran. A
/// `provider_busy` from anywhere else keeps its own code.
pub(super) const OWNER_EXEC_LEASE_BUSY: &str = "graph_authored_exec_lease_busy";

/// [`OWNER_EXEC_LEASE_BUSY`] for an authored one-off `hack run` (HACK-2742).
pub(super) const OWNER_RUN_LEASE_BUSY: &str = "graph_authored_run_lease_busy";

/// The owner's answer code when its own check ended an authored command before
/// it took the lease (HACK-2742): a pending signal (its `hack down`, a Ctrl-C of
/// the foreground owner), or a changed publication or pin. The check runs before
/// the wait and before every lease attempt, so nothing was read, touched or
/// started. Without this code the owner's plain `refused()` reached the CLI as
/// "unconfirmed".
pub(in crate::provider::graph::native) const OWNER_COMMAND_NOT_STARTED: &str =
    "graph_authored_command_not_started";

/// The owner's pre-effect wait code that `code` names, if it is one. Only the
/// macOS interactive requester reads it.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph::native) fn owner_pre_effect_code(
    code: &str,
) -> Option<&'static str> {
    [
        OWNER_EXEC_LEASE_BUSY,
        OWNER_RUN_LEASE_BUSY,
        OWNER_COMMAND_NOT_STARTED,
    ]
    .into_iter()
    .find(|known| *known == code)
}

/// Which authored command the owner answers, for its lease code.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum OwnerCommand {
    /// Finite and interactive `hack exec`.
    Exec,
    /// One-off `hack run`.
    Run,
}

/// The pre-effect code for a failure of the owner's own wait: its check refused
/// (`guard_refused`), or the lease stayed busy. Any other failure keeps its code.
pub(super) fn owner_wait_refusal(
    error: CandidateError,
    guard_refused: bool,
    command: OwnerCommand,
) -> CandidateError {
    if guard_refused {
        CandidateError::new(
            OWNER_COMMAND_NOT_STARTED,
            "The owner's check ended an authored command before it took the provider lease; nothing ran.",
        )
    } else if error.code == "provider_busy" {
        CandidateError::new(
            match command {
                OwnerCommand::Exec => OWNER_EXEC_LEASE_BUSY,
                OwnerCommand::Run => OWNER_RUN_LEASE_BUSY,
            },
            "The owner's authored command could not acquire the provider lease; nothing ran.",
        )
    } else {
        error
    }
}

/// The owner's guard and lease wait for one authored command, with their
/// pre-effect codes (HACK-2739, HACK-2742). The guard runs first, then before
/// every lease attempt and once after acquisition, so a pending signal ends the
/// wait within one backoff step. The wait counts against the command's fixed
/// `deadline` and is capped at `COMMAND_LEASE_WAIT`: it runs on the owner's only
/// loop, and the requester has already waited out a longer holder before it
/// sent the request. Nothing before the returned engine has an effect.
#[cfg(target_os = "macos")]
pub(super) fn owner_command_engine<'a>(
    candidate: &'a Candidate,
    deadline: Instant,
    guard: &dyn Fn() -> Result<(), CandidateError>,
    command: OwnerCommand,
) -> Result<Engine<'a>, CandidateError> {
    let guard_refused = Cell::new(false);
    let checked = || {
        guard().inspect_err(|_| guard_refused.set(true))?;
        Ok(())
    };
    checked().map_err(|error| owner_wait_refusal(error, true, command))?;
    Engine::connect_command_until(candidate, deadline, &checked)
        .map_err(|error| owner_wait_refusal(error, guard_refused.get(), command))
}

/// The owner's guard and lease wait for a finite or interactive exec, with the
/// exec's own lease code.
#[cfg(target_os = "macos")]
pub(super) fn owner_exec_engine<'a>(
    candidate: &'a Candidate,
    deadline: Instant,
    guard: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<Engine<'a>, CandidateError> {
    owner_command_engine(candidate, deadline, guard, OwnerCommand::Exec)
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
    let deadline = Instant::now() + Duration::from_secs(30);
    // The owner loop's guard (signals, publication, pin) runs before every lease
    // attempt, and the wait counts against this 30 s budget (HACK-2669). The
    // requester already waited out a longer holder before it sent this
    // (HACK-2739), so this wait only covers a holder that took the lease since.
    let engine = owner_exec_engine(candidate, deadline, guard)?;
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
    // The persistent-data witness is proven once before the first transport and
    // once after the last response (HACK-2752); see `snapshot_unwitnessed_until`.
    snapshot_until(backend, receipt.clone(), Some(deadline))?;
    let generation = member(backend, &receipt, resource)?;
    // Recheck the complete current selection immediately before each create/start
    // transport, and after each response. A failed post-effect proof withholds output.
    let fresh = || {
        managed_environment::remaining_until(deadline)?;
        snapshot_unwitnessed_until(backend, receipt.clone(), Some(deadline))?;
        if member(backend, &receipt, resource)? != generation {
            return Err(refused());
        }
        Ok(())
    };
    fresh()?;
    let (exit_code, stdout, stderr, dropped) =
        backend.exec(&container, selected, deadline, &fresh)?;
    managed_environment::remaining_until(deadline)?;
    snapshot_until(backend, receipt.clone(), Some(deadline))?;
    if member(backend, &receipt, resource)? != generation {
        return Err(refused());
    }
    let result = ServiceExec {
        receipt,
        service: selected.service.clone(),
        container,
        exit_code,
        stdout_base64: base64::engine::general_purpose::STANDARD.encode(stdout),
        stderr_base64: base64::engine::general_purpose::STANDARD.encode(stderr),
        truncated: dropped.any(),
        stdout_dropped: dropped.stdout,
        stderr_dropped: dropped.stderr,
    };
    if !result.valid(selected) {
        return Err(refused());
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
pub(in crate::provider::graph::native) fn interactive(
    candidate: &Candidate,
    expected: &Receipt,
    selected: &ExecSelection,
    console_size: [u16; 2],
    session: &str,
    guard: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<crate::provider::engine::interactive_exec::Attached, CandidateError> {
    use crate::provider::interactive_session::{Backend as SessionBackend, Binding};
    if !selected.valid() {
        return Err(refused());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    // The owner loop's guard (signals, publication, pin, client disconnect) runs
    // before every lease attempt, and the wait counts against this 30 s budget
    // (HACK-2669). Its failures are pre-intent: no session receipt exists yet,
    // so they carry their own codes (HACK-2742).
    let engine = owner_exec_engine(candidate, deadline, guard)?;
    let (receipt, _) = journal::load(
        candidate,
        expected.review.scope().run,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    receipt.check_binding(expected)?;
    if receipt.phase != Phase::ReadyObserved || !receipt.readiness.contains_key(&selected.service) {
        return Err(refused());
    }
    let owned = OwnedBackend {
        engine,
        launcher: None,
        leases: BTreeMap::new(),
    };
    let backend = GuardedBackend {
        backend: &owned,
        guard: Some(guard),
    };
    let resource = receipt
        .resources
        .get(&format!("container:{}", selected.service))
        .filter(|r| r.kind == Kind::Container)
        .ok_or_else(refused)?;
    let container = resource.id.clone().ok_or_else(refused)?;
    let generation = member(&backend, &receipt, resource)?;
    // The persistent-data witness is proven once before the session's first
    // transport; each transport rechecks the rest (HACK-2752).
    let checked = |witness: bool| {
        guard()?;
        managed_environment::remaining_until(deadline)?;
        journal::read_control(candidate, &expected.review)?.check_binding(expected)?;
        if witness {
            snapshot_until(&backend, receipt.clone(), Some(deadline))?;
        } else {
            snapshot_unwitnessed_until(&backend, receipt.clone(), Some(deadline))?;
        }
        if member(&backend, &receipt, resource)? != generation {
            return Err(refused());
        }
        Ok(())
    };
    checked(true)?;
    let fresh = || checked(false);
    owned.engine.interactive_start(
        candidate,
        Binding {
            backend: SessionBackend::Authored,
            namespace: receipt.review.scope().namespace.to_owned(),
            run: receipt.review.scope().run.to_owned(),
            owner: receipt.owner.clone(),
            boot: receipt.boot.clone(),
            container,
            generation: generation.clone(),
            service: selected.service.clone(),
        },
        crate::provider::engine::interactive_exec::Command {
            argv: &selected.argv,
            workdir: selected.workdir.as_deref(),
            console_size,
            session,
        },
        deadline,
        &fresh,
    )
}
