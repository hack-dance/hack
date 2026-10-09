//! Explicit native consumption. The provider lease covers admission through the last observation.
use super::*;
use crate::provider::{environment::PendingEnvironment, managed_environment, native_environment};
use std::{cell::Cell, path::Path, time::Instant};

trait Backend {
    #[cfg(any(target_os = "macos", test))]
    fn logs(&self, _id: &str, _tail: u16) -> Result<(String, String, bool), CandidateError> {
        Err(refused())
    }
    fn verify_source(&self, receipt: &Receipt, _active: bool) -> Result<(), CandidateError> {
        if receipt.source.is_some() {
            return Err(refused());
        }
        Ok(())
    }
    fn verify_source_until(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        managed_environment::remaining_until(deadline)?;
        self.verify_source(receipt, true)?;
        managed_environment::remaining_until(deadline)?;
        Ok(())
    }
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
    fn verify_data(
        &self,
        receipt: &Receipt,
        _deadline: Instant,
        _fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        if receipt.data.is_empty() {
            Ok(())
        } else {
            Err(refused())
        }
    }
    fn stop(
        &self,
        _selected: &[(String, u64)],
        _admitted: &BTreeMap<&str, &str>,
    ) -> Result<(), CandidateError> {
        Err(refused())
    }
}
/// Recovery authority must survive every bounded engine call, including failed
/// observations. Losing it stops this attempt before another engine operation.
struct GuardedBackend<'a, B> {
    backend: &'a B,
    guard: Option<&'a dyn Fn() -> Result<(), CandidateError>>,
}
impl<B: Backend> Backend for GuardedBackend<'_, B> {
    #[cfg(any(target_os = "macos", test))]
    fn logs(&self, id: &str, tail: u16) -> Result<(String, String, bool), CandidateError> {
        check_startup(self.guard)?;
        let result = self.backend.logs(id, tail);
        check_startup(self.guard)?;
        result
    }
    fn verify_source(&self, receipt: &Receipt, active: bool) -> Result<(), CandidateError> {
        check_startup(self.guard)?;
        let result = self.backend.verify_source(receipt, active);
        check_startup(self.guard)?;
        result
    }
    fn verify_source_until(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        check_startup(self.guard)?;
        let result = self.backend.verify_source_until(receipt, deadline);
        check_startup(self.guard)?;
        result
    }
    fn verify_data(
        &self,
        receipt: &Receipt,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        let guard = || {
            check_startup(self.guard)?;
            fresh()
        };
        let result = self.backend.verify_data(receipt, deadline, &guard);
        guard()?;
        result
    }
    fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, CandidateError> {
        check_startup(self.guard)?;
        let result = self.backend.request(method, path, body);
        check_startup(self.guard)?;
        result
    }
    fn stop(
        &self,
        selected: &[(String, u64)],
        admitted: &BTreeMap<&str, &str>,
    ) -> Result<(), CandidateError> {
        check_startup(self.guard)?;
        let result = self.backend.stop(selected, admitted);
        check_startup(self.guard)?;
        result
    }
}
impl Backend for Engine<'_> {
    #[cfg(any(target_os = "macos", test))]
    fn logs(&self, id: &str, tail: u16) -> Result<(String, String, bool), CandidateError> {
        self.logs_tail(id, tail)
    }
    fn verify_data(
        &self,
        receipt: &Receipt,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        verify_data_using_engine(self, receipt, deadline, fresh)
    }
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
    #[cfg(any(target_os = "macos", test))]
    fn logs(&self, id: &str, tail: u16) -> Result<(String, String, bool), CandidateError> {
        self.engine.logs_tail(id, tail)
    }
    fn verify_source(&self, receipt: &Receipt, active: bool) -> Result<(), CandidateError> {
        if let Some(binding) = &receipt.source {
            source::verify(&self.engine, binding, active)?;
        }
        Ok(())
    }
    fn verify_source_until(
        &self,
        receipt: &Receipt,
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        if let Some(binding) = &receipt.source {
            source::verify_until(&self.engine, binding, deadline)?;
        }
        managed_environment::remaining_until(deadline)?;
        Ok(())
    }
    fn verify_data(
        &self,
        receipt: &Receipt,
        deadline: Instant,
        fresh: &dyn Fn() -> Result<(), CandidateError>,
    ) -> Result<(), CandidateError> {
        verify_data_using_engine(&self.engine, receipt, deadline, fresh)
    }
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

