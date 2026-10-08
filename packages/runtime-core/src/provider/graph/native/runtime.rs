//! Explicit native consumption. The provider lease covers admission through the last observation.
use super::*;
use crate::provider::{environment::PendingEnvironment, native_environment};
use std::{cell::Cell, path::Path, time::Instant};

trait Backend {
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError>;
    fn stage(
        &mut self,
        _pending: PendingEnvironment,
        _binding: native_environment::Binding,
        _config: &mut Value,
    ) -> Result<(), CandidateError> {
        Err(refused())
    }
    fn verify_private(&self, _service: &str) -> Result<(), CandidateError> {
        Ok(())
    }
    fn stop(
        &self,
        _selected: &[(String, u64)],
        _admitted: &BTreeMap<&str, &str>,
    ) -> Result<(), CandidateError> {
        Err(refused())
    }
}
impl Backend for Engine<'_> {
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        Engine::request(self, method, path, body)
    }
}
struct OwnedBackend<'a> {
    engine: Engine<'a>,
    launcher: Option<String>,
    leases: BTreeMap<String, crate::provider::environment::EnvironmentLease>,
}
impl Backend for OwnedBackend<'_> {
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        self.engine.request(method, path, body)
    }
    fn stage(
        &mut self,
        pending: PendingEnvironment,
        binding: native_environment::Binding,
        config: &mut Value,
    ) -> Result<(), CandidateError> {
        let service = pending.service().to_owned();
        let (uid, gid) = launcher::identity(config)?;
        let lease = pending
            .with_identity(uid, gid)
            .stage_native(self.engine.guest(), binding)?;
        let path = lease.verified_path_with_guest(self.engine.guest(), &service)?;
        self.leases.insert(service, lease);
        launcher::attach(config, &path, self.launcher.as_deref().ok_or_else(refused)?)
    }
    fn verify_private(&self, service: &str) -> Result<(), CandidateError> {
        if let Some(lease) = self.leases.get(service) {
            lease.verified_path_with_guest(self.engine.guest(), service)?;
        }
        Ok(())
    }
    fn stop(
        &self,
        selected: &[(String, u64)],
        admitted: &BTreeMap<&str, &str>,
    ) -> Result<(), CandidateError> {
        self.engine
            .stop_containers_diagnosed(selected)
            .map_err(|failure| super::super::shutdown::stop_error(failure, admitted))
    }
}

fn ownership(receipt: &Receipt, resource: &Resource, value: &Value) -> Result<(), CandidateError> {
    let expected = labels(&receipt.owner, &receipt.review, resource);
    let id = value["Id"]
        .as_str()
        .filter(|id| hex(id, 64))
        .ok_or_else(refused)?;
    if resource
        .id
        .as_deref()
        .is_some_and(|expected| expected != id)
        || value["Name"]
            .as_str()
            .unwrap_or_default()
            .trim_start_matches('/')
            != resource.name
        || (resource.kind == Kind::Container
            && value["Image"].as_str() != resource.image.as_deref())
        || (resource.kind == Kind::Network
            && (value["Driver"] != "bridge" || value["Internal"] != !resource.outbound))
    {
        return Err(refused());
    }
    // Labels are checked separately from user process configuration and never authorize adoption.
    let observed_labels = if resource.kind == Kind::Container {
        &value["Config"]["Labels"]
    } else {
        &value["Labels"]
    };
    if !expected
        .as_object()
        .expect("native labels")
        .iter()
        .all(|(key, expected)| observed_labels.get(key) == Some(expected))
    {
        return Err(refused());
    }
    Ok(())
}

