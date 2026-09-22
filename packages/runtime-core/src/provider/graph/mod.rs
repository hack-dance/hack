//! Fresh owned graph attempts. Recovery only observes or cleans recorded resources; never replay.
pub mod one_off;
mod service_exec;
pub use service_exec::{
    ServiceExecOptions, ServiceExecResult, service_exec, service_exec_generation,
    service_exec_with_environment,
};
mod normalized;
#[cfg(target_os = "macos")]
pub use normalized::run_normalized_with_host_dependencies_until;
pub use normalized::{
    NormalizedInputIdentity, NormalizedRunOptions, compile_normalized_inputs, run_normalized,
};
mod admission;
mod cache_provenance;
mod dependency_hosts;
mod initializer_cache;
mod volume_subpaths;
pub use dependency_hosts::dependency_address;
#[cfg(target_os = "macos")]
pub mod foreground;
mod startup;
mod startup_failure;
#[cfg(target_os = "macos")]
pub use startup::{Dependency, HostRelayRuntime};
mod archive;
pub use archive::archive;
mod bridge_recovery;
mod bridges;
pub use bridge_recovery::{export_bridge_recovery, inspect_bridge_recovery};
pub(in crate::provider) use bridges::{initialize_owner_registry, verify_owner_registry};
mod cleanup_enrollment;
#[cfg(target_os = "macos")]
mod dead_owner_cleanup;
#[cfg(target_os = "macos")]
pub use dead_owner_cleanup::recover_cleanup;

mod config;
mod dependency_cache;
mod image_environment;
mod image_process;
pub use cleanup_enrollment::{Phase as RelayCleanupPhase, RelayCleanup};
mod endpoints;
#[cfg(target_os = "macos")]
mod host_relay;
#[cfg(target_os = "macos")]
pub use host_relay::{
    HostRelayService, cleanup_with_relay, confirm_relay_cleanup, resume_relay_cleanup,
};
mod relay;
pub use bridges::{
    ReserveBridgeOptions, inspect_bridges, publish_bridge, reconcile_bridges, release_bridge,
    reserve_bridge, start_bridge,
};
mod environment;
pub use endpoints::GuestEndpoint;
#[cfg(all(test, feature = "environment-launcher"))]
mod environment_crash_test;
mod launcher;
mod probes;
#[cfg(all(test, feature = "environment-launcher"))]
mod startup_test;
pub use environment::stage_environment;
mod export;
pub use export::{Export, export};
mod journal;
mod retention;
mod storage;
mod storage_inventory;
pub use retention::{prune, reconcile_export};
pub use storage_inventory::inventory as storage_inventory;
mod restore;
mod restore_history;
mod routes;
mod service_logs;
mod shutdown;
pub use service_logs::{
    ServiceLogOptions, ServiceLogResult, ServiceSelection, service_logs, service_selection,
};
mod source;
use super::{engine::Engine, state};
use crate::{
    Candidate, CandidateError,
    project::{
        self, PlanOptions,
        execution::{self, Condition, Driver, Event, Health, Observation},
    },
};
use reqwest::Method;
pub use restore::{restore, restore_with_environment};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub use source::SourceBinding;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    time::Duration,
};

const MAX_SERVICES: usize = super::environment::MAX_MANAGED_SERVICES;
const MAX_NETWORKS: usize = 32;
const MAX_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
// Keep guest kernel/engine headroom outside all graph reservations. This only
// applies to the development profile; research comparison budgets are unchanged.
const GUEST_MEMORY_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_MEMORY_BYTES: u64 =
    super::Profile::Development.memory_mib() as u64 * 1024 * 1024 - GUEST_MEMORY_RESERVE_BYTES;
const MAX_VOLUMES: usize = 8;

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
    /// Explicitly enrolled local HTTPS intent, not a claim of active publication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<project::RoutingPlan>,
    /// Ordered logical attachments; absent only on legacy container receipts or non-containers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub networks: Option<Vec<String>>,
    /// Legacy graphs are internal; outbound requires an explicitly admitted pool.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub outbound: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<dependency_cache::CacheBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_provenance: Option<cache_provenance::CacheProvenance>,
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
    /// Most recent observed startup failure; retained after cleanup and replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_failure: Option<startup_failure::Failure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_input: Option<NormalizedInputIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_startup: Option<startup::Startup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_cleanup: Option<RelayCleanup>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub probes: BTreeMap<String, probes::Probe>,
    pub version: u32,
    pub run: String,
    pub owner: String,
    pub namespace: String,
    pub plan_id: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub environment_attached: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub initializer_cache_release: BTreeMap<String, initializer_cache::Record>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceBinding>,
    pub readiness: BTreeMap<String, Condition>,
    pub resources: BTreeMap<String, Resource>,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub receipt: Receipt,
    pub journal_incomplete: bool,
    pub observations: BTreeMap<String, Value>,
    pub guest_endpoints: BTreeMap<String, GuestEndpoint>,
    pub storage_references: Value,
}
fn labels(owner: &str, run: &str, namespace: &str, plan: &str, resource: &Resource) -> Value {
    json!({"io.hack-local.owner":owner,"io.hack-local.graph":run,"io.hack-local.namespace":namespace,"io.hack-local.plan":plan,"io.hack-local.kind":resource.kind.word(),"io.hack-local.resource":resource.key})
}
fn expected_labels(receipt: &Receipt, resource: &Resource) -> Value {
    if let Some(cache) = &resource.cache {
        return cache.labels(&receipt.owner, &resource.key);
    }
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
    verify_resource_identity(receipt, resource, &value)?;
    Ok(Some(value))
}
// Container layer contents never authorize cleanup: both writable and read-only
// roots use the same immutable identity, labels, name and image checks.
fn verify_resource_identity(
    receipt: &Receipt,
    resource: &Resource,
    value: &Value,
) -> Result<(), CandidateError> {
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
            && (value["Driver"] != "bridge" || value["Internal"] != !resource.outbound))
    {
        return Err(error(
            "graph_resource_identity",
            "Owned resource type, name or pinned image differs.",
        ));
    }
    Ok(())
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
fn check_network_intent(
    engine: &Engine<'_>,
    resources: &BTreeMap<String, Resource>,
) -> Result<(), CandidateError> {
    check_network_request(engine.guest().network_intent(), resources)
}
fn check_network_request(
    intent: &super::NetworkIntent,
    resources: &BTreeMap<String, Resource>,
) -> Result<(), CandidateError> {
    if resources.values().any(|r| r.outbound)
        && *intent != super::NetworkIntent::Internet
        && !matches!(intent, super::NetworkIntent::ApprovedHosts { cidrs, .. } if !cidrs.is_empty())
    {
        return Err(error(
            "graph_network_intent",
            "Outbound graph networks require an internet or explicitly approved-host pool.",
        ));
    }
    Ok(())
}

