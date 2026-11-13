//! Foreground graph startup owner. Keys and child handles never enter receipts.
use super::*;
mod jobs;
mod rebind;
use crate::provider::guest_tool::{APPEND, PREPARE, PUBLISH};
use crate::provider::{
    host_endpoint::HostEndpoint,
    lifecycle::{RelayChild, RelayLaunch},
    relay_owner::{
        Context,
        managed::{ManagedOwner, ManagedSlot},
        publication::PinnedEndpoint,
    },
};
use base64::Engine as _;
pub use rebind::RefreshPolicy;
pub(super) fn require_dependency_rebind_complete(
    root: &Path,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    rebind::require_complete(root, receipt)
}

pub(super) fn require_dependency_rebind_recovery_complete(
    root: &Path,
    receipt: &Receipt,
    boot: &str,
) -> Result<(), CandidateError> {
    rebind::require_recovery_complete(root, receipt, boot)
}

pub(super) fn archive_dependency_rebind_after_cleanup(
    root: &Path,
    original: &Receipt,
    cleaned: &Receipt,
    boot: &str,
) -> Result<(), CandidateError> {
    rebind::archive_after_cleanup(root, original, cleaned, boot)
}

#[cfg(target_os = "macos")]
pub(super) fn dependency_rebind_boot(
    root: &Path,
    receipt: &Receipt,
) -> Result<Option<String>, CandidateError> {
    rebind::boot(root, receipt)
}

#[cfg(target_os = "macos")]
pub(super) fn archive_retired_dependency_rebind(
    root: &Path,
    original: &Receipt,
    cleaned: &Receipt,
    boot: &str,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    rebind::archive::retired_completed(root, original, cleaned, boot, verify)
}

#[cfg(target_os = "macos")]
pub(super) fn retired_dependency_rebind_archive_complete(
    root: &Path,
    original: &Receipt,
    boot: &str,
) -> Result<bool, CandidateError> {
    rebind::archive::retired_archive_complete(root, original, boot)
}
use sha2::{Digest, Sha256};
use std::{io::Read, time::Instant};

/// One explicit host dependency for one service. The endpoint is a live captured
/// generation, not a port number or implicit host-gateway route.
#[derive(Clone)]
pub struct Dependency {
    pub service: String,
    pub binding: String,
    pub slot: u8,
    pub port: u16,
    pub aliases: Vec<String>,
    pub endpoint: HostEndpoint,
    /// An executable selection may follow its original stable supervisor. Fixed
    /// PID selections deliberately carry no refresh authority.
    pub refresh: Option<RefreshPolicy>,
}
/// Must outlive the graph using it. Drop revokes host grants and closes transport
/// handles; it does not claim guest processes were stopped or persistent data removed.
/// Call cleanup while the handle remains alive. Detached owner recovery is separate.
pub struct HostRelayRuntime {
    managed: ManagedOwner,
    context: Context,
    candidate: PathBuf,
    artifact: Vec<u8>,
    artifact_hash: String,
    dependencies: BTreeMap<(String, String), Dependency>,
    children: BTreeMap<(String, String), RelayChild>,
    templates: BTreeMap<String, Value>,
    job_targets: BTreeMap<String, Vec<crate::provider::relay_owner::Target>>,
    run: Option<String>,
    selected_run: Option<String>,
    control_generation: String,
    startup_cancelled: Option<fn() -> bool>,
    /// Sticky: a dependency rebind wrote its journal and did not complete. Its
    /// effects are unconfirmed, so automatic refresh must never try again.
    rebind_unconfirmed: bool,
    // Dropped after the managed listeners: only verified cleanup releases capacity.
    dependency_reservation: Option<super::super::dependency_slots::Reservation>,
}
fn refused() -> CandidateError {
    error(
        "graph_startup",
        "Graph dependency startup is incomplete or its owned identity changed.",
    )
}
// Fixed stage codes identify refusal boundaries without serializing configuration.
fn stage_refused(code: &'static str) -> CandidateError {
    error(
        code,
        "Graph dependency startup validation failed; configuration values omitted.",
    )
}
/// An owned service failed while dependency relays were attached. The stage code
/// stays `graph_startup_application_failed`; the message and service name the
/// failed service (exit code, death or health) instead of a validation failure.
fn application_failed(
    name: &str,
    observation: Observation,
    probe: Option<&crate::provider::http_probe::HttpProbe>,
) -> CandidateError {
    probes::service_failure("graph_startup_application_failed", name, observation, probe)
}
// Fresh and restored graphs both provision a new container generation. Retained
// stopped/ready receipts cannot authorize listener attachment.
fn validate_start_phase(resource_phase: &str, graph_phase: &str) -> Result<(), CandidateError> {
    if resource_phase != "start-intent" || !matches!(graph_phase, "preparing" | "restoring") {
        return Err(stage_refused("graph_startup_started_phase"));
    }
    Ok(())
}
/// Upper bound for the engine to record a container's own exit after its relay
/// transport has already reported exit. A container still running after this
/// window has genuinely lost its listener.
const LISTENER_EXIT_SETTLE: Duration = Duration::from_secs(10);
const LISTENER_EXIT_POLL: Duration = Duration::from_millis(25);

/// The relay transport is never container-death evidence: when the service's
/// main process exits, the relay inside the container ends with it, but the
/// engine can record the container's own exit only afterwards, which can take
/// seconds on a loaded VM.
/// Re-inspect while the container still reports running, up to `deadline`, so a
/// completed initializer or a crashing service is classified by its own exit
/// instead of as a lost listener. Each inspection is read-only and checks
/// cancellation first; the last observation is returned either way.
fn settle_exited_transport(
    mut observed: Value,
    deadline: Instant,
    poll: Duration,
    mut inspect: impl FnMut() -> Result<Value, CandidateError>,
) -> Result<Value, CandidateError> {
    while observed["State"]["Running"] == true && Instant::now() < deadline {
        std::thread::sleep(poll.min(deadline.saturating_duration_since(Instant::now())));
        observed = inspect()?;
    }
    Ok(observed)
}
fn verify_exited_listener(
    condition: Option<&Condition>,
    observed: &Value,
) -> Result<(), CandidateError> {
    if condition == Some(&Condition::Completed)
        && observed["State"]["Running"] == false
        && observed["State"]["ExitCode"] == 0
        && observed["State"]["OOMKilled"] != true
    {
        return Ok(());
    }
    let code = if observed["State"]["Running"] == true {
        "graph_startup_running_listener_lost"
    } else if observed["State"]["OOMKilled"] == true {
        "graph_startup_listener_oom"
    } else {
        "graph_startup_listener_unexpected_exit"
    };
    Err(stage_refused(code))
}

