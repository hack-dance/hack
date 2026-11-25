//! Append resources to the foreground owner's existing graph journal.
#[cfg(target_os = "macos")]
use super::startup::Driver as _;
use super::*;
#[cfg(target_os = "macos")]
use std::{path::Path, time::Instant};

/// In-memory public normalization and authored service digests. Managed
/// values never enter this structure.
#[cfg(target_os = "macos")]
pub(super) struct Input {
    document: Value,
    authored: Option<BTreeMap<String, String>>,
}

#[cfg(target_os = "macos")]
impl Input {
    pub(super) fn read(
        compose: project::NormalizedComposeOptions<'_>,
        plan: &project::PlanData,
    ) -> Result<Self, CandidateError> {
        let bytes = project::source::read_compose(&plan.source.join(&plan.compose_file))?;
        if digest(&bytes) != compose.expected_compose_sha256 {
            return Err(refused(
                "Compose input changed before the owner could record it.",
            ));
        }
        Ok(Self {
            document: project::yaml::parse(compose.compose_bytes)?,
            authored: authored_digests(&bytes),
        })
    }

    fn combine(&self, next: Self, added: &BTreeMap<String, Value>) -> Result<Self, CandidateError> {
        let mut document = self.document.clone();
        let mut authored = self.authored.clone().filter(|_| next.authored.is_some());
        let services = document["services"]
            .as_object_mut()
            .ok_or_else(|| refused("The owner's normalized services are missing."))?;
        for name in added.keys() {
            services.insert(name.clone(), next.document["services"][name].clone());
            if let Some(authored) = &mut authored
                && let Some(spec) = next
                    .authored
                    .as_ref()
                    .and_then(|services| services.get(name))
            {
                authored.insert(name.clone(), spec.clone());
            }
        }
        for section in ["networks", "volumes"] {
            if let Some(incoming) = next.document[section].as_object() {
                if document[section].is_null() {
                    document[section] = json!({});
                }
                let target = document[section].as_object_mut().ok_or_else(|| {
                    refused("The owner's normalized resource declarations are invalid.")
                })?;
                for (name, resource) in incoming {
                    target
                        .entry(name.clone())
                        .or_insert_with(|| resource.clone());
                }
            }
        }
        Ok(Self { document, authored })
    }
}

#[cfg(any(target_os = "macos", test))]
fn authored_digests(bytes: &[u8]) -> Option<BTreeMap<String, String>> {
    let original = project::yaml::parse(bytes).ok()?;
    Some(
        original["services"]
            .as_object()?
            .iter()
            .map(|(service, spec)| (service.clone(), digest(spec.to_string().as_bytes())))
            .collect(),
    )
}

#[cfg(any(target_os = "macos", test))]
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", crate::Hex(Sha256::digest(bytes)))
}

#[cfg(any(target_os = "macos", test))]
fn refused(message: &'static str) -> CandidateError {
    error("graph_extend", message)
}

#[cfg(any(target_os = "macos", test))]
fn reviews_services(plan: &project::PlanData, owned: &BTreeSet<&str>) -> bool {
    plan.services
        .iter()
        .filter(|(_, service)| service.active)
        .map(|(name, _)| name.as_str())
        .eq(owned.iter().copied())
}

#[cfg(any(target_os = "macos", test))]
fn review_combined(
    candidate: &Candidate,
    compose: project::NormalizedComposeOptions<'_>,
    document: &Value,
    full: Option<(&str, &str, &[u8])>,
    owned: &BTreeSet<&str>,
) -> Result<project::PlanReport, CandidateError> {
    if let Some((expected_plan, expected_hash, bytes)) = full {
        let report = project::plan_normalized(
            candidate,
            project::NormalizedComposeOptions {
                compose_bytes: bytes,
                ..compose
            },
        )?;
        if report.plan.compose_sha256 != expected_hash {
            return Err(refused(
                "Combined normalized input differs from its reviewed bytes.",
            ));
        }
        if report.plan_id == expected_plan
            && report.plan.enrollment_compatible
            && reviews_services(&report.plan, owned)
        {
            return Ok(report);
        }
        // A changed source inventory can change the plan ID while an append is
        // being prepared. Fall back to the owner's known combined declarations.
    }
    let bytes = document.to_string();
    project::plan_normalized(
        candidate,
        project::NormalizedComposeOptions {
            compose_bytes: bytes.as_bytes(),
            ..compose
        },
    )
}

