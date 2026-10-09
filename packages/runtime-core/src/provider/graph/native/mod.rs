//! Native authored lowering; runtime ownership and effects are separately admitted.
use super::*;
use crate::{project::native::NativeInputs, provider::native_input};
#[cfg(target_os = "macos")]
pub mod foreground;
mod journal;
pub mod persistent_data;
mod runtime;
pub mod selection;
mod source;
pub use journal::{Phase, Receipt};
pub(super) use runtime::reservations;
pub use runtime::{Snapshot, cleanup, inspect, run};

pub(in crate::provider) fn environment_binding(
    candidate: &Candidate,
    owner: &str,
    boot: &str,
    binding: &crate::provider::native_environment::Binding,
    service: &str,
    staging: bool,
) -> Result<(), CandidateError> {
    let (receipt, _) = journal::load(candidate, &binding.run, owner, boot)?;
    let resource = receipt
        .resources
        .get(&format!("container:{service}"))
        .ok_or_else(refused)?;
    let scope = receipt.review.scope();
    if binding.namespace != scope.namespace
        || binding.review != receipt.review.review_id()
        || binding.container != resource.name
        || (staging
            && (receipt.phase != Phase::Preparing
                || resource.phase != "create-intent"
                || resource.id.is_some()))
        || (!staging && resource.phase == "reserved")
    {
        return Err(refused());
    }
    Ok(())
}

/// Public engine configuration only, deliberately without Debug/Serialize.
/// No image inspection, private staging, journal or engine effect is performed here.
pub struct Configuration {
    graph: execution::Graph,
    review: native_input::Review,
    configs: BTreeMap<String, Value>,
    resources: BTreeMap<String, Resource>,
    source: Option<source::Binding>,
    storage: BTreeSet<String>,
    data_mounts: BTreeMap<String, Vec<crate::project::native::StorageMount>>,
    data: BTreeMap<String, persistent_data::engine::Reference>,
}
impl Configuration {
    pub fn graph(&self) -> &execution::Graph {
        &self.graph
    }
    pub fn review(&self) -> &native_input::Review {
        &self.review
    }
    pub fn containers(&self) -> &BTreeMap<String, Value> {
        &self.configs
    }
    pub fn resources(&self) -> &BTreeMap<String, Resource> {
        &self.resources
    }
}

fn refused() -> CandidateError {
    error(
        "native_graph_admission",
        "Native consumption requires its exact compiler review, immutable images, bounded process/readiness and a separately admitted live-source or persistent-storage contract; values omitted.",
    )
}

fn labels(owner: &str, review: &native_input::Review, resource: &Resource) -> Value {
    let scope = review.scope();
    json!({
        "io.hack-local.owner":owner,"io.hack-local.graph":scope.run,
        "io.hack-local.namespace":scope.namespace,"io.hack-local.plan":review.review_id(),
        "io.hack-local.kind":resource.kind.word(),"io.hack-local.resource":resource.key,
        "io.hack-local.input-kind":"native"
    })
}