fn same_resource_bindings(
    requested: &BTreeMap<String, Resource>,
    retained: &BTreeMap<String, Resource>,
) -> bool {
    requested.len() == retained.len()
        && requested.iter().all(|(key, resource)| {
            retained.get(key).is_some_and(|old| {
                old.kind == resource.kind
                    && old.key == resource.key
                    && old.name == resource.name
                    && old.image == resource.image
                    && old.cache == resource.cache
                    && old.outbound == resource.outbound
                    && old.routing == resource.routing
                    && (old.networks == resource.networks
                        // Old receipts predate attachment persistence and admitted at most
                        // one network. The caller also requires the unchanged plan identity.
                        || (old.networks.is_none()
                            && resource.networks.as_ref().is_some_and(|v| v.len() <= 1)))
            })
        })
}

fn network_bindings_valid(resources: &BTreeMap<String, Resource>) -> bool {
    let network_count = resources
        .values()
        .filter(|r| r.kind == Kind::Network)
        .count();
    resources.values().all(|resource| {
        let Some(networks) = &resource.networks else {
            return resource.kind != Kind::Container || network_count <= 1;
        };
        resource.kind == Kind::Container
            && networks.len() <= MAX_NETWORKS
            && networks.iter().collect::<BTreeSet<_>>().len() == networks.len()
            && networks.iter().all(|name| {
                resources
                    .get(&format!("network:{name}"))
                    .is_some_and(|network| network.kind == Kind::Network && network.key == *name)
            })
    })
}

fn resource_counts_fit(resources: &BTreeMap<String, Resource>) -> bool {
    [
        (Kind::Container, MAX_SERVICES),
        (Kind::Network, MAX_NETWORKS),
        (Kind::Volume, MAX_VOLUMES),
    ]
    .into_iter()
    .all(|(kind, limit)| {
        resources
            .values()
            .filter(|resource| resource.kind == kind)
            .count()
            <= limit
    })
}

fn load(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    load_at(
        directory(candidate, run)?,
        run,
        engine.guest().incarnation(),
    )
}

// Validation is identical for normal active loads and confirmation-only archives.
fn load_at(
    root: PathBuf,
    run: &str,
    incarnation: &str,
) -> Result<(Receipt, PathBuf), CandidateError> {
    state::check_private_directory(&root)?;
    let receipt: Receipt = state::read(&root.join("state.json"))?;
    if receipt
        .startup_failure
        .as_ref()
        .is_some_and(|failure| !failure.valid(&receipt))
        || receipt.version != 1
        || receipt.run != run
        || receipt.owner != incarnation
        || !hex(&receipt.namespace, 64)
        || !hex(&receipt.plan_id, 64)
        || receipt
            .normalized_input
            .as_ref()
            .is_some_and(|input| !input.valid(&receipt.namespace))
        || receipt.source.as_ref().is_some_and(|s| {
            !s.valid()
                || s.live.as_ref().is_some_and(|live| {
                    live.workspace.namespace != receipt.namespace
                        || live.workspace.provider_incarnation != receipt.owner
                })
        })
        || receipt
            .relay_cleanup
            .as_ref()
            .is_some_and(|marker| !marker.valid())
        || receipt
            .relay_startup
            .as_ref()
            .is_some_and(|s| !s.valid(&receipt))
        || receipt
            .resources
            .values()
            .any(|r| r.outbound && r.kind != Kind::Network)
        || receipt.resources.is_empty()
        || !resource_counts_fit(&receipt.resources)
        || !network_bindings_valid(&receipt.resources)
        || receipt.resources.values().any(|resource| {
            resource.routing.as_ref().is_some_and(|route| {
                resource.kind != Kind::Container || !routes::valid_intent(route)
            })
        })
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
            || !r.cache.as_ref().map_or_else(
                || {
                    r.name.strip_prefix(&prefix).is_some_and(|v| {
                        !v.is_empty() && v.len() <= 2 && v.bytes().all(|b| b.is_ascii_digit())
                    })
                },
                |cache| r.kind == Kind::Volume && cache.valid() && r.name == cache.name(),
            )
            || (r.phase == "released" && r.cache.is_none())
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
                "released",
            ]
            .contains(&r.phase.as_str())
        {
            return Err(error("graph_receipt", "Malformed graph resource identity."));
        }
    }
    for resource in receipt.resources.values() {
        if resource
            .cache_provenance
            .as_ref()
            .is_some_and(|p| !p.valid(&receipt, resource))
        {
            return Err(error("graph_receipt", "Malformed cache provenance."));
        }
    }
    initializer_cache::validate_receipt(&receipt)?;
    probes::validate(&receipt)?;
    Ok((receipt, root))
}