// One classifier for live status and effectful verification. Only the caller's
// callback may retain evidence; a presentation observation cannot write it.
fn classify_exited_listener(
    receipt: &mut Receipt,
    name: &str,
    observed: &Value,
    observation: Observation,
    mut record: impl FnMut(
        &mut Receipt,
        &str,
        Observation,
        Option<CandidateError>,
    ) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    if observation.failed() {
        record(receipt, name, observation, None)?;
        return Err(application_failed(
            name,
            observation,
            receipt.probes.get(name).map(|probe| &probe.config),
        ));
    }
    if let Err(error) = verify_exited_listener(receipt.readiness.get(name), observed) {
        if error.code == "graph_startup_listener_unexpected_exit"
            && observation == (Observation::Exited { code: 0 })
        {
            return record(receipt, name, observation, Some(error));
        }
        return Err(error);
    }
    Ok(())
}
fn verify_endpoint_generations(
    dependencies: &BTreeMap<(String, String), Dependency>,
    startup: &Startup,
) -> Result<(), CandidateError> {
    let mut generations = BTreeMap::new();
    for ((service, name), dependency) in dependencies {
        let selected = startup
            .services
            .get(service)
            .ok_or_else(|| stage_refused("graph_dependency_endpoint_changed"))?;
        let binding = selected
            .bindings
            .get(name)
            .ok_or_else(|| stage_refused("graph_dependency_endpoint_changed"))?;
        if binding.slot != dependency.slot
            || binding.port != dependency.port
            || binding.aliases != dependency.aliases
        {
            return Err(stage_refused("graph_dependency_endpoint_changed"));
        }
        // A completed job has no admitted relay or live endpoint obligation.
        // Its exact stopped container identity is verified separately below.
        if selected.phase == Phase::Completed {
            continue;
        }
        let generation = match generations.entry(dependency.slot) {
            std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::btree_map::Entry::Vacant(entry) => entry.insert(
                dependency
                    .endpoint
                    .fingerprint()
                    .map_err(|_| stage_refused("graph_dependency_endpoint_changed"))?,
            ),
        };
        if binding.endpoint_generation.as_deref() != Some(generation.as_str()) {
            return Err(stage_refused("graph_dependency_endpoint_changed"));
        }
    }
    Ok(())
}
fn completed_generation(
    receipt: &Receipt,
    boot: &str,
    resource: &Resource,
    observed: &Value,
    service: &Service,
) -> Result<[u8; 32], CandidateError> {
    if resource.kind != Kind::Container
        || receipt.readiness.get(&resource.key) != Some(&Condition::Completed)
        || !matches!(service.phase, Phase::Released | Phase::Completed)
        || observed["State"]["StartedAt"].as_str() != service.started_at.as_deref()
    {
        return Err(stage_refused("graph_dependency_completed_identity"));
    }
    host_relay::inspected_completed_generation(receipt, boot, resource, observed)
}
fn validate_routes<'a>(
    dependencies: impl Iterator<Item = &'a Dependency>,
    inputs: &project::inputs::ExecutionInputs,
) -> Result<(), CandidateError> {
    let mut selected: BTreeMap<&str, std::collections::BTreeSet<&str>> = BTreeMap::new();
    for dependency in dependencies {
        dependency_address(dependency.slot, &dependency.aliases)?;
        if !inputs.services.contains_key(&dependency.service) {
            return Err(dependency_hosts::refused());
        }
        let names = selected.entry(&dependency.service).or_default();
        for name in &dependency.aliases {
            if !names.insert(name) {
                return Err(dependency_hosts::refused());
            }
        }
    }
    for (service, values) in &inputs.services {
        if !values.extra_hosts.is_empty()
            && inputs
                .review
                .plan
                .services
                .get(service)
                .ok_or_else(dependency_hosts::refused)?
                .mounts
                .iter()
                .any(|mount| shadows_name_resolution(&mount.target))
        {
            return Err(dependency_hosts::refused());
        }
        let actual = selected.remove(service.as_str()).unwrap_or_default();
        let expected = values.extra_hosts.keys().map(String::as_str).collect();
        if actual != expected
            || values
                .extra_hosts
                .values()
                .any(|target| target != "host-gateway")
        {
            return Err(dependency_hosts::refused());
        }
    }
    Ok(())
}

fn matches_selected_run(selected: Option<&str>, run: &str) -> bool {
    selected.is_none_or(|selected| selected == run)
}
fn require_relay_admission(candidate: &Candidate, run: Option<&str>) -> Result<(), CandidateError> {
    if let Some(run) = run {
        super::super::acknowledged_publisher::require_no_pending_missing_lock(candidate, run)?;
        super::super::acknowledged_publisher::require_acknowledged_relay_complete(candidate, run)?;
    }
    Ok(())
}
fn relay_admission_gate(
    candidate: &Candidate,
    run: Option<&str>,
    deadline: Instant,
) -> Result<super::super::publication_gate::Guard, CandidateError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(error(
                "provider_busy",
                "Relay publication admission expired before provider acquisition.",
            ));
        }
        match super::super::publication_gate::Guard::acquire(candidate) {
            Err(error) if error.code == "provider_busy" => {
                std::thread::sleep(remaining.min(Duration::from_millis(50)));
            }
            Err(error) => return Err(error),
            Ok(gate) => {
                require_relay_admission(candidate, run)?;
                return Ok(gate);
            }
        }
    }
}
pub(in crate::provider::graph) fn control_root(
    state_root: &Path,
    owner: &str,
    boot: Option<&str>,
    run: Option<&str>,
) -> Result<PathBuf, CandidateError> {
    control_root_generation(state_root, owner, boot, run, None)
}

/// Reconstruct only the directory bound by this exact receipt and boot.
pub(in crate::provider::graph) fn receipt_control_root(
    state_root: &Path,
    receipt: &Receipt,
    boot: &str,
) -> Result<PathBuf, CandidateError> {
    let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
    control_root_generation(
        state_root,
        &receipt.owner,
        Some(boot),
        Some(&receipt.run),
        startup.control_generation.as_deref(),
    )
}

pub(in crate::provider::graph) fn process_control_generation(
    process: &crate::provider::identity::ProcessIdentity,
) -> Result<String, CandidateError> {
    let digest = Sha256::digest(
        serde_json::to_vec(&(
            "hack-graph-owner-process-v1",
            process.pid,
            process.start_micros,
            process.uid,
        ))
        .map_err(|_| refused())?,
    );
    Ok(format!("{digest:x}")[..32].to_owned())
}

pub(in crate::provider::graph) fn process_control_root(
    state_root: &Path,
    owner: &str,
    boot: &str,
    run: &str,
    process: &crate::provider::identity::ProcessIdentity,
) -> Result<PathBuf, CandidateError> {
    control_root_generation(
        state_root,
        owner,
        Some(boot),
        Some(run),
        Some(&process_control_generation(process)?),
    )
}

fn control_root_generation(
    state_root: &Path,
    owner: &str,
    boot: Option<&str>,
    run: Option<&str>,
    generation: Option<&str>,
) -> Result<PathBuf, CandidateError> {
    if generation.is_some_and(|value| !hex(value, 32)) {
        return Err(refused());
    }
    let identity = match run {
        Some(run) if hex(run, 32) => {
            json!(["hack-graph-owner-run-v1", state_root, owner, boot, run])
        }
        Some(_) => return Err(refused()),
        None => json!(["hack-graph-owner-v1", state_root, owner, boot]),
    };
    let identity = match generation {
        Some(generation) => json!(["hack-graph-owner-lifetime-v1", identity, generation]),
        None => identity,
    };
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).map_err(|_| refused())?)
    );
    Ok(PathBuf::from(format!(
        "/private/tmp/hkro-{}",
        &digest[..24]
    )))
}

