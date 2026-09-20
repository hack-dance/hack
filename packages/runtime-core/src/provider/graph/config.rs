use super::*;
use crate::project::{execution::Graph, inputs::ExecutionInputs};
use std::collections::BTreeSet;

pub(super) struct Prepared {
    pub graph: Graph,
    pub cache_initializers: BTreeMap<String, String>,
    pub configs: BTreeMap<String, Value>,
    pub probes: BTreeMap<String, super::super::http_probe::HttpProbe>,
    pub resources: BTreeMap<String, Resource>,
    pub namespace: String,
    pub plan_id: String,
}
/// After source replay admission, preserve the original graph ownership identity
/// on restored requests. Never change resource names, images, routes or cache keys.
pub(super) fn retain_replay_ownership(
    prepared: &mut Prepared,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    if prepared.namespace != receipt.namespace
        || !same_resource_bindings(&prepared.resources, &receipt.resources)
    {
        return Err(error(
            "graph_receipt",
            "Replay resources differ from their retained ownership.",
        ));
    }
    for (name, config) in &mut prepared.configs {
        let resource = prepared
            .resources
            .get(&format!("container:{name}"))
            .ok_or_else(|| error("graph_receipt", "Replay container identity is missing."))?;
        if config["Labels"]
            != labels(
                &receipt.owner,
                &receipt.run,
                &receipt.namespace,
                &prepared.plan_id,
                resource,
            )
        {
            return Err(error(
                "graph_receipt",
                "Replay generated labels differ from expected ownership.",
            ));
        }
        config["Labels"] = labels(
            &receipt.owner,
            &receipt.run,
            &receipt.namespace,
            &receipt.plan_id,
            resource,
        );
    }
    prepared.plan_id = receipt.plan_id.clone();
    Ok(())
}

