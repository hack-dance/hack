//! Append resources to the foreground owner's existing graph journal.
#[cfg(target_os = "macos")]
use super::startup::Driver as _;
use super::*;
#[cfg(target_os = "macos")]
use std::time::Instant;

#[cfg(target_os = "macos")]
fn refused(message: &'static str) -> CandidateError {
    error("graph_extend", message)
}

/// The newly compiled graph uses existing resources by logical key. Existing
/// containers are dependency witnesses only, even when their authored spec changed.
fn select_resources(current: &Receipt, prepared: &mut config::Prepared) -> BTreeSet<String> {
    let existing = prepared
        .configs
        .keys()
        .filter(|name| current.resources.contains_key(&format!("container:{name}")))
        .cloned()
        .collect::<BTreeSet<_>>();
    prepared.configs.retain(|name, _| !existing.contains(name));
    prepared.probes.retain(|name, _| !existing.contains(name));
    prepared
        .default_health_cadence
        .retain(|name, _| !existing.contains(name));
    prepared
        .resources
        .retain(|_, resource| match resource.kind {
            Kind::Container => !existing.contains(&resource.key),
            Kind::Network => prepared.configs.values().any(|config| {
                config["NetworkingConfig"]["EndpointsConfig"]
                    .get(&resource.name)
                    .is_some()
            }),
            Kind::Volume => prepared.configs.values().any(|config| {
                config["HostConfig"]["Mounts"]
                    .as_array()
                    .is_some_and(|mounts| {
                        mounts.iter().any(|mount| {
                            mount["Type"] == "volume" && mount["Source"] == resource.name
                        })
                    })
            }),
        });
    existing
}

#[cfg(target_os = "macos")]
pub(super) struct Selection<'a> {
    pub options: NormalizedRunOptions<'a>,
    pub generation: &'a str,
    pub managed: ManagedInput<'a>,
    pub deadline: Instant,
}