fn inspected<B: Backend>(
    backend: &B,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<Option<Value>, CandidateError> {
    let value = match backend.request(
        Method::GET,
        &format!(
            "/v1.53/{}/{}{}",
            resource.kind.collection(),
            resource.id.as_deref().unwrap_or(&resource.name),
            if resource.kind == Kind::Container {
                "/json"
            } else {
                ""
            }
        ),
        None,
    ) {
        Ok(value) => value,
        Err(error) if error.code == "engine_not_found" => return Ok(None),
        Err(error) => return Err(error),
    };
    ownership(receipt, resource, &value)?;
    Ok(Some(value))
}

fn verify_config(
    receipt: &Receipt,
    service: &str,
    expected: &Value,
    environment: &BTreeMap<String, String>,
    actual: &Value,
) -> Result<(), CandidateError> {
    image_environment::verify(environment, &actual["Config"]["Env"])?;
    for (key, value) in expected.as_object().ok_or_else(refused)? {
        if key == "Env" {
            continue;
        }
        if key == "NetworkingConfig" {
            continue;
        }
        let observed = if key == "HostConfig" {
            &actual["HostConfig"]
        } else {
            &actual["Config"][key]
        };
        if mismatch(value, observed, key).is_some() {
            return Err(refused());
        }
    }
    verify_attachment(receipt, service, actual)
}
fn verify_attachment(
    receipt: &Receipt,
    service: &str,
    actual: &Value,
) -> Result<(), CandidateError> {
    let network = receipt
        .resources
        .get("network:default")
        .ok_or_else(refused)?;
    let attachments = actual["NetworkSettings"]["Networks"]
        .as_object()
        .ok_or_else(refused)?;
    let attached = attachments.get(&network.name).ok_or_else(refused)?;
    let observed_id = attached["NetworkID"].as_str();
    if attachments.len() != 1
        || network.id.is_none()
        || (observed_id != network.id.as_deref()
            && !(actual["State"]["Running"] != true && observed_id == Some("")))
        || !attached["Aliases"]
            .as_array()
            .is_some_and(|aliases| aliases.iter().any(|alias| alias == service))
    {
        return Err(refused());
    }
    Ok(())
}

// A network receipt grants no authority over an unknown endpoint. Recheck all
// members before container effects and require a running container's exact endpoint.
fn project_network<B: Backend>(
    backend: &B,
    receipt: &Receipt,
    container: Option<&Value>,
) -> Result<Value, CandidateError> {
    let resource = receipt
        .resources
        .get("network:default")
        .ok_or_else(refused)?;
    if resource.id.is_none() || !["created", "remove-intent"].contains(&resource.phase.as_str()) {
        return Err(refused());
    }
    let network = inspected(backend, receipt, resource)?.ok_or_else(refused)?;
    network_members(receipt, &network, container)?;
    Ok(network)
}
fn network_members(
    receipt: &Receipt,
    network: &Value,
    container: Option<&Value>,
) -> Result<(), CandidateError> {
    let resource = receipt
        .resources
        .get("network:default")
        .ok_or_else(refused)?;
    let members = network["Containers"].as_object().ok_or_else(refused)?;
    for (id, member) in members {
        let owned = receipt
            .resources
            .values()
            .find(|r| r.kind == Kind::Container && r.id.as_deref() == Some(id.as_str()))
            .ok_or_else(refused)?;
        if member["Name"].as_str() != Some(owned.name.as_str()) {
            return Err(refused());
        }
    }
    if let Some(container) = container.filter(|value| value["State"]["Running"] == true) {
        let id = container["Id"].as_str().ok_or_else(refused)?;
        let attachment = &container["NetworkSettings"]["Networks"][&resource.name];
        let endpoint = attachment["EndpointID"]
            .as_str()
            .filter(|id| hex(id, 64))
            .ok_or_else(refused)?;
        let ip = attachment["IPAddress"].as_str().ok_or_else(refused)?;
        let address = ip.parse::<std::net::Ipv4Addr>().map_err(|_| refused())?;
        let member = members.get(id).ok_or_else(refused)?;
        if address.is_unspecified()
            || address.is_loopback()
            || address.is_multicast()
            || member["EndpointID"].as_str() != Some(endpoint)
            || member["IPv4Address"]
                .as_str()
                .and_then(|value| value.split_once('/'))
                .map(|(ip, _)| ip)
                != Some(ip)
        {
            return Err(refused());
        }
    }
    Ok(())
}

struct Session<'a, B> {
    candidate: &'a Candidate,
    startup_guard: Option<&'a dyn Fn() -> Result<(), CandidateError>>,
    selected: selection::Selected,
    backend: B,
    root: PathBuf,
    receipt: Receipt,
    configs: BTreeMap<String, Value>,
    expected_environment: BTreeMap<String, BTreeMap<String, String>>,
    environments: BTreeMap<String, PendingEnvironment>,
}
impl<B: Backend> Session<'_, B> {
    fn save(&self) -> Result<(), CandidateError> {
        journal::save(&self.root, &self.receipt)
    }
    fn reserve(&mut self, service: &str, phase: &str) -> Result<(), CandidateError> {
        self.receipt
            .resources
            .get_mut(&format!("container:{service}"))
            .ok_or_else(refused)?
            .phase = phase.into();
        self.save()
    }
    fn prepare_network(&mut self) -> Result<(), CandidateError> {
        self.check_cancelled()?;
        let key = "network:default";
        let resource = self.receipt.resources.get(key).ok_or_else(refused)?.clone();
        if resource.phase != "reserved"
            || resource.id.is_some()
            || inspected(&self.backend, &self.receipt, &resource)?.is_some()
        {
            return Err(refused());
        }
        self.receipt
            .resources
            .get_mut(key)
            .ok_or_else(refused)?
            .phase = "create-intent".into();
        self.save()?;
        self.check_cancelled()?;
        let created = self.backend.request(Method::POST, "/v1.53/networks/create", Some(&json!({"Name":resource.name,"Driver":"bridge","Internal":!resource.outbound,"Labels":labels(&self.receipt.owner, &self.receipt.review, &resource)})))?;
        let id = created["Id"]
            .as_str()
            .filter(|id| hex(id, 64))
            .ok_or_else(refused)?
            .to_owned();
        let network = self.receipt.resources.get_mut(key).ok_or_else(refused)?;
        network.id = Some(id);
        network.phase = "created".into();
        self.save()?;
        if !project_network(&self.backend, &self.receipt, None)?["Containers"]
            .as_object()
            .is_some_and(|members| members.is_empty())
        {
            return Err(refused());
        }
        Ok(())
    }
}
impl<B: Backend> Driver for Session<'_, B> {
    fn check_cancelled(&self) -> Result<(), CandidateError> {
        check_startup(self.startup_guard)?;
        self.selected.assert_fresh(self.candidate)
    }
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        match event {
            Event::StartIntent { service } => {
                if self.receipt.resources["network:default"].phase == "reserved" {
                    self.prepare_network()?;
                } else {
                    project_network(&self.backend, &self.receipt, None)?;
                }
                if self
                    .receipt
                    .resources
                    .get(&format!("container:{service}"))
                    .is_none_or(|resource| resource.phase != "reserved" || resource.id.is_some())
                {
                    return Err(refused());
                }
                self.reserve(service, "create-intent")
            }
            Event::Started { service } => self.reserve(service, "started"),
            Event::StartUncertain { service } => self.reserve(service, "uncertain"),
            Event::Observed {
                service,
                observation,
            } if observation.failed() => {
                self.receipt.failed(service, observation);
                self.save()
            }
            Event::Observed { .. } => Ok(()),
            Event::Ready => {
                self.receipt.phase = Phase::ReadyObserved;
                self.save()
            }
        }
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        self.check_cancelled()?;
        project_network(&self.backend, &self.receipt, None)?;
        let key = format!("container:{service}");
        let resource = self.receipt.resources[&key].clone();
        if resource.phase != "create-intent"
            || resource.id.is_some()
            || inspected(&self.backend, &self.receipt, &resource)?.is_some()
        {
            return Err(refused());
        }
        if let Some(pending) = self.environments.remove(service) {
            self.check_cancelled()?;
            self.backend.stage(
                pending,
                native_environment::Binding::new(&self.receipt.review, &resource),
                self.configs.get_mut(service).ok_or_else(refused)?,
            )?;
        }
        self.check_cancelled()?;
        self.backend.verify_private(service)?;
        let created = self.backend.request(
            Method::POST,
            &format!("/v1.53/containers/create?name={}", resource.name),
            Some(&self.configs[service]),
        )?;
        let id = created["Id"]
            .as_str()
            .filter(|id| hex(id, 64))
            .ok_or_else(refused)?
            .to_owned();
        self.receipt.resources.get_mut(&key).ok_or_else(refused)?.id = Some(id.clone());
        self.reserve(service, "created")?;
        let value = inspected(&self.backend, &self.receipt, &self.receipt.resources[&key])?
            .ok_or_else(refused)?;
        verify_config(
            &self.receipt,
            service,
            &self.configs[service],
            &self.expected_environment[service],
            &value,
        )?;
        self.reserve(service, "start-intent")?;
        self.check_cancelled()?;
        self.backend.verify_private(service)?;
        project_network(&self.backend, &self.receipt, None)?;
        self.backend
            .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
        Ok(())
    }
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
        self.check_cancelled()?;
        self.backend.verify_private(service)?;
        let resource = &self.receipt.resources[&format!("container:{service}")];
        let value = inspected(&self.backend, &self.receipt, resource)?.ok_or_else(refused)?;
        verify_config(
            &self.receipt,
            service,
            &self.configs[service],
            &self.expected_environment[service],
            &value,
        )?;
        project_network(&self.backend, &self.receipt, Some(&value))?;
        observation(&value)
    }
}