/// The newly compiled graph uses existing resources by logical key. Existing
/// containers are dependency witnesses only, even when their authored spec changed.
fn select_resources(prepared: &mut config::Prepared, existing: &BTreeSet<String>) {
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
}

#[cfg(target_os = "macos")]
pub(super) struct Selection<'a> {
    pub options: NormalizedRunOptions<'a>,
    pub generation: &'a str,
    pub combined: Option<super::foreground::CombinedExtensionInput>,
    pub managed: ManagedInput<'a>,
    pub deadline: Instant,
}

/// The foreground loop serializes this request with down, jobs and dependency
/// refresh. The Engine lease covers ownership checks, intent and guest effects.
/// Every effect then has the same cleanup authority as a cold graph start.
#[cfg(target_os = "macos")]
pub(super) struct Started {
    pub receipt: Receipt,
    pub services: BTreeSet<String>,
    pub changed: BTreeSet<String>,
}

#[cfg(target_os = "macos")]
pub(super) fn run(
    candidate: &Candidate,
    selected: Selection<'_>,
    startup: &mut HostRelayRuntime,
) -> Result<Started, CandidateError> {
    let Selection {
        options,
        generation,
        combined: full_identity,
        managed,
        deadline,
    } = selected;
    check_environment_deadline(deadline)?;
    let compiled = compile_normalized_inputs(candidate, &options, managed.values)?;
    let mut environments = pending_environments(&compiled, managed.files, deadline)?;
    let inputs = compiled.executable;
    let next_input = Input::read(options.compose, &inputs.review.plan)?;
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
        super::super::engine::ConnectionMode::Allocation,
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
    let before = receipt.clone();
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
    let mut owned = BTreeSet::new();
    let mut existing = BTreeSet::new();
    let mut resuming = BTreeSet::new();
    for name in prepared.configs.keys() {
        let Some(resource) = receipt.resources.get(&format!("container:{name}")) else {
            continue;
        };
        owned.insert(name.clone());
        let value = inspect_resource(&engine, &receipt, resource)?.ok_or_else(|| {
            refused("An already owned service is missing. Use hack down to reconcile the run.")
        })?;
        let state = observation(&value)?;
        if value["State"]["Running"] == true
            || receipt.readiness[name] == Condition::Completed
                && state == (Observation::Exited { code: 0 })
        {
            existing.insert(name.clone());
        } else if matches!(state, Observation::Exited { .. }) {
            restart_policy::verify_admitted(resource, &value)?;
            resuming.insert(name.clone());
        } else {
            return Err(refused(
                "An owned service is changing state. Retry after hack ps reports it running or stopped.",
            ));
        }
    }
    let previous_input = startup.extension_input.as_ref();
    let authored = previous_input
        .and_then(|previous| previous.authored.as_ref())
        .zip(next_input.authored.as_ref());
    let changed = existing
        .iter()
        .filter(|name| {
            authored.is_some_and(|(before, after)| before.get(*name) != after.get(*name))
        })
        .cloned()
        .collect();
    select_resources(&mut prepared, &owned);
    if prepared.configs.is_empty() && resuming.is_empty() {
        return Ok(Started {
            receipt,
            services: BTreeSet::new(),
            changed,
        });
    }
    // The whole-file review can describe the live run only if the definitions
    // of its already-owned containers still match the admitted declarations.
    let full_identity = full_identity.filter(|_| {
        authored.is_some_and(|(previous, next)| {
            receipt.readiness.keys().all(|name| {
                previous
                    .get(name)
                    .is_some_and(|digest| next.get(name) == Some(digest))
            })
        })
    });
    let combined = if let Some(previous) = previous_input {
        previous.combine(next_input, &prepared.configs)?
    } else {
        next_input
    };
    let combined_services = receipt
        .readiness
        .keys()
        .chain(prepared.configs.keys())
        .map(String::as_str)
        .collect();
    let reviewed = review_combined(
        candidate,
        options.compose,
        &combined.document,
        full_identity.as_ref().and_then(|full| full.review()),
        &combined_services,
    )?;
    let combined_covers_owned = reviews_services(&reviewed.plan, &combined_services);
    let combined_identity = NormalizedInputIdentity {
        namespace: receipt.namespace.clone(),
        original_compose_sha256: options.compose.expected_compose_sha256.to_owned(),
        normalized_compose_sha256: reviewed.plan.compose_sha256.clone(),
    };
    let bridge_count = prepared
        .resources
        .values()
        .map(|resource| resource.loopback_ports.len() + usize::from(resource.routing.is_some()))
        .sum();
    bridges::check_extension_capacity(candidate, &engine, &receipt, &resuming, bridge_count)?;
    environments.retain(|service, _| !owned.contains(service));
    let mut new_storage = Vec::new();
    let mut existing_volumes = Vec::new();
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
                existing_volumes.push(key);
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
    let expected_environment = verify_images(
        &engine,
        &receipt.resources,
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
    if receipt.source.is_none() {
        receipt.source = source.map(|source| source.binding);
    }
    // Keep the approved share and cache publication. Its execution contract
    // must describe the combined review, even when only the old services bind source.
    let combined_contract = receipt
        .source
        .as_ref()
        .filter(|binding| binding.shared.is_some() && combined_covers_owned)
        .map(|_| source::review_shared_contract(&reviewed.plan))
        .transpose()?;
    startup.check_cancelled()?;
    receipt.extending = prepared
        .configs
        .keys()
        .cloned()
        .chain(resuming.iter().cloned())
        .collect();
    let services = receipt.extending.clone();
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
    // Keep the active phase and all old entries until the extension commits.
    session.save()?;
    let result = (|| {
        for key in existing_volumes {
            session.check_cancelled()?;
            volume_subpaths::prepare(
                &session.engine,
                &session.receipt,
                &session.receipt.resources[&key],
                &session.configs,
                false,
            )?;
        }
        session.check_cancelled()?;
        session.receipt.probes.extend(probes::fresh(
            &session.engine,
            &session.configs,
            prepared.probes,
        )?);
        session.save()?;
        if !resuming.is_empty() {
            session.check_cancelled()?;
            bridges::release_extension(candidate, &session.engine, &session.receipt, &resuming)?;
            session
                .startup
                .as_mut()
                .ok_or_else(|| refused("Missing extension driver."))?
                .resume_publications(&session.receipt, &resuming);
        }
        let mut created = BTreeSet::new();
        for key in new_storage {
            session.check_cancelled()?;
            session.create_storage_resource(&key, false, &mut created)?;
        }
        session.apply_created_volume_cadence(&created);
        // Jobs use the admitted template before private attachments.
        let templates = session.configs.clone();
        execution::run_seeded(
            &prepared.graph,
            &mut session,
            deadline.saturating_duration_since(Instant::now()),
            &existing,
        )?;
        Ok::<_, CandidateError>(templates)
    })();
    let Session {
        engine,
        root,
        mut receipt,
        ..
    } = session;
    let committed = result.and_then(|templates| {
        startup.check_cancelled()?;
        let publications = startup
            .early_publications
            .as_mut()
            .ok_or_else(|| refused("Targeted start requires the owner's publication set."))?;
        publications.verify_extension(candidate, &receipt)?;
        receipt.normalized_input = Some(combined_identity);
        receipt.input_plan_id = Some(reviewed.plan_id);
        if let Some(contract) = combined_contract {
            let source = receipt
                .source
                .as_mut()
                .ok_or_else(|| refused("Missing combined source binding."))?;
            source.shared_contract = Some(contract);
        }
        receipt.extending.clear();
        state::write(&root.join("state.json"), &receipt)?;
        Ok(templates)
    });
    match committed {
        Ok(templates) => {
            startup.remember_extensions(templates);
            startup.extension_input = Some(combined);
            Ok(Started {
                receipt,
                services,
                changed,
            })
        }
        Err(error) => {
            // On uncertain rollback leave the full journal and all authority
            // with the owner. A later down can clean both resource sets.
            if rollback(candidate, &engine, &root, &before).is_ok() {
                // Successful rollback leaves resumed services stopped and
                // removes their old publications as well as any replacements.
                // Reap old handles even if the first retirement attempt failed.
                startup.resume_publications(&before, &resuming);
                if let Some(publications) = &mut startup.early_publications {
                    publications.mark_rolled_back();
                }
                Err(error)
            } else {
                Err(super::error(
                    "graph_extend_incomplete",
                    "Targeted start failed and could not confirm rollback. Run hack down to clean up the owned resources.",
                ))
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn rollback(
    candidate: &Candidate,
    engine: &Engine<'_>,
    root: &Path,
    before: &Receipt,
) -> Result<(), CandidateError> {
    if root.join("state.pending").symlink_metadata().is_ok() {
        return Err(refused("The targeted start journal needs reconciliation."));
    }
    let (current, _) = load_at(root.to_path_buf(), &before.run, &before.owner)?;
    if current.extending.is_empty() {
        return Err(refused("The targeted start journal is no longer pending."));
    }
    let selected = &current.extending;
    let has_new_environment =
        !environment::cleanup_slots_selected(candidate, engine, &current, |name| {
            selected.contains(name) && !before.readiness.contains_key(name)
        })?
        .is_empty();
    bridges::release_extension(candidate, engine, &current, selected)?;
    let mut added = current.clone();
    added
        .resources
        .retain(|key, _| !before.resources.contains_key(key));
    added.probes.retain(|service, _| {
        added
            .resources
            .contains_key(&format!("container:{service}"))
    });
    shutdown::stop_selected(engine, &added, true)?;
    let mut resumed = current.clone();
    resumed.resources.retain(|key, resource| {
        resource.kind == Kind::Container
            && selected.contains(&resource.key)
            && before.resources.contains_key(key)
    });
    // A previously stopped service can have accepted the start before its
    // reply was lost. Stop it without deleting its pre-existing resources.
    shutdown::stop_selected(engine, &resumed, false)?;
    for kind in [Kind::Container, Kind::Network, Kind::Volume] {
        for resource in added
            .resources
            .values()
            .filter(|resource| resource.kind == kind)
        {
            if resource.cache.is_none() && resource.phase != "reserved" {
                remove_owned_resource(engine, &added, resource, || Ok(()))?;
            }
        }
    }
    probes::cleanup(engine, &mut added)?;
    if has_new_environment {
        let attempt = probes::token()?;
        for resource in added
            .resources
            .values()
            .filter(|resource| resource.kind == Kind::Container)
        {
            super::super::environment_recovery::archive_job(
                candidate,
                engine.guest(),
                &current.run,
                &resource.key,
                &resource.name,
                &root
                    .join("extension-environment-history")
                    .join(&attempt)
                    .join(&resource.key),
            )?;
        }
    }
    let mut restored = before.clone();
    for (service, probe) in current.probes {
        if restored.probes.contains_key(&service) && selected.contains(&service) {
            restored.probes.insert(service, probe);
        }
    }
    state::write(&root.join("state.json"), &restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, path::Path};

    #[test]
    fn tags_in_authored_input_skip_optional_change_digests() {
        let authored = b"x-example: !override fixture\nservices: {web: {image: alpine}}";
        assert!(authored_digests(authored).is_none());
        let normalized = br#"{"x-example":"fixture","services":{"web":{"image":"alpine"}}}"#;
        assert_eq!(authored_digests(normalized).unwrap().len(), 1);
    }

    #[test]
    fn combined_shared_contract_matches_later_plain_restore_review() {
        let fixture = super::super::tests::Fixture::new();
        let home = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&home.0).unwrap();
        let image = format!("sha256:{}", "c".repeat(64));
        let web =
            json!({"image":image,"network_mode":"none","volumes":["./src:/app:ro","zdata:/data"]});
        let full = format!(
            r#"{{"services":{{"web":{web},"redis":{{"image":"{image}","network_mode":"none","volumes":["adata:/data"]}}}},"volumes":{{"zdata":{{}},"adata":{{}}}}}}"#
        );
        fs::create_dir(fixture.0.join("src")).unwrap();
        fs::write(fixture.0.join("src/marker"), "source").unwrap();
        fs::write(fixture.0.join("compose.yaml"), &full).unwrap();
        let namespace = candidate.plan(&fixture.0).unwrap().namespace;
        let original = digest(full.as_bytes());
        let partial = json!({"services":{"web":web},"volumes":{"zdata":{}}}).to_string();
        let compose = project::NormalizedComposeOptions {
            project: &fixture.0,
            branch: None,
            expected_namespace: &namespace,
            compose_file: Path::new("compose.yaml"),
            expected_compose_sha256: &original,
            compose_bytes: partial.as_bytes(),
            profiles: &[],
        };
        let cold = project::plan_normalized(&candidate, compose).unwrap();
        let cold_contract = source::review_shared_contract(&cold.plan).unwrap();
        let full_options = project::NormalizedComposeOptions {
            compose_bytes: full.as_bytes(),
            ..compose
        };
        let reviewed = project::plan_normalized(&candidate, full_options).unwrap();
        let synthetic: Value = serde_json::from_str(&full).unwrap();
        assert_ne!(synthetic.to_string(), full);
        let combined = review_combined(
            &candidate,
            compose,
            &synthetic,
            Some((&reviewed.plan_id, &original, full.as_bytes())),
            &BTreeSet::from(["redis", "web"]),
        )
        .unwrap();
        assert_eq!(combined.plan_id, reviewed.plan_id);
        assert_eq!(combined.plan.compose_sha256, original);
        let contract = source::review_shared_contract(&combined.plan).unwrap();

        // Restore may observe a new inventory with the same execution input.
        fs::write(fixture.0.join("src/marker"), "edited source").unwrap();
        let restore = project::plan_normalized(&candidate, full_options).unwrap();
        let current = project::snapshot::capture_plan(&restore.plan).unwrap();
        assert_eq!(
            cold_contract
                .verify(&restore.plan, current.receipt())
                .unwrap_err()
                .code,
            "live_source_contract"
        );
        contract.verify(&restore.plan, current.receipt()).unwrap();
        assert!(
            review_combined(
                &candidate,
                compose,
                &synthetic,
                Some((&reviewed.plan_id, &"0".repeat(64), full.as_bytes())),
                &BTreeSet::from(["redis", "web"]),
            )
            .is_err()
        );
    }

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
            json!({"services":{"redis":{"image":image,"depends_on":["web"],"volumes":["redis-data:/data"]},"web":{"image":image}},"networks":{"default":{"internal":true}},"volumes":{"redis-data":{}}}),
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
        select_resources(&mut prepared, &BTreeSet::from(["web".into()]));
        assert!(!prepared.configs.contains_key("web"));
        let redis = &prepared.resources["container:redis"];
        assert_ne!(redis.name, web_name);
        assert_eq!(
            prepared.configs["redis"]["HostConfig"]["NetworkMode"],
            net_name
        );
        image_volumes::admit(
            &json!({"/data":{}}),
            &prepared.configs["redis"],
            &prepared.resources,
        )
        .unwrap();
        let mut lost = redis.clone();
        lost.phase = "create-intent".into();
        receipt.resources.insert("container:redis".into(), lost);
        receipt.readiness = goals;
        receipt.extending.insert("redis".into());
        let root = directory(&candidate, &run).unwrap();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        state::write(&root.join("state.json"), &receipt).unwrap();
        let (read, root) = load_at(root, &run, &owner).unwrap();
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

        let pending = root.join("state.pending");
        fs::write(&pending, b"{interrupted").unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        let evidence = journal::retain(&root).unwrap().unwrap();
        let mut reconciled = read;
        reconciled.set_phase("reconciled-cleanup-only");
        state::write(&root.join("state.json"), &reconciled).unwrap();
        let (loaded, _) = load_at(root, &run, &owner).unwrap();
        assert_eq!(loaded.phase, "reconciled-cleanup-only");
        assert!(loaded.extending.is_empty());
        assert!(loaded.resources.contains_key("container:redis"));
        assert_eq!(
            fs::read(evidence.join("interrupted.pending")).unwrap(),
            b"{interrupted"
        );
    }
}
