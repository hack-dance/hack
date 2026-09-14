//! Fresh owned graph attempts. Recovery only observes or cleans recorded resources; never replay.
mod archive;
pub use archive::archive;
mod config;
mod export;
pub use export::{Export, export};
mod journal;
mod restore;
use super::{engine::Engine, state};
use crate::{
    Candidate, CandidateError,
    project::{
        self, PlanOptions,
        execution::{self, Condition, Driver, Event, Health, Observation},
    },
};
use reqwest::Method;
pub use restore::restore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, os::unix::fs::DirBuilderExt, path::PathBuf, time::Duration};

fn error(code: &'static str, message: &str) -> CandidateError {
    CandidateError::new(code, message)
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn image_id(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|s| hex(s, 64))
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Container,
    Network,
    Volume,
}
impl Kind {
    fn word(self) -> &'static str {
        match self {
            Self::Container => "container",
            Self::Network => "network",
            Self::Volume => "volume",
        }
    }
    fn collection(self) -> &'static str {
        match self {
            Self::Container => "containers",
            Self::Network => "networks",
            Self::Volume => "volumes",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub kind: Kind,
    pub key: String,
    pub name: String,
    pub id: Option<String>,
    pub image: Option<String>,
    pub phase: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub version: u32,
    pub run: String,
    pub owner: String,
    pub namespace: String,
    pub plan_id: String,
    pub phase: String,
    pub readiness: BTreeMap<String, Condition>,
    pub resources: BTreeMap<String, Resource>,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub receipt: Receipt,
    pub journal_incomplete: bool,
    pub observations: BTreeMap<String, Value>,
}
fn labels(owner: &str, run: &str, namespace: &str, plan: &str, resource: &Resource) -> Value {
    json!({"io.hack-local.owner":owner,"io.hack-local.graph":run,"io.hack-local.namespace":namespace,"io.hack-local.plan":plan,"io.hack-local.kind":resource.kind.word(),"io.hack-local.resource":resource.key})
}
fn expected_labels(receipt: &Receipt, resource: &Resource) -> Value {
    labels(
        &receipt.owner,
        &receipt.run,
        &receipt.namespace,
        &receipt.plan_id,
        resource,
    )
}
fn directory(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    if !hex(run, 32) {
        return Err(error(
            "graph_run_id",
            "Graph attempt ID must be 32 lowercase hexadecimal characters.",
        ));
    }
    Ok(candidate.state_root.join("run/graphs").join(run))
}
fn inspect_resource(
    engine: &Engine<'_>,
    receipt: &Receipt,
    resource: &Resource,
) -> Result<Option<Value>, CandidateError> {
    let path = format!(
        "/v1.53/{}/{}{}",
        resource.kind.collection(),
        resource.id.as_deref().unwrap_or(&resource.name),
        if resource.kind == Kind::Container {
            "/json"
        } else {
            ""
        }
    );
    let value = match engine.request(Method::GET, &path, None) {
        Ok(v) => v,
        Err(e) if e.code == "engine_not_found" => return Ok(None),
        Err(e) => return Err(e),
    };
    let observed_labels = if resource.kind == Kind::Container {
        &value["Config"]["Labels"]
    } else {
        &value["Labels"]
    };
    let expected = expected_labels(receipt, resource);
    if !expected
        .as_object()
        .expect("labels")
        .iter()
        .all(|(k, v)| observed_labels.get(k) == Some(v))
    {
        return Err(error(
            "graph_foreign_resource",
            "Recorded graph name resolves to foreign ownership labels.",
        ));
    }
    if resource.kind != Kind::Volume {
        let id = value["Id"].as_str().filter(|v| hex(v, 64)).ok_or_else(|| {
            error(
                "graph_resource_identity",
                "Resource has no valid immutable identity.",
            )
        })?;
        if resource
            .id
            .as_deref()
            .is_some_and(|expected| expected != id)
        {
            return Err(error(
                "graph_resource_identity",
                "Recorded resource identity changed.",
            ));
        }
    }
    let actual_name = value["Name"]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches('/');
    if actual_name != resource.name
        || (resource.kind == Kind::Container
            && value["Image"].as_str() != resource.image.as_deref())
        || (resource.kind == Kind::Volume && value["Driver"] != "local")
        || (resource.kind == Kind::Network
            && (value["Driver"] != "bridge" || value["Internal"] != true))
    {
        return Err(error(
            "graph_resource_identity",
            "Owned resource type, name or pinned image differs.",
        ));
    }
    Ok(Some(value))
}
fn observation(value: &Value) -> Result<Observation, CandidateError> {
    let state = &value["State"];
    if state["Dead"] == true || state["OOMKilled"] == true {
        return Ok(Observation::Dead);
    }
    if state["Running"] == true {
        let health = match state["Health"]["Status"].as_str() {
            None => Health::None,
            Some("starting") => Health::Starting,
            Some("healthy") => Health::Healthy,
            Some("unhealthy") => Health::Unhealthy,
            _ => return Err(error("graph_state", "Unknown owned service health state.")),
        };
        return Ok(Observation::Running { health });
    }
    match state["Status"].as_str() {
        Some("created") => Ok(Observation::Created),
        Some("exited") => Ok(Observation::Exited {
            code: state["ExitCode"]
                .as_i64()
                .ok_or_else(|| error("graph_state", "Missing service exit code."))?,
        }),
        _ => Err(error("graph_state", "Unexpected owned service state.")),
    }
}
fn load(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    let root = directory(candidate, run)?;
    state::check_private_directory(&root)?;
    let receipt: Receipt = state::read(&root.join("state.json"))?;
    if receipt.version != 1
        || receipt.run != run
        || receipt.owner != engine.guest().incarnation()
        || !hex(&receipt.namespace, 64)
        || !hex(&receipt.plan_id, 64)
        || receipt.resources.is_empty()
        || receipt.resources.len() > 24
        || ![
            "preparing",
            "ready-observed",
            "failed-retained",
            "cleanup-intent",
            "removed",
            "stopped-data-retained",
            "restarting",
            "restoring",
            "reconciled-cleanup-only",
        ]
        .contains(&receipt.phase.as_str())
    {
        return Err(error(
            "graph_receipt",
            "Graph receipt identity or budget differs.",
        ));
    }
    if receipt.readiness.len()
        != receipt
            .resources
            .values()
            .filter(|r| r.kind == Kind::Container)
            .count()
        || receipt
            .readiness
            .keys()
            .any(|name| !receipt.resources.contains_key(&format!("container:{name}")))
    {
        return Err(error(
            "graph_receipt",
            "Readiness goals do not match recorded services.",
        ));
    }
    for (key, r) in &receipt.resources {
        let prefix = format!("hkg-{run}-{}-", r.kind.word());
        if key != &format!("{}:{}", r.kind.word(), r.key)
            || !r.name.strip_prefix(&prefix).is_some_and(|v| {
                !v.is_empty() && v.len() <= 2 && v.bytes().all(|b| b.is_ascii_digit())
            })
            || r.id.as_deref().is_some_and(|id| !hex(id, 64))
            || (r.kind == Kind::Container && !r.image.as_deref().is_some_and(image_id))
            || (r.kind != Kind::Container && r.image.is_some())
            || (r.kind == Kind::Volume && r.id.is_some())
            || ![
                "reserved",
                "create-intent",
                "created",
                "start-intent",
                "started",
                "uncertain",
                "restart-reserved",
                "absent",
            ]
            .contains(&r.phase.as_str())
        {
            return Err(error("graph_receipt", "Malformed graph resource identity."));
        }
    }
    Ok((receipt, root))
}