impl HostRelayRuntime {
    /// Validate every declared name against explicit selected bindings before owner
    /// creation. Graph admission repeats this check against fresh executable inputs.
    pub fn validate_inputs(
        dependencies: &[Dependency],
        inputs: &project::inputs::ExecutionInputs,
    ) -> Result<(), CandidateError> {
        validate_routes(dependencies.iter(), inputs)
    }
    /// The caller supplies a reviewed Linux ARM64 static artifact and its pinned
    /// digest. This API does not infer provenance from a filename or select a build.
    pub fn new(
        candidate: &Candidate,
        artifact: &Path,
        expected_sha256: &str,
        dependencies: Vec<Dependency>,
    ) -> Result<Self, CandidateError> {
        Self::new_scoped(
            candidate,
            artifact,
            expected_sha256,
            dependencies,
            None,
            false,
        )
    }
    /// Run-scoped foreground owner identity. The selected run is validated before
    /// any artifact/provider effects and must match eventual graph admission.
    pub fn new_for_run(
        candidate: &Candidate,
        artifact: &Path,
        expected_sha256: &str,
        dependencies: Vec<Dependency>,
        run: &str,
    ) -> Result<Self, CandidateError> {
        if !hex(run, 32) {
            return Err(refused());
        }
        Self::new_scoped(
            candidate,
            artifact,
            expected_sha256,
            dependencies,
            Some(run),
            false,
        )
    }
    /// Allocate physical dependency transports pool-wide. Selection slots remain
    /// logical groups in the reviewed plan; admitted receipts record their mapping.
    pub fn new_for_run_auto(
        candidate: &Candidate,
        artifact: &Path,
        expected_sha256: &str,
        dependencies: Vec<Dependency>,
        run: &str,
    ) -> Result<Self, CandidateError> {
        if !hex(run, 32) {
            return Err(refused());
        }
        Self::new_scoped(
            candidate,
            artifact,
            expected_sha256,
            dependencies,
            Some(run),
            true,
        )
    }
    fn new_scoped(
        candidate: &Candidate,
        artifact: &Path,
        expected_sha256: &str,
        dependencies: Vec<Dependency>,
        selected_run: Option<&str>,
        automatic_slots: bool,
    ) -> Result<Self, CandidateError> {
        if !hex(expected_sha256, 64)
            || dependencies.len() > crate::provider::relay_auth::MAX_LOGICAL_BINDINGS
        {
            return Err(stage_refused("graph_startup_input"));
        }
        let bytes = relay_artifact(artifact, expected_sha256, !dependencies.is_empty())?;
        // The CLI constructs this relay before acquiring its foreground run
        // lock. Fence pending retirement before any new listener or reservation,
        // in the recovery path's gate-before-Engine order. This local guard is
        // released before foreground admission takes the gate again.
        let admission_deadline = Instant::now() + Duration::from_secs(30);
        let publication_gate = relay_admission_gate(candidate, selected_run, admission_deadline)?;
        let engine = Engine::connect_until(candidate, admission_deadline, || false)?;
        // Ordinary ACK retirement also holds the Engine lease. It may have
        // changed the journals while this constructor waited for that lease.
        publication_gate.verify(candidate)?;
        require_relay_admission(candidate, selected_run)?;
        let owner = state::Owner::load(candidate)?;
        engine.guest().verify()?;
        let context = host_relay::context(engine.guest().incarnation(), engine.guest().boot_id())?;
        let capacity = if dependencies.is_empty() {
            0
        } else {
            owner
                .dependency_sockets
                .ok_or_else(|| stage_refused("graph_startup_capacity"))?
                .slots
        };
        let mut selected = BTreeMap::new();
        let mut slots = BTreeMap::new();
        let mut refresh_policies = BTreeMap::new();
        let mut service_slots = std::collections::BTreeSet::new();
        let mut ports = std::collections::BTreeSet::new();
        let mut aliases = std::collections::BTreeSet::new();
        for dependency in dependencies {
            let address = dependency_address(dependency.slot, &dependency.aliases)?;
            let endpoint_generation = dependency.endpoint.generation()?;
            if dependency.service.is_empty()
                || (!automatic_slots && dependency.slot >= capacity)
                || dependency.port == 0
                || slots
                    .insert(dependency.slot, endpoint_generation)
                    .is_some_and(|prior| prior != endpoint_generation)
                || refresh_policies
                    .insert(dependency.slot, dependency.refresh.clone())
                    .is_some_and(|prior| prior != dependency.refresh)
                || !service_slots.insert((dependency.service.clone(), dependency.slot))
                || !binding_name(&dependency.binding)
                || !ports.insert((dependency.service.clone(), address, dependency.port))
                || !dependency
                    .aliases
                    .iter()
                    .all(|alias| aliases.insert((dependency.service.clone(), alias.clone())))
                || selected.contains_key(&(dependency.service.clone(), dependency.binding.clone()))
            {
                return Err(stage_refused("graph_startup_dependency_selection"));
            }
            selected.insert(
                (dependency.service.clone(), dependency.binding.clone()),
                dependency,
            );
        }
        // The native owner incarnation also lets pre-admission recovery locate
        // its directory before a Startup receipt exists. A replacement process
        // has a different birth time even when its PID was reused.
        let control_generation = process_control_generation(&crate::provider::identity::observe(
            std::process::id() as i32,
        )?)?;
        let control_root = control_root_generation(
            &candidate.state_root,
            &owner.token,
            owner.guest_boot_id.as_deref(),
            selected_run,
            Some(&control_generation),
        )?;
        state::private_directory(&control_root)?;
        let mut dependency_reservation = if let Some(run) = selected_run {
            super::super::dependency_slots::Reservation::reserve(
                candidate,
                &engine,
                run,
                &slots.keys().copied().collect(),
                automatic_slots,
            )?
        } else {
            super::super::dependency_slots::check_exact_available(
                candidate,
                &engine,
                &slots.keys().copied().collect(),
            )?;
            None
        };
        if let Some(reservation) = &dependency_reservation {
            let mapping = reservation.mapping();
            for dependency in selected.values_mut() {
                dependency.slot = *mapping.get(&dependency.slot).ok_or_else(refused)?;
            }
            slots = slots
                .into_iter()
                .map(|(logical, generation)| (mapping[&logical], generation))
                .collect();
        }
        let started = ManagedOwner::start(
            context,
            &control_root,
            slots
                .into_keys()
                .map(|slot| ManagedSlot {
                    slot,
                    path: owner.short_home.join(format!("dependency-{slot:02}.sock")),
                    canonical_parent: candidate.state_root.join("run/smolvm/home"),
                })
                .collect(),
        );
        let managed = match started {
            Ok(managed) => managed,
            Err(error) => {
                if let Some(reservation) = &mut dependency_reservation {
                    let _ = reservation.cancel_locked();
                }
                return Err(error);
            }
        };
        if let Some(reservation) = &mut dependency_reservation {
            if let Err(error) = reservation.bound() {
                drop(managed);
                let _ = reservation.cancel_locked();
                return Err(error);
            }
        }
        Ok(Self {
            managed,
            context,
            candidate: candidate.checkout.clone(),
            artifact: bytes,
            artifact_hash: expected_sha256.into(),
            dependencies: selected,
            children: BTreeMap::new(),
            templates: BTreeMap::new(),
            job_targets: BTreeMap::new(),
            run: None,
            selected_run: selected_run.map(str::to_owned),
            control_generation,
            startup_cancelled: None,
            rebind_unconfirmed: false,
            dependency_reservation,
        })
    }
    /// Armed only while the foreground initial startup runs, never during cleanup.
    pub(in crate::provider::graph) fn set_startup_cancellation(
        &mut self,
        check: Option<fn() -> bool>,
    ) {
        self.startup_cancelled = check;
    }
    pub fn endpoint(&self) -> PinnedEndpoint {
        self.managed.endpoint()
    }
    /// Event-driven notification only; draining does not authorize replacement.
    pub fn dependency_notification_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        self.managed.notification_fd()
    }
    pub fn drain_dependency_notifications(&self) -> Result<bool, CandidateError> {
        self.managed.drain_notifications()
    }
    /// True once any dependency rebind reached its journal without completing.
    /// Callers that retry automatically must stop: the outcome is uncertain.
    pub fn dependency_rebind_unconfirmed(&self) -> bool {
        self.rebind_unconfirmed
    }
    /// Host PIDs of the currently admitted listeners that may follow a
    /// replacement (executable or owner-scoped selections). Fixed-PID
    /// selections carry no replacement authority and are omitted. This is a
    /// selection of what to watch for exit, never authority to refresh.
    #[cfg(target_os = "macos")]
    pub fn refreshable_listener_identities(
        &self,
    ) -> Vec<crate::provider::identity::ProcessIdentity> {
        let mut identities: Vec<_> = self
            .dependencies
            .values()
            .filter(|dependency| dependency.refresh.is_some())
            .map(|dependency| dependency.endpoint.process_identity())
            .collect();
        identities.sort_by_key(|identity| identity.pid);
        identities.dedup();
        identities
    }
    /// Stop only recorded listener generations, then use enrolled retirement and
    /// graph cleanup. A failed stop or uncertain journal remains retained.
    pub(in crate::provider::graph) fn admission_started(&self) -> bool {
        self.run.is_some()
    }
    /// Fresh private restore currently supports the control-only owner. Validate
    /// before any listener or graph effect; dependency startup is not replayable.
    pub(in crate::provider::graph) fn cleanup_for_restore(
        &mut self,
        candidate: &Candidate,
        expected_generation: &str,
        deadline: std::time::Instant,
    ) -> Result<Receipt, CandidateError> {
        if self.candidate != candidate.checkout
            || !self.dependencies.is_empty()
            || !self.children.is_empty()
        {
            return Err(refused());
        }
        self.managed.verify_alive()?;
        host_relay::cleanup_with_relay_expected(
            candidate,
            self.run.as_deref().ok_or_else(refused)?,
            false,
            &self.endpoint(),
            Some((expected_generation, deadline)),
        )
    }
    pub fn cleanup(
        &mut self,
        candidate: &Candidate,
        remove_data: bool,
    ) -> Result<Receipt, CandidateError> {
        if self.candidate != candidate.checkout {
            return Err(refused());
        }
        let run = self.run.clone().ok_or_else(refused)?;
        if crate::provider::graph::directory(candidate, &run)?
            .join("one-off.json")
            .symlink_metadata()
            .is_ok()
        {
            crate::provider::graph::one_off::runtime::finish(candidate, self, &run)?;
        }
        if let Some(receipt) = self.cleanup_incomplete_rebind(candidate, &run, remove_data)? {
            let _engine = Engine::connect_cleanup_wait(candidate)?;
            self.release_dependency_reservation()?;
            return Ok(receipt);
        }
        let engine = Engine::connect_cleanup_wait(candidate)?;
        let (before, root) = crate::provider::graph::load(candidate, &engine, &run)?;
        // Capture before stopping any listener. The next required cleanup
        // journal commit retains the evidence; there is no advisory disk write
        // that could strand state.pending and prevent stopping.
        // Keep the persisted generation unchanged for rebind archival.
        let mut captured = before.clone();
        let classified = if captured.startup_failure.is_some() {
            Ok(())
        } else {
            self.verify_listeners(
                &engine,
                &mut captured,
                None,
                |receipt, name, observation, failure| {
                    if receipt.startup_failure.is_none() {
                        startup_failure::record(receipt, name, observation)?;
                    }
                    failure.map_or(Ok(()), Err)
                },
            )
        };
        if classified.is_err() && captured.startup_failure.is_none() {
            startup_failure::unrecorded();
        }
        let boot = engine.guest().boot_id().to_owned();
        for name in self.children.keys().cloned().collect::<Vec<_>>() {
            let child = self.children.get_mut(&name).ok_or_else(refused)?;
            engine
                .guest()
                .stop_relay_listener(child, Duration::from_secs(10))?;
            self.children.remove(&name);
        }
        drop(engine);
        let receipt = host_relay::cleanup_with_relay_captured(
            candidate,
            &run,
            remove_data,
            &self.endpoint(),
            None,
            captured.startup_failure,
        )?;
        self.children.clear();
        let cleanup_engine = Engine::connect_cleanup_wait(candidate)?;
        startup::verify_cleanup(&cleanup_engine, &receipt)?;
        rebind::archive_after_cleanup(&root, &before, &receipt, &boot)?;
        self.release_dependency_reservation()?;
        Ok(receipt)
    }
    // Caller retains the provider lease after verified graph cleanup. Close the
    // authenticated owner and its exact socket inodes before freeing capacity.
    fn release_dependency_reservation(&mut self) -> Result<(), CandidateError> {
        if let Some(reservation) = &mut self.dependency_reservation {
            self.managed.shutdown()?;
            reservation.cancel_locked()?;
        }
        Ok(())
    }
    fn check(&self, engine: &impl Inspection, receipt: &Receipt) -> Result<(), CandidateError> {
        self.managed.verify_alive()?;
        let context = host_relay::context(engine.incarnation(), engine.boot_id()?)?;
        if context.runtime != self.context.runtime
            || context.boot != self.context.boot
            || receipt.owner != engine.incarnation()
            || !matches_selected_run(self.selected_run.as_deref(), &receipt.run)
            || self.run.as_deref() != Some(&receipt.run)
        {
            return Err(refused());
        }
        engine.verify()
    }
    /// The status caller supplies no persistence callback. Effects retain the
    /// original failure-recording boundary under their exclusive Engine lease.
    fn verify_with(
        &mut self,
        engine: &impl Inspection,
        receipt: &mut Receipt,
        root: &Path,
        record: impl FnMut(
            &mut Receipt,
            &str,
            Observation,
            Option<CandidateError>,
        ) -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        self.check(engine, receipt)?;
        if matches!(
            receipt.phase.as_str(),
            "preparing" | "restoring" | "ready-observed"
        ) {
            rebind::require_complete(root, receipt)?;
        }
        if matches!(
            receipt.phase.as_str(),
            "preparing" | "restoring" | "ready-observed"
        ) && !self.dependencies.is_empty()
        {
            verify_endpoint_generations(
                &self.dependencies,
                receipt
                    .relay_startup
                    .as_ref()
                    .ok_or_else(|| stage_refused("graph_dependency_endpoint_changed"))?,
            )?;
        }
        if let Some(startup) = &receipt.relay_startup {
            for (name, service) in &startup.services {
                if service.phase == Phase::Completed {
                    let resource = receipt
                        .resources
                        .get(&format!("container:{name}"))
                        .ok_or_else(refused)?;
                    let observed =
                        inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
                    completed_generation(receipt, engine.boot_id()?, resource, &observed, service)?;
                }
            }
        }
        self.verify_listeners(engine, receipt, self.startup_cancelled, record)
    }

    // Called before cleanup stops any child. Cleanup passes no cancellation
    // callback: cancellation requests stopping, not loss of exit evidence.
    fn verify_listeners(
        &mut self,
        engine: &impl Inspection,
        receipt: &mut Receipt,
        cancelled: Option<fn() -> bool>,
        mut record: impl FnMut(
            &mut Receipt,
            &str,
            Observation,
            Option<CandidateError>,
        ) -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        for ((name, _), child) in &mut self.children {
            if child.poll_exit()?.is_some() {
                let resource = receipt
                    .resources
                    .get(&format!("container:{name}"))
                    .ok_or_else(refused)?;
                let observed = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
                let observed = settle_exited_transport(
                    observed,
                    Instant::now() + LISTENER_EXIT_SETTLE,
                    LISTENER_EXIT_POLL,
                    || {
                        if cancelled.is_some_and(|check| check()) {
                            return Err(error(
                                "graph_cancelled",
                                "Foreground startup was cancelled; owned cleanup is required.",
                            ));
                        }
                        inspect_resource(engine, receipt, resource)?.ok_or_else(refused)
                    },
                )?;
                let observation = probes::observe(engine, receipt, name, &observed)?;
                classify_exited_listener(receipt, name, &observed, observation, &mut record)?;
            }
        }
        Ok(())
    }

    pub(in crate::provider::graph) fn check_readonly(
        &mut self,
        observer: &impl Inspection,
        receipt: &Receipt,
        root: &Path,
    ) -> Result<(), CandidateError> {
        self.verify_with(observer, &mut receipt.clone(), root, |_, _, _, failure| {
            failure.map_or(Ok(()), Err)
        })
    }
}
impl Driver for HostRelayRuntime {
    fn admission_started(&self) -> bool {
        self.run.is_some()
    }