fn unsupported() -> CandidateError {
    error(
        "graph_subset",
        "Graph driver requires pinned images, explicit managed environment delivery, internal networks, named volumes and no automatic restart; build, unbound/writable source, port, label and logging overrides remain gated.",
    )
}
pub(super) fn prepare(
    inputs: ExecutionInputs,
    readiness: &BTreeMap<String, Condition>,
    run: &str,
    owner: &str,
    source: Option<&source::Inputs>,
) -> Result<Prepared, CandidateError> {
    prepare_delivery(
        inputs,
        readiness,
        run,
        owner,
        source,
        DeliveryOptions::default(),
    )
}
#[derive(Default)]
pub(super) struct DeliveryOptions {
    pub environment: bool,
    pub dependency_hosts: bool,
    pub routing_enrolled: bool,
}
pub(super) fn prepare_delivery(
    inputs: ExecutionInputs,
    readiness: &BTreeMap<String, Condition>,
    run: &str,
    owner: &str,
    source: Option<&source::Inputs>,
    options: DeliveryOptions,
) -> Result<Prepared, CandidateError> {
    let DeliveryOptions {
        environment: delivery,
        dependency_hosts,
        routing_enrolled,
    } = options;
    if inputs.requires_managed_environment() && !delivery {
        return Err(unsupported());
    }
    if !dependency_hosts
        && inputs
            .services
            .values()
            .any(|service| !service.extra_hosts.is_empty())
    {
        return Err(super::dependency_hosts::refused());
    }
    let graph = Graph::from_plan(&inputs.review.plan, readiness)?;
    let plan = &inputs.review.plan;
    routes::validate_plan(plan, &graph, routing_enrolled)?;
    for (name, service) in plan.services.iter().filter(|(_, service)| service.active) {
        if service.dependency_cache.is_some() && graph.services[name].ready != Condition::Completed
        {
            return Err(error(
                "graph_cache_readiness",
                "Dependency cache initializers require successful completion readiness.",
            ));
        }
    }
    if graph.services.len() > MAX_SERVICES {
        return Err(error(
            "graph_budget",
            "At most 32 services fit this driver profile; aggregate resource limits also apply.",
        ));
    }
    let caches = if plan
        .services
        .values()
        .any(|service| service.active && service.dependency_cache.is_some())
    {
        let source = source.ok_or_else(|| {
            error(
                "graph_cache_source",
                "Dependency caches require an explicitly verified source publication.",
            )
        })?;
        let scope = dependency_cache::scope(&plan.source)?;
        dependency_cache::resolve(
            plan,
            source.current_manifest.as_ref().unwrap_or(&source.manifest),
            &scope,
            &inputs.services,
        )?
    } else {
        BTreeMap::new()
    };
    let mut networks = BTreeSet::new();
    let mut volumes = BTreeSet::new();
    let mut total_memory = 0u64;
    let mut total_cpus = 0f64;
    for service in plan.services.values().filter(|s| s.active) {
        if service.restart != "no"
            || !service.ports.is_empty()
            || service.labels.keys().any(|key| {
                !(routing_enrolled && service.routing.is_some() && routes::recognized(key))
                    && !(service.dependency_cache.is_some()
                        && matches!(
                            key.as_str(),
                            "hack.dependencies.cache-volume"
                                | "hack.dependencies.lockfiles"
                                | "hack.dependencies.runtime-files"
                                | "hack.dependencies.bootstrap"
                        ))
            })
            || service.logging.is_some()
            || service.image.as_deref().is_none_or(|v| !image_id(v))
            || service
                .platform
                .as_deref()
                .is_some_and(|p| !["linux/arm64", "linux/arm64/v8"].contains(&p))
        {
            return Err(unsupported());
        }
        if service.network_mode == "project-networks" {
            if service.networks.is_empty()
                || service.networks.len() > MAX_NETWORKS
                || service.networks.iter().collect::<BTreeSet<_>>().len() != service.networks.len()
            {
                return Err(unsupported());
            }
            for network in &service.networks {
                if !plan
                    .networks
                    .get(network)
                    .is_some_and(|n| n.driver == "bridge")
                {
                    return Err(unsupported());
                }
                networks.insert(network.clone());
            }
        } else if service.network_mode != "none" || !service.networks.is_empty() {
            return Err(unsupported());
        }
        for mount in &service.mounts {
            if mount.subpath.as_deref().is_some_and(|value| {
                mount.kind != "volume" || !project::valid_volume_subpath(value)
            }) {
                return Err(unsupported());
            }
            if mount.kind == "bind" {
                if (!mount.read_only && !source.is_some_and(|s| s.binding.shared.is_some()))
                    || !source.is_some_and(|s| s.paths.contains_key(&mount.source))
                {
                    return Err(unsupported());
                }
                continue;
            }
            if mount.kind != "volume" || !plan.volumes.contains_key(&mount.source) {
                return Err(unsupported());
            }
            volumes.insert(mount.source.clone());
        }
        let memory = service.limits.memory_bytes.unwrap_or(256 * 1024 * 1024);
        let cpus = service.limits.cpus.unwrap_or(0.5);
        if !(16 * 1024 * 1024..=MAX_MEMORY_BYTES).contains(&memory)
            || !cpus.is_finite()
            || !(0.1..=2.0).contains(&cpus)
            || service.limits.pids.is_some_and(|p| p > 128)
            || service
                .limits
                .shared_memory_bytes
                .is_some_and(|v| v > 64 * 1024 * 1024)
            || service
                .stop_grace_period_nanos
                .is_some_and(|n| n > 30_000_000_000)
        {
            return Err(error(
                "graph_budget",
                "A service exceeds the bounded graph profile.",
            ));
        }
        total_memory += memory;
        total_cpus += cpus;
    }
    if networks.len() > MAX_NETWORKS
        || volumes.len() > MAX_VOLUMES
        || total_memory > MAX_TOTAL_MEMORY_BYTES
        || total_cpus > 4.0
    {
        return Err(error(
            "graph_budget",
            "Graph exceeds 32 networks, eight volumes, four CPUs or the development guest memory reservation budget.",
        ));
    }
    let mut resources = BTreeMap::new();
    for (kind, entries) in [(Kind::Network, networks), (Kind::Volume, volumes)] {
        for (index, key) in entries.into_iter().enumerate() {
            let cache = (kind == Kind::Volume).then(|| caches.get(&key)).flatten();
            let resource = Resource {
                routing: None,
                networks: None,
                outbound: kind == Kind::Network && !plan.networks[&key].internal,
                cache: cache.cloned(),
                cache_provenance: None,
                kind,
                key: key.clone(),
                name: cache.map_or_else(
                    || format!("hkg-{run}-{}-{index}", kind.word()),
                    |cache| cache.name(),
                ),
                id: None,
                image: None,
                phase: "reserved".into(),
            };
            resources.insert(format!("{}:{key}", kind.word()), resource);
        }
    }
    let mut configs = BTreeMap::new();
    let mut probes = BTreeMap::new();
    for (index, (name, service)) in plan.services.iter().filter(|(_, s)| s.active).enumerate() {
        let values = &inputs.services[name];
        let image = service.image.as_ref().expect("checked image");
        let resource = Resource {
            routing: service.routing.clone(),
            networks: Some(service.networks.clone()),
            outbound: false,
            cache: None,
            cache_provenance: None,
            kind: Kind::Container,
            key: name.clone(),
            name: format!("hkg-{run}-container-{index}"),
            id: None,
            image: Some(image.clone()),
            phase: "reserved".into(),
        };
        let labels = labels(
            owner,
            run,
            &plan.namespace,
            &inputs.review.plan_id,
            &resource,
        );
        let network_names = resources
            .values()
            .filter(|resource| resource.kind == Kind::Network)
            .map(|resource| (resource.key.clone(), resource.name.clone()))
            .collect();
        let (network, endpoints) = network_config(name, &service.networks, &network_names)?;
        let mounts: Vec<_> = service.mounts.iter().map(|m| {
            if m.kind == "bind" {
                let source = source.expect("validated source");
                // Installers must read immutable inputs so a host edit cannot poison
                // a content-keyed cache while installation is in progress.
                let frozen_initializer = source.binding.shared.is_some() && service.dependency_cache.is_some();
                let path = if frozen_initializer {
                    let root = format!("/storage/hack-source/{}/{}/tree", plan.namespace, source.manifest.revision);
                    if m.source == "." { root } else { format!("{root}/{}", m.source) }
                } else { source.paths[&m.source].clone() };
                json!({"Type":"bind","Source":path,"Target":m.target,"ReadOnly":frozen_initializer || m.read_only,"BindOptions":{"Propagation":"rprivate"}})
            } else {
                { let mut mount = json!({"Type":"volume","Source":resources[&format!("volume:{}",m.source)].name,"Target":m.target,"ReadOnly":m.read_only});
                if let Some(subpath) = &m.subpath { mount["VolumeOptions"] = json!({"Subpath":subpath,"NoCopy":true}); } mount }
            }
        }).collect();
        // Writable roots are container-owned layers, not writable source binds.
        // Their contents are discarded when the container is removed; durable data uses named volumes.
        let mut config = json!({"Image":image,"Labels":labels,"HostConfig":{
            "NetworkMode":network,"Memory":service.limits.memory_bytes.unwrap_or(268435456),"NanoCpus":(service.limits.cpus.unwrap_or(0.5)*1e9) as u64,
            "PidsLimit":service.limits.pids.unwrap_or(64),"ReadonlyRootfs":service.read_only,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"Init":service.init,
            "Mounts":mounts,"Tmpfs":{"/tmp":"rw,noexec,nosuid,size=16777216"},"ShmSize":service.limits.shared_memory_bytes.unwrap_or(67108864),
            "RestartPolicy":{"Name":"no"},"LogConfig":{"Type":"json-file","Config":{"max-size":"1m","max-file":"1"}}
        }});
        // Virtiofs preserves the host uid. Root services need DAC_OVERRIDE to
        // traverse/write an explicitly shared tree owned by that uid. Read-only
        // mounts still enforce read-only access; no other capabilities are added.
        if source.is_some_and(|s| s.binding.shared.is_some())
            && service.dependency_cache.is_none()
            && service.mounts.iter().any(|m| m.kind == "bind")
        {
            config["HostConfig"]["CapAdd"] = json!(["DAC_OVERRIDE"]);
        }
        // Only explicitly compiled public values enter engine metadata. Bare/null
        // managed inputs are delivered separately by the private launcher.
        // Omit Env when empty so image defaults remain the engine's responsibility.
        if !values.environment.is_empty() {
            config["Env"] = json!(values.environment);
        }
        if !values.extra_hosts.is_empty() {
            config["HostConfig"]["ExtraHosts"] = json!(
                values
                    .extra_hosts
                    .iter()
                    .map(|(name, target)| format!("{name}:{target}"))
                    .collect::<Vec<_>>()
            );
        }
        if !service.exposed_ports.is_empty() {
            let ports: serde_json::Map<String, Value> = service
                .exposed_ports
                .iter()
                .map(|port| {
                    (
                        if port.contains('/') {
                            port.clone()
                        } else {
                            format!("{port}/tcp")
                        },
                        json!({}),
                    )
                })
                .collect();
            config["ExposedPorts"] = Value::Object(ports);
        }
        if network != "none" {
            config["NetworkingConfig"] = json!({"EndpointsConfig":endpoints});
        }
        if let Some(argv) = &values.entrypoint {
            config["Entrypoint"] = json!(argv);
            if values.command.is_none() {
                config["Cmd"] = json!([]);
            }
        }
        if let Some(argv) = &values.command {
            config["Cmd"] = json!(argv);
        }
        if let Some(user) = &values.user {
            config["User"] = json!(user);
        }
        if let Some(dir) = &service.working_dir {
            config["WorkingDir"] = json!(dir);
        }
        if let Some(signal) = &service.stop_signal {
            config["StopSignal"] = json!(signal);
        }
        config["StopTimeout"] = json!(
            service
                .stop_grace_period_nanos
                .unwrap_or(10_000_000_000)
                .div_ceil(1_000_000_000)
        );
        if let Some(probe) = service
            .healthcheck
            .as_ref()
            .and_then(|h| h.native_http.as_ref())
        {
            if !cfg!(feature = "native-http-probe") {
                return Err(error(
                    "native_http_unavailable",
                    "Build the candidate with native-http-probe to run native HTTP checks.",
                ));
            }
            probe.validate()?;
            if readiness[name] == Condition::Completed {
                return Err(error(
                    "native_http_readiness",
                    "Native HTTP requires a long-running service readiness goal.",
                ));
            }
            launcher::identity(&config)?;
            for mount in config["HostConfig"]["Mounts"].as_array().unwrap() {
                let path = mount["Target"].as_str().unwrap_or("");
                if path == "/" || path == "/run" || path.starts_with("/run/hack-http-probe") {
                    return Err(error(
                        "native_http_mount",
                        "Mount overlaps a reserved HTTP probe path.",
                    ));
                }
            }
            probes.insert(name.clone(), probe.clone());
            config["Healthcheck"] = json!({"Test":["NONE"]});
        } else if let Some(health) = &service.healthcheck {
            let mut value = json!({});
            if let Some(test) = &values.health_test {
                value["Test"] = json!(test);
            }
            for (key, value_nanos) in [
                ("Interval", health.interval_nanos),
                ("Timeout", health.timeout_nanos),
                ("StartPeriod", health.start_period_nanos),
                ("StartInterval", health.start_interval_nanos),
            ] {
                if let Some(nanos) = value_nanos {
                    value[key] = json!(nanos);
                }
            }
            if let Some(retries) = health.retries {
                value["Retries"] = json!(retries);
            }
            config["Healthcheck"] = value;
        }
        configs.insert(name.clone(), config);
        resources.insert(format!("container:{name}"), resource);
    }
    let cache_initializers = plan
        .services
        .iter()
        .filter(|(_, s)| s.active)
        .filter_map(|(name, s)| {
            s.dependency_cache
                .as_ref()
                .filter(|c| c.bootstrap)
                .map(|c| (name.clone(), c.volume.clone()))
        })
        .collect();
    Ok(Prepared {
        cache_initializers,
        graph,
        configs,
        probes,
        resources,
        namespace: plan.namespace.clone(),
        plan_id: inputs.review.plan_id.clone(),
    })
}