fn verify_prior_data_retirement(
    prior: &Receipt,
    selected: &BTreeMap<String, persistent_data::engine::Reference>,
) -> Result<(), CandidateError> {
    if prior.data.values().any(|reference| {
        selected
            .values()
            .any(|current| current.name() == reference.name())
            && (prior.phase != Phase::Removed || !reference.enrolled())
    }) {
        return Err(refused());
    }
    Ok(())
}

fn verify_data_using_engine(
    engine: &Engine<'_>,
    receipt: &Receipt,
    deadline: Instant,
    fresh: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    for reference in receipt
        .data
        .values()
        .filter(|reference| reference.enrolled())
    {
        persistent_data::engine::verify(
            engine.guest().candidate(),
            engine,
            reference,
            deadline,
            fresh,
        )?;
    }
    fresh()
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
    if resource.kind == Kind::Container
        && let Some(binding) = &receipt.source
    {
        binding.verify_container(&resource.key, value)?;
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
    verify_data_mounts(receipt, service, actual)?;
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .ok_or_else(refused)?;
    let selected = resource.networks.as_ref().ok_or_else(refused)?;
    let attachments = actual["NetworkSettings"]["Networks"]
        .as_object()
        .ok_or_else(refused)?;
    if attachments.len() != selected.len() {
        return Err(refused());
    }
    for logical in selected {
        let network = receipt
            .resources
            .get(&format!("network:{logical}"))
            .ok_or_else(refused)?;
        let attached = attachments.get(&network.name).ok_or_else(refused)?;
        let observed_id = attached["NetworkID"].as_str();
        let extras = receipt.topology.as_ref().map_or(&[][..], |topology| {
            topology.attachments[service][logical].as_slice()
        });
        let aliases = attached["Aliases"].as_array().ok_or_else(refused)?;
        if network.id.is_none()
            || (observed_id != network.id.as_deref()
                && !(actual["State"]["Running"] != true && observed_id == Some("")))
            || !std::iter::once(service)
                .chain(extras.iter().map(String::as_str))
                .all(|name| aliases.iter().any(|alias| alias == name))
        {
            return Err(refused());
        }
        if receipt.topology.is_some() {
            let expected = std::iter::once(service)
                .chain(extras.iter().map(String::as_str))
                .collect::<BTreeSet<_>>();
            let observed = aliases
                .iter()
                .map(|alias| alias.as_str().ok_or_else(refused))
                .collect::<Result<Vec<_>, _>>()?;
            let short = resource.id.as_deref().and_then(|id| id.get(..12));
            if observed.iter().collect::<BTreeSet<_>>().len() != observed.len()
                || observed.iter().any(|alias| {
                    !expected.contains(alias) && *alias != resource.name && Some(*alias) != short
                })
            {
                return Err(refused());
            }
        }
    }
    Ok(())
}

fn verify_data_mounts(
    receipt: &Receipt,
    service: &str,
    actual: &Value,
) -> Result<(), CandidateError> {
    if receipt.data.is_empty() {
        return Ok(());
    }
    let expected = receipt
        .data_mounts
        .get(service)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mounts = actual["Mounts"].as_array().ok_or_else(refused)?;
    if mounts.len() != expected.len() {
        return Err(refused());
    }
    for selected in expected {
        let reference = receipt
            .data
            .get(&selected.storage)
            .filter(|reference| reference.enrolled())
            .ok_or_else(refused)?;
        let matching = mounts
            .iter()
            .filter(|mount| mount["Destination"] == selected.target)
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(refused());
        }
        let mount = matching[0];
        if mount["Type"] != "volume"
            || mount["Name"] != reference.name()
            || mount["Source"] != reference.mountpoint()
            || mount["Driver"] != "local"
            || mount["RW"].as_bool() != Some(!selected.read_only)
        {
            return Err(refused());
        }
    }
    Ok(())
}