    fn process_services(&self) -> std::collections::BTreeSet<String> {
        self.dependencies
            .keys()
            .map(|(service, _)| service.clone())
            .collect()
    }

    fn check_cancelled(&self) -> Result<(), CandidateError> {
        if self.startup_cancelled.is_some_and(|check| check()) {
            return Err(error(
                "graph_cancelled",
                "Foreground startup was cancelled; owned cleanup is required.",
            ));
        }
        Ok(())
    }

    fn validate_inputs(
        &self,
        inputs: &project::inputs::ExecutionInputs,
    ) -> Result<(), CandidateError> {
        validate_routes(self.dependencies.values(), inputs)
    }
    fn verify(
        &mut self,
        engine: &Engine<'_>,
        receipt: &mut Receipt,
        root: &Path,
    ) -> Result<(), CandidateError> {
        self.verify_with(
            engine,
            receipt,
            root,
            |receipt, name, observation, failure| {
                if let Some(error) = failure {
                    return Err(startup_failure::preserve_listener_error(
                        root,
                        receipt,
                        name,
                        observation,
                        error,
                    ));
                }
                startup_failure::record(receipt, name, observation)?;
                state::write(&root.join("state.json"), receipt)
            },
        )
    }

    fn prepare(
        &mut self,
        engine: &Engine<'_>,
        receipt: &mut Receipt,
        root: &Path,
        configs: &mut BTreeMap<String, Value>,
    ) -> Result<(), CandidateError> {
        if self.run.is_some()
            || receipt.relay_startup.is_some()
            || !matches_selected_run(self.selected_run.as_deref(), &receipt.run)
        {
            return Err(stage_refused("graph_startup_prepare_state"));
        }
        if let Some(reservation) = &mut self.dependency_reservation {
            reservation.admitted();
        }
        let mut services: BTreeMap<String, Service> = BTreeMap::new();
        for ((name, binding), dependency) in &self.dependencies {
            let config = configs
                .get(name)
                .ok_or_else(|| stage_refused("graph_startup_service_config"))?;
            launcher::validate(config)
                .map_err(super::super::process_refusals::Refused::into_error)?;
            if config["HostConfig"]["Init"] != true {
                return Err(stage_refused("graph_startup_init"));
            }
            if !services.contains_key(name) {
                let mut random = [0u8; 16];
                fs::File::open("/dev/urandom")
                    .and_then(|mut f| f.read_exact(&mut random))
                    .map_err(state::io)?;
                services.insert(
                    name.clone(),
                    Service {
                        generation: random.iter().map(|b| format!("{b:02x}")).collect(),
                        bindings: BTreeMap::new(),
                        phase: Phase::Prepared,
                        started_at: None,
                    },
                );
            }
            services.get_mut(name).ok_or_else(refused)?.bindings.insert(
                binding.clone(),
                Binding {
                    slot: dependency.slot,
                    endpoint_generation: Some(dependency.endpoint.fingerprint()?),
                    port: dependency.port,
                    aliases: dependency.aliases.clone(),
                    process: None,
                },
            );
        }
        receipt.relay_startup = Some(Startup {
            control_only: self.dependencies.is_empty(),
            guest_root: None,
            control_root: self.endpoint().runtime_root().into(),
            control_generation: Some(self.control_generation.clone()),
            artifact: self.artifact_hash.clone(),
            services,
        });
        if !receipt
            .relay_startup
            .as_ref()
            .ok_or_else(refused)?
            .valid(receipt)
        {
            return Err(stage_refused("graph_startup_binding_validation"));
        }
        self.templates = configs.clone();
        self.run = Some(receipt.run.clone());
        self.check(engine, receipt)?;
        state::write(&root.join("state.json"), receipt)?;
        // Cancellation is safe only after this graph has a durable cleanup owner.
        self.check_cancelled()?;
        if self.dependencies.is_empty() {
            return cleanup::absent(engine, receipt);
        }
        let identity = engine
            .guest()
            .execute(PREPARE, &[&receipt.run, &receipt.owner], None)?;
        let (device, inode) = identity.trim_end().split_once(':').ok_or_else(refused)?;
        let identity = (
            device.parse::<u64>().map_err(|_| refused())?,
            inode.parse::<u64>().map_err(|_| refused())?,
        );
        if identity.1 == 0 {
            return Err(refused());
        }
        receipt
            .relay_startup
            .as_mut()
            .ok_or_else(refused)?
            .guest_root = Some(identity);
        state::write(&root.join("state.json"), receipt)?;
        for (index, chunk) in self.artifact.chunks(24 * 1024).enumerate() {
            self.check_cancelled()?;
            let offset = (index * 24 * 1024).to_string();
            engine.guest().execute(
                APPEND,
                &[&receipt.run, &offset],
                Some(&base64::engine::general_purpose::STANDARD.encode(chunk)),
            )?;
        }
        self.check_cancelled()?;
        engine
            .guest()
            .execute(PUBLISH, &[&receipt.run, &self.artifact_hash], None)?;
        for service in receipt
            .relay_startup
            .as_ref()
            .ok_or_else(refused)?
            .services
            .values()
        {
            self.check_cancelled()?;
            engine
                .guest()
                .execute(GATE, &[&receipt.run, &service.generation], None)?;
        }
        Ok(())
    }
    fn started(
        &mut self,
        engine: &Engine<'_>,
        receipt: &mut Receipt,
        root: &Path,
        config: &Value,
        service: &str,
    ) -> Result<(), CandidateError> {
        let dependencies: Vec<_> = self
            .dependencies
            .iter()
            .filter(|((name, _), _)| name == service)
            .map(|((_, binding), dependency)| (binding.clone(), dependency.endpoint.clone()))
            .collect();
        if dependencies.is_empty() {
            return Ok(());
        }
        self.check(engine, receipt)?;
        let resource = receipt
            .resources
            .get(&format!("container:{service}"))
            .ok_or_else(refused)?
            .clone();
        validate_start_phase(&resource.phase, &receipt.phase)?;
        let observed = inspect_resource(engine, receipt, &resource)?.ok_or_else(refused)?;
        let generation = host_relay::inspected_generation(
            receipt,
            engine.guest().boot_id(),
            &resource,
            &observed,
        )?;
        let selected = receipt
            .relay_startup
            .as_mut()
            .and_then(|s| s.services.get_mut(service))
            .ok_or_else(refused)?;
        if selected.phase != Phase::Prepared {
            return Err(refused());
        }
        engine
            .guest()
            .execute(HELD, &[&receipt.run, &selected.generation], None)?;
        selected.phase = Phase::ProvisionIntent;
        selected.started_at = Some(
            observed["State"]["StartedAt"]
                .as_str()
                .ok_or_else(refused)?
                .into(),
        );
        let selected = selected.clone();
        state::write(&root.join("state.json"), receipt)?;
        let scope = host_relay::graph_scope(self.context, &receipt.run)?;
        let mut targets = Vec::new();
        let result = (|| {
            let (uid, gid) = launcher::identity(config)?;
            for (name, endpoint) in dependencies {
                let binding = selected.bindings.get(&name).ok_or_else(refused)?;
                if binding.endpoint_generation.as_deref() != Some(endpoint.fingerprint()?.as_str())
                {
                    return Err(refused());
                }
                let identity = host_relay::named_binding_identity(generation, &name, binding)?;
                let grant = self
                    .managed
                    .register(scope, identity, binding.slot, endpoint)?;
                targets.push(grant.target);
                let child = engine.guest().launch_relay_listener(
                    RelayLaunch {
                        container: resource.id.as_deref().ok_or_else(refused)?,
                        uid,
                        gid,
                        slot: binding.slot,
                        port: binding.port,
                        address: dependency_address(binding.slot, &binding.aliases)?,
                    },
                    grant.credential.into_private_input()?,
                )?;
                let key = (service.to_owned(), name.clone());
                self.children.insert(key.clone(), child);
                let deadline = Instant::now() + Duration::from_secs(8);
                let process = loop {
                    self.check(engine, receipt)?;
                    let child = self.children.get_mut(&key).ok_or_else(refused)?;
                    if let Some(process) = child.poll_ready()? {
                        break process;
                    }
                    if Instant::now() >= deadline || child.poll_exit()?.is_some() {
                        return Err(refused());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                };
                let observed = inspect_resource(engine, receipt, &resource)?.ok_or_else(refused)?;
                if host_relay::inspected_generation(
                    receipt,
                    engine.guest().boot_id(),
                    &resource,
                    &observed,
                )? != generation
                {
                    return Err(refused());
                }
                receipt
                    .relay_startup
                    .as_mut()
                    .and_then(|s| s.services.get_mut(service))
                    .and_then(|s| s.bindings.get_mut(&name))
                    .ok_or_else(refused)?
                    .process = Some(process);
                state::write(&root.join("state.json"), receipt)?;
            }
            // Earlier listeners must still be live when the final binding is ready.
            for name in selected.bindings.keys() {
                if self
                    .children
                    .get_mut(&(service.into(), name.clone()))
                    .ok_or_else(refused)?
                    .poll_exit()?
                    .is_some()
                {
                    return Err(refused());
                }
            }
            let persisted = receipt
                .relay_startup
                .as_mut()
                .and_then(|s| s.services.get_mut(service))
                .ok_or_else(refused)?;
            if !persisted.all_provisioned() {
                return Err(refused());
            }
            persisted.phase = Phase::Provisioned;
            state::write(&root.join("state.json"), receipt)?;
            self.check(engine, receipt)?;
            engine
                .guest()
                .execute(RELEASE, &[&receipt.run, &selected.generation], None)?;
            receipt
                .relay_startup
                .as_mut()
                .and_then(|s| s.services.get_mut(service))
                .ok_or_else(refused)?
                .phase = Phase::Released;
            state::write(&root.join("state.json"), receipt)
        })();
        if service.starts_with("job-") {
            self.job_targets.insert(service.into(), targets.clone());
        }
        if result.is_err() {
            // Try every selected retirement even if an earlier retirement refuses.
            let mut failure = None;
            for target in targets {
                if let Err(error) = self.managed.retire(target) {
                    failure.get_or_insert(error);
                }
            }
            if let Some(error) = failure {
                return Err(error);
            }
        }
        result
    }
}
// Arguments are validated receipt IDs/digests. Artifact chunks are non-secret.
const GATE: &str = r#"
root="/storage/hack-graph-startup/$1"
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -e "$root/$2"; test ! -L "$root/$2"
mkdir -m 555 "$root/$2"
sync -f "$root"
"#;
const HELD: &str = r#"
root="/storage/hack-graph-startup/$1/$2"
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:555
test ! -e "$root/release"; test ! -L "$root/release"
test ! -e "$root/pending"; test ! -L "$root/pending"
"#;
const RELEASE: &str = r#"
root="/storage/hack-graph-startup/$1/$2"
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:555
test ! -e "$root/release"; test ! -L "$root/release"
test ! -e "$root/pending"; test ! -L "$root/pending"
(umask 077; set -C; printf '%s\n' "$2" > "$root/pending")
chmod 444 "$root/pending"; sync -f "$root/pending"
mv "$root/pending" "$root/release"; sync -f "$root"
"#;

fn relay_artifact(
    artifact: &Path,
    expected_sha256: &str,
    required: bool,
) -> Result<Vec<u8>, CandidateError> {
    if required {
        Ok(
            crate::provider::guest_tool::Artifact::read(artifact, expected_sha256)?
                .bytes()
                .to_vec(),
        )
    } else {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    #[test]
    fn status_and_cleanup_classify_the_same_exit_without_a_status_write() {
        let fixture = super::super::super::tests::Fixture::new();
        let root = &fixture.0;
        let original: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{"web":"started"},"resources":{"container:web":{"key":"web","kind":"container","name":format!("hkg-{}-container-0", "a".repeat(32)),"id":"e".repeat(64),"phase":"started","image":format!("sha256:{}", "f".repeat(64))}}})).unwrap();
        state::write(&root.join("state.json"), &original).unwrap();
        let bytes = fs::read(root.join("state.json")).unwrap();
        for code in [0, 7] {
            let observed = json!({"State":{"Running":false,"ExitCode":code,"OOMKilled":false}});
            let observation = Observation::Exited { code };
            let mut status = original.clone();
            let live_error = classify_exited_listener(
                &mut status,
                "web",
                &observed,
                observation,
                |_, _, _, error| error.map_or(Ok(()), Err),
            )
            .unwrap_err();
            assert!(status.startup_failure.is_none());
            assert_eq!(fs::read(root.join("state.json")).unwrap(), bytes);
            let mut cleanup = original.clone();
            let captured_error = classify_exited_listener(
                &mut cleanup,
                "web",
                &observed,
                observation,
                |receipt, service, observation, error| {
                    startup_failure::record(receipt, service, observation)?;
                    error.map_or(Ok(()), Err)
                },
            )
            .unwrap_err();
            assert_eq!(live_error.code, captured_error.code);
            assert_eq!(cleanup.startup_failure.unwrap().observation, observation);
            // Cleanup capture also has no standalone persistence step that
            // could strand state.pending before the required cleanup commit.
            assert_eq!(fs::read(root.join("state.json")).unwrap(), bytes);
            assert!(!root.join("state.pending").exists());
        }
        let mut completed = original;
        completed
            .readiness
            .insert("web".into(), Condition::Completed);
        classify_exited_listener(
            &mut completed,
            "web",
            &json!({"State":{"Running":false,"ExitCode":0,"OOMKilled":false}}),
            Observation::Exited { code: 0 },
            |_, _, _, _| panic!("successful completion is not failure evidence"),
        )
        .unwrap();
    }
    #[test]
    fn dependency_free_constructor_skips_artifact_but_required_artifact_uses_fixed_refusal() {
        let fixture = super::super::super::tests::Fixture::new();
        let absent = fixture.0.join("absent-guest-artifact");
        assert_eq!(
            relay_artifact(&absent, &"a".repeat(64), false).unwrap(),
            Vec::<u8>::new()
        );
        assert_eq!(
            relay_artifact(&absent, &"a".repeat(64), true)
                .unwrap_err()
                .code,
            "guest_tool_artifact"
        );
        assert!(!absent.exists());
    }
    #[test]
    fn transport_exit_waits_for_the_container_to_record_its_own_exit() {
        // A quick-exit initializer: its relay transport ends first, and the
        // engine still reports the container running for a few inspections.
        let running = json!({"State":{"Running":true,"ExitCode":0,"OOMKilled":false}});
        let exited = json!({"State":{"Running":false,"ExitCode":0,"OOMKilled":false}});
        let mut inspections = 0;
        let settled = settle_exited_transport(
            running.clone(),
            Instant::now() + Duration::from_secs(30),
            Duration::from_millis(1),
            || {
                inspections += 1;
                Ok(if inspections < 3 {
                    running.clone()
                } else {
                    exited.clone()
                })
            },
        )
        .unwrap();
        assert_eq!(inspections, 3);
        verify_exited_listener(Some(&Condition::Completed), &settled).unwrap();
        // Without settling, the same first observation is a lost listener.
        assert_eq!(
            verify_exited_listener(Some(&Condition::Completed), &running)
                .unwrap_err()
                .code,
            "graph_startup_running_listener_lost"
        );
        // A crashing service is classified by its own exit, not as lost.
        let crashed = json!({"State":{"Running":false,"ExitCode":3,"OOMKilled":false}});
        let settled = settle_exited_transport(
            running.clone(),
            Instant::now() + Duration::from_secs(30),
            Duration::from_millis(1),
            || Ok(crashed.clone()),
        )
        .unwrap();
        assert_eq!(settled["State"]["ExitCode"], 3);
    }
    #[test]
    fn transport_exit_with_a_container_that_keeps_running_is_still_lost() {
        let running = json!({"State":{"Running":true,"ExitCode":0,"OOMKilled":false}});
        let mut inspections = 0;
        let started = Instant::now();
        let settled = settle_exited_transport(
            running.clone(),
            Instant::now() + Duration::from_millis(60),
            Duration::from_millis(5),
            || {
                inspections += 1;
                Ok(running.clone())
            },
        )
        .unwrap();
        assert!(inspections >= 1);
        assert!(started.elapsed() >= Duration::from_millis(60));
        assert_eq!(
            verify_exited_listener(Some(&Condition::Completed), &settled)
                .unwrap_err()
                .code,
            "graph_startup_running_listener_lost"
        );
        // An already exited container is never re-inspected.
        let exited = json!({"State":{"Running":false,"ExitCode":0,"OOMKilled":false}});
        let settled = settle_exited_transport(
            exited.clone(),
            Instant::now() + Duration::from_secs(30),
            Duration::from_millis(1),
            || panic!("an exited container needs no further inspection"),
        )
        .unwrap();
        assert_eq!(settled, exited);
        // Cancellation and inspection refusals stop the wait.
        let refused = settle_exited_transport(
            running,
            Instant::now() + Duration::from_secs(30),
            Duration::from_millis(1),
            || Err(error("graph_cancelled", "cancelled")),
        )
        .unwrap_err();
        assert_eq!(refused.code, "graph_cancelled");
    }
    #[test]
    fn exited_listener_accepts_only_successful_completed_service() {
        let exited = json!({"State":{"Running":false,"ExitCode":0,"OOMKilled":false}});
        verify_exited_listener(Some(&Condition::Completed), &exited).unwrap();
        assert_eq!(
            verify_exited_listener(Some(&Condition::Started), &exited)
                .unwrap_err()
                .code,
            "graph_startup_listener_unexpected_exit"
        );
        assert_eq!(
            verify_exited_listener(Some(&Condition::Healthy), &exited)
                .unwrap_err()
                .code,
            "graph_startup_listener_unexpected_exit"
        );
        let running = json!({"State":{"Running":true,"ExitCode":0,"OOMKilled":false}});
        assert_eq!(
            verify_exited_listener(Some(&Condition::Completed), &running)
                .unwrap_err()
                .code,
            "graph_startup_running_listener_lost"
        );
        let oom = json!({"State":{"Running":false,"ExitCode":137,"OOMKilled":true}});
        assert_eq!(
            verify_exited_listener(Some(&Condition::Completed), &oom)
                .unwrap_err()
                .code,
            "graph_startup_listener_oom"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn released_dependency_detects_host_listener_rotation_without_adopting_it() {
        use std::{net::TcpListener, thread};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = HostEndpoint::capture(std::process::id() as i32, address.port()).unwrap();
        let pinned = endpoint.fingerprint().unwrap();
        let key = ("web".to_owned(), "content".to_owned());
        let mut dependencies = BTreeMap::from([(
            key,
            Dependency {
                service: "web".into(),
                binding: "content".into(),
                slot: 0,
                port: 8443,
                aliases: vec!["content.example".into()],
                endpoint,
                refresh: None,
            },
        )]);
        let startup = Startup {
            control_generation: None,
            control_only: false,
            guest_root: Some((1, 1)),
            control_root: PathBuf::from("/tmp/fixture-control"),
            artifact: "a".repeat(64),
            services: BTreeMap::from([(
                "web".into(),
                Service {
                    generation: "b".repeat(32),
                    bindings: BTreeMap::from([(
                        "content".into(),
                        Binding {
                            slot: 0,
                            endpoint_generation: Some(pinned.clone()),
                            port: 8443,
                            aliases: vec!["content.example".into()],
                            process: None,
                        },
                    )]),
                    phase: Phase::Released,
                    started_at: Some("fixture-start".into()),
                },
            )]),
        };
        verify_endpoint_generations(&dependencies, &startup).unwrap();

        drop(listener);
        let deadline = Instant::now() + Duration::from_millis(250);
        let replacement = loop {
            match TcpListener::bind(address) {
                Ok(replacement) => break replacement,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AddrInUse
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("replacement listener could not bind: {error}"),
            }
        };
        let current = HostEndpoint::capture(std::process::id() as i32, address.port()).unwrap();
        assert_ne!(current.fingerprint().unwrap(), pinned);
        assert_eq!(
            verify_endpoint_generations(&dependencies, &startup)
                .unwrap_err()
                .code,
            "graph_dependency_endpoint_changed"
        );
        dependencies.values_mut().next().unwrap().endpoint = current;
        assert_eq!(
            verify_endpoint_generations(&dependencies, &startup)
                .unwrap_err()
                .code,
            "graph_dependency_endpoint_changed"
        );
        drop(replacement);
    }
    #[test]
    fn restored_dependency_container_accepts_only_new_start_intent() {
        validate_start_phase("start-intent", "preparing").unwrap();
        validate_start_phase("start-intent", "restoring").unwrap();
        for phase in [
            "ready-observed",
            "stopped-data-retained",
            "removed",
            "failed-retained",
        ] {
            assert_eq!(
                validate_start_phase("start-intent", phase)
                    .unwrap_err()
                    .code,
                "graph_startup_started_phase"
            );
        }
        for phase in ["reserved", "created", "running", "removed"] {
            assert!(validate_start_phase(phase, "restoring").is_err());
        }
    }
    #[test]
    fn invalid_constructor_input_has_fixed_stage_code_before_effects() {
        let fixture = super::super::super::tests::Fixture::new();
        let failure = HostRelayRuntime::new(
            &Candidate::discover(&fixture.0).unwrap(),
            Path::new("/unread-artifact"),
            "invalid",
            Vec::new(),
        )
        .err()
        .expect("invalid digest refused");
        assert_eq!(failure.code, "graph_startup_input");
    }
    #[test]
    fn pending_relay_retirement_refuses_both_constructors_before_provider_effects() {
        let fixture = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let run = "a".repeat(32);
        let root = super::super::super::directory(&candidate, &run).unwrap();
        state::private_directory(&root).unwrap();
        let retained = root.join("retained-sentinel");
        fs::write(&retained, b"retained data").unwrap();
        let before = fs::symlink_metadata(&retained).unwrap();
        for phase in ["intent", "complete"] {
            let pending = root.join(format!(
                "acknowledged-relay-retirement-{}-{phase}.pending",
                "c".repeat(64)
            ));
            fs::write(&pending, b"interrupted retirement").unwrap();
            for automatic in [false, true] {
                let result = if automatic {
                    HostRelayRuntime::new_for_run_auto(
                        &candidate,
                        Path::new("/unread-artifact"),
                        &"b".repeat(64),
                        Vec::new(),
                        &run,
                    )
                } else {
                    HostRelayRuntime::new_for_run(
                        &candidate,
                        Path::new("/unread-artifact"),
                        &"b".repeat(64),
                        Vec::new(),
                        &run,
                    )
                };
                assert_eq!(
                    result.err().expect("pending retirement refused").code,
                    "graph_acknowledged_relay_retirement"
                );
                assert!(!candidate.state_root.join("run/smolvm").exists());
                assert_eq!(fs::read(&pending).unwrap(), b"interrupted retirement");
                assert_eq!(fs::read(&retained).unwrap(), b"retained data");
                let after = fs::symlink_metadata(&retained).unwrap();
                assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
                // Failure releases the constructor gate; no owner escapes and
                // ordinary foreground publication can acquire it afterward.
                super::super::super::publication_gate::Guard::acquire(&candidate).unwrap();
            }
            fs::remove_file(pending).unwrap();
        }
    }
    #[test]
    fn relay_admission_waits_for_gate_release_without_provider_effects() {
        let fixture = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let gate = super::super::super::publication_gate::Guard::acquire(&candidate).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                drop(gate);
            });
            let acquired = relay_admission_gate(&candidate, Some(&"a".repeat(32)), deadline)
                .expect("released publication gate admitted");
            acquired.verify(&candidate).unwrap();
            assert!(!candidate.state_root.join("run/smolvm").exists());
        });
        super::super::super::publication_gate::Guard::acquire(&candidate).unwrap();
    }
    #[test]
    fn relay_admission_gate_timeout_has_no_provider_effects_or_deadline_renewal() {
        let fixture = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let gate = super::super::super::publication_gate::Guard::acquire(&candidate).unwrap();
        let deadline = Instant::now() + Duration::from_millis(20);
        let failure = relay_admission_gate(&candidate, None, deadline)
            .err()
            .expect("held publication gate expired");
        assert_eq!(failure.code, "provider_busy");
        assert!(Instant::now() >= deadline);
        assert!(!candidate.state_root.join("run/smolvm").exists());
        gate.verify(&candidate).unwrap();
        drop(gate);
        assert_eq!(
            relay_admission_gate(&candidate, None, deadline)
                .err()
                .expect("expired original deadline remains expired")
                .code,
            "provider_busy"
        );
    }
    #[test]
    fn declared_aliases_must_be_bound_exactly_before_owner_creation() {
        let fixture = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let project = fixture.0.join("project");
        fs::create_dir(&project).unwrap();
        fs::write(
            project.join("compose.yaml"),
            serde_json::to_vec(&json!({"services":{"web":{
                "image":format!("sha256:{}", "a".repeat(64)),"network_mode":"none","read_only":true,
                "extra_hosts":["one.example:host-gateway","two.example:host-gateway"]
            }}}))
            .unwrap(),
        )
        .unwrap();
        let options = || project::PlanOptions {
            branch: None,
            project: &project,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let plan = project::plan(&candidate, options()).unwrap();
        let inputs =
            project::inputs::compile(&candidate, options(), &plan.plan_id, &BTreeMap::new())
                .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = HostEndpoint::capture(
            std::process::id() as i32,
            listener.local_addr().unwrap().port(),
        )
        .unwrap();
        let mut dependencies = vec![
            Dependency {
                service: "web".into(),
                binding: "one".into(),
                slot: 0,
                port: 443,
                aliases: vec!["one.example".into()],
                endpoint: endpoint.clone(),
                refresh: None,
            },
            Dependency {
                service: "web".into(),
                binding: "two".into(),
                slot: 1,
                port: 443,
                aliases: vec!["two.example".into()],
                endpoint,
                refresh: None,
            },
        ];
        HostRelayRuntime::validate_inputs(&dependencies, &inputs).unwrap();
        let mut inputs = inputs;
        for target in [
            "/etc",
            "/etc/hosts",
            "/etc/nsswitch.conf",
            "/etc/hosts/child",
            "/etc/nsswitch.conf/child",
        ] {
            inputs.review.plan.services.get_mut("web").unwrap().mounts = vec![project::MountPlan {
                subpath: None,
                kind: "bind".into(),
                source: "source".into(),
                target: target.into(),
                read_only: true,
                source_policy: "fixture".into(),
            }];
            assert_eq!(
                HostRelayRuntime::validate_inputs(&dependencies, &inputs)
                    .unwrap_err()
                    .code,
                "graph_dependency_hosts"
            );
        }
        inputs.review.plan.services.get_mut("web").unwrap().mounts[0].target =
            "/etc/hosts-backup".into();
        HostRelayRuntime::validate_inputs(&dependencies, &inputs).unwrap();
        inputs
            .review
            .plan
            .services
            .get_mut("web")
            .unwrap()
            .mounts
            .clear();
        assert!(HostRelayRuntime::validate_inputs(&dependencies[..1], &inputs).is_err());
        dependencies[1].aliases = vec!["one.example".into()];
        assert!(HostRelayRuntime::validate_inputs(&dependencies, &inputs).is_err());
        dependencies[1].aliases = vec!["unrequested.example".into()];
        assert!(HostRelayRuntime::validate_inputs(&dependencies, &inputs).is_err());
        dependencies[1].service = "unrequested".into();
        assert!(HostRelayRuntime::validate_inputs(&dependencies, &inputs).is_err());
        assert!(!candidate.state_root.exists());
    }
}