/// Primary network preserves declaration order; every declared network receives
/// the service DNS alias. An empty declaration is the already-validated none mode.
fn network_config(
    service: &str,
    networks: &[String],
    names: &BTreeMap<String, String>,
) -> Result<(String, Value), CandidateError> {
    if networks.len() > MAX_NETWORKS {
        return Err(unsupported());
    }
    let mut seen = BTreeSet::new();
    let mut endpoints = serde_json::Map::new();
    let mut primary = "none".to_owned();
    for (index, key) in networks.iter().enumerate() {
        if !seen.insert(key) {
            return Err(unsupported());
        }
        let name = names.get(key).ok_or_else(unsupported)?;
        if index == 0 {
            primary = name.clone();
        }
        if endpoints
            .insert(name.clone(), json!({"Aliases":[service]}))
            .is_some()
        {
            return Err(unsupported());
        }
    }
    Ok((primary, Value::Object(endpoints)))
}

#[cfg(test)]
mod network_tests {
    use super::*;

    #[test]
    fn emits_all_endpoints_and_preserves_first_declared_primary() {
        let names = BTreeMap::from([
            ("back".into(), "owned-back".into()),
            ("front".into(), "owned-front".into()),
        ]);
        let (primary, endpoints) =
            network_config("search", &["front".into(), "back".into()], &names).unwrap();
        assert_eq!(primary, "owned-front");
        assert_eq!(
            endpoints,
            json!({"owned-back":{"Aliases":["search"]},"owned-front":{"Aliases":["search"]}})
        );
        assert_eq!(
            network_config("search", &[], &names).unwrap(),
            ("none".into(), json!({}))
        );
    }

    #[test]
    fn refuses_missing_duplicate_and_over_budget_networks() {
        let names = (0..=MAX_NETWORKS)
            .map(|i| (format!("n{i}"), format!("owned-{i}")))
            .collect::<BTreeMap<_, _>>();
        assert!(network_config("s", &["missing".into()], &names).is_err());
        assert!(network_config("s", &["n0".into(), "n0".into()], &names).is_err());
        let selected = names.keys().cloned().collect::<Vec<_>>();
        assert!(network_config("s", &selected, &names).is_err());
        assert_eq!(
            network_config("s", &selected[..MAX_NETWORKS], &names)
                .unwrap()
                .1
                .as_object()
                .unwrap()
                .len(),
            MAX_NETWORKS
        );
    }
}