/// Fresh native attempt only. This does not select a default backend or acquire credentials.
pub fn run(
    candidate: &Candidate,
    prepared: selection::Prepared,
) -> Result<Receipt, CandidateError> {
    #[cfg(target_os = "macos")]
    {
        let run = prepared.input().review().scope().run.to_owned();
        let guard = super::foreground::DirectGuard::acquire(candidate, &run)?;
        run_guarded(candidate, prepared, Some(&|| guard.verify()), None)
    }
    #[cfg(not(target_os = "macos"))]
    run_guarded(candidate, prepared, None, None)
}

fn check_startup(
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    guard.map_or(Ok(()), |check| check())
}

// The foreground owner retains this guard throughout startup. It fences the exact
// publication and cancellation, without interrupting or replaying in-flight effects.
pub(super) fn run_guarded(
    candidate: &Candidate,
    prepared: selection::Prepared,
    startup_guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
    admitted: Option<&Cell<bool>>,
) -> Result<Receipt, CandidateError> {
    check_startup(startup_guard)?;
    let (selected, input) = prepared.into_parts(candidate)?;
    let deadline = selected.remaining()?;
    #[cfg(target_os = "macos")]
    let engine = Engine::connect_until(candidate, deadline, || {
        check_startup(startup_guard).is_err()
    })?
    .with_admission_deadline(deadline);
    #[cfg(not(target_os = "macos"))]
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != crate::provider::Profile::Development {
        return Err(refused());
    }
    check_startup(startup_guard)?;
    selected.assert_fresh(candidate)?;
    let mut config = configuration(&input, engine.guest().incarnation())?;
    check_network_intent(&engine, &config.resources)?;
    let private = input.private_services();
    // Stop observations require a whole-second bounded timeout even when authored intent omits it.
    for value in config.configs.values_mut() {
        value
            .as_object_mut()
            .ok_or_else(refused)?
            .entry("StopTimeout")
            .or_insert(json!(10));
    }
    crate::provider::source_job::check_reservations(&engine)?;
    admission::check(candidate, &engine, None, &config.configs)?;
    if !private.is_empty() {
        crate::provider::environment::preflight_capacity(engine.guest(), private.len())?;
    }
    let expected = verify_images(&engine, &config.resources, &mut config.configs, &private)?;
    for name in &private {
        launcher::validate(&config.configs[name])?;
    }
    check_startup(startup_guard)?;
    selected.assert_fresh(candidate)?;
    let receipt = Receipt::preparing(
        &config,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    let root = journal::reserve(candidate, &receipt)?;
    if let Some(admitted) = admitted {
        admitted.set(true);
    }
    // Retain a native reservation before launcher publication, staging or container creation.
    let execution = (|| {
        check_startup(startup_guard)?;
        selected.assert_fresh(candidate)?;
        let launcher = if private.is_empty() {
            None
        } else {
            Some(launcher::publish(&engine)?)
        };
        let (_, environments) = input.into_parts()?;
        let graph = config.graph;
        let mut session = Session {
            candidate,
            startup_guard,
            selected,
            backend: OwnedBackend {
                engine,
                launcher,
                leases: BTreeMap::new(),
            },
            root: root.clone(),
            receipt: receipt.clone(),
            configs: config.configs,
            expected_environment: expected,
            environments,
        };
        let result = session.prepare_network().and_then(|()| {
            execution::run(
                &graph,
                &mut session,
                deadline.saturating_duration_since(Instant::now()),
            )
        });
        if let Err(error) = result {
            session.receipt.phase = Phase::FailedRetained;
            session.save()?;
            return Err(error);
        }
        Ok(session.receipt)
    })();
    if execution.is_err() {
        // Do not overwrite a newer durable uncertain/start intent with the original reservation.
        let (mut retained, _) = journal::load(
            candidate,
            receipt.review.scope().run,
            &receipt.owner,
            &receipt.boot,
        )?;
        retained.phase = Phase::FailedRetained;
        journal::save(&root, &retained)?;
    }
    execution
}

/// Read-only same-incarnation inspection. A historical ready phase is not current health.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Snapshot, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, _) = journal::load(
        candidate,
        run,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    let backend = OwnedBackend {
        engine,
        launcher: None,
        leases: BTreeMap::new(),
    };
    snapshot(&backend, receipt)
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub receipt: Receipt,
    pub observations: BTreeMap<String, Option<Observation>>,
}
fn snapshot<B: Backend>(backend: &B, receipt: Receipt) -> Result<Snapshot, CandidateError> {
    let mut observations = BTreeMap::new();
    if receipt.phase == Phase::Removed {
        if inspected(backend, &receipt, &receipt.resources["network:default"])?.is_some() {
            return Err(refused());
        }
    } else {
        project_network(backend, &receipt, None)?;
    }
    for resource in receipt
        .resources
        .values()
        .filter(|r| r.kind == Kind::Container)
    {
        let observed = inspected(backend, &receipt, resource)?;
        if let Some(value) = &observed {
            verify_attachment(&receipt, &resource.key, value)?;
            project_network(backend, &receipt, Some(value))?;
        }
        observations.insert(
            resource.key.clone(),
            observed.as_ref().map(observation).transpose()?,
        );
    }
    Ok(Snapshot {
        receipt,
        observations,
    })
}