pub struct RunOptions<'a> {
    pub project: PlanOptions<'a>,
    pub expected_plan: &'a str,
    pub non_secret_values: &'a BTreeMap<String, String>,
    pub readiness: &'a BTreeMap<String, Condition>,
    pub run_id: &'a str,
    pub timeout: Duration,
}
struct Session<'a> {
    engine: Engine<'a>,
    root: PathBuf,
    receipt: Receipt,
    configs: BTreeMap<String, Value>,
    restarting: bool,
}
impl Session<'_> {
    #[cfg(test)]
    fn fault_pause(&self, point: &str) -> Result<(), CandidateError> {
        if std::env::var("HACK_LOCAL_GRAPH_FAULT").as_deref() == Ok(point) {
            state::write(
                &self.root.join(format!("fault-{point}.json")),
                &json!({"point":point,"run":self.receipt.run}),
            )?;
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        Ok(())
    }
    fn verify_config(&self, service: &str, inspected: &Value) -> Result<(), CandidateError> {
        let expected = &self.configs[service];
        for (key, value) in expected.as_object().expect("compiled config") {
            let actual = if key == "HostConfig" {
                &inspected["HostConfig"]
            } else if key == "NetworkingConfig" {
                continue;
            } else {
                &inspected["Config"][key]
            };
            if let Some(path) = mismatch(value, actual, key) {
                return Err(CandidateError::new(
                    "graph_config_mismatch",
                    format!("Owned container differs at compiled field {path}; values omitted."),
                ));
            }
        }
        if let Some(networks) = expected["NetworkingConfig"]["EndpointsConfig"].as_object() {
            for network in networks.keys() {
                if !inspected["NetworkSettings"]["Networks"][network]["Aliases"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == service))
                {
                    return Err(error(
                        "graph_config_mismatch",
                        "Owned network alias is missing.",
                    ));
                }
            }
        }
        Ok(())
    }
    fn save(&self) -> Result<(), CandidateError> {
        state::write(&self.root.join("state.json"), &self.receipt)
    }
    fn reserve(&mut self, key: &str, phase: &str) -> Result<(), CandidateError> {
        self.receipt
            .resources
            .get_mut(key)
            .ok_or_else(|| error("graph_service", "Unknown graph service."))?
            .phase = phase.into();
        self.save()
    }
    fn create_resources(&mut self, retain_data: bool) -> Result<(), CandidateError> {
        let keys: Vec<_> = self
            .receipt
            .resources
            .iter()
            .filter(|(_, r)| r.kind != Kind::Container)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let resource = self.receipt.resources[&key].clone();
            if retain_data && resource.kind == Kind::Volume {
                if inspect_resource(&self.engine, &self.receipt, &resource)?.is_none() {
                    return Err(error(
                        "graph_data_missing",
                        "Retained data disappeared; restore will not recreate it.",
                    ));
                }
                continue;
            }
            if inspect_resource(&self.engine, &self.receipt, &resource)?.is_some() {
                return Err(error(
                    "graph_resource_exists",
                    "Fresh graph cannot adopt an existing resource.",
                ));
            }
            self.reserve(&key, "create-intent")?;
            let labels = expected_labels(&self.receipt, &resource);
            let body = if resource.kind == Kind::Network {
                json!({"Name":resource.name,"Driver":"bridge","Internal":true,"Labels":labels})
            } else {
                json!({"Name":resource.name,"Driver":"local","Labels":labels})
            };
            let value = self.engine.request(
                Method::POST,
                &format!("/v1.53/{}/create", resource.kind.collection()),
                Some(&body),
            )?;
            if resource.kind == Kind::Network {
                self.receipt.resources.get_mut(&key).expect("resource").id = Some(
                    value["Id"]
                        .as_str()
                        .filter(|v| hex(v, 64))
                        .ok_or_else(|| {
                            error(
                                "graph_resource_identity",
                                "Missing created network identity.",
                            )
                        })?
                        .into(),
                );
            }
            if inspect_resource(&self.engine, &self.receipt, &self.receipt.resources[&key])?
                .is_none()
            {
                return Err(error(
                    "graph_resource_missing",
                    "Created graph resource is missing.",
                ));
            }
            self.reserve(&key, "created")?;
        }
        Ok(())
    }
}
impl Driver for Session<'_> {
    fn record(&mut self, event: Event<'_>) -> Result<(), CandidateError> {
        match event {
            Event::StartIntent { service } => {
                let key = format!("container:{service}");
                if self.receipt.resources.get(&key).is_none_or(|r| {
                    r.phase
                        != if self.restarting {
                            "restart-reserved"
                        } else {
                            "reserved"
                        }
                }) {
                    return Err(error(
                        "graph_replay_refused",
                        "Existing service intent cannot be replayed.",
                    ));
                }
                self.reserve(
                    &key,
                    if self.restarting {
                        "start-intent"
                    } else {
                        "create-intent"
                    },
                )
            }
            Event::Started { service } => self.reserve(&format!("container:{service}"), "started"),
            Event::StartUncertain { service } => {
                self.reserve(&format!("container:{service}"), "uncertain")
            }
            Event::Observed { .. } => Ok(()),
            Event::Ready => {
                self.receipt.phase = "ready-observed".into();
                self.save()
            }
        }
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        let key = format!("container:{service}");
        let resource = self.receipt.resources[&key].clone();
        if self.restarting {
            if resource.phase != "start-intent" {
                return Err(error("graph_replay_refused", "Restart intent is missing."));
            }
            let inspected = inspect_resource(&self.engine, &self.receipt, &resource)?
                .ok_or_else(|| error("graph_resource_missing", "Restart resource is missing."))?;
            self.verify_config(service, &inspected)?;
            let id = resource.id.as_deref().ok_or_else(|| {
                error(
                    "graph_replay_refused",
                    "Restart requires a confirmed immutable container ID.",
                )
            })?;
            self.engine
                .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
            return Ok(());
        }
        if resource.phase != "create-intent" || resource.id.is_some() {
            return Err(error(
                "graph_replay_refused",
                "Container creation cannot be replayed.",
            ));
        }
        if inspect_resource(&self.engine, &self.receipt, &resource)?.is_some() {
            return Err(error(
                "graph_resource_exists",
                "Fresh graph cannot adopt an existing container.",
            ));
        }
        let config = &self.configs[service];
        let value = self.engine.request(
            Method::POST,
            &format!("/v1.53/containers/create?name={}", resource.name),
            Some(config),
        )?;
        #[cfg(test)]
        self.fault_pause("after-create")?;
        let id = value["Id"]
            .as_str()
            .filter(|v| hex(v, 64))
            .ok_or_else(|| {
                error(
                    "graph_resource_identity",
                    "Missing created container identity.",
                )
            })?
            .to_owned();
        self.receipt.resources.get_mut(&key).expect("resource").id = Some(id.clone());
        self.reserve(&key, "created")?;
        let inspected =
            inspect_resource(&self.engine, &self.receipt, &self.receipt.resources[&key])?
                .ok_or_else(|| error("graph_resource_missing", "Created container is missing."))?;
        self.verify_config(service, &inspected)?;
        self.reserve(&key, "start-intent")?;
        self.engine
            .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
        #[cfg(test)]
        self.fault_pause("after-start")?;
        Ok(())
    }
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
        let resource = &self.receipt.resources[&format!("container:{service}")];
        let value = inspect_resource(&self.engine, &self.receipt, resource)?
            .ok_or_else(|| error("graph_resource_missing", "Owned service disappeared."))?;
        observation(&value)
    }
}
/// Explicit fresh attempt only. All commands must be non-secret until managed delivery is qualified.
pub fn run(candidate: &Candidate, options: RunOptions<'_>) -> Result<Receipt, CandidateError> {
    let root = directory(candidate, options.run_id)?;
    if options.timeout.is_zero() || options.timeout > Duration::from_secs(600) {
        return Err(error(
            "graph_budget",
            "Graph timeout is outside the bounded profile.",
        ));
    }
    let inputs = project::inputs::compile(
        candidate,
        options.project,
        options.expected_plan,
        options.non_secret_values,
    )?;
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != super::Profile::Development {
        return Err(error(
            "graph_profile",
            "Graph allocation requires the explicit development VM profile.",
        ));
    }
    let archived = archive::path(candidate, options.run_id)?;
    if root.exists() || root.is_symlink() || archived.exists() || archived.is_symlink() {
        return Err(error(
            "graph_replay_refused",
            "A graph attempt directory already exists; inspect or clean it explicitly.",
        ));
    }
    check_reservations(candidate, &engine, None)?;
    super::source_job::check_reservations(&engine)?;
    let prepared = config::prepare(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
    )?;
    verify_images(&engine, &prepared.resources)?;
    state::private_directory(root.parent().expect("graph parent"))?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(state::io)?;
    let receipt = Receipt {
        version: 1,
        run: options.run_id.into(),
        owner: engine.guest().incarnation().into(),
        namespace: prepared.namespace,
        plan_id: prepared.plan_id,
        phase: "preparing".into(),
        readiness: options.readiness.clone(),
        resources: prepared.resources,
    };
    let mut session = Session {
        engine,
        root,
        receipt,
        configs: prepared.configs,
        restarting: false,
    };
    session.save()?;
    let result = (|| {
        session.create_resources(false)?;
        execution::run(&prepared.graph, &mut session, options.timeout)
    })();
    if let Err(failure) = result {
        session.receipt.phase = "failed-retained".into();
        session.save()?;
        return Err(failure);
    }
    Ok(session.receipt.clone())
}
/// Read-only recovery inspection; historical ready phase is not a current health assertion.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Snapshot, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    let mut observations = BTreeMap::new();
    for (key, resource) in &receipt.resources {
        let value = match inspect_resource(&engine, &receipt, resource)? {
            None => json!({"state":"absent"}),
            Some(v) if resource.kind == Kind::Container => {
                serde_json::to_value(observation(&v)?)
                    .map_err(|_| error("graph_state", "Cannot encode observation."))?
            }
            Some(_) => json!({"state":"present"}),
        };
        observations.insert(key.clone(), value);
    }
    Ok(Snapshot {
        receipt,
        journal_incomplete: root.join("state.pending").exists()
            || root.join("state.pending").is_symlink(),
        observations,
    })
}
/// Explicit owned cleanup. Ordinary cleanup preserves named data; removing it requires `remove_data`.
pub fn cleanup(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
) -> Result<Receipt, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = load(candidate, &engine, run)?;
    if root.join("state.pending").exists() || root.join("state.pending").is_symlink() {
        return Err(error(
            "graph_journal_uncertain",
            "Pending graph journal is retained; cleanup is blocked until journal reconciliation.",
        ));
    }
    receipt.phase = "cleanup-intent".into();
    state::write(&root.join("state.json"), &receipt)?;
    for kind in [Kind::Container, Kind::Network, Kind::Volume] {
        if kind == Kind::Volume && !remove_data {
            continue;
        }
        let keys: Vec<_> = receipt
            .resources
            .iter()
            .filter(|(_, r)| r.kind == kind)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let resource = receipt.resources[&key].clone();
            if let Some(value) = inspect_resource(&engine, &receipt, &resource)? {
                let target = if kind == Kind::Volume {
                    resource.name.as_str()
                } else {
                    value["Id"].as_str().expect("verified id")
                };
                engine.request(
                    Method::DELETE,
                    &format!(
                        "/v1.53/{}/{target}{}",
                        kind.collection(),
                        if kind == Kind::Container {
                            "?force=true&v=true"
                        } else {
                            ""
                        }
                    ),
                    None,
                )?;
                if inspect_resource(&engine, &receipt, &resource)?.is_some() {
                    return Err(error(
                        "graph_cleanup_uncertain",
                        "Removed graph resource remains visible.",
                    ));
                }
            }
            receipt.resources.get_mut(&key).expect("resource").phase = "absent".into();
            state::write(&root.join("state.json"), &receipt)?;
        }
    }
    receipt.phase = if remove_data {
        "removed"
    } else {
        "stopped-data-retained"
    }
    .into();
    state::write(&root.join("state.json"), &receipt)?;
    Ok(receipt)
}