pub struct RunOptions<'a> {
    /// Explicitly consume an acknowledged mutable directory workspace.
    pub live_source: bool,
    pub shared_source: bool,
    /// Explicit guest page/dentry cache release after selected fresh initializers.
    pub release_initializer_cache: BTreeSet<String>,
    /// Admit reviewed route intent; this does not itself publish an HTTPS route.
    pub routing_enrolled: bool,
    pub project: PlanOptions<'a>,
    pub expected_plan: &'a str,
    pub source_revision: Option<&'a str>,
    pub non_secret_values: &'a BTreeMap<String, String>,
    pub readiness: &'a BTreeMap<String, Condition>,
    pub run_id: &'a str,
    pub timeout: Duration,
}
struct Session<'a, 's> {
    startup: Option<&'s mut dyn startup::Driver>,
    engine: Engine<'a>,
    root: PathBuf,
    receipt: Receipt,
    configs: BTreeMap<String, Value>,
    expected_environment: BTreeMap<String, BTreeMap<String, String>>,
    restarting: bool,
    fresh_cache_completion: bool,
    cache_initializers: BTreeMap<String, String>,
    environments: BTreeMap<String, super::environment::PendingEnvironment>,
    leases: BTreeMap<String, super::environment::EnvironmentLease>,
    launcher: Option<String>,
}
#[cfg(test)]
pub(super) fn fault_pause(
    root: &std::path::Path,
    run: &str,
    point: &str,
) -> Result<(), CandidateError> {
    if std::env::var("HACK_LOCAL_GRAPH_FAULT").as_deref() == Ok(point) {
        state::write(
            &root.join(format!("fault-{point}.json")),
            &json!({"point":point,"run":run}),
        )?;
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    Ok(())
}
impl Session<'_, '_> {
    #[cfg(test)]
    fn fault_pause(&self, point: &str) -> Result<(), CandidateError> {
        fault_pause(&self.root, &self.receipt.run, point)
    }
    fn verify_config(&self, service: &str, inspected: &Value) -> Result<(), CandidateError> {
        image_environment::verify(
            &self.expected_environment[service],
            &inspected["Config"]["Env"],
        )?;
        let expected = &self.configs[service];
        for (key, value) in expected.as_object().expect("compiled config") {
            if key == "Env" {
                continue;
            }
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
            let actual = inspected["NetworkSettings"]["Networks"]
                .as_object()
                .ok_or_else(|| {
                    error(
                        "graph_config_mismatch",
                        "Owned network attachments are missing.",
                    )
                })?;
            if networks.keys().collect::<BTreeSet<_>>() != actual.keys().collect::<BTreeSet<_>>() {
                return Err(error(
                    "graph_config_mismatch",
                    "Owned network attachments differ from the compiled selection.",
                ));
            }
            for network in networks.keys() {
                let resource = self
                    .receipt
                    .resources
                    .values()
                    .find(|resource| resource.kind == Kind::Network && resource.name == *network)
                    .ok_or_else(|| {
                        error(
                            "graph_config_mismatch",
                            "Compiled network is not recorded as owned.",
                        )
                    })?;
                let id = resource.id.as_deref().ok_or_else(|| {
                    error(
                        "graph_config_mismatch",
                        "Owned network identity is missing.",
                    )
                })?;
                let observed = actual[network]["NetworkID"].as_str();
                if observed != Some(id)
                    && !(inspected["State"]["Running"] != true && observed == Some(""))
                {
                    return Err(error(
                        "graph_config_mismatch",
                        "Owned network identity changed.",
                    ));
                }
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
        } else if inspected["NetworkSettings"]["Networks"]
            .as_object()
            .is_some_and(|v| v.keys().any(|key| key != "none"))
        {
            return Err(error(
                "graph_config_mismatch",
                "Network-isolated container has unexpected attachments.",
            ));
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
        self.save()?;
        one_off::record_effect(&self.root, key, &self.receipt.resources[key])
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
            self.check_cancelled()?;
            let resource = self.receipt.resources[&key].clone();
            if retain_data && resource.kind == Kind::Volume {
                if inspect_resource(&self.engine, &self.receipt, &resource)?.is_none() {
                    return Err(error(
                        "graph_data_missing",
                        "Retained data disappeared; restore will not recreate it.",
                    ));
                }
                cache_provenance::verify(&self.engine, &self.receipt, &resource)?;
                volume_subpaths::prepare(
                    &self.engine,
                    &self.receipt,
                    &resource,
                    &self.configs,
                    false,
                )?;
                continue;
            }
            if inspect_resource(&self.engine, &self.receipt, &resource)?.is_some() {
                if resource.cache.is_some() {
                    volume_subpaths::prepare(
                        &self.engine,
                        &self.receipt,
                        &resource,
                        &self.configs,
                        false,
                    )?;
                    self.capture_cache_provenance(&key, false)?;
                    self.reserve(&key, "created")?;
                    continue;
                }
                return Err(error(
                    "graph_resource_exists",
                    "Fresh graph cannot adopt an existing resource.",
                ));
            }
            if resource.cache.is_some() {
                check_cache_capacity(&self.engine, &self.receipt.owner)?;
            }
            self.check_cancelled()?;
            self.reserve(&key, "create-intent")?;
            let labels = expected_labels(&self.receipt, &resource);
            let body = if resource.kind == Kind::Network {
                json!({"Name":resource.name,"Driver":"bridge","Internal":!resource.outbound,"Labels":labels})
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
            volume_subpaths::prepare(&self.engine, &self.receipt, &resource, &self.configs, true)?;
            self.capture_cache_provenance(&key, true)?;
            self.reserve(&key, "created")?;
        }
        Ok(())
    }
}
impl Driver for Session<'_, '_> {
    fn check_cancelled(&self) -> Result<(), CandidateError> {
        if let Some(startup) = &self.startup {
            startup.check_cancelled()?;
        }
        Ok(())
    }

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
            Event::Observed {
                service,
                observation: Observation::Exited { code: 0 },
            } => self.record_cache_completion(service),
            Event::Observed {
                service,
                observation,
            } if observation.failed() => {
                startup_failure::record(&mut self.receipt, service, observation)?;
                self.save()
            }
            Event::Observed { .. } => Ok(()),
            Event::Ready => {
                if let Some(startup) = self.startup.as_mut() {
                    startup.verify(&self.engine, &mut self.receipt, &self.root)?;
                }
                self.receipt.phase = "ready-observed".into();
                self.save()
            }
        }
    }
    fn start(&mut self, service: &str) -> Result<(), CandidateError> {
        self.check_cancelled()?;
        let key = format!("container:{service}");
        let resource = self.receipt.resources[&key].clone();
        if self.restarting {
            if resource.phase != "start-intent" {
                return Err(error("graph_replay_refused", "Restart intent is missing."));
            }
            self.prepare_probe(service)?;
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
            self.start_probe(service, id)?;
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
        self.prepare_probe(service)?;
        if let Some(pending) = self.environments.remove(service) {
            self.receipt.environment_attached = true;
            self.save()?;
            let (uid, gid) = launcher::identity(&self.configs[service])?;
            let lease = pending.with_identity(uid, gid).stage_bound(
                self.engine.guest(),
                Some(super::environment_recovery::GraphBinding {
                    run: self.receipt.run.clone(),
                    container: resource.name.clone(),
                }),
            )?;
            #[cfg(test)]
            self.fault_pause("after-environment-stage")?;
            let path = lease.verified_path_with_guest(self.engine.guest(), service)?;
            self.leases.insert(service.into(), lease);
            launcher::attach(
                self.configs.get_mut(service).expect("service"),
                &path,
                self.launcher.as_deref().expect("prepared launcher"),
            )?;
        }
        if let Some(startup) = &self.receipt.relay_startup {
            if let Some(selected) = startup.services.get(service) {
                startup::attach(
                    self.configs.get_mut(service).expect("service"),
                    selected,
                    &startup::guest_directory(&self.receipt.run, &selected.generation),
                    &startup::guest_executable(&self.receipt.run),
                )?;
            }
        }
        self.check_cancelled()?;
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
        if let Some(lease) = self.leases.get(service) {
            lease.verified_path_with_guest(self.engine.guest(), service)?;
        }
        if let Some(startup) = self.startup.as_mut() {
            startup.verify(&self.engine, &mut self.receipt, &self.root)?;
        }
        self.check_cancelled()?;
        self.engine
            .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)?;
        if let Some(startup) = self.startup.as_mut() {
            startup.started(
                &self.engine,
                &mut self.receipt,
                &self.root,
                &self.configs[service],
                service,
            )?;
        }
        self.start_probe(service, &id)?;
        #[cfg(test)]
        self.fault_pause("after-start")?;
        Ok(())
    }
    fn observe(&mut self, service: &str) -> Result<Observation, CandidateError> {
        if let Some(startup) = self.startup.as_mut() {
            startup.verify(&self.engine, &mut self.receipt, &self.root)?;
        }
        let resource = &self.receipt.resources[&format!("container:{service}")];
        let value = inspect_resource(&self.engine, &self.receipt, resource)?
            .ok_or_else(|| error("graph_resource_missing", "Owned service disappeared."))?;
        self.verify_config(service, &value)?;
        probes::observe(&self.engine, &self.receipt, service, &value)
    }
}
/// Explicit fresh attempt only. All commands must be non-secret until managed delivery is qualified.
pub fn run(candidate: &Candidate, options: RunOptions<'_>) -> Result<Receipt, CandidateError> {
    let inputs = project::inputs::compile(
        candidate,
        PlanOptions {
            project: options.project.project,
            compose_file: options.project.compose_file,
            profiles: options.project.profiles,
        },
        options.expected_plan,
        options.non_secret_values,
    )?;
    run_inputs(candidate, options, inputs, BTreeMap::new(), None, None)
}
/// Initial graph startup with a retained foreground dependency owner. The caller
/// must keep runtime alive and use its enrolled cleanup, including after failure.
#[cfg(target_os = "macos")]
pub fn run_with_host_dependencies(
    candidate: &Candidate,
    options: RunOptions<'_>,
    runtime: &mut HostRelayRuntime,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    lifetime: Duration,
) -> Result<Receipt, CandidateError> {
    run_with_host_dependencies_until(
        candidate,
        options,
        runtime,
        managed,
        environment_deadline(lifetime)?,
    )
}
/// Initial dependency startup retaining the exact private-ingress expiry deadline.
#[cfg(target_os = "macos")]
pub fn run_with_host_dependencies_until(
    candidate: &Candidate,
    options: RunOptions<'_>,
    runtime: &mut HostRelayRuntime,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: std::time::Instant,
) -> Result<Receipt, CandidateError> {
    startup::Driver::check_cancelled(runtime)?;
    check_environment_deadline(deadline)?;
    let (inputs, environments) = if managed.is_empty() {
        (
            project::inputs::compile(
                candidate,
                PlanOptions {
                    project: options.project.project,
                    compose_file: options.project.compose_file,
                    profiles: options.project.profiles,
                },
                options.expected_plan,
                options.non_secret_values,
            )?,
            BTreeMap::new(),
        )
    } else {
        compile_environment_inputs_until(candidate, &options, managed, deadline)?
    };
    check_environment_deadline(deadline)?;
    startup::Driver::check_cancelled(runtime)?;
    run_inputs(
        candidate,
        options,
        inputs,
        environments,
        Some(runtime),
        None,
    )
}
/// Experimental explicit in-memory delivery. No native provider is selected or called.
pub fn run_with_environment(
    candidate: &Candidate,
    options: RunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    lifetime: Duration,
) -> Result<Receipt, CandidateError> {
    let (inputs, environments) =
        compile_environment_inputs(candidate, &options, managed, lifetime)?;
    run_inputs(candidate, options, inputs, environments, None, None)
}
type EnvironmentInputs = (
    project::inputs::ExecutionInputs,
    BTreeMap<String, super::environment::PendingEnvironment>,
);
fn environment_deadline(lifetime: Duration) -> Result<std::time::Instant, CandidateError> {
    if lifetime.is_zero() || lifetime > Duration::from_secs(300) {
        return Err(error(
            "environment_input",
            "Environment lifetime exceeded its budget.",
        ));
    }
    std::time::Instant::now()
        .checked_add(lifetime)
        .ok_or_else(|| {
            error(
                "environment_expired",
                "Environment delivery deadline expired.",
            )
        })
}
fn check_environment_deadline(deadline: std::time::Instant) -> Result<(), CandidateError> {
    if deadline
        .checked_duration_since(std::time::Instant::now())
        .is_some_and(|left| !left.is_zero() && left <= Duration::from_secs(300))
    {
        Ok(())
    } else {
        Err(error(
            "environment_expired",
            "Environment delivery deadline expired or exceeded its budget.",
        ))
    }
}
fn compile_environment_inputs(
    candidate: &Candidate,
    options: &RunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    lifetime: Duration,
) -> Result<EnvironmentInputs, CandidateError> {
    compile_environment_inputs_until(candidate, options, managed, environment_deadline(lifetime)?)
}
pub(super) fn compile_environment_inputs_until(
    candidate: &Candidate,
    options: &RunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: std::time::Instant,
) -> Result<EnvironmentInputs, CandidateError> {
    if !cfg!(feature = "environment-launcher") {
        return Err(error(
            "environment_launcher_disabled",
            "Build with the environment-launcher feature for experimental delivery.",
        ));
    }
    check_environment_deadline(deadline)?;
    let scoped = project::inputs::compile_scoped(
        candidate,
        PlanOptions {
            project: options.project.project,
            compose_file: options.project.compose_file,
            profiles: options.project.profiles,
        },
        options.expected_plan,
        options.non_secret_values,
        managed,
    )?;
    let environments = scoped
        .managed_environment
        .iter()
        .map(|(name, values)| {
            super::environment::PendingEnvironment::until(name, values, deadline)
                .map(|pending| (name.clone(), pending))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    check_environment_deadline(deadline)?;
    Ok((scoped.executable, environments))
}

fn run_inputs(
    candidate: &Candidate,
    options: RunOptions<'_>,
    inputs: project::inputs::ExecutionInputs,
    environments: BTreeMap<String, super::environment::PendingEnvironment>,
    startup: Option<&mut dyn startup::Driver>,
    normalized_input: Option<NormalizedInputIdentity>,
) -> Result<Receipt, CandidateError> {
    if let Some(driver) = startup.as_ref() {
        driver.validate_inputs(&inputs)?;
    } else if inputs
        .services
        .values()
        .any(|service| !service.extra_hosts.is_empty())
    {
        return Err(dependency_hosts::refused());
    }
    let root = directory(candidate, options.run_id)?;
    if options.timeout.is_zero() || options.timeout > Duration::from_secs(600) {
        return Err(error(
            "graph_budget",
            "Graph timeout is outside the bounded profile.",
        ));
    }
    if options.live_source && !options.non_secret_values.is_empty() {
        return Err(error(
            "graph_live_source",
            "Live source cannot yet bind external execution substitutions.",
        ));
    }
    source::requested_mode(
        &inputs.review.plan,
        options.source_revision,
        options.live_source,
        options.shared_source,
    )?;
    // The Engine retains OwnedGuest's mutation lease through immutable/live source
    // verification and durable consumer publication, serializing sync and admission.
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != super::Profile::Development {
        return Err(error(
            "graph_profile",
            "Graph allocation requires the explicit development VM profile.",
        ));
    }
    let archived = archive::path(candidate, options.run_id)?;
    let consumed = retention::consumed(candidate, options.run_id)?;
    if root.exists()
        || root.is_symlink()
        || archived.exists()
        || archived.is_symlink()
        || consumed.exists()
        || consumed.is_symlink()
    {
        return Err(error(
            "graph_replay_refused",
            "A graph attempt directory already exists; inspect or clean it explicitly.",
        ));
    }
    super::source_job::check_reservations(&engine)?;
    let source = source::prepare_mode(
        candidate,
        &engine,
        &inputs.review.plan,
        options.source_revision,
        options.live_source,
        options.shared_source,
    )?;
    let mut prepared = config::prepare_delivery(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
        source.as_ref(),
        config::DeliveryOptions {
            environment: !environments.is_empty(),
            dependency_hosts: startup.is_some(),
            routing_enrolled: options.routing_enrolled,
        },
    )?;
    initializer_cache::validate_selection(
        &options.release_initializer_cache,
        &prepared.cache_initializers,
    )?;
    check_network_intent(&engine, &prepared.resources)?;
    admission::check(candidate, &engine, None, &prepared.configs)?;
    if !environments.is_empty() {
        super::environment::preflight_capacity(engine.guest(), environments.len())?;
    }
    // Resolve inherited process defaults only from the exact verified image,
    // before the private launcher takes ownership of Entrypoint and Cmd.
    let expected_environment = verify_images(
        &engine,
        &prepared.resources,
        &mut prepared.configs,
        &environments.keys().cloned().collect(),
    )?;
    for name in environments.keys() {
        launcher::validate(&prepared.configs[name])?;
    }
    if let Some(driver) = startup.as_ref() {
        driver.check_cancelled()?;
    }
    let launcher = if environments.is_empty() {
        None
    } else {
        Some(launcher::publish(&engine)?)
    };
    if let Some(driver) = startup.as_ref() {
        driver.check_cancelled()?;
    }
    state::private_directory(root.parent().expect("graph parent"))?;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(state::io)?;
    let probe_states = probes::fresh(&engine, &prepared.configs, prepared.probes)?;
    let receipt = Receipt {
        startup_failure: None,
        normalized_input,
        relay_startup: None,
        relay_cleanup: None,
        probes: probe_states,
        version: 1,
        run: options.run_id.into(),
        owner: engine.guest().incarnation().into(),
        namespace: prepared.namespace,
        plan_id: prepared.plan_id,
        phase: "preparing".into(),
        environment_attached: false,
        initializer_cache_release: options
            .release_initializer_cache
            .iter()
            .map(|name| (name.clone(), initializer_cache::Record::selected()))
            .collect(),
        source: source.map(|s| s.binding),
        readiness: options.readiness.clone(),
        resources: prepared.resources,
    };
    let mut session = Session {
        startup,
        engine,
        root,
        receipt,
        configs: prepared.configs,
        expected_environment,
        restarting: false,
        fresh_cache_completion: true,
        cache_initializers: prepared.cache_initializers,
        environments,
        leases: BTreeMap::new(),
        launcher,
    };
    session.save()?;
    let result = (|| {
        // Once the graph directory exists, enroll its cleanup owner before
        // observing cancellation. A pending signal must not strand reserved state.
        if let Some(startup) = session.startup.as_mut() {
            startup.prepare(
                &session.engine,
                &mut session.receipt,
                &session.root,
                &mut session.configs,
            )?;
        }
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
/// The compiler pins the first declared service network in NetworkMode. Select
/// that primary attachment, never a network belonging only to another service.
/// The endpoint resolver independently checks membership/address/generation.
fn endpoint_network<'a>(
    receipt: &Receipt,
    container: &Value,
    networks: &'a BTreeMap<String, Option<Value>>,
) -> Result<Option<&'a Value>, CandidateError> {
    let refused = || {
        error(
            "graph_endpoint_identity",
            "Service primary attachment differs from its recorded owned network.",
        )
    };
    let mode = container["HostConfig"]["NetworkMode"]
        .as_str()
        .ok_or_else(refused)?;
    if mode == "none" {
        return Ok(None);
    }
    let mut matching = receipt
        .resources
        .iter()
        .filter(|(_, resource)| resource.kind == Kind::Network && resource.name == mode);
    let (key, resource) = matching.next().ok_or_else(refused)?;
    if matching.next().is_some() {
        return Err(refused());
    }
    let id = resource
        .id
        .as_deref()
        .filter(|id| hex(id, 64))
        .ok_or_else(refused)?;
    let network = networks
        .get(key)
        .and_then(Option::as_ref)
        .ok_or_else(refused)?;
    if network["Id"].as_str() != Some(id)
        || network["Name"].as_str() != Some(mode)
        || container["NetworkSettings"]["Networks"][mode]["NetworkID"].as_str() != Some(id)
    {
        return Err(refused());
    }
    Ok(Some(network))
}

/// Read-only recovery inspection; historical ready phase is not a current health assertion.
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Snapshot, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    inspect_using(candidate, &engine, run)
}
fn inspect_using(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<Snapshot, CandidateError> {
    let (receipt, root) = load(candidate, engine, run)?;
    let mut observations = BTreeMap::new();
    let journal_incomplete =
        root.join("state.pending").exists() || root.join("state.pending").is_symlink();
    let mut networks = BTreeMap::new();
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Network)
    {
        networks.insert(key.clone(), inspect_resource(engine, &receipt, resource)?);
    }
    let mut guest_endpoints = BTreeMap::new();
    for (key, resource) in &receipt.resources {
        let inspected = if resource.kind == Kind::Network {
            networks.get(key).expect("network inspected").clone()
        } else {
            inspect_resource(engine, &receipt, resource)?
        };
        let value = match inspected {
            None => json!({"state":"absent"}),
            Some(v) if resource.kind == Kind::Container => {
                let observation = probes::observe(engine, &receipt, &resource.key, &v)?;
                if !journal_incomplete
                    && receipt.phase == "ready-observed"
                    && resource.id.is_some()
                    && observation
                        == (Observation::Running {
                            health: Health::Healthy,
                        })
                    && let Some(probe) = receipt.probes.get(&resource.key)
                    && endpoint_network(&receipt, &v, &networks)?.is_some()
                {
                    guest_endpoints.insert(
                        resource.key.clone(),
                        endpoints::resolve_attached(
                            &v,
                            &networks,
                            probe.config.port,
                            &endpoints::EndpointScope {
                                receipt: &receipt,
                                boot: engine.guest().boot_id(),
                                service: &resource.key,
                            },
                        )?,
                    );
                }
                serde_json::to_value(observation)
                    .map_err(|_| error("graph_state", "Cannot encode observation."))?
            }
            Some(_) => json!({"state":"present"}),
        };
        observations.insert(key.clone(), value);
    }
    let storage_references = storage::references(&receipt, journal_incomplete, &observations);
    Ok(Snapshot {
        receipt,
        journal_incomplete,
        observations,
        guest_endpoints,
        storage_references,
    })
}
/// Explicit owned cleanup. Ordinary cleanup preserves named data; removing it requires `remove_data`.
pub fn cleanup(
    candidate: &Candidate,
    run: &str,
    remove_data: bool,
) -> Result<Receipt, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let (receipt, root) = load(candidate, &engine, run)?;
    cleanup_enrollment::ordinary_mutation(&root, &receipt)?;
    cleanup_owned(candidate, &engine, receipt, &root, remove_data)
}

// The caller retains the VM mutation lease through this entire effect and any
// additional relay confirmation. Never reconnect from inside this function.
fn cleanup_owned(
    candidate: &Candidate,
    engine: &Engine<'_>,
    mut receipt: Receipt,
    root: &std::path::Path,
    remove_data: bool,
) -> Result<Receipt, CandidateError> {
    if root.join("state.pending").exists() || root.join("state.pending").is_symlink() {
        return Err(error(
            "graph_journal_uncertain",
            "Pending graph journal is retained; cleanup is blocked until journal reconciliation.",
        ));
    }
    startup::cleanup_guest(engine, &receipt, false)?;
    bridges::release_run(candidate, engine, &receipt)?;
    let environment_slots = environment::cleanup_slots(candidate, engine, &receipt)?;
    receipt.phase = "cleanup-intent".into();
    state::write(&root.join("state.json"), &receipt)?;
    shutdown::stop_owned(engine, &receipt, root)?;
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
            if resource.cache.is_some() {
                // A graph can release its reference, never destroy a shared cache.
                // Cache-wide collection needs independent references and retention policy.
                inspect_resource(engine, &receipt, &resource)?;
                receipt.resources.get_mut(&key).expect("resource").phase = "released".into();
                state::write(&root.join("state.json"), &receipt)?;
                continue;
            }
            if let Some(value) = inspect_resource(engine, &receipt, &resource)? {
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
                            "?v=true"
                        } else {
                            ""
                        }
                    ),
                    None,
                )?;
                if inspect_resource(engine, &receipt, &resource)?.is_some() {
                    return Err(error(
                        "graph_cleanup_uncertain",
                        "Removed graph resource remains visible.",
                    ));
                }
            }
            volume_subpaths::forget_removed(engine, &receipt, &resource)?;
            receipt.resources.get_mut(&key).expect("resource").phase = "absent".into();
            // The durable cleanup intent owns every retry. Reinspection recovers partial removal;
            // only the final receipt needs another commit, including environment-slot retirement.
            #[cfg(test)]
            fault_pause(root, &receipt.run, "cleanup-after-remove")?;
        }
    }
    startup::cleanup_guest(engine, &receipt, true)?;
    startup::verify_cleanup(engine, &receipt)?;
    probes::cleanup(engine, &mut receipt)?;
    for slot in environment_slots {
        super::environment_recovery::retire(candidate, engine.guest(), &slot, None)?;
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
    normalized::require_file_replay(&receipt)?;
    initializer_cache::require_resolved(&receipt)?;
    cleanup_enrollment::ordinary_mutation(&root, &receipt)?;
    environment::require_replay_supported(&receipt)?;
    if root.join("state.pending").exists()
        || root.join("state.pending").is_symlink()
        || receipt.phase != "ready-observed"
        || receipt.readiness != *options.readiness
    {
        return Err(error(
            "graph_replay_refused",
            "Only a completely acknowledged ready graph with an unchanged plan can explicitly restart.",
        ));
    }
    super::source_job::check_reservations(&engine)?;
    let source = source::prepare_replay(
        &engine,
        &inputs,
        &receipt,
        options.source_revision,
        options.live_source,
        options.shared_source,
        options.non_secret_values,
    )?;
    let mut prepared = config::prepare(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
        source.as_ref(),
    )?;
    config::retain_replay_ownership(&mut prepared, &receipt)?;
    if prepared.namespace != receipt.namespace
        || !same_resource_bindings(&prepared.resources, &receipt.resources)
    {
        return Err(error(
            "graph_receipt",
            "Restart resources differ from the reviewed graph.",
        ));
    }
    check_network_intent(&engine, &prepared.resources)?;
    admission::check(candidate, &engine, Some(options.run_id), &prepared.configs)?;
    for resource in receipt.resources.values() {
        volume_subpaths::prepare(&engine, &receipt, resource, &prepared.configs, false)?;
    }
    let expected_environment = verify_images(
        &engine,
        &prepared.resources,
        &mut prepared.configs,
        &BTreeSet::new(),
    )?;
    probes::unchanged(&prepared.configs, &prepared.probes, &receipt)?;
    for resource in receipt.resources.values() {
        let value = inspect_resource(&engine, &receipt, resource)?.ok_or_else(|| {
            error(
                "graph_resource_missing",
                "Restart requires every recorded resource.",
            )
        })?;
        cache_provenance::verify(&engine, &receipt, resource)?;
        if resource.kind == Kind::Container {
            admission::unchanged(&value, &prepared.configs[&resource.key])?;
        }
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
        startup: None,
        engine,
        root,
        receipt,
        configs: prepared.configs,
        expected_environment,
        restarting: true,
        fresh_cache_completion: false,
        cache_initializers: BTreeMap::new(),
        environments: BTreeMap::new(),
        leases: BTreeMap::new(),
        launcher: None,
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
    let (mut receipt, root) = archive::load_reconciliation(candidate, &engine, run)?;
    for resource in receipt.resources.values() {
        inspect_resource(&engine, &receipt, resource)?;
    }
    if let Some(retained) = journal::retain(&root)? {
        state::write(&retained.join("committed.json"), &receipt)?;
        // Enrollment already fences ordinary mutations. Preserve committed
        // terminal evidence so explicit confirmation can independently recover.
        if receipt.relay_cleanup.is_none() {
            receipt.phase = "reconciled-cleanup-only".into();
            state::write(&root.join("state.json"), &receipt)?;
        }
    }
    if initializer_cache::abort_after_boot_change(&mut receipt, engine.guest().boot_id())? {
        state::write(&root.join("state.json"), &receipt)?;
    }
    Ok(receipt)
}

/// The caller already holds OwnedGuest's mutation lease. Do not acquire an
/// Engine or source writer lock here: graph admission and sync share this lease.
pub(super) fn check_live_source_consumers(
    guest: &super::lifecycle::OwnedGuest<'_>,
    namespace: &str,
    tree_inode: Option<u64>,
    contract: Option<&project::live_source::Contract>,
) -> Result<(), CandidateError> {
    check_live_source_records(
        guest.candidate(),
        guest.incarnation(),
        namespace,
        tree_inode,
        contract,
    )
}

fn check_live_source_records(
    candidate: &Candidate,
    incarnation: &str,
    namespace: &str,
    tree_inode: Option<u64>,
    contract: Option<&project::live_source::Contract>,
) -> Result<(), CandidateError> {
    let parent = candidate.state_root.join("run/graphs");
    if !parent.try_exists().map_err(state::io)? && !parent.is_symlink() {
        return Ok(());
    }
    state::check_private_directory(&parent)?;
    let entries = fs::read_dir(&parent)
        .map_err(state::io)?
        .take(65)
        .collect::<Result<Vec<_>, _>>()
        .map_err(state::io)?;
    if entries.len() > 64 {
        return Err(error(
            "graph_live_source",
            "Graph consumer inventory exceeds its bound.",
        ));
    }
    for entry in entries {
        let run = entry
            .file_name()
            .into_string()
            .map_err(|_| error("graph_live_source", "Invalid graph consumer directory."))?;
        let root = directory(candidate, &run)?;
        let pending = root.join("state.pending");
        if pending.try_exists().map_err(state::io)? || pending.is_symlink() {
            return Err(error(
                "graph_live_source",
                "Uncertain graph journal blocks source mutation.",
            ));
        }
        let (receipt, _) = load_at(root, &run, incarnation)?;
        check_live_consumer(&receipt, namespace, tree_inode, contract)?;
    }
    Ok(())
}

fn check_live_consumer(
    receipt: &Receipt,
    namespace: &str,
    tree_inode: Option<u64>,
    contract: Option<&project::live_source::Contract>,
) -> Result<(), CandidateError> {
    let Some(live) = receipt
        .source
        .as_ref()
        .and_then(|source| source.live.as_ref())
    else {
        return Ok(());
    };
    if live.workspace.namespace != receipt.namespace
        || live.workspace.provider_incarnation != receipt.owner
    {
        return Err(error(
            "graph_live_source",
            "Graph live workspace identity differs.",
        ));
    }
    if receipt.phase == "removed" {
        if receipt
            .resources
            .values()
            .any(|r| r.phase != "absent" && !(r.cache.is_some() && r.phase == "released"))
        {
            return Err(error(
                "graph_live_source",
                "Removed consumer has unretired resources.",
            ));
        }
        return Ok(());
    }
    if live.workspace.namespace == namespace
        && (tree_inode != Some(live.workspace.tree_inode) || contract != Some(&live.contract))
    {
        return Err(error(
            "graph_live_source",
            "Source update lacks the exact retained consumer contract.",
        ));
    }
    Ok(())
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

fn check_cache_capacity(engine: &Engine<'_>, owner: &str) -> Result<(), CandidateError> {
    let listing = engine.request(Method::GET, "/v1.53/volumes", None)?;
    let volumes = match listing.get("Volumes") {
        Some(Value::Array(volumes)) => volumes.as_slice(),
        Some(Value::Null) => &[],
        _ => {
            return Err(error(
                "graph_cache_inventory",
                "Cannot verify cache volume admission inventory.",
            ));
        }
    };
    if volumes
        .iter()
        .filter(|v| {
            v["Labels"]["io.hack-local.owner"] == owner
                && v["Labels"]["io.hack-local.kind"] == "dependency-cache"
        })
        .count()
        >= 64
    {
        return Err(error(
            "graph_cache_capacity",
            "Runtime cache limit of 64 volumes reached; explicit cache retention is required.",
        ));
    }
    Ok(())
}

fn verify_images(
    engine: &Engine<'_>,
    resources: &BTreeMap<String, Resource>,
    configs: &mut BTreeMap<String, Value>,
    private_services: &BTreeSet<String>,
) -> Result<BTreeMap<String, BTreeMap<String, String>>, CandidateError> {
    let mut expected = BTreeMap::new();
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
        if private_services.contains(&resource.key) {
            image_process::apply_private(
                configs
                    .get_mut(&resource.key)
                    .expect("compiled service config"),
                &image["Config"],
            )?;
        }
        expected.insert(
            resource.key.clone(),
            image_environment::compose(&image["Config"]["Env"], &configs[&resource.key]["Env"])?,
        );
    }
    Ok(expected)
}