/// Bounded same-incarnation cleanup; no restart, cross-boot restore, force or volume pruning.
pub fn cleanup(candidate: &Candidate, run: &str) -> Result<Receipt, CandidateError> {
    #[cfg(target_os = "macos")]
    {
        let guard = super::foreground::DirectGuard::acquire(candidate, run)?;
        cleanup_guarded(candidate, run, None, Some(&|| guard.verify()))
    }
    #[cfg(not(target_os = "macos"))]
    cleanup_guarded(candidate, run, None, None)
}
pub(super) fn cleanup_guarded(
    candidate: &Candidate,
    run: &str,
    review: Option<&native_input::Review>,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<Receipt, CandidateError> {
    check_startup(guard)?;
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = journal::load(
        candidate,
        run,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    if review.is_some_and(|review| *review != receipt.review) {
        return Err(refused());
    }
    let backend = OwnedBackend {
        engine,
        launcher: None,
        leases: BTreeMap::new(),
    };
    cleanup_using_guarded(&backend, &mut receipt, &root, guard)?;
    check_startup(guard)?;
    native_environment::retire_graph(candidate, backend.engine.guest(), &receipt)?;
    Ok(receipt)
}
#[cfg(test)]
fn cleanup_using<B: Backend>(
    backend: &B,
    receipt: &mut Receipt,
    root: &Path,
) -> Result<(), CandidateError> {
    cleanup_using_guarded(backend, receipt, root, None)
}
fn cleanup_using_guarded<B: Backend>(
    backend: &B,
    receipt: &mut Receipt,
    root: &Path,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<(), CandidateError> {
    check_startup(guard)?;
    let mut prepared = BTreeMap::new();
    let network = receipt
        .resources
        .get("network:default")
        .ok_or_else(refused)?
        .clone();
    let network_present = inspected(backend, receipt, &network)?.is_some();
    if network_present {
        if network.id.is_none() {
            return Err(refused());
        }
        project_network(backend, receipt, None)?;
    }
    // All ownership and stop-state preflights complete before the first stop effect.
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Container)
    {
        if let Some(value) = inspected(backend, receipt, resource)? {
            if resource.id.is_none() {
                return Err(refused());
            }
            if network_present {
                verify_attachment(receipt, &resource.key, &value)?;
                project_network(backend, receipt, Some(&value))?;
            }
            prepared.insert(
                key.clone(),
                super::super::shutdown::prepare(resource, &value)?,
            );
        }
    }
    check_startup(guard)?;
    receipt.phase = Phase::StopIntent;
    journal::save(root, receipt)?;
    let stops = prepared
        .values()
        .filter(|p| p.running)
        .map(|p| (p.id.clone(), u64::from(p.grace_seconds)))
        .collect::<Vec<_>>();
    check_startup(guard)?;
    let admitted = prepared
        .iter()
        .filter(|(_, prepared)| prepared.running)
        .map(|(key, prepared)| (prepared.id.as_str(), receipt.resources[key].key.as_str()))
        .collect::<BTreeMap<_, _>>();
    backend.stop(&stops, &admitted)?;
    for (key, prepared) in &prepared {
        let resource = &receipt.resources[key];
        let value = inspected(backend, receipt, resource)?.ok_or_else(refused)?;
        let terminal = super::super::shutdown::terminal(resource, &value, prepared.running)?;
        if terminal.id != prepared.id {
            return Err(refused());
        }
        super::super::shutdown::record_terminal(&mut receipt.terminal, key.clone(), terminal);
    }
    receipt.phase = Phase::Stopped;
    journal::save(root, receipt)?;
    receipt.phase = Phase::RemovalIntent;
    journal::save(root, receipt)?;
    for key in prepared.keys() {
        check_startup(guard)?;
        let resource = &receipt.resources[key];
        let value = inspected(backend, receipt, resource)?.ok_or_else(refused)?;
        super::super::shutdown::terminal(resource, &value, false)?;
        backend.request(
            Method::DELETE,
            &format!(
                "/v1.53/containers/{}",
                resource.id.as_deref().ok_or_else(refused)?
            ),
            None,
        )?;
        if inspected(backend, receipt, resource)?.is_some() {
            return Err(refused());
        }
        receipt.resources.get_mut(key).ok_or_else(refused)?.phase = "removed".into();
        journal::save(root, receipt)?;
    }
    for resource in receipt.resources.values_mut() {
        if resource.kind == Kind::Container {
            resource.phase = "removed".into();
        }
    }
    if inspected(backend, receipt, &network)?.is_some() {
        let actual = project_network(backend, receipt, None)?;
        if !actual["Containers"]
            .as_object()
            .is_some_and(|members| members.is_empty())
        {
            return Err(refused());
        }
        receipt
            .resources
            .get_mut("network:default")
            .ok_or_else(refused)?
            .phase = "remove-intent".into();
        journal::save(root, receipt)?;
        check_startup(guard)?;
        backend.request(
            Method::DELETE,
            &format!(
                "/v1.53/networks/{}",
                network.id.as_deref().ok_or_else(refused)?
            ),
            None,
        )?;
        if inspected(backend, receipt, &network)?.is_some() {
            return Err(refused());
        }
    }
    receipt
        .resources
        .get_mut("network:default")
        .ok_or_else(refused)?
        .phase = "removed".into();
    receipt.phase = Phase::Removed;
    journal::save(root, receipt)
}

#[cfg(test)]
mod tests;

pub(in crate::provider::graph) fn reservations(
    candidate: &Candidate,
    engine: &Engine<'_>,
    new_attempt: bool,
    add: impl FnMut(&Value) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    reservations_using(
        candidate,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
        new_attempt,
        |receipt, resource| inspected(engine, receipt, resource),
        add,
    )
}
fn reservations_using(
    candidate: &Candidate,
    owner: &str,
    boot: &str,
    new_attempt: bool,
    mut inspect: impl FnMut(&Receipt, &Resource) -> Result<Option<Value>, CandidateError>,
    mut add: impl FnMut(&Value) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let runs = storage_inventory::runs(&candidate.state_root.join("run/native-graphs"))?;
    if new_attempt && runs.len() == 64 {
        return Err(refused());
    }
    for run in runs {
        let (receipt, _) = journal::load_admission(candidate, &run, owner, boot)?;
        if receipt.phase == Phase::Removed {
            continue;
        }
        if receipt.phase != Phase::ReadyObserved {
            return Err(refused());
        }
        let network =
            inspect(&receipt, &receipt.resources["network:default"])?.ok_or_else(refused)?;
        network_members(&receipt, &network, None)?;
        for resource in receipt
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
        {
            let value = inspect(&receipt, resource)?.ok_or_else(refused)?;
            verify_attachment(&receipt, &resource.key, &value)?;
            network_members(&receipt, &network, Some(&value))?;
            add(&value)?;
        }
    }
    Ok(())
}