// A network receipt grants no authority over an unknown endpoint. Recheck all
// members before container effects and require a running container's exact endpoint.
fn project_network<B: Backend>(
    backend: &B,
    receipt: &Receipt,
    logical: &str,
    container: Option<&Value>,
) -> Result<Value, CandidateError> {
    let resource = receipt
        .resources
        .get(&format!("network:{logical}"))
        .ok_or_else(refused)?;
    if resource.id.is_none() || !["created", "remove-intent"].contains(&resource.phase.as_str()) {
        return Err(refused());
    }
    let network = inspected(backend, receipt, resource)?.ok_or_else(refused)?;
    network_members(receipt, logical, &network, container)?;
    Ok(network)
}
fn network_members(
    receipt: &Receipt,
    logical: &str,
    network: &Value,
    container: Option<&Value>,
) -> Result<(), CandidateError> {
    let resource = receipt
        .resources
        .get(&format!("network:{logical}"))
        .ok_or_else(refused)?;
    let members = network["Containers"].as_object().ok_or_else(refused)?;
    for (id, member) in members {
        let owned = receipt
            .resources
            .values()
            .find(|r| {
                r.kind == Kind::Container
                    && r.id.as_deref() == Some(id.as_str())
                    && r.networks
                        .as_ref()
                        .is_some_and(|networks| networks.iter().any(|name| name == logical))
            })
            .ok_or_else(refused)?;
        if member["Name"].as_str() != Some(owned.name.as_str()) {
            return Err(refused());
        }
    }
    if let Some(container) = container.filter(|value| value["State"]["Running"] == true) {
        let id = container["Id"].as_str().ok_or_else(refused)?;
        let selected = receipt
            .resources
            .values()
            .find(|r| r.kind == Kind::Container && r.id.as_deref() == Some(id))
            .ok_or_else(refused)?;
        if !selected
            .networks
            .as_ref()
            .is_some_and(|networks| networks.iter().any(|name| name == logical))
        {
            if members.contains_key(id)
                || container["NetworkSettings"]["Networks"]
                    .get(&resource.name)
                    .is_some()
            {
                return Err(refused());
            }
            return Ok(());
        }
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
fn network_keys(receipt: &Receipt) -> Vec<String> {
    receipt.topology.as_ref().map_or_else(
        || vec!["default".to_owned()],
        |topology| topology.networks.keys().cloned().collect(),
    )
}
fn project_networks<B: Backend>(
    backend: &B,
    receipt: &Receipt,
    container: Option<&Value>,
) -> Result<(), CandidateError> {
    for logical in network_keys(receipt) {
        project_network(backend, receipt, &logical, container)?;
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
    fn prepare_network(&mut self, logical: &str) -> Result<(), CandidateError> {
        self.check_cancelled()?;
        let key = format!("network:{logical}");
        let resource = self
            .receipt
            .resources
            .get(&key)
            .ok_or_else(refused)?
            .clone();
        if resource.phase != "reserved"
            || resource.id.is_some()
            || inspected(&self.backend, &self.receipt, &resource)?.is_some()
        {
            return Err(refused());
        }
        self.receipt
            .resources
            .get_mut(&key)
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
        let network = self.receipt.resources.get_mut(&key).ok_or_else(refused)?;
        network.id = Some(id);
        network.phase = "created".into();
        self.save()?;
        if !project_network(&self.backend, &self.receipt, logical, None)?["Containers"]
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
        self.selected.assert_fresh(self.candidate)?;
        self.backend.verify_source(&self.receipt, true)?;
        // Guest source checks can wait. They cannot renew the original authored
        // selection/cancellation/deadline at the create or ready boundary.
        check_startup(self.startup_guard)?;
        self.selected.assert_fresh(self.candidate)?;
        self.backend
            .verify_data(&self.receipt, self.selected.remaining()?, &|| {
                check_startup(self.startup_guard)?;
                self.selected.assert_fresh(self.candidate)
            })?;
        check_startup(self.startup_guard)?;
        self.selected.assert_fresh(self.candidate)
    }
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        match event {
            Event::StartIntent { service } => {
                for logical in network_keys(&self.receipt) {
                    if self.receipt.resources[&format!("network:{logical}")].phase == "reserved" {
                        self.prepare_network(&logical)?;
                    } else {
                        project_network(&self.backend, &self.receipt, &logical, None)?;
                    }
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
                self.check_cancelled()?;
                self.receipt.phase = Phase::ReadyObserved;
                self.save()
            }
        }
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        self.check_cancelled()?;
        project_networks(&self.backend, &self.receipt, None)?;
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
        self.check_cancelled()?;
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
        project_networks(&self.backend, &self.receipt, None)?;
        self.backend
            .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
        self.check_cancelled()?;
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
        project_networks(&self.backend, &self.receipt, Some(&value))?;
        self.check_cancelled()?;
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
    // Birth/device/inode/labels can all alias after replacement. Until the native
    // root-witness transport is qualified, no ordinary invocation may reach the
    // provider or publish receipt4/create/enroll/use persistent data.
    if !input.inputs().storage.is_empty() {
        return Err(error(
            "native_graph_storage_unqualified",
            "Native persistent storage requires a qualified root continuity witness; no provider or data effects were authorized.",
        ));
    }
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
    let source = selected
        .project_source
        .as_ref()
        .map(|source| source::prepare(&engine, source))
        .transpose()?;
    check_startup(startup_guard)?;
    selected.assert_fresh(candidate)?;
    let mut config = configuration_with_source(&input, engine.guest().incarnation(), source)?;
    config.data = persistent_data::engine::select(
        candidate,
        &engine,
        config.review.scope().namespace,
        &config.storage,
        deadline,
        &|| {
            check_startup(startup_guard)?;
            selected.assert_fresh(candidate)
        },
    )?;
    // A new compute attempt may reuse data only after all earlier admitted consumers
    // have completed exact retirement. Exited/uncertain containers still count.
    if !config.data.is_empty() {
        for run in storage_inventory::runs(&candidate.state_root.join("run/native-graphs"))? {
            let (prior, _) = journal::load_admission(
                candidate,
                &run,
                engine.guest().incarnation(),
                engine.guest().boot_id(),
            )?;
            verify_prior_data_retirement(&prior, &config.data)?;
        }
    }
    for (service, mounts) in &config.data_mounts {
        config.configs.get_mut(service).ok_or_else(refused)?["HostConfig"]["Mounts"] = json!(mounts.iter().map(|mount| {
            Ok(json!({"Type":"volume","Source":config.data.get(&mount.storage).ok_or_else(refused)?.name(),"Target":mount.target,"ReadOnly":mount.read_only,"VolumeOptions":{"NoCopy":true}}))
        }).collect::<Result<Vec<_>, CandidateError>>()?);
    }
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
    if !config.data.is_empty() && !private.is_empty() {
        // Delivery bind + persistent mount intersection needs its own saved physical
        // mount membership proof. Refuse before any stable-volume or container effect.
        return Err(refused());
    }
    let expected = if config.data.is_empty() {
        verify_images(&engine, &config.resources, &mut config.configs, &private)?
    } else {
        verify_native_images(&engine, &config.resources, &mut config.configs, &private)?
    };
    for name in &private {
        launcher::validate(&config.configs[name])?;
    }
    check_startup(startup_guard)?;
    selected.assert_fresh(candidate)?;
    let mut receipt = Receipt::preparing(
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
        for logical in receipt.data.keys().cloned().collect::<Vec<_>>() {
            let reference = receipt.data.get_mut(&logical).ok_or_else(refused)?;
            persistent_data::engine::enroll(candidate, &engine, reference, deadline, &|| {
                check_startup(startup_guard)?;
                selected.assert_fresh(candidate)
            })?;
            journal::save(&root, &receipt)?;
        }
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
        let result = network_keys(&session.receipt)
            .into_iter()
            .try_for_each(|logical| session.prepare_network(&logical))
            .and_then(|()| {
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

/// The exact current member is inspected before and after a finite Engine log read.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg(any(target_os = "macos", test))]
pub(super) struct ServiceLogs {
    pub receipt: Receipt,
    pub service: String,
    pub container: String,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}
#[cfg(target_os = "macos")]
pub(super) fn logs(
    candidate: &Candidate,
    expected: &Receipt,
    service: &str,
    tail: u16,
    guard: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<ServiceLogs, CandidateError> {
    guard()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let engine = Engine::connect_cleanup_until(candidate, deadline)?;
    let (receipt, _) = journal::load(
        candidate,
        expected.review.scope().run,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    receipt.check_binding(expected)?;
    let backend = OwnedBackend {
        engine,
        launcher: None,
        leases: BTreeMap::new(),
    };
    let backend = GuardedBackend {
        backend: &backend,
        guard: Some(guard),
    };
    let result = logs_with(&backend, receipt, service, tail, deadline)?;
    journal::read_control(candidate, &expected.review)?.check_binding(expected)?;
    guard()?;
    managed_environment::remaining_until(deadline)?;
    Ok(result)
}
#[cfg(any(target_os = "macos", test))]
fn logs_with<B: Backend>(
    backend: &B,
    receipt: Receipt,
    service: &str,
    tail: u16,
    deadline: Instant,
) -> Result<ServiceLogs, CandidateError> {
    managed_environment::remaining_until(deadline)?;
    if receipt.phase != Phase::ReadyObserved || !(1..=1000).contains(&tail) {
        return Err(refused());
    }
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .ok_or_else(refused)?;
    if resource.kind != Kind::Container || !receipt.readiness.contains_key(service) {
        return Err(refused());
    }
    let container = resource.id.clone().ok_or_else(refused)?;
    snapshot_until(backend, receipt.clone(), Some(deadline))?;
    let before = inspected(backend, &receipt, resource)?.ok_or_else(refused)?;
    let generation = before["State"]["StartedAt"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .ok_or_else(refused)?
        .to_owned();
    let (stdout, stderr, truncated) = backend.logs(&container, tail)?;
    let after = inspected(backend, &receipt, resource)?.ok_or_else(refused)?;
    if after["State"]["StartedAt"] != generation {
        return Err(refused());
    }
    snapshot_until(backend, receipt.clone(), Some(deadline))?;
    managed_environment::remaining_until(deadline)?;
    Ok(ServiceLogs {
        receipt,
        service: service.into(),
        container,
        stdout,
        stderr,
        truncated,
    })
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
    snapshot_until(backend, receipt, None)
}
fn snapshot_until<B: Backend>(
    backend: &B,
    receipt: Receipt,
    deadline: Option<Instant>,
) -> Result<Snapshot, CandidateError> {
    let verify_source = || match deadline {
        Some(deadline) => backend.verify_source_until(&receipt, deadline),
        None => backend.verify_source(&receipt, receipt.phase != Phase::Removed),
    };
    verify_source()?;
    let data_deadline = deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(40));
    backend.verify_data(&receipt, data_deadline, &|| Ok(()))?;
    let mut observations = BTreeMap::new();
    if receipt.phase == Phase::Removed {
        for logical in network_keys(&receipt) {
            if inspected(
                backend,
                &receipt,
                &receipt.resources[&format!("network:{logical}")],
            )?
            .is_some()
            {
                return Err(refused());
            }
        }
    } else {
        project_networks(backend, &receipt, None)?;
    }
    for resource in receipt
        .resources
        .values()
        .filter(|r| r.kind == Kind::Container)
    {
        let observed = inspected(backend, &receipt, resource)?;
        if let Some(value) = &observed {
            verify_attachment(&receipt, &resource.key, value)?;
            project_networks(backend, &receipt, Some(value))?;
        }
        observations.insert(
            resource.key.clone(),
            observed.as_ref().map(observation).transpose()?,
        );
    }
    verify_source()?;
    backend.verify_data(&receipt, data_deadline, &|| Ok(()))?;
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
    expected: Option<&Receipt>,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
) -> Result<Receipt, CandidateError> {
    cleanup_inner(candidate, run, expected, guard, false, None, None)
}
#[cfg(target_os = "macos")]
pub(super) fn cleanup_recovery(
    candidate: &Candidate,
    run: &str,
    expected: &Receipt,
    guard: &dyn Fn() -> Result<(), CandidateError>,
    environment_retired: bool,
    inventory: &native_environment::Inventory,
    finish: &dyn Fn(&Snapshot) -> Result<(), CandidateError>,
) -> Result<Receipt, CandidateError> {
    cleanup_inner(
        candidate,
        run,
        Some(expected),
        Some(guard),
        environment_retired,
        Some(inventory),
        Some(finish),
    )
}
type CleanupFinish<'a> = dyn Fn(&Snapshot) -> Result<(), CandidateError> + 'a;
fn cleanup_inner(
    candidate: &Candidate,
    run: &str,
    expected: Option<&Receipt>,
    guard: Option<&dyn Fn() -> Result<(), CandidateError>>,
    environment_retired: bool,
    inventory: Option<&native_environment::Inventory>,
    finish: Option<&CleanupFinish<'_>>,
) -> Result<Receipt, CandidateError> {
    check_startup(guard)?;
    let engine = Engine::connect_cleanup(candidate)?;
    check_startup(guard)?;
    let (mut receipt, root) = journal::load(
        candidate,
        run,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    if let Some(expected) = expected {
        receipt.check_binding(expected)?;
    }
    check_startup(guard)?;
    let backend = OwnedBackend {
        engine,
        launcher: None,
        leases: BTreeMap::new(),
    };
    #[cfg(target_os = "macos")]
    if let Some(inventory) = inventory {
        native_environment::verify_inventory(
            candidate,
            backend.engine.guest(),
            &receipt,
            inventory,
            environment_retired,
            guard,
        )?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = inventory;
    cleanup_using_guarded(&backend, &mut receipt, &root, guard)?;
    check_startup(guard)?;
    if !environment_retired {
        native_environment::retire_graph(candidate, backend.engine.guest(), &receipt, guard)?;
    }
    check_startup(guard)?;
    if let Some(finish) = finish {
        // Keep the cleanup provider lease through fresh absence and publication
        // retirement; no second startup or cleanup connection supplies authority.
        native_environment::verify_retired_graph(
            candidate,
            backend.engine.guest(),
            &receipt,
            guard,
        )?;
        #[cfg(target_os = "macos")]
        if let Some(inventory) = inventory {
            native_environment::verify_inventory(
                candidate,
                backend.engine.guest(),
                &receipt,
                inventory,
                true,
                guard,
            )?;
        }
        let guarded = GuardedBackend {
            backend: &backend,
            guard,
        };
        let observed = snapshot(&guarded, receipt.clone())?;
        check_startup(guard)?;
        finish(&observed)?;
        check_startup(guard)?;
    }
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
    let guarded = GuardedBackend { backend, guard };
    let backend = &guarded;
    backend.verify_source(receipt, false)?;
    backend.verify_data(receipt, Instant::now() + Duration::from_secs(40), &|| {
        check_startup(guard)
    })?;
    // A committed cleanup phase is retry authority for this same inventory, never
    // permission to move the receipt back to startup or stop an already retired run.
    let stopped = matches!(
        receipt.phase,
        Phase::Stopped | Phase::RemovalIntent | Phase::Removed
    );
    let removing = matches!(receipt.phase, Phase::RemovalIntent | Phase::Removed);
    let removed = receipt.phase == Phase::Removed;
    let mut prepared = BTreeMap::new();
    let networks = network_keys(receipt)
        .into_iter()
        .map(|logical| {
            let resource = receipt
                .resources
                .get(&format!("network:{logical}"))
                .ok_or_else(refused)?
                .clone();
            let present = inspected(backend, receipt, &resource)?.is_some();
            if present {
                if resource.id.is_none() || removed || resource.phase == "removed" {
                    return Err(refused());
                }
                project_network(backend, receipt, &logical, None)?;
            }
            Ok((logical, resource, present))
        })
        .collect::<Result<Vec<_>, CandidateError>>()?;
    if receipt.topology.is_some()
        && (networks.iter().any(|(_, resource, present)| {
            !present
                && !matches!(
                    resource.phase.as_str(),
                    "removed" | "reserved" | "remove-intent"
                )
        }) || (networks
            .iter()
            .any(|(_, resource, present)| !present && resource.phase == "reserved")
            && receipt
                .resources
                .values()
                .any(|resource| resource.kind == Kind::Container && resource.id.is_some())))
    {
        // A never-created bridge is safe only before any container creation;
        // an uncertain create cannot be converted into absence authority.
        return Err(refused());
    }
    // All ownership and stop-state preflights complete before the first stop effect.
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Container)
    {
        if let Some(value) = inspected(backend, receipt, resource)? {
            if resource.id.is_none() || removed || resource.phase == "removed" {
                return Err(refused());
            }
            if networks.iter().all(|(_, _, present)| *present) {
                verify_attachment(receipt, &resource.key, &value)?;
                project_networks(backend, receipt, Some(&value))?;
            }
            let selected = super::super::shutdown::prepare(resource, &value)?;
            if stopped && selected.running {
                return Err(refused());
            }
            prepared.insert(key.clone(), selected);
        }
    }
    if receipt.topology.is_some()
        && !prepared.is_empty()
        && networks.iter().any(|(_, _, present)| !present)
    {
        return Err(refused());
    }
    check_startup(guard)?;
    backend.verify_source(receipt, false)?;
    if removed {
        return Ok(());
    }
    if !stopped {
        check_startup(guard)?;
        receipt.phase = Phase::StopIntent;
        journal::save(root, receipt)?;
    }
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
    if !stopped {
        backend.verify_source(receipt, false)?;
        backend.stop(&stops, &admitted)?;
    }
    backend.verify_source(receipt, false)?;
    for (key, prepared) in &prepared {
        let resource = &receipt.resources[key];
        let value = inspected(backend, receipt, resource)?.ok_or_else(refused)?;
        let terminal = super::super::shutdown::terminal(resource, &value, prepared.running)?;
        if terminal.id != prepared.id {
            return Err(refused());
        }
        super::super::shutdown::record_terminal(&mut receipt.terminal, key.clone(), terminal);
    }
    if !stopped {
        receipt.phase = Phase::Stopped;
    }
    // A resumed removal still durably records each fresh terminal observation
    // before deletion, without moving its already committed phase backward.
    check_startup(guard)?;
    journal::save(root, receipt)?;
    if !removing {
        check_startup(guard)?;
        receipt.phase = Phase::RemovalIntent;
        journal::save(root, receipt)?;
    }
    for key in prepared.keys() {
        check_startup(guard)?;
        backend.verify_source(receipt, false)?;
        let resource = &receipt.resources[key];
        let value = inspected(backend, receipt, resource)?.ok_or_else(refused)?;
        super::super::shutdown::terminal(resource, &value, false)?;
        check_startup(guard)?;
        backend.verify_source(receipt, false)?;
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
        check_startup(guard)?;
        receipt.resources.get_mut(key).ok_or_else(refused)?.phase = "removed".into();
        journal::save(root, receipt)?;
    }
    for resource in receipt.resources.values_mut() {
        if resource.kind == Kind::Container {
            resource.phase = "removed".into();
        }
    }
    for (logical, network, _) in &networks {
        if inspected(backend, receipt, network)?.is_some() {
            let actual = project_network(backend, receipt, logical, None)?;
            if !actual["Containers"]
                .as_object()
                .is_some_and(|members| members.is_empty())
            {
                return Err(refused());
            }
            check_startup(guard)?;
            receipt
                .resources
                .get_mut(&format!("network:{logical}"))
                .ok_or_else(refused)?
                .phase = "remove-intent".into();
            journal::save(root, receipt)?;
            check_startup(guard)?;
            backend.verify_source(receipt, false)?;
            backend.request(
                Method::DELETE,
                &format!(
                    "/v1.53/networks/{}",
                    network.id.as_deref().ok_or_else(refused)?
                ),
                None,
            )?;
            if inspected(backend, receipt, network)?.is_some() {
                return Err(refused());
            }
        }
        check_startup(guard)?;
        receipt
            .resources
            .get_mut(&format!("network:{logical}"))
            .ok_or_else(refused)?
            .phase = "removed".into();
        if receipt.topology.is_some() {
            // Each bridge's absence must be durable before the next delete.
            journal::save(root, receipt)?;
        }
    }
    receipt.phase = Phase::Removed;
    backend.verify_source(receipt, false)?;
    backend.verify_data(receipt, Instant::now() + Duration::from_secs(40), &|| {
        check_startup(guard)
    })?;
    journal::save(root, receipt)
}

fn verify_native_images(
    engine: &Engine<'_>,
    resources: &BTreeMap<String, Resource>,
    configs: &mut BTreeMap<String, Value>,
    private: &BTreeSet<String>,
) -> Result<BTreeMap<String, BTreeMap<String, String>>, CandidateError> {
    let mut expected = BTreeMap::new();
    for resource in resources
        .values()
        .filter(|resource| resource.kind == Kind::Container)
    {
        let image = engine.request(
            Method::GET,
            &format!(
                "/v1.53/images/{}/json",
                resource.image.as_deref().ok_or_else(refused)?
            ),
            None,
        )?;
        let config = configs.get_mut(&resource.key).ok_or_else(refused)?;
        if image["Id"].as_str() != resource.image.as_deref()
            || image["Os"] != "linux"
            || image["Architecture"] != "arm64"
        {
            return Err(refused());
        }
        if !image["Config"]["Volumes"].is_null() {
            let volumes = image["Config"]["Volumes"].as_object().ok_or_else(refused)?;
            let mounts = config["HostConfig"]["Mounts"]
                .as_array()
                .ok_or_else(refused)?;
            // Every image-declared volume must be overridden by exactly one admitted
            // persistent mount; anonymous engine allocation is never allowed.
            for (target, options) in volumes {
                if !options.as_object().is_some_and(|object| object.is_empty())
                    || mounts
                        .iter()
                        .filter(|mount| {
                            mount["Type"] == "volume"
                                && mount["Target"] == *target
                                && mount["VolumeOptions"]["NoCopy"] == true
                        })
                        .count()
                        != 1
                {
                    return Err(refused());
                }
            }
        }
        if private.contains(&resource.key) {
            image_process::apply_private(config, &image["Config"])?;
        }
        expected.insert(
            resource.key.clone(),
            image_environment::compose(&image["Config"]["Env"], &config["Env"])?,
        );
    }
    Ok(expected)
}

#[cfg(test)]
mod tests;

pub(in crate::provider::graph) fn reservations(
    candidate: &Candidate,
    engine: &Engine<'_>,
    new_attempt: bool,
    add: impl FnMut(&Value) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let mut verified_data = BTreeSet::new();
    reservations_using(
        candidate,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
        new_attempt,
        |receipt, resource| {
            if verified_data.insert(receipt.review.scope().run.to_owned()) {
                engine.verify_data(
                    receipt,
                    Instant::now() + Duration::from_secs(40),
                    &|| Ok(()),
                )?;
            }
            inspected(engine, receipt, resource)
        },
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
        let networks = network_keys(&receipt)
            .into_iter()
            .map(|logical| {
                let network = inspect(&receipt, &receipt.resources[&format!("network:{logical}")])?
                    .ok_or_else(refused)?;
                network_members(&receipt, &logical, &network, None)?;
                Ok((logical, network))
            })
            .collect::<Result<Vec<_>, CandidateError>>()?;
        for resource in receipt
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
        {
            let value = inspect(&receipt, resource)?.ok_or_else(refused)?;
            verify_attachment(&receipt, &resource.key, &value)?;
            for (logical, network) in &networks {
                network_members(&receipt, logical, network, Some(&value))?;
            }
            add(&value)?;
        }
    }
    Ok(())
}
