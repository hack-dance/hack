use super::*;
use crate::project::{execution::Graph, inputs::ExecutionInputs};
use std::collections::BTreeSet;

pub(super) struct Prepared {
    pub graph: Graph,
    pub configs: BTreeMap<String, Value>,
    pub resources: BTreeMap<String, Resource>,
    pub namespace: String,
    pub plan_id: String,
}
fn unsupported() -> CandidateError {
    error(
        "graph_subset",
        "Graph driver requires pinned images, read-only roots, no environment delivery, internal networks, named volumes and no automatic restart; build, unbound/writable source, port, label and logging overrides remain gated.",
    )
}
pub(super) fn prepare(
    inputs: ExecutionInputs,
    readiness: &BTreeMap<String, Condition>,
    run: &str,
    owner: &str,
    source: Option<&source::Inputs>,
) -> Result<Prepared, CandidateError> {
    if inputs.requires_managed_environment() {
        return Err(unsupported());
    }
    let graph = Graph::from_plan(&inputs.review.plan, readiness)?;
    let plan = &inputs.review.plan;
    if graph.services.len() > 8 {
        return Err(error(
            "graph_budget",
            "At most eight services fit this driver profile.",
        ));
    }
    let mut networks = BTreeSet::new();
    let mut volumes = BTreeSet::new();
    let mut total_memory = 0u64;
    let mut total_cpus = 0f64;
    for (name, service) in plan.services.iter().filter(|(_, s)| s.active) {
        if !service.read_only
            || service.restart != "no"
            || !service.ports.is_empty()
            || !service.labels.is_empty()
            || service.logging.is_some()
            || !inputs.services[name].environment.is_empty()
            || service.image.as_deref().is_none_or(|v| !image_id(v))
            || service
                .platform
                .as_deref()
                .is_some_and(|p| !["linux/arm64", "linux/arm64/v8"].contains(&p))
        {
            return Err(unsupported());
        }
        if service.network_mode == "project-networks" {
            for network in &service.networks {
                if !plan
                    .networks
                    .get(network)
                    .is_some_and(|n| n.internal && n.driver == "bridge")
                {
                    return Err(unsupported());
                }
                networks.insert(network.clone());
            }
        } else if service.network_mode != "none" {
            return Err(unsupported());
        }
        for mount in &service.mounts {
            if mount.kind == "bind" {
                if !mount.read_only || !source.is_some_and(|s| s.paths.contains_key(&mount.source))
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
        if !(16 * 1024 * 1024..=1024 * 1024 * 1024).contains(&memory)
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
    if networks.len() > 1
        || volumes.len() > 8
        || total_memory > 4 * 1024 * 1024 * 1024
        || total_cpus > 4.0
    {
        return Err(error(
            "graph_budget",
            "Graph exceeds one network, eight volumes, four CPUs or 4 GiB RAM.",
        ));
    }
    let mut resources = BTreeMap::new();
    for (kind, entries) in [(Kind::Network, networks), (Kind::Volume, volumes)] {
        for (index, key) in entries.into_iter().enumerate() {
            let resource = Resource {
                kind,
                key: key.clone(),
                name: format!("hkg-{run}-{}-{index}", kind.word()),
                id: None,
                image: None,
                phase: "reserved".into(),
            };
            resources.insert(format!("{}:{key}", kind.word()), resource);
        }
    }
    let mut configs = BTreeMap::new();
    for (index, (name, service)) in plan.services.iter().filter(|(_, s)| s.active).enumerate() {
        let values = &inputs.services[name];
        let image = service.image.as_ref().expect("checked image");
        let resource = Resource {
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
        let network = if service.network_mode == "none" {
            "none".to_owned()
        } else {
            let network = service.networks.first().ok_or_else(unsupported)?;
            resources[&format!("network:{network}")].name.clone()
        };
        let mounts: Vec<_> = service.mounts.iter().map(|m| {
            if m.kind == "bind" {
                json!({"Type":"bind","Source":source.expect("validated source").paths[&m.source],"Target":m.target,"ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}})
            } else {
                json!({"Type":"volume","Source":resources[&format!("volume:{}",m.source)].name,"Target":m.target,"ReadOnly":m.read_only})
            }
        }).collect();
        let mut config = json!({"Image":image,"Labels":labels,"HostConfig":{
            "NetworkMode":network,"Memory":service.limits.memory_bytes.unwrap_or(268435456),"NanoCpus":(service.limits.cpus.unwrap_or(0.5)*1e9) as u64,
            "PidsLimit":service.limits.pids.unwrap_or(64),"ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"Init":service.init,
            "Mounts":mounts,"Tmpfs":{"/tmp":"rw,noexec,nosuid,size=16777216"},"ShmSize":service.limits.shared_memory_bytes.unwrap_or(67108864),
            "RestartPolicy":{"Name":"no"},"LogConfig":{"Type":"json-file","Config":{"max-size":"1m","max-file":"1"}}
        }});
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
            config["NetworkingConfig"] = json!({"EndpointsConfig":{network:{"Aliases":[name]}}});
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
        if let Some(health) = &service.healthcheck {
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
    Ok(Prepared {
        graph,
        configs,
        resources,
        namespace: plan.namespace.clone(),
        plan_id: inputs.review.plan_id.clone(),
    })
}
