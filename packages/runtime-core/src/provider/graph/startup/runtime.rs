//! Foreground graph startup owner. Keys and child handles never enter receipts.
use super::*;
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
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    time::Instant,
};

/// One explicit host dependency for one service. The endpoint is a live captured
/// generation, not a port number or implicit host-gateway route.
pub struct Dependency {
    pub service: String,
    pub binding: String,
    pub slot: u8,
    pub port: u16,
    pub aliases: Vec<String>,
    pub endpoint: HostEndpoint,
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
    run: Option<String>,
    selected_run: Option<String>,
    startup_cancelled: Option<fn() -> bool>,
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
// Fresh and restored graphs both provision a new container generation. Retained
// stopped/ready receipts cannot authorize listener attachment.
fn validate_start_phase(resource_phase: &str, graph_phase: &str) -> Result<(), CandidateError> {
    if resource_phase != "start-intent" || !matches!(graph_phase, "preparing" | "restoring") {
        return Err(stage_refused("graph_startup_started_phase"));
    }
    Ok(())
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
fn control_root(
    state_root: &Path,
    owner: &str,
    boot: Option<&str>,
    run: Option<&str>,
) -> Result<PathBuf, CandidateError> {
    let identity = match run {
        Some(run) if hex(run, 32) => {
            json!(["hack-graph-owner-run-v1", state_root, owner, boot, run])
        }
        Some(_) => return Err(refused()),
        None => json!(["hack-graph-owner-v1", state_root, owner, boot]),
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
        Self::new_scoped(candidate, artifact, expected_sha256, dependencies, None)
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
        )
    }
    fn new_scoped(
        candidate: &Candidate,
        artifact: &Path,
        expected_sha256: &str,
        dependencies: Vec<Dependency>,
        selected_run: Option<&str>,
    ) -> Result<Self, CandidateError> {
        if !hex(expected_sha256, 64)
            || dependencies.len() > crate::provider::relay_auth::MAX_LOGICAL_BINDINGS
        {
            return Err(stage_refused("graph_startup_input"));
        }
        let bytes = if dependencies.is_empty() {
            Vec::new()
        } else {
            let mut file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(artifact)
                .map_err(state::io)?;
            let metadata = file.metadata().map_err(state::io)?;
            if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 || metadata.nlink() != 1 {
                return Err(stage_refused("graph_startup_artifact_file"));
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(state::io)?;
            if bytes.len() as u64 != metadata.len()
                || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256
                || bytes.get(..6) != Some(b"\x7fELF\x02\x01")
                || bytes.get(18..20) != Some(&[183, 0])
            {
                return Err(stage_refused("graph_startup_artifact_identity"));
            }
            bytes
        };
        let engine = Engine::connect(candidate)?;
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
        let mut service_slots = std::collections::BTreeSet::new();
        let mut ports = std::collections::BTreeSet::new();
        let mut aliases = std::collections::BTreeSet::new();
        for dependency in dependencies {
            let address = dependency_address(dependency.slot, &dependency.aliases)?;
            let endpoint_generation = dependency.endpoint.generation()?;
            if dependency.service.is_empty()
                || dependency.slot >= capacity
                || dependency.port == 0
                || slots
                    .insert(dependency.slot, endpoint_generation)
                    .is_some_and(|prior| prior != endpoint_generation)
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
        let control_root = control_root(
            &candidate.state_root,
            &owner.token,
            owner.guest_boot_id.as_deref(),
            selected_run,
        )?;
        state::private_directory(&control_root)?;
        let managed = ManagedOwner::start(
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
        )?;
        Ok(Self {
            managed,
            context,
            candidate: candidate.checkout.clone(),
            artifact: bytes,
            artifact_hash: expected_sha256.into(),
            dependencies: selected,
            children: BTreeMap::new(),
            run: None,
            selected_run: selected_run.map(str::to_owned),
            startup_cancelled: None,
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
        let run = self.run.as_deref().ok_or_else(refused)?;
        let engine = Engine::connect_cleanup_wait(candidate)?;
        for name in self.children.keys().cloned().collect::<Vec<_>>() {
            let child = self.children.get_mut(&name).ok_or_else(refused)?;
            engine
                .guest()
                .stop_relay_listener(child, Duration::from_secs(10))?;
            self.children.remove(&name);
        }
        drop(engine);
        let receipt =
            host_relay::cleanup_with_relay(candidate, run, remove_data, &self.endpoint())?;
        self.children.clear();
        Ok(receipt)
    }
    fn check(&self, engine: &Engine<'_>, receipt: &Receipt) -> Result<(), CandidateError> {
        self.managed.verify_alive()?;
        let context = host_relay::context(engine.guest().incarnation(), engine.guest().boot_id())?;
        if context.runtime != self.context.runtime
            || context.boot != self.context.boot
            || receipt.owner != engine.guest().incarnation()
            || !matches_selected_run(self.selected_run.as_deref(), &receipt.run)
            || self.run.as_deref() != Some(&receipt.run)
        {
            return Err(refused());
        }
        engine.guest().verify()
    }
}
impl Driver for HostRelayRuntime {
    fn admission_started(&self) -> bool {
        self.run.is_some()
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
        self.check(engine, receipt)?;
        for ((name, _), child) in &mut self.children {
            if child.poll_exit()?.is_some() {
                let resource = receipt
                    .resources
                    .get(&format!("container:{name}"))
                    .ok_or_else(refused)?;
                let observed = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
                let observation = probes::observe(engine, receipt, name, &observed)?;
                if observation.failed() {
                    // The relay often exits with its application. Preserve the owned
                    // service's value-free failure before automatic cleanup removes it.
                    startup_failure::record(receipt, name, observation)?;
                    state::write(&root.join("state.json"), receipt)?;
                    return Err(stage_refused("graph_startup_application_failed"));
                }
                verify_exited_listener(receipt.readiness.get(name), &observed)?;
            }
        }
        Ok(())
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
        let mut services: BTreeMap<String, Service> = BTreeMap::new();
        for ((name, binding), dependency) in &self.dependencies {
            let config = configs
                .get(name)
                .ok_or_else(|| stage_refused("graph_startup_service_config"))?;
            launcher::validate(config)?;
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
const PREPARE: &str = r#"
umask 077
base=/storage/hack-graph-startup
test ! -L "$base"
if test ! -e "$base"; then mkdir -m 700 "$base"; fi
test "$(stat -c %u:%g:%a "$base")" = 0:0:700
root="$base/$1"
test ! -e "$root"; test ! -L "$root"
mkdir -m 700 "$root"
printf '%s\n' "$2" > "$root/owner"
chmod 444 "$root/owner"
: > "$root/helper.pending"
stat -c %d:%i "$root"
"#;
const APPEND: &str = r#"
root="/storage/hack-graph-startup/$1"
test ! -L "$root"; test "$(stat -c %u:%g:%a "$root")" = 0:0:700
test ! -L "$root/helper.pending"; test -f "$root/helper.pending"
test "$(stat -c %u:%g:%h:%s "$root/helper.pending")" = "0:0:1:$2"
base64 -d >> "$root/helper.pending"
"#;
const PUBLISH: &str = r#"
root="/storage/hack-graph-startup/$1"
test ! -L "$root"; test ! -L "$root/helper.pending"
test -f "$root/helper.pending"; test "$(stat -c %u:%g:%h "$root/helper.pending")" = 0:0:1
test "$(sha256sum "$root/helper.pending" | cut -d' ' -f1)" = "$2"
test ! -e "$root/helper"; test ! -L "$root/helper"
chmod 555 "$root/helper.pending"; mv "$root/helper.pending" "$root/helper"
sync -f "$root"
"#;
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

#[cfg(test)]
mod route_tests {
    use super::*;
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
            },
            Dependency {
                service: "web".into(),
                binding: "two".into(),
                slot: 1,
                port: 443,
                aliases: vec!["two.example".into()],
                endpoint,
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
mod owner_scope_tests {
    use super::*;
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
