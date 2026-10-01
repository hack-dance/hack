//! Explicit dependency replacement. Selection precedes every effect; interruption
//! retains a dedicated journal and fenced capabilities rather than replaying work.
use super::*;
use crate::provider::{identity, relay_owner::managed::SlotFence};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::PathBuf};

const JOURNAL: &str = "dependency-rebind.json";
pub(super) mod archive;
#[cfg(test)]
mod nested_tests;
pub(super) use archive::after_cleanup as archive_after_cleanup;

fn rejected() -> CandidateError {
    stage_refused("graph_dependency_refresh_refused")
}

fn child_stage<T>(
    result: Result<T, CandidateError>,
    stage: &'static str,
) -> Result<T, CandidateError> {
    result.map_err(|cause| stage_refused(stage).with_cause_code(cause.code.to_owned()))
}

/// In-memory authority for an executable-selected tunnel to follow its original
/// same-user supervisor. A port or a matching executable alone cannot grant it.
#[derive(Clone, PartialEq, Eq)]
pub struct RefreshPolicy {
    executable: PathBuf,
    host_port: u16,
    supervisor: identity::ProcessIdentity,
    intermediate_executables: Vec<PathBuf>,
}
impl RefreshPolicy {
    /// Select exactly this many native ancestry links (1..=8). The final ancestor
    /// remains pinned by full identity; only intermediate identities may rotate,
    /// preserving their reviewed executable paths and same-user lineage.
    pub fn capture(
        endpoint: &HostEndpoint,
        executable: &Path,
        host_port: u16,
        supervisor_depth: u8,
    ) -> Result<Self, CandidateError> {
        if host_port == 0 || !executable.is_absolute() {
            return Err(rejected());
        }
        let executable = executable.canonicalize().map_err(|_| rejected())?;
        endpoint
            .require_executable(&executable)
            .map_err(|_| rejected())?;
        let process = endpoint.process_identity();
        let selected = HostEndpoint::capture(process.pid, host_port).map_err(|_| rejected())?;
        if selected.fingerprint()? != endpoint.fingerprint()? {
            return Err(rejected());
        }
        let mut lineage = identity::lineage(&process, supervisor_depth).map_err(|_| rejected())?;
        let supervisor = lineage.pop().ok_or_else(rejected)?;
        validate_supervisor(&process, &supervisor)?;
        Ok(Self {
            executable,
            host_port,
            supervisor,
            intermediate_executables: lineage
                .into_iter()
                .map(|parent| parent.executable)
                .collect(),
        })
    }

    /// Binds native review to the selected anchor and intermediate executable
    /// chain as well as depth. Contains no process arguments or credentials.
    pub fn review_fingerprint(&self) -> Result<String, CandidateError> {
        let bytes = serde_json::to_vec(&(
            "hack-dependency-refresh-policy-v1",
            &self.executable,
            self.host_port,
            &self.supervisor,
            &self.intermediate_executables,
        ))
        .map_err(|_| rejected())?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }

    fn validate(&self, endpoint: &HostEndpoint) -> Result<(), CandidateError> {
        endpoint
            .require_executable(&self.executable)
            .map_err(|_| rejected())?;
        let process = endpoint.process_identity();
        let depth =
            u8::try_from(self.intermediate_executables.len() + 1).map_err(|_| rejected())?;
        let lineage = identity::lineage(&process, depth).map_err(|_| rejected())?;
        validate_replacement(self, &process, &lineage)?;
        let current = identity::observe(self.supervisor.pid).map_err(|_| rejected())?;
        identity::verify(
            &self.supervisor,
            &current,
            &self.supervisor.executable,
            process.uid,
        )
        .map_err(|_| rejected())?;
        let selected =
            HostEndpoint::capture(process.pid, self.host_port).map_err(|_| rejected())?;
        if selected.fingerprint()? != endpoint.fingerprint()? {
            return Err(rejected());
        }
        Ok(())
    }

