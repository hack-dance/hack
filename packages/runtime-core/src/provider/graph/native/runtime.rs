//! Explicit native consumption. The provider lease covers admission through the last observation.
use super::*;
use crate::provider::{environment::PendingEnvironment, native_environment};
use std::{path::Path, time::Instant};

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
    fn stop(&self, _selected: &[(String, u64)]) -> Result<(), CandidateError> {
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
    fn stop(&self, selected: &[(String, u64)]) -> Result<(), CandidateError> {
        self.engine
            .stop_containers_diagnosed(selected)
            .map_err(|failure| failure.error)
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
        || value["Image"].as_str() != resource.image.as_deref()
    {
        return Err(refused());
    }
    // Labels are checked separately from user process configuration and never authorize adoption.
    if !expected
        .as_object()
        .expect("native labels")
        .iter()
        .all(|(key, expected)| value["Config"]["Labels"].get(key) == Some(expected))
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
            "/v1.53/containers/{}/json",
            resource.id.as_deref().unwrap_or(&resource.name)
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
    expected: &Value,
    environment: &BTreeMap<String, String>,
    actual: &Value,
) -> Result<(), CandidateError> {
    image_environment::verify(environment, &actual["Config"]["Env"])?;
    for (key, value) in expected.as_object().ok_or_else(refused)? {
        if key == "Env" {
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
    if !actual["NetworkSettings"]["Networks"]
        .as_object()
        .is_some_and(|networks| networks.keys().all(|key| key == "none"))
    {
        return Err(refused());
    }
    Ok(())
}

struct Session<'a, B> {
    candidate: &'a Candidate,
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
}
impl<B: Backend> Driver for Session<'_, B> {
    fn check_cancelled(&self) -> Result<(), CandidateError> {
        self.selected.assert_fresh(self.candidate)
    }
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        match event {
            Event::StartIntent { service } => {
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
            &self.configs[service],
            &self.expected_environment[service],
            &value,
        )?;
        self.reserve(service, "start-intent")?;
        self.check_cancelled()?;
        self.backend.verify_private(service)?;
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
            &self.configs[service],
            &self.expected_environment[service],
            &value,
        )?;
        observation(&value)
    }
}

/// Fresh native attempt only. This does not select a default backend or acquire credentials.
pub fn run(
    candidate: &Candidate,
    prepared: selection::Prepared,
) -> Result<Receipt, CandidateError> {
    let (selected, input) = prepared.into_parts(candidate)?;
    let deadline = selected.remaining()?;
    #[cfg(target_os = "macos")]
    let engine =
        Engine::connect_until(candidate, deadline, || false)?.with_admission_deadline(deadline);
    #[cfg(not(target_os = "macos"))]
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != crate::provider::Profile::Development {
        return Err(refused());
    }
    selected.assert_fresh(candidate)?;
    let mut config = configuration(&input, engine.guest().incarnation())?;
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
    selected.assert_fresh(candidate)?;
    let receipt = Receipt::preparing(
        &config,
        engine.guest().incarnation(),
        engine.guest().boot_id(),
    )?;
    let root = journal::reserve(candidate, &receipt)?;
    // Retain a native reservation before launcher publication, staging or container creation.
    let execution = (|| {
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
        let result = execution::run(
            &graph,
            &mut session,
            deadline.saturating_duration_since(Instant::now()),
        );
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
    for resource in receipt.resources.values() {
        observations.insert(
            resource.key.clone(),
            inspected(backend, &receipt, resource)?
                .as_ref()
                .map(observation)
                .transpose()?,
        );
    }
    Ok(Snapshot {
        receipt,
        observations,
    })
}

/// Bounded same-incarnation cleanup; no restart, cross-boot restore, force or volume pruning.
pub fn cleanup(candidate: &Candidate, run: &str) -> Result<Receipt, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = journal::load(
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
    cleanup_using(&backend, &mut receipt, &root)?;
    native_environment::retire_graph(candidate, backend.engine.guest(), &receipt)?;
    Ok(receipt)
}
fn cleanup_using<B: Backend>(
    backend: &B,
    receipt: &mut Receipt,
    root: &Path,
) -> Result<(), CandidateError> {
    let mut prepared = BTreeMap::new();
    // All ownership and stop-state preflights complete before the first stop effect.
    for (key, resource) in &receipt.resources {
        if let Some(value) = inspected(backend, receipt, resource)? {
            if resource.id.is_none() {
                return Err(refused());
            }
            prepared.insert(
                key.clone(),
                super::super::shutdown::prepare(resource, &value)?,
            );
        }
    }
    receipt.phase = Phase::StopIntent;
    journal::save(root, receipt)?;
    let stops = prepared
        .values()
        .filter(|p| p.running)
        .map(|p| (p.id.clone(), u64::from(p.grace_seconds)))
        .collect::<Vec<_>>();
    backend.stop(&stops)?;
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
        resource.phase = "removed".into();
    }
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
        for resource in receipt.resources.values() {
            let value = inspect(&receipt, resource)?.ok_or_else(refused)?;
            add(&value)?;
        }
    }
    Ok(())
}