/// The foreground loop serializes this request with down, jobs and dependency
/// refresh. The Engine lease covers ownership checks, intent and guest effects.
/// Every effect then has the same cleanup authority as a cold graph start.
#[cfg(target_os = "macos")]
pub(super) fn run(
    candidate: &Candidate,
    selected: Selection<'_>,
    startup: &mut HostRelayRuntime,
) -> Result<Receipt, CandidateError> {
    let Selection {
        options,
        generation,
        managed,
        deadline,
    } = selected;
    check_environment_deadline(deadline)?;
    let compiled = compile_normalized_inputs(candidate, &options, managed.values)?;
    let mut environments = pending_environments(&compiled, managed.files, deadline)?;
    let inputs = compiled.executable;
    if inputs
        .services
        .values()
        .any(|service| !service.extra_hosts.is_empty())
    {
        return Err(refused(
            "Adding host dependency bindings requires a fresh graph start.",
        ));
    }
    if options.run.timeout.is_zero() || options.run.timeout > Duration::from_secs(600) {
        return Err(refused(
            "Targeted start timeout is outside the bounded profile.",
        ));
    }
    let deadline = deadline.min(Instant::now() + options.run.timeout);
    let engine = Engine::connect_for_start(
        candidate,
        super::super::engine::ConnectionMode::Cleanup,
        deadline,
        &|| startup.check_cancelled(),
    )?;
    let (mut receipt, root) = load(candidate, &engine, options.run.run_id)?;
    if service_exec_generation(&receipt)? != generation
        || receipt.namespace != inputs.review.plan.namespace
        || receipt.normalized_input.is_none()
        || receipt.phase != "ready-observed"
        || !receipt.extending.is_empty()
        || root.join("state.pending").try_exists().map_err(state::io)?
        || receipt.resources.values().any(|r| match r.kind {
            Kind::Container => r.phase != "started",
            _ => r.phase != "created",
        })
    {
        return Err(refused(
            "The current graph is changed or incomplete. Inspect it before retrying, or stop it with hack down.",
        ));
    }
    startup.check_cancelled()?;
    startup.verify(&engine, &mut receipt, &root)?;
    let source = source::prepare_mode(
        candidate,
        &engine,
        &inputs.review.plan,
        options.run.source_revision,
        false,
        options.run.shared_source,
    )?;
    if let (Some(existing), Some(source)) = (&receipt.source, &source)
        && *existing != source.binding
        && !(existing.shared.is_some()
            && existing.shared == source.binding.shared
            && options.run.source_revision.is_none())
    {
        return Err(refused(
            "Targeted start requires the current graph's source binding.",
        ));
    }
    let mut prepared = config::prepare_with_ownership(
        inputs,
        options.run.readiness,
        &receipt.run,
        &receipt.owner,
        source.as_ref(),
        config::DeliveryOptions {
            environment: !environments.is_empty(),
            dependency_hosts: false,
            routing_enrolled: options.run.routing_enrolled,
            loopback_ports: options.run.loopback_ports,
        },
        Some(&receipt),
    )?;
    let existing = select_resources(&receipt, &mut prepared);
    for name in &existing {
        let resource = &receipt.resources[&format!("container:{name}")];
        let value = inspect_resource(&engine, &receipt, resource)?.ok_or_else(|| {
            refused("An already owned service is missing. Use hack down to reconcile the run.")
        })?;
        if !(value["State"]["Running"] == true
            || receipt.readiness[name] == Condition::Completed
                && observation(&value)? == (Observation::Exited { code: 0 }))
        {
            return Err(refused(
                "An already owned service is stopped. Use hack down before starting it again.",
            ));
        }
    }
    if prepared.configs.is_empty() {
        return Ok(receipt);
    }
    environments.retain(|service, _| !existing.contains(service));
    let mut new_storage = Vec::new();
    for (key, resource) in prepared.resources {
        if let Some(owned) = receipt.resources.get(&key) {
            if owned.name != resource.name
                || owned.outbound != resource.outbound
                || owned.cache != resource.cache
                || inspect_resource(&engine, &receipt, owned)?.is_none()
            {
                return Err(refused(
                    "A shared network or volume differs from its current ownership.",
                ));
            }
            if owned.kind == Kind::Volume {
                volume_subpaths::prepare(&engine, &receipt, owned, &prepared.configs, false)?;
            }
        } else {
            if resource.kind != Kind::Container {
                new_storage.push(key.clone());
            }
            receipt.resources.insert(key, resource);
        }
    }
    for name in prepared.configs.keys() {
        receipt
            .readiness
            .insert(name.clone(), options.run.readiness[name]);
    }
    if !resource_counts_fit(&receipt.resources)
        || !network_bindings_valid(&receipt.resources)
        || !loopback_ports_valid(&receipt.resources)
    {
        return Err(refused(
            "Selected services exceed the graph's resource or port limits.",
        ));
    }
    let mut hostnames = BTreeSet::new();
    if !receipt
        .resources
        .values()
        .filter_map(|r| r.routing.as_ref())
        .flat_map(|route| &route.hostnames)
        .all(|name| hostnames.insert(name))
    {
        return Err(refused(
            "Selected services claim a hostname already owned by this graph.",
        ));
    }
    check_network_intent(&engine, &receipt.resources)?;
    admission::check_extension(candidate, &engine, &prepared.configs)?;
    if !environments.is_empty() {
        super::super::environment::preflight_capacity(engine.guest(), environments.len())?;
    }
    let (wrapped, file_owners) = private_services(&environments);
    // Image inspection only applies to new containers, even though the graph
    // used to compile their dependency edges includes existing ones.
    let new_containers = receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Container && prepared.configs.contains_key(&r.key))
        .map(|(key, r)| (key.clone(), r.clone()))
        .collect();
    let expected_environment = verify_images(
        &engine,
        &new_containers,
        &mut prepared.configs,
        &wrapped,
        &file_owners,
        Some(&mut prepared.default_health_cadence),
    )?;
    validate_private_delivery(&prepared.configs, &environments)?;
    startup.check_cancelled()?;
    let launcher = if environments.is_empty() {
        None
    } else {
        Some(launcher::publish(&engine)?)
    };
    receipt
        .probes
        .extend(probes::fresh(&engine, &prepared.configs, prepared.probes)?);
    if receipt.source.is_none() {
        receipt.source = source.map(|source| source.binding);
    }
    receipt.extending = prepared.configs.keys().cloned().collect();
    let mut session = Session {
        startup: Some(startup),
        engine,
        root,
        receipt,
        configs: prepared.configs,
        default_health_cadence: prepared.default_health_cadence,
        expected_environment,
        restarting: false,
        fresh_cache_completion: true,
        cache_initializers: prepared.cache_initializers,
        environments,
        leases: BTreeMap::new(),
        launcher,
        probe_findings: BTreeMap::new(),
    };
    // A single journal commit enrolls every new name before the first create.
    // Keep the active phase and all old entries even on error or interruption.
    session.save()?;
    let mut created = BTreeSet::new();
    for key in new_storage {
        session.create_storage_resource(&key, false, &mut created)?;
    }
    session.apply_created_volume_cadence(&created);
    // Jobs derive their public process template from the same admission as up.
    // Save this before Session adds any private launcher attachments.
    let templates = session.configs.clone();
    execution::run_seeded(
        &prepared.graph,
        &mut session,
        deadline.saturating_duration_since(Instant::now()),
        &existing,
    )?;
    let receipt = session.receipt;
    startup.remember_extensions(templates);
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn targeted_ownership_preserves_running_ids_and_recovers_lost_create_reply() {
        let fixture = super::super::tests::Fixture::new();
        let candidate_root = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&candidate_root.0).unwrap();
        let run = "a".repeat(32);
        let owner = "b".repeat(32);
        let image = format!("sha256:{}", "c".repeat(64));
        let web_id = "d".repeat(64);
        let redis_id = "e".repeat(64);
        let compile = |document: Value| {
            fs::write(fixture.0.join("compose.yaml"), document.to_string()).unwrap();
            let options = || PlanOptions {
                project: &fixture.0,
                branch: None,
                profiles: &[],
                compose_file: Path::new("compose.yaml"),
            };
            let review = project::plan(&candidate, options()).unwrap();
            project::inputs::compile(&candidate, options(), &review.plan_id, &BTreeMap::new())
                .unwrap()
        };
        let old = compile(
            json!({"services":{"web":{"image":image}},"networks":{"default":{"internal":true}}}),
        );
        let old_plan = old.review.plan_id.clone();
        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":run,"owner":owner,"namespace":old.review.plan.namespace,
            "plan_id":old_plan,"phase":"ready-observed","readiness":{"web":"started"},
            "resources":{}
        }))
        .unwrap();
        let prepared = config::prepare(old, &receipt.readiness, &run, &owner, None).unwrap();
        receipt.resources = prepared.resources;
        let web = receipt.resources.get_mut("container:web").unwrap();
        web.id = Some(web_id.clone());
        web.phase = "started".into();
        let web_name = web.name.clone();
        let net_name = receipt.resources["network:default"].name.clone();
        let next = compile(
            json!({"services":{"redis":{"image":image,"depends_on":["web"]},"web":{"image":image}},"networks":{"default":{"internal":true}}}),
        );
        assert_ne!(next.review.plan_id, old_plan);
        let goals = BTreeMap::from([
            ("redis".into(), Condition::Started),
            ("web".into(), Condition::Started),
        ]);
        let mut prepared = config::prepare_with_ownership(
            next,
            &goals,
            &run,
            &owner,
            None,
            config::DeliveryOptions {
                environment: false,
                dependency_hosts: false,
                routing_enrolled: false,
                loopback_ports: false,
            },
            Some(&receipt),
        )
        .unwrap();
        assert_eq!(
            select_resources(&receipt, &mut prepared),
            BTreeSet::from(["web".into()])
        );
        assert!(!prepared.configs.contains_key("web"));
        let redis = &prepared.resources["container:redis"];
        assert_ne!(redis.name, web_name);
        assert_eq!(
            prepared.configs["redis"]["HostConfig"]["NetworkMode"],
            net_name
        );
        let mut lost = redis.clone();
        lost.phase = "create-intent".into();
        receipt.resources.insert("container:redis".into(), lost);
        receipt.readiness = goals;
        receipt.extending.insert("redis".into());
        let root = directory(&candidate, &run).unwrap();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        state::write(&root.join("state.json"), &receipt).unwrap();
        let (read, _) = load_at(root, &run, &owner).unwrap();
        assert_eq!(
            read.resources["container:web"].id.as_deref(),
            Some(web_id.as_str())
        );
        let redis = &read.resources["container:redis"];
        assert!(redis.id.is_none());
        // The recorded name and old plan labels still authenticate a real create
        // whose reply was lost. A foreign replacement at the name cannot pass.
        let mut inspected = json!({"Id":redis_id,"Name":redis.name,"Image":image,"Config":{"Labels":prepared.configs["redis"]["Labels"]}});
        verify_resource_identity(&read, redis, &inspected).unwrap();
        inspected["Config"]["Labels"]["io.hack-local.plan"] = json!("f".repeat(64));
        assert!(verify_resource_identity(&read, redis, &inspected).is_err());
    }
}