    fn discover(&self) -> Result<HostEndpoint, CandidateError> {
        let (pid, expected) =
            HostEndpoint::discover(&self.executable, self.host_port).map_err(|_| rejected())?;
        let endpoint = HostEndpoint::capture(pid, self.host_port).map_err(|_| rejected())?;
        self.validate(&endpoint)?;
        if endpoint.fingerprint()? != expected {
            return Err(rejected());
        }
        Ok(endpoint)
    }
}
fn validate_supervisor(
    process: &identity::ProcessIdentity,
    parent: &identity::ProcessIdentity,
) -> Result<(), CandidateError> {
    if process.pid <= 1
        || parent.pid <= 1
        || process.pid == parent.pid
        || process.start_micros == 0
        || parent.start_micros == 0
        || process.uid != parent.uid
        || !parent.executable.is_absolute()
    {
        return Err(rejected());
    }
    Ok(())
}
fn validate_replacement(
    policy: &RefreshPolicy,
    process: &identity::ProcessIdentity,
    lineage: &[identity::ProcessIdentity],
) -> Result<(), CandidateError> {
    let (anchor, intermediate) = lineage.split_last().ok_or_else(rejected)?;
    let mut seen = BTreeSet::from([process.pid]);
    for parent in lineage {
        validate_supervisor(process, parent)?;
        if !seen.insert(parent.pid) {
            return Err(rejected());
        }
    }
    if policy.host_port == 0
        || process.executable != policy.executable
        || anchor != &policy.supervisor
        || intermediate.len() != policy.intermediate_executables.len()
        || !intermediate
            .iter()
            .zip(&policy.intermediate_executables)
            .all(|(parent, executable)| &parent.executable == executable)
    {
        return Err(rejected());
    }
    Ok(())
}