fn mismatch(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match expected {
        Value::Object(fields) => fields.iter().find_map(|(k, v)| {
            let path = format!("{path}.{k}");
            match actual.get(k) {
                Some(a) => mismatch(v, a, &path),
                None if v == &Value::Bool(false) || v.as_array().is_some_and(Vec::is_empty) => None,
                None => Some(path),
            }
        }),
        Value::Array(values) if values.is_empty() && actual.is_null() => None,
        Value::Array(values) => match actual.as_array() {
            Some(a) if a.len() == values.len() => values
                .iter()
                .zip(a)
                .enumerate()
                .find_map(|(i, (e, a))| mismatch(e, a, &format!("{path}[{i}]"))),
            _ => Some(path.into()),
        },
        _ if expected == actual => None,
        _ => Some(path.into()),
    }
}
#[cfg(test)]
fn contains_request(expected: &Value, actual: &Value) -> bool {
    mismatch(expected, actual, "request").is_none()
}

/// Explicit restart of a previously ready graph after all containers have stopped. IDs are
/// retained; no create is issued. Any incomplete prior transition requires inspection/cleanup.
pub fn restart(candidate: &Candidate, options: RunOptions<'_>) -> Result<Receipt, CandidateError> {
    if options.timeout.is_zero() || options.timeout > Duration::from_secs(600) {
        return Err(error("graph_budget", "Invalid graph timeout."));
    }
    let inputs = project::inputs::compile(
        candidate,
        options.project,
        options.expected_plan,
        options.non_secret_values,
    )?;
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != super::Profile::Development {
        return Err(error(
            "graph_profile",
            "Graph allocation requires the explicit development VM profile.",
        ));
    }
    let (mut receipt, root) = load(candidate, &engine, options.run_id)?;
    if root.join("state.pending").exists()
        || root.join("state.pending").is_symlink()
        || receipt.phase != "ready-observed"
        || receipt.plan_id != inputs.review.plan_id
        || receipt.readiness != *options.readiness
    {
        return Err(error(
            "graph_replay_refused",
            "Only a completely acknowledged ready graph with an unchanged plan can explicitly restart.",
        ));
    }
    check_reservations(candidate, &engine, Some(options.run_id))?;
    super::source_job::check_reservations(&engine)?;
    let prepared = config::prepare(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
    )?;
    if prepared.namespace != receipt.namespace
        || prepared.resources.keys().ne(receipt.resources.keys())
    {
        return Err(error(
            "graph_receipt",
            "Restart resources differ from the reviewed graph.",
        ));
    }
    for resource in receipt.resources.values() {
        let value = inspect_resource(&engine, &receipt, resource)?.ok_or_else(|| {
            error(
                "graph_resource_missing",
                "Restart requires every recorded resource.",
            )
        })?;
        if resource.kind == Kind::Container
            && (resource.phase != "started"
                || resource.id.is_none()
                || !matches!(observation(&value)?, Observation::Exited { .. }))
        {
            return Err(error(
                "graph_restart_running",
                "Restart requires confirmed, stopped containers and acknowledged prior starts.",
            ));
        }
    }
    receipt.phase = "restarting".into();
    for resource in receipt
        .resources
        .values_mut()
        .filter(|r| r.kind == Kind::Container)
    {
        resource.phase = "restart-reserved".into();
    }
    let mut session = Session {
        engine,
        root,
        receipt,
        configs: prepared.configs,
        restarting: true,
    };
    session.save()?;
    if let Err(failure) = execution::run(&prepared.graph, &mut session, options.timeout) {
        session.receipt.phase = "failed-retained".into();
        session.save()?;
        return Err(failure);
    }
    Ok(session.receipt)
}