/// Lower only freshly prepared native compiler input, without constructing Compose PlanData.
/// Owner shape is checked here; the execution consumer must verify the real guest,
/// authored selection, images and combined reservations before any create.
pub fn configuration(
    prepared: &native_input::Prepared,
    owner: &str,
) -> Result<Configuration, CandidateError> {
    configuration_with_source(prepared, owner, None)
}
fn configuration_with_source(
    prepared: &native_input::Prepared,
    owner: &str,
    source: Option<source::Binding>,
) -> Result<Configuration, CandidateError> {
    prepared.remaining()?;
    let inputs: &NativeInputs = prepared.inputs();
    let review = prepared.review();
    review.validate(review.scope())?;
    if !hex(owner, 32)
        || inputs.review_identity() != *review.compiler_identity()
        || !inputs.managed_environment.is_empty()
        || inputs.source.root != "."
        || inputs.workloads.len() != inputs.graph.services.len()
        || inputs.workloads.keys().ne(inputs.graph.services.keys())
    {
        return Err(refused());
    }
    let mounts: BTreeMap<_, _> = inputs
        .workloads
        .iter()
        .filter_map(|(name, workload)| {
            workload
                .source_mount
                .as_ref()
                .map(|mount| (name.clone(), mount.clone()))
        })
        .collect();
    if source.is_some() && !inputs.storage.is_empty() {
        return Err(refused());
    }
    match (&source, mounts.is_empty()) {
        (None, true) => {}
        (Some(source), false) if source.mounts == mounts => source.validate(
            &inputs
                .graph
                .services
                .iter()
                .map(|(name, service)| (name.clone(), service.ready))
                .collect(),
        )?,
        _ => return Err(refused()),
    }
    let mut configs = BTreeMap::new();
    let mut resources = BTreeMap::new();
    // Native workload networking is an implicit project contract: ordinary outbound
    // bridge access and exact service DNS aliases. Provider policy admission is separate.
    let network = Resource {
        routing: None,
        networks: None,
        outbound: true,
        cache: None,
        cache_provenance: None,
        kind: Kind::Network,
        key: "default".into(),
        name: format!("hkn-{}-network-0", review.scope().run),
        id: None,
        image: None,
        phase: "reserved".into(),
    };
    let network_names = BTreeMap::from([("default".into(), network.name.clone())]);
    resources.insert("network:default".into(), network);
    for (index, (name, workload)) in inputs.workloads.iter().enumerate() {
        if !image_id(&workload.image) {
            return Err(refused());
        }
        let resource = Resource {
            routing: None,
            networks: Some(vec!["default".into()]),
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind: Kind::Container,
            key: name.clone(),
            name: format!("hkn-{}-container-{index}", review.scope().run),
            id: None,
            image: Some(workload.image.clone()),
            phase: "reserved".into(),
        };
        let mut config = config::container_base(&workload.image, labels(owner, review, &resource));
        if workload.source_mount.is_some() {
            config["HostConfig"]["Mounts"] =
                json!([source.as_ref().ok_or_else(refused)?.config(name)?]);
        }
        let (primary, endpoints) = config::network_config(
            name,
            resource.networks.as_ref().ok_or_else(refused)?,
            &network_names,
        )?;
        config["HostConfig"]["NetworkMode"] = json!(primary);
        config["NetworkingConfig"] = json!({"EndpointsConfig":endpoints});
        for (field, value) in [
            ("Cmd", workload.command.as_ref()),
            ("Entrypoint", workload.entrypoint.as_ref()),
        ] {
            if let Some(value) = value {
                config[field] = json!(value);
            }
        }
        if let Some(init) = workload.init {
            config["HostConfig"]["Init"] = json!(init);
        }
        if let Some(directory) = &workload.working_directory {
            config["WorkingDir"] = json!(directory);
        }
        if !workload.environment.is_empty() {
            config["Env"] = json!(
                workload
                    .environment
                    .iter()
                    .map(|(key, value)| format!("{key}={value}"))
                    .collect::<Vec<_>>()
            );
        }
        if let Some(shutdown) = &workload.shutdown {
            if let Some(signal) = &shutdown.signal {
                config["StopSignal"] = json!(signal);
            }
            if let Some(ms) = shutdown.grace_ms {
                // Docker's create StopTimeout has whole-second precision. Do not
                // silently round authored milliseconds before timing is qualified.
                if ms % 1000 != 0 || ms > 30_000 {
                    return Err(refused());
                }
                config["StopTimeout"] = json!(ms / 1000);
            }
        }
        if let Some(readiness) = &workload.readiness {
            config["Healthcheck"] = json!({
                "Test":readiness.test,"Interval":u64::from(readiness.interval_ms)*1_000_000,
                "Timeout":u64::from(readiness.timeout_ms)*1_000_000,"Retries":readiness.retries
            });
        }
        resources.insert(format!("container:{name}"), resource);
        configs.insert(name.clone(), config);
    }
    prepared.remaining()?;
    Ok(Configuration {
        graph: inputs.graph.clone(),
        review: review.clone(),
        configs,
        resources,
        source,
        storage: inputs.storage.clone(),
        data_mounts: inputs
            .workloads
            .iter()
            .filter(|(_, workload)| !workload.mounts.is_empty())
            .map(|(name, workload)| (name.clone(), workload.mounts.clone()))
            .collect(),
        data: BTreeMap::new(),
    })
}

#[cfg(test)]
mod tests;