#[cfg(test)]
mod application_failure_tests {
    use super::*;
    #[test]
    fn an_application_failure_names_the_service_not_dependency_validation() {
        let error = application_failed("deps", Observation::Exited { code: 3 }, None);
        assert_eq!(error.code, "graph_startup_application_failed");
        assert_eq!(error.service.as_deref(), Some("deps"));
        let message = error.message.to_string();
        assert!(message.contains("deps exited with code 3"), "{message}");
        assert!(!message.contains("validation"), "{message}");
        let dead = application_failed("deps", Observation::Dead, None);
        assert!(dead.message.to_string().contains("dead or OOM-killed"));
        // An invalid service identifier is never echoed as the service.
        assert_eq!(
            application_failed("bad name", Observation::Dead, None).service,
            None
        );
    }
}

#[cfg(test)]
mod owner_scope_tests {
    use super::*;
    #[test]
    fn restored_owner_stops_without_replaying_legacy_pending_coordinator() {
        use crate::provider::relay_owner::lifecycle_intent::Coordinator;
        let state = std::env::temp_dir().join(format!("owner-restore-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&state).unwrap();
        let run = "a".repeat(32);
        let owner = "b".repeat(32);
        let context = super::super::super::host_relay::context(&owner, "boot").unwrap();
        let graph = super::super::super::host_relay::graph_scope(context, &run).unwrap();
        let old_root = control_root(&state, &owner, Some("boot"), Some(&run)).unwrap();
        state::private_directory(&old_root).unwrap();
        let mut old_owner = ManagedOwner::start(context, &old_root, vec![]).unwrap();
        let endpoint = old_owner.endpoint();
        let mut pending =
            Coordinator::begin_graph_enrolled(&endpoint, graph, [4; 32], None, |_| Ok(())).unwrap();
        pending
            .prepare_graph(&endpoint, Duration::from_secs(2))
            .unwrap();
        assert!(
            pending
                .execute::<()>([4; 32], || Err(CandidateError::new(
                    "publisher_stop_uncertain",
                    "legacy publisher exited before stop"
                )))
                .is_err()
        );
        drop(pending);
        old_owner.shutdown().unwrap();
        let bytes = fs::read(old_root.join("relay-lifecycle/state.json")).unwrap();
        let process = crate::provider::identity::observe(std::process::id() as i32).unwrap();
        let fresh_root = process_control_root(&state, &owner, "boot", &run, &process).unwrap();
        assert_ne!(fresh_root, old_root);
        let mut replacement = process.clone();
        replacement.executable = "/fixture/renamed-runtime".into();
        assert_eq!(
            fresh_root,
            process_control_root(&state, &owner, "boot", &run, &replacement).unwrap()
        );
        replacement.start_micros += 1;
        assert_ne!(
            fresh_root,
            process_control_root(&state, &owner, "boot", &run, &replacement).unwrap()
        );
        state::private_directory(&fresh_root).unwrap();
        let mut fresh = ManagedOwner::start(context, &fresh_root, vec![]).unwrap();
        let endpoint = fresh.endpoint();
        let mut stop =
            Coordinator::begin_graph_enrolled(&endpoint, graph, [5; 32], None, |_| Ok(())).unwrap();
        stop.prepare_graph(&endpoint, Duration::from_secs(2))
            .unwrap();
        let compute = state.join("compute-running");
        fs::write(&compute, b"running").unwrap();
        stop.execute([5; 32], || fs::remove_file(&compute).map_err(state::io))
            .unwrap();
        stop.confirm([5; 32], || {
            assert!(!compute.exists());
            Ok([6; 32])
        })
        .unwrap();
        stop.acknowledge().unwrap();
        drop(stop);
        fresh.shutdown().unwrap();
        assert_eq!(
            fs::read(old_root.join("relay-lifecycle/state.json")).unwrap(),
            bytes
        );
        fs::remove_dir_all(old_root).unwrap();
        fs::remove_dir_all(fresh_root).unwrap();
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn scoped_identity_binds_run_owner_boot_and_candidate() {
        let state = Path::new("/candidate/.hack-local");
        let run = "a".repeat(32);
        let root = control_root(state, "owner", Some("boot"), Some(&run)).unwrap();
        for other in [
            control_root(state, "owner", Some("boot"), Some(&"b".repeat(32))).unwrap(),
            control_root(state, "other", Some("boot"), Some(&run)).unwrap(),
            control_root(state, "owner", Some("other"), Some(&run)).unwrap(),
            control_root(Path::new("/other"), "owner", Some("boot"), Some(&run)).unwrap(),
            control_root(state, "owner", Some("boot"), None).unwrap(),
        ] {
            assert_ne!(root, other);
        }
        assert!(control_root(state, "owner", Some("boot"), Some("bad")).is_err());
        assert!(matches_selected_run(Some(&run), &run));
        assert!(!matches_selected_run(Some(&run), &"b".repeat(32)));
        assert!(matches_selected_run(None, &run));
    }
    #[test]
    fn legacy_absent_boot_preserves_null_serialization() {
        let state = Path::new("/candidate/.hack-local");
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!(["hack-graph-owner-v1", state, "owner", null])).unwrap()
            )
        );
        assert_eq!(
            control_root(state, "owner", None, None).unwrap(),
            PathBuf::from(format!("/private/tmp/hkro-{}", &digest[..24]))
        );
        assert_ne!(
            control_root(state, "owner", None, None).unwrap(),
            control_root(state, "owner", Some("boot"), None).unwrap()
        );
    }

    #[test]
    fn legacy_identity_is_byte_for_byte_unchanged() {
        let state = Path::new("/candidate/.hack-local");
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!(["hack-graph-owner-v1", state, "owner", "boot"]))
                    .unwrap()
            )
        );
        assert_eq!(
            control_root(state, "owner", Some("boot"), None).unwrap(),
            PathBuf::from(format!("/private/tmp/hkro-{}", &digest[..24]))
        );
    }
}