#[cfg(test)]
mod tests;

/// Reconcile an interrupted journal for cleanup only. The pending bytes never become execution
/// authority: every possible create already had a name in the last committed receipt. The
/// interrupted file is retained, existing resources are verified, and no engine mutation occurs.
pub fn reconcile(candidate: &Candidate, run: &str) -> Result<Receipt, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (mut receipt, root) = load(candidate, &engine, run)?;
    for resource in receipt.resources.values() {
        inspect_resource(&engine, &receipt, resource)?;
    }
    if let Some(retained) = journal::retain(&root)? {
        state::write(&retained.join("committed.json"), &receipt)?;
        receipt.phase = "reconciled-cleanup-only".into();
        state::write(&root.join("state.json"), &receipt)?;
    }
    Ok(receipt)
}

/// Called while holding the provider mutation lease, before any workload allocation.
pub(super) fn check_reservations(
    candidate: &Candidate,
    engine: &Engine<'_>,
    except: Option<&str>,
) -> Result<(), CandidateError> {
    let parent = candidate.state_root.join("run/graphs");
    if parent.exists() || parent.is_symlink() {
        state::check_private_directory(&parent)?;
        let entries: Vec<_> = fs::read_dir(&parent)
            .map_err(state::io)?
            .take(65)
            .collect::<Result<_, _>>()
            .map_err(state::io)?;
        if entries.len() > 64 || (entries.len() == 64 && except.is_none()) {
            return Err(error(
                "graph_retention_budget",
                "Graph receipt retention exceeds 64 attempts; explicit archival is required.",
            ));
        }
        for entry in entries {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| error("graph_receipt", "Invalid graph directory name."))?;
            if except == Some(name.as_str()) {
                continue;
            }
            let (other, other_root) = load(candidate, engine, &name)?;
            if other_root.join("state.pending").exists()
                || other_root.join("state.pending").is_symlink()
                || !["removed", "stopped-data-retained"].contains(&other.phase.as_str())
            {
                return Err(error(
                    "graph_capacity_reserved",
                    "Another graph retains an active or uncertain reservation; inspect and clean it before allocating another graph.",
                ));
            }
        }
    }
    Ok(())
}

fn verify_images(
    engine: &Engine<'_>,
    resources: &BTreeMap<String, Resource>,
) -> Result<(), CandidateError> {
    for resource in resources.values().filter(|r| r.kind == Kind::Container) {
        let image = engine.request(
            Method::GET,
            &format!(
                "/v1.53/images/{}/json",
                resource.image.as_deref().expect("image")
            ),
            None,
        )?;
        if image["Id"].as_str() != resource.image.as_deref()
            || image["Os"] != "linux"
            || image["Architecture"] != "arm64"
            || image["Config"]["Volumes"]
                .as_object()
                .is_some_and(|v| !v.is_empty())
        {
            return Err(error(
                "graph_image",
                "Pinned image architecture or implicit volumes are incompatible.",
            ));
        }
    }
    Ok(())
}