struct SlotSelection {
    slot: u8,
    expected: [u8; 32],
    endpoint: HostEndpoint,
    fingerprint: String,
    keys: Vec<(String, String)>,
    terminal_only: bool,
}
fn fingerprint_bytes(value: &str) -> Result<[u8; 32], CandidateError> {
    if !hex(value, 64) {
        return Err(rejected());
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).map_err(|_| rejected())?;
    }
    if bytes == [0; 32] {
        return Err(rejected());
    }
    Ok(bytes)
}
fn selections(
    dependencies: &BTreeMap<(String, String), Dependency>,
    startup: &Startup,
) -> Result<Vec<SlotSelection>, CandidateError> {
    let mut groups: BTreeMap<u8, Vec<(String, String)>> = BTreeMap::new();
    for (key, dependency) in dependencies {
        let binding = startup
            .services
            .get(&key.0)
            .and_then(|service| service.bindings.get(&key.1))
            .ok_or_else(rejected)?;
        if binding.slot != dependency.slot
            || binding.port != dependency.port
            || binding.aliases != dependency.aliases
        {
            return Err(rejected());
        }
        groups.entry(dependency.slot).or_default().push(key.clone());
    }
    let actual: BTreeSet<_> = dependencies.keys().cloned().collect();
    let recorded: BTreeSet<_> = startup
        .services
        .iter()
        .flat_map(|(service, value)| {
            value
                .bindings
                .keys()
                .map(move |binding| (service.clone(), binding.clone()))
        })
        .collect();
    if actual != recorded {
        return Err(rejected());
    }
    let mut result = Vec::new();
    for (slot, keys) in groups {
        let policy = &dependencies[keys.first().ok_or_else(rejected)?].refresh;
        if keys.iter().any(|key| &dependencies[key].refresh != policy) {
            return Err(rejected());
        }
        let terminal_only = keys
            .iter()
            .all(|key| startup.services[&key.0].phase == Phase::Completed);
        let mut old = None;
        let mut healthy = 0;
        for key in &keys {
            let generation = startup.services[&key.0].bindings[&key.1]
                .endpoint_generation
                .as_deref()
                .ok_or_else(rejected)?;
            let expected = fingerprint_bytes(generation)?;
            if old.replace(expected).is_some_and(|prior| prior != expected) {
                return Err(rejected());
            }
            if let Ok(current) = dependencies[key].endpoint.fingerprint() {
                if current != generation {
                    return Err(rejected());
                }
                healthy += 1;
            }
        }
        if healthy == keys.len() {
            continue;
        }
        // A shared transport is one selected endpoint; never refresh only a subset.
        if healthy != 0 {
            return Err(rejected());
        }
        let mut replacement: Option<(HostEndpoint, String)> = None;
        for key in &keys {
            let policy = dependencies[key].refresh.as_ref().ok_or_else(rejected)?;
            let selected = policy.discover()?;
            let fingerprint = selected.fingerprint()?;
            if replacement
                .as_ref()
                .is_some_and(|(_, prior)| prior != &fingerprint)
            {
                return Err(rejected());
            }
            replacement = Some((selected, fingerprint));
        }
        let (endpoint, fingerprint) = replacement.ok_or_else(rejected)?;
        let expected = old.ok_or_else(rejected)?;
        if fingerprint_bytes(&fingerprint)? == expected {
            return Err(rejected());
        }
        result.push(SlotSelection {
            slot,
            expected,
            endpoint,
            fingerprint,
            keys,
            terminal_only,
        });
    }
    Ok(result)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RebindJournal {
    version: u8,
    operation: String,
    run: String,
    owner: String,
    boot: String,
    expected_generation: String,
    phase: String,
    slots: BTreeMap<u8, JournalSlot>,
    processes: BTreeMap<String, BTreeMap<String, crate::provider::lifecycle::RelayProcess>>,
    /// Additive journal field; Completed receipts require this owner to clean up.
    /// Older bundles are not compatible with the new active-state phase.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    completed_services: BTreeSet<String>,
    completed_generation: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalSlot {
    before: String,
    after: String,
    bindings: Vec<(String, String)>,
    /// Empty host fence selects future job admission without historical grants.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    terminal_only: bool,
}
fn existing(root: &Path, receipt: &Receipt) -> Result<Option<RebindJournal>, CandidateError> {
    match fs::symlink_metadata(root.join(JOURNAL)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(rejected()),
        Ok(_) => {
            let journal: RebindJournal = state::read(&root.join(JOURNAL))?;
            if journal.version != 1
                || journal.run != receipt.run
                || journal.owner != receipt.owner
                || !hex(&journal.operation, 32)
                || !hex(&journal.expected_generation, 64)
                || (journal.slots.is_empty() && journal.completed_services.is_empty())
                || journal.slots.len() > 32
                || journal.completed_services.len() > 32
                || !journal
                    .slots
                    .values()
                    .all(|slot| hex(&slot.before, 64) && hex(&slot.after, 64))
            {
                return Err(rejected());
            }
            Ok(Some(journal))
        }
    }
}
#[cfg(target_os = "macos")]
pub(super) fn boot(root: &Path, receipt: &Receipt) -> Result<Option<String>, CandidateError> {
    Ok(existing(root, receipt)?.map(|journal| journal.boot))
}
pub(super) fn require_complete(root: &Path, receipt: &Receipt) -> Result<(), CandidateError> {
    if pending_journal(root)? {
        return Err(stage_refused("graph_dependency_rebind_incomplete"));
    }
    let completed: BTreeSet<_> = receipt
        .relay_startup
        .as_ref()
        .into_iter()
        .flat_map(|startup| startup.services.iter())
        .filter(|(_, service)| service.phase == Phase::Completed)
        .map(|(name, _)| name.clone())
        .collect();
    if let Some(journal) = existing(root, receipt)? {
        if journal.phase == "cleaned" && receipt.phase != "ready-observed" {
            return Ok(());
        }
        if journal.phase != "completed"
            || !journal
                .completed_generation
                .as_deref()
                .is_some_and(|value| hex(value, 64))
        {
            return Err(stage_refused("graph_dependency_rebind_incomplete"));
        }
        if receipt.phase == "ready-observed" {
            if completed != journal.completed_services {
                return Err(stage_refused("graph_dependency_rebind_incomplete"));
            }
            for name in &completed {
                let service = &receipt
                    .relay_startup
                    .as_ref()
                    .ok_or_else(rejected)?
                    .services[name];
                if receipt.readiness.get(name) != Some(&Condition::Completed)
                    || service
                        .bindings
                        .values()
                        .any(|binding| binding.process.is_some())
                    || journal.processes.contains_key(name)
                {
                    return Err(stage_refused("graph_dependency_rebind_incomplete"));
                }
            }
            for slot in journal.slots.values() {
                if slot.terminal_only
                    && (slot.bindings.is_empty()
                        || slot
                            .bindings
                            .iter()
                            .any(|(service, _)| !completed.contains(service)))
                {
                    return Err(stage_refused("graph_dependency_rebind_incomplete"));
                }
                for (service, name) in &slot.bindings {
                    let binding = receipt
                        .relay_startup
                        .as_ref()
                        .and_then(|startup| startup.services.get(service))
                        .and_then(|service| service.bindings.get(name))
                        .ok_or_else(rejected)?;
                    if binding.endpoint_generation.as_deref() != Some(slot.after.as_str()) {
                        return Err(stage_refused("graph_dependency_rebind_incomplete"));
                    }
                    if completed.contains(service) {
                        continue;
                    }
                    if binding.process
                        != journal
                            .processes
                            .get(service)
                            .and_then(|processes| processes.get(name))
                            .copied()
                        || binding.process.is_none()
                    {
                        return Err(stage_refused("graph_dependency_rebind_incomplete"));
                    }
                }
            }
        }
    } else if receipt.phase == "ready-observed" && !completed.is_empty() {
        return Err(stage_refused("graph_dependency_rebind_incomplete"));
    }
    Ok(())
}
fn pending_journal(root: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(root.join(JOURNAL).with_extension("pending")) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(rejected()),
    }
}

impl HostRelayRuntime {
    // An unconfirmed launch may have no parsed process marker. In that case
    // explicit graph cleanup removes the exactly owned containers, then proves
    // absence before reaping helper transports. Never infer guest death from EOF.
    pub(super) fn cleanup_incomplete_rebind(
        &mut self,
        candidate: &Candidate,
        run: &str,
        remove_data: bool,
    ) -> Result<Option<Receipt>, CandidateError> {
        let engine = Engine::connect_cleanup_wait(candidate)?;
        let (before, root) = crate::provider::graph::load(candidate, &engine, run)?;
        let boot = engine.guest().boot_id().to_owned();
        let pending = pending_journal(&root)?;
        let journal = existing(&root, &before)?;
        if journal.is_none() && !pending {
            return Ok(None);
        }
        if !pending
            && journal
                .as_ref()
                .is_some_and(|journal| journal.phase == "completed")
        {
            return Ok(None);
        }
        let mut containers = BTreeMap::new();
        for key in self.children.keys() {
            let resource = before
                .resources
                .get(&format!("container:{}", key.0))
                .ok_or_else(rejected)?;
            if resource.kind != Kind::Container {
                return Err(rejected());
            }
            containers.insert(
                key.clone(),
                (
                    resource.id.clone().ok_or_else(rejected)?,
                    resource.name.clone(),
                ),
            );
        }
        drop(engine);
        let receipt =
            host_relay::cleanup_with_relay(candidate, run, remove_data, &self.endpoint())?;
        let engine = Engine::connect_cleanup_wait(candidate)?;
        for (key, (id, name)) in containers {
            engine.guest().reap_relay_after_container_absence(
                self.children.get_mut(&key).ok_or_else(rejected)?,
                &id,
                &name,
            )?;
            self.children.remove(&key);
        }
        startup::verify_cleanup(&engine, &receipt)?;
        archive_after_cleanup(&root, &before, &receipt, &boot)?;
        Ok(Some(receipt))
    }

    /// Replace only stale, explicitly refreshable dependency listeners in the
    /// current graph. No application or container is restarted. An interrupted
    /// attempt remains fenced and requires owned cleanup; it is never replayed.
    pub fn refresh_dependencies(
        &mut self,
        candidate: &Candidate,
        run: &str,
        expected_generation: &str,
        cancelled: impl Fn() -> bool,
    ) -> Result<Value, CandidateError> {
        let check_cancelled = || {
            if cancelled() {
                Err(stage_refused("graph_dependency_rebind_cancelled"))
            } else {
                Ok(())
            }
        };
        check_cancelled()?;
        if self.candidate != candidate.checkout
            || self.run.as_deref() != Some(run)
            || !hex(expected_generation, 64)
            || !self.job_targets.is_empty()
        {
            return Err(rejected());
        }
        let engine = Engine::connect_until(
            candidate,
            Instant::now() + Duration::from_secs(15),
            &cancelled,
        )?;
        let (mut receipt, root) = crate::provider::graph::load(candidate, &engine, run)?;
        self.check(&engine, &receipt)?;
        require_complete(&root, &receipt)?;
        if receipt.phase != "ready-observed"
            || service_exec_generation(&receipt)? != expected_generation
            || root.join("one-off.json").try_exists().map_err(state::io)?
        {
            return Err(rejected());
        }
        // Review every already terminal job, including bindings on unchanged
        // slots. A terminal phase means ALL its historical grants were retired.
        // This staged receipt is not published until the journal and effects finish.
        let mut terminal = BTreeMap::new();
        let mut retire_keys = Vec::new();
        let mut retire_identities = Vec::new();
        let mut completed_services = BTreeSet::new();
        let startup = receipt.relay_startup.as_ref().ok_or_else(rejected)?;
        for (name, service) in &startup.services {
            check_cancelled()?;
            let resource = receipt
                .resources
                .get(&format!("container:{name}"))
                .ok_or_else(rejected)?;
            let observed = inspect_resource(&engine, &receipt, resource)?.ok_or_else(rejected)?;
            if service.phase != Phase::Completed && observed["State"]["Running"] == true {
                continue;
            }
            let generation = completed_generation(
                &receipt,
                engine.guest().boot_id(),
                resource,
                &observed,
                service,
            )?;
            completed_services.insert(name.clone());
            terminal.insert(name.clone(), (resource.clone(), generation));
            if service.phase == Phase::Completed {
                continue;
            }
            for (binding_name, binding) in &service.bindings {
                let key = (name.clone(), binding_name.clone());
                if binding.process.is_none() || !self.children.contains_key(&key) {
                    return Err(rejected());
                }
                retire_identities.push(host_relay::named_binding_identity(
                    generation,
                    binding_name,
                    binding,
                )?);
                retire_keys.push(key);
            }
        }
        for name in &completed_services {
            let service = receipt
                .relay_startup
                .as_mut()
                .ok_or_else(rejected)?
                .services
                .get_mut(name)
                .ok_or_else(rejected)?;
            service.phase = Phase::Completed;
            for binding in service.bindings.values_mut() {
                binding.process = None;
            }
        }
        let startup = receipt.relay_startup.as_ref().ok_or_else(rejected)?;
        let selected = selections(&self.dependencies, startup)?;
        check_cancelled()?;
        if selected.is_empty() && retire_keys.is_empty() {
            return response(&receipt, &[]);
        }
        let mut containers = BTreeMap::new();
        for slot in &selected {
            for key in &slot.keys {
                check_cancelled()?;
                let service = startup.services.get(&key.0).ok_or_else(rejected)?;
                if service.phase == Phase::Completed {
                    continue;
                }
                if service.phase != Phase::Released
                    || service.bindings[&key.1].process.is_none()
                    || !self.children.contains_key(key)
                {
                    return Err(rejected());
                }
                if containers.contains_key(&key.0) {
                    continue;
                }
                let resource = receipt
                    .resources
                    .get(&format!("container:{}", key.0))
                    .ok_or_else(rejected)?;
                let observed =
                    inspect_resource(&engine, &receipt, resource)?.ok_or_else(rejected)?;
                let generation = host_relay::inspected_generation(
                    &receipt,
                    engine.guest().boot_id(),
                    resource,
                    &observed,
                )?;
                if observed["State"]["StartedAt"].as_str() != service.started_at.as_deref() {
                    return Err(rejected());
                }
                let user = launcher::identity(&observed["Config"])?;
                containers.insert(key.0.clone(), (resource.clone(), generation, user));
            }
        }
        // Repeat native selector checks at the last pre-effect boundary. Discovery
        // and every container inspection above must finish before journal/fencing.
        for slot in &selected {
            for key in &slot.keys {
                self.dependencies[key]
                    .refresh
                    .as_ref()
                    .ok_or_else(rejected)?
                    .validate(&slot.endpoint)?;
            }
            if slot.endpoint.fingerprint()? != slot.fingerprint {
                return Err(rejected());
            }
        }
        check_cancelled()?;
        let scope = host_relay::graph_scope(self.context, run)?;
        let mut journal = RebindJournal {
            version: 1,
            operation: probes::token()?,
            run: run.into(),
            owner: receipt.owner.clone(),
            boot: engine.guest().boot_id().into(),
            expected_generation: expected_generation.into(),
            phase: "prepared".into(),
            processes: BTreeMap::new(),
            completed_services,
            completed_generation: None,
            slots: selected
                .iter()
                .map(|slot| {
                    (
                        slot.slot,
                        JournalSlot {
                            before: slot
                                .expected
                                .iter()
                                .map(|byte| format!("{byte:02x}"))
                                .collect(),
                            after: slot.fingerprint.clone(),
                            bindings: slot.keys.clone(),
                            terminal_only: slot.terminal_only,
                        },
                    )
                })
                .collect(),
        };
        state::write(&root.join(JOURNAL), &journal)?;
        let mut fences: Vec<(u8, SlotFence)> = Vec::new();
        let result = (|| {
            check_cancelled()?;
            if !retire_identities.is_empty() {
                // The journal precedes revocation, including completed-only
                // operations. A crash can never present this retirement as ready.
                self.managed.retire_bindings(scope, &retire_identities)?;
                for key in &retire_keys {
                    check_cancelled()?;
                    child_stage(
                        engine.guest().stop_relay_listener(
                            self.children.get_mut(key).ok_or_else(rejected)?,
                            Duration::from_secs(10),
                        ),
                        "graph_dependency_rebind_stop",
                    )?;
                    self.children.remove(key);
                }
            }
            for slot in &selected {
                check_cancelled()?;
                fences.push((
                    slot.slot,
                    if slot.terminal_only {
                        self.managed.begin_terminal_rebind(
                            scope,
                            slot.slot,
                            slot.expected,
                            slot.endpoint.clone(),
                        )?
                    } else {
                        self.managed.begin_rebind(scope, slot.slot, slot.expected)?
                    },
                ));
            }
            journal.phase = "fenced".into();
            state::write(&root.join(JOURNAL), &journal)?;
            for slot in &selected {
                let fence = &fences
                    .iter()
                    .find(|(number, _)| *number == slot.slot)
                    .ok_or_else(rejected)?
                    .1;
                for key in &slot.keys {
                    check_cancelled()?;
                    if journal.completed_services.contains(&key.0) {
                        continue;
                    }
                    child_stage(
                        engine.guest().stop_relay_listener(
                            self.children.get_mut(key).ok_or_else(rejected)?,
                            Duration::from_secs(10),
                        ),
                        "graph_dependency_rebind_stop",
                    )?;
                    self.children.remove(key);
                    let (resource, generation, (uid, gid)) = &containers[&key.0];
                    let mut binding = receipt
                        .relay_startup
                        .as_ref()
                        .ok_or_else(rejected)?
                        .services[&key.0]
                        .bindings[&key.1]
                        .clone();
                    binding.endpoint_generation = Some(slot.fingerprint.clone());
                    binding.process = None;
                    self.dependencies[key]
                        .refresh
                        .as_ref()
                        .ok_or_else(rejected)?
                        .validate(&slot.endpoint)?;
                    let identity =
                        host_relay::named_binding_identity(*generation, &key.1, &binding)?;
                    let grant = self.managed.register_replacement(
                        fence,
                        identity,
                        slot.endpoint.clone(),
                    )?;
                    let child = child_stage(
                        engine.guest().launch_relay_listener(
                            RelayLaunch {
                                container: resource.id.as_deref().ok_or_else(rejected)?,
                                uid: *uid,
                                gid: *gid,
                                slot: slot.slot,
                                port: binding.port,
                                address: dependency_address(slot.slot, &binding.aliases)?,
                            },
                            grant.credential.into_private_input()?,
                        ),
                        "graph_dependency_rebind_launch",
                    )?;
                    self.children.insert(key.clone(), child);
                    let deadline = Instant::now() + Duration::from_secs(8);
                    let process = loop {
                        check_cancelled()?;
                        let child = self.children.get_mut(key).ok_or_else(rejected)?;
                        if let Some(process) =
                            child_stage(child.poll_ready(), "graph_dependency_rebind_readiness")?
                        {
                            break process;
                        }
                        if Instant::now() >= deadline
                            || child_stage(child.poll_exit(), "graph_dependency_rebind_readiness")?
                                .is_some()
                        {
                            return Err(rejected());
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    };
                    let observed =
                        inspect_resource(&engine, &receipt, resource)?.ok_or_else(rejected)?;
                    if host_relay::inspected_generation(
                        &receipt,
                        engine.guest().boot_id(),
                        resource,
                        &observed,
                    )? != *generation
                    {
                        return Err(rejected());
                    }
                    journal
                        .processes
                        .entry(key.0.clone())
                        .or_default()
                        .insert(key.1.clone(), process);
                    journal.phase = "provisioning".into();
                    state::write(&root.join(JOURNAL), &journal)?;
                }
            }
            check_cancelled()?;
            for (name, (resource, generation)) in &terminal {
                let observed =
                    inspect_resource(&engine, &receipt, resource)?.ok_or_else(rejected)?;
                if completed_generation(
                    &receipt,
                    engine.guest().boot_id(),
                    resource,
                    &observed,
                    &receipt
                        .relay_startup
                        .as_ref()
                        .ok_or_else(rejected)?
                        .services[name],
                )? != *generation
                {
                    return Err(rejected());
                }
            }
            for slot in &selected {
                for key in &slot.keys {
                    self.dependencies[key]
                        .refresh
                        .as_ref()
                        .ok_or_else(rejected)?
                        .validate(&slot.endpoint)?;
                    if !journal.completed_services.contains(&key.0) {
                        let child = self.children.get_mut(key).ok_or_else(rejected)?;
                        if child.poll_exit()?.is_some() {
                            return Err(rejected());
                        }
                    }
                    let binding = receipt
                        .relay_startup
                        .as_mut()
                        .ok_or_else(rejected)?
                        .services
                        .get_mut(&key.0)
                        .and_then(|service| service.bindings.get_mut(&key.1))
                        .ok_or_else(rejected)?;
                    binding.endpoint_generation = Some(slot.fingerprint.clone());
                    binding.process = journal
                        .processes
                        .get(&key.0)
                        .and_then(|processes| processes.get(&key.1))
                        .copied();
                }
            }
            if !receipt
                .relay_startup
                .as_ref()
                .ok_or_else(rejected)?
                .valid(&receipt)
            {
                return Err(rejected());
            }
            state::write(&root.join("state.json"), &receipt)?;
            for slot in &selected {
                for key in &slot.keys {
                    self.dependencies
                        .get_mut(key)
                        .ok_or_else(rejected)?
                        .endpoint = slot.endpoint.clone();
                }
            }
            let generation = service_exec_generation(&receipt)?;
            journal.completed_generation = Some(generation.clone());
            // Publish synchronized completion before reopening any slot. A
            // subsequent activation failure refences the whole operation.
            journal.phase = "committed".into();
            state::write(&root.join(JOURNAL), &journal)?;
            check_cancelled()?;
            if !fences.is_empty() {
                self.managed.complete_rebinds(
                    &fences
                        .iter()
                        .map(|(_, fence)| fence.clone())
                        .collect::<Vec<_>>(),
                )?;
            }
            check_cancelled()?;
            journal.phase = "completed".into();
            state::write(&root.join(JOURNAL), &journal)?;
            response(
                &receipt,
                &selected.iter().map(|slot| slot.slot).collect::<Vec<_>>(),
            )
        })();
        if let Err(original) = result {
            let mut cleanup_failed = false;
            for (_, fence) in &fences {
                if self.managed.abort_rebind(fence).is_err() {
                    cleanup_failed = true;
                }
            }
            journal.phase = "failed".into();
            if state::write(&root.join(JOURNAL), &journal).is_err() {
                cleanup_failed = true;
            }
            if cleanup_failed {
                return Err(stage_refused("graph_dependency_rebind_cleanup")
                    .with_cause_code(original.code.to_owned()));
            }
            return Err(original);
        }
        result
    }
}

fn response(receipt: &Receipt, slots: &[u8]) -> Result<Value, CandidateError> {
    Ok(
        json!({"ok":true,"run":receipt.run,"plan":receipt.plan_id,"owner":receipt.owner,
        "namespace":receipt.namespace,"generation":service_exec_generation(receipt)?,"changed_slots":slots}),
    )
}

#[cfg(test)]
mod tests;
