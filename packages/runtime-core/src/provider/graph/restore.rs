use super::*;

/// Recreate acknowledged, removed compute around the same verified named data. This is explicit
/// execution of the unchanged reviewed graph, not replay of an interrupted attempt.
pub fn restore(candidate: &Candidate, options: RunOptions<'_>) -> Result<Receipt, CandidateError> {
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
    restore_inputs(
        candidate,
        options,
        inputs,
        BTreeMap::new(),
        false,
        None,
        None,
    )
}
/// Explicit fresh delivery after completed cleanup; retained intents never supply or renew values.
pub fn restore_with_environment(
    candidate: &Candidate,
    options: RunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    lifetime: Duration,
) -> Result<Receipt, CandidateError> {
    restore_with_environment_until(candidate, options, managed, environment_deadline(lifetime)?)
}
/// Fresh delivery retaining the private ingress deadline through compilation and staging.
/// This never extends an existing lease or authorizes replay of interrupted cleanup.
pub(crate) fn restore_with_environment_until(
    candidate: &Candidate,
    options: RunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: std::time::Instant,
) -> Result<Receipt, CandidateError> {
    let (inputs, environments) =
        compile_environment_inputs_until(candidate, &options, managed, deadline)?;
    restore_inputs(candidate, options, inputs, environments, true, None, None)
}
/// Retains the existing control-only foreground driver for owner checks at every
/// execution boundary; this does not replay dependency setup or create a new owner.
#[cfg(target_os = "macos")]
pub(super) fn restore_with_foreground(
    candidate: &Candidate,
    options: RunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: std::time::Instant,
    runtime: &mut HostRelayRuntime,
) -> Result<Receipt, CandidateError> {
    let (inputs, environments) =
        compile_environment_inputs_until(candidate, &options, managed, deadline)?;
    restore_inputs(
        candidate,
        options,
        inputs,
        environments,
        true,
        Some(runtime),
        None,
    )
}
pub(super) struct FreshOwnerRestore<'a> {
    pub identity: NormalizedInputIdentity,
    pub generation: &'a str,
    pub deadline: std::time::Instant,
}
#[cfg(target_os = "macos")]
pub(super) fn restore_normalized_foreground(
    candidate: &Candidate,
    options: NormalizedRunOptions<'_>,
    managed: &BTreeMap<String, BTreeMap<String, String>>,
    deadline: std::time::Instant,
    runtime: &mut HostRelayRuntime,
    generation: &str,
) -> Result<Receipt, CandidateError> {
    startup::Driver::check_cancelled(runtime)?;
    check_environment_deadline(deadline)?;
    let compiled = compile_normalized_inputs(candidate, &options, managed)?;
    let identity = NormalizedInputIdentity {
        namespace: compiled.executable.review.plan.namespace.clone(),
        original_compose_sha256: options.compose.expected_compose_sha256.into(),
        normalized_compose_sha256: compiled.executable.review.plan.compose_sha256.clone(),
    };
    let environments = compiled
        .managed_environment
        .iter()
        .map(|(name, values)| {
            super::super::environment::PendingEnvironment::until(name, values, deadline)
                .map(|pending| (name.clone(), pending))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    check_environment_deadline(deadline)?;
    restore_inputs(
        candidate,
        options.run,
        compiled.executable,
        environments,
        true,
        Some(runtime),
        Some(FreshOwnerRestore {
            identity,
            generation,
            deadline,
        }),
    )
}
fn verify_fresh(
    receipt: &Receipt,
    plan: &str,
    fresh: &FreshOwnerRestore<'_>,
    generation: &str,
) -> Result<(), CandidateError> {
    if !hex(fresh.generation, 64)
        || generation != fresh.generation
        || receipt.normalized_input.as_ref() != Some(&fresh.identity)
        || plan != receipt.plan_id
    {
        return Err(error(
            "graph_restore_refused",
            "Stopped restore selection or normalized input changed; no graph effects were started.",
        ));
    }
    Ok(())
}
/// Binds the stopped selection to current boot and exact observed retained data.
/// Existing receipts identify managed volumes by name/labels; this additionally
/// fences replacement between explicit selection and restoration.
pub(super) fn restore_generation(
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<String, CandidateError> {
    use sha2::{Digest, Sha256};
    let mut volumes = BTreeMap::new();
    for (key, resource) in &receipt.resources {
        if resource.kind != Kind::Volume {
            continue;
        }
        let inspected = inspect_resource(engine, receipt, resource)?
            .ok_or_else(|| error("graph_data_missing", "Retained volume is missing."))?;
        let created = inspected["CreatedAt"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| error("graph_receipt", "Volume identity unavailable."))?;
        let directory = volume_subpaths::directory_identity(engine, resource, &inspected)?;
        if inspect_resource(engine, receipt, resource)?.as_ref() != Some(&inspected) {
            return Err(error(
                "graph_receipt",
                "Retained volume changed during selection.",
            ));
        }
        volumes.insert(key, (resource.name.as_str(), created.to_owned(), directory));
    }
    let bytes = serde_json::to_vec(&(receipt, engine.guest().boot_id(), volumes))
        .map_err(|_| error("graph_receipt", "Restore selection unavailable."))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn restore_inputs(
    candidate: &Candidate,
    options: RunOptions<'_>,
    inputs: project::inputs::ExecutionInputs,
    environments: BTreeMap<String, super::super::environment::PendingEnvironment>,
    redelivery: bool,
    mut startup: Option<&mut dyn startup::Driver>,
    fresh: Option<FreshOwnerRestore<'_>>,
) -> Result<Receipt, CandidateError> {
    if options.timeout.is_zero() || options.timeout > Duration::from_secs(600) {
        return Err(error("graph_budget", "Invalid restore timeout."));
    }
    let engine = Engine::connect(candidate)?;
    if engine.guest().profile() != super::super::Profile::Development {
        return Err(error(
            "graph_profile",
            "Restore requires the development VM profile.",
        ));
    }
    let (mut receipt, root) = load(candidate, &engine, options.run_id)?;
    if let Some(fresh) = &fresh {
        verify_fresh(
            &receipt,
            &inputs.review.plan_id,
            fresh,
            &restore_generation(&engine, &receipt)?,
        )?;
    } else {
        normalized::require_file_replay(&receipt)?;
    }
    if let Some(driver) = startup.as_ref() {
        driver.validate_inputs(&inputs)?;
    }

    initializer_cache::require_resolved(&receipt)?;
    cleanup_enrollment::retention(&root, &receipt)?;
    if fresh.is_none()
        && let Some(driver) = startup.as_mut()
    {
        driver.verify(&engine, &mut receipt, &root)?;
    }
    if !redelivery {
        environment::require_replay_supported(&receipt)?;
    }
    if root.join("state.pending").exists()
        || root.join("state.pending").is_symlink()
        || receipt.phase != "stopped-data-retained"
        || receipt.readiness != *options.readiness
    {
        return Err(error(
            "graph_restore_refused",
            "Restore requires completed ordinary cleanup and the unchanged plan and readiness goals.",
        ));
    }
    super::super::source_job::check_reservations(&engine)?;
    let source = source::prepare_replay(
        &engine,
        &inputs,
        &receipt,
        options.source_revision,
        options.live_source,
        options.shared_source,
        options.non_secret_values,
    )?;
    let mut prepared = config::prepare_delivery(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
        source.as_ref(),
        config::DeliveryOptions {
            environment: !environments.is_empty(),
            dependency_hosts: fresh.is_some(),
            routing_enrolled: options.routing_enrolled,
        },
    )?;
    config::retain_replay_ownership(&mut prepared, &receipt)?;
    if prepared.namespace != receipt.namespace
        || !same_resource_bindings(&prepared.resources, &receipt.resources)
    {
        return Err(error(
            "graph_receipt",
            "Restore resources differ from the reviewed graph.",
        ));
    }
    check_network_intent(&engine, &prepared.resources)?;
    admission::check(candidate, &engine, Some(options.run_id), &prepared.configs)?;
    if !environments.is_empty() {
        super::super::environment::preflight_capacity(engine.guest(), environments.len())?;
    }
    let expected_environment = verify_images(
        &engine,
        &prepared.resources,
        &mut prepared.configs,
        &environments.keys().cloned().collect(),
    )?;
    for resource in receipt.resources.values() {
        let present = inspect_resource(&engine, &receipt, resource)?.is_some();
        if resource.kind == Kind::Volume {
            if !present {
                return Err(error(
                    "graph_data_missing",
                    "Retained volume is missing; restore will not recreate it.",
                ));
            }
        } else {
            let mut by_name = resource.clone();
            by_name.id = None;
            if resource.phase != "absent"
                || present
                || inspect_resource(&engine, &receipt, &by_name)?.is_some()
            {
                return Err(error(
                    "graph_restore_refused",
                    "Restore requires confirmed absence of every prior container and network.",
                ));
            }
        }
    }
    for name in environments.keys() {
        launcher::validate(&prepared.configs[name])?;
    }
    if let Some(fresh) = &fresh {
        check_environment_deadline(fresh.deadline)?;
        if restore_generation(&engine, &receipt)? != fresh.generation {
            return Err(error(
                "graph_restore_refused",
                "Retained restore selection changed before effects.",
            ));
        }
    }
    if let Some(driver) = startup.as_ref() {
        driver.check_cancelled()?;
    }
    // Retain the complete acknowledged old generation before replacing its
    // boot-bound dependency owner. Historical cleanup is verified in its own context.
    if fresh.is_some() {
        super::restore_history::retain(&root, &receipt)?;
        receipt.relay_startup = None;
        receipt.relay_cleanup = None;
    } else {
        if let Some(mut marker) = receipt.relay_cleanup.clone() {
            super::restore_history::retain(&root, &receipt)?;
            marker.phase = cleanup_enrollment::Phase::Dormant;
            receipt.relay_cleanup = Some(marker);
            state::write(&root.join("state.json"), &receipt)?;
        }
    }
    // Recheck retirement under the same engine guard before creating fresh allocations.
    for slot in environment::cleanup_slots(candidate, &engine, &receipt)? {
        super::super::environment_recovery::retire(candidate, engine.guest(), &slot, None)?;
    }
    let launcher = if environments.is_empty() {
        None
    } else {
        Some(launcher::publish(&engine)?)
    };
    if fresh.is_none() && receipt.relay_cleanup.is_none() {
        super::restore_history::retain(&root, &receipt)?;
    }
    // The complete previous attempt is retained above; current failure evidence
    // belongs only to this newly admitted generation.
    receipt.startup_failure = None;
    receipt.probes = probes::fresh(&engine, &prepared.configs, prepared.probes)?;
    receipt.phase = "restoring".into();
    for (key, resource) in &mut receipt.resources {
        if resource.kind != Kind::Volume {
            *resource = prepared.resources[key].clone();
        }
    }
    let mut session = Session {
        startup,
        engine,
        root,
        receipt,
        configs: prepared.configs,
        expected_environment,
        restarting: false,
        fresh_cache_completion: false,
        cache_initializers: BTreeMap::new(),
        environments,
        leases: BTreeMap::new(),
        launcher,
    };
    // A fresh driver's prepare validates its prospective enrollment before its
    // first durable write. Keep the acknowledged stopped receipt authoritative
    // until that boundary, so pre-admission failure can retire the new owner.
    if fresh.is_none() {
        session.save()?;
    }
    #[cfg(test)]
    if fresh.is_none() {
        session.fault_pause("restore-intent")?;
    }
    let result = (|| {
        if fresh.is_some()
            && let Some(driver) = session.startup.as_mut()
        {
            driver.prepare(
                &session.engine,
                &mut session.receipt,
                &session.root,
                &mut session.configs,
            )?;
        }
        session.create_resources(true)?;
        execution::run(&prepared.graph, &mut session, options.timeout)
    })();
    if let Err(failure) = result {
        retain_restore_failure(
            &session.root,
            &mut session.receipt,
            fresh.is_some(),
            session
                .startup
                .as_ref()
                .is_none_or(|driver| driver.admission_started()),
        )?;
        return Err(failure);
    }
    Ok(session.receipt)
}

fn retain_restore_failure(
    root: &std::path::Path,
    receipt: &mut Receipt,
    fresh: bool,
    admitted: bool,
) -> Result<(), CandidateError> {
    if fresh && !admitted {
        return Ok(());
    }
    receipt.phase = "failed-retained".into();
    state::write(&root.join("state.json"), receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, time::Instant};

    #[test]
    fn fresh_normalized_restore_requires_exact_plan_provenance_and_selection() {
        let identity = NormalizedInputIdentity {
            namespace: "c".repeat(64),
            original_compose_sha256: "e".repeat(64),
            normalized_compose_sha256: "f".repeat(64),
        };
        let receipt:Receipt=serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"stopped-data-retained","readiness":{},"resources":{},"normalized_input":identity})).unwrap();
        let generation = "1".repeat(64);
        let mut fresh = FreshOwnerRestore {
            identity: identity.clone(),
            generation: &generation,
            deadline: Instant::now() + Duration::from_secs(30),
        };
        verify_fresh(&receipt, &receipt.plan_id, &fresh, &generation).unwrap();
        assert!(verify_fresh(&receipt, &"2".repeat(64), &fresh, &generation).is_err());
        assert!(verify_fresh(&receipt, &receipt.plan_id, &fresh, &"3".repeat(64)).is_err());
        for field in [0, 1, 2] {
            fresh.identity = identity.clone();
            match field {
                0 => fresh.identity.namespace = "4".repeat(64),
                1 => fresh.identity.original_compose_sha256 = "4".repeat(64),
                _ => fresh.identity.normalized_compose_sha256 = "4".repeat(64),
            };
            assert!(verify_fresh(&receipt, &receipt.plan_id, &fresh, &generation).is_err());
        }
        assert!(normalized::require_file_replay(&receipt).is_err());
    }
    #[test]
    fn fresh_prepare_refusal_preserves_acknowledged_stopped_receipt() {
        let fixture = super::super::tests::Fixture::new();
        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"stopped-data-retained","readiness":{},"resources":{}
        }))
        .unwrap();
        let path = fixture.0.join("state.json");
        state::write(&path, &receipt).unwrap();
        let stopped = fs::read(&path).unwrap();
        receipt.phase = "restoring".into();
        retain_restore_failure(&fixture.0, &mut receipt, true, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), stopped);
        assert!(!fixture.0.join("state.pending").exists());
        retain_restore_failure(&fixture.0, &mut receipt, true, true).unwrap();
        let failed: Receipt = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(failed.phase, "failed-retained");
        assert_ne!(fs::read(&path).unwrap(), stopped);
    }

    fn refused_before_effects(deadline: Option<Instant>, lifetime: Duration, expected: &str) {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let public = BTreeMap::new();
        let readiness = BTreeMap::new();
        let managed = BTreeMap::from([(
            "app".into(),
            BTreeMap::from([("TOKEN".into(), "synthetic-private-input".into())]),
        )]);
        // Deliberately absent project and provider state: deadline/feature admission
        // must refuse before compilation or an Engine connection can have effects.
        let options = RunOptions {
            live_source: false,
            shared_source: false,
            release_initializer_cache: std::collections::BTreeSet::new(),
            routing_enrolled: false,
            project: PlanOptions {
                project: &fixture.0,
                compose_file: Path::new("absent.yaml"),
                profiles: &[],
            },
            expected_plan: &"a".repeat(64),
            source_revision: None,
            non_secret_values: &public,
            readiness: &readiness,
            run_id: &"b".repeat(32),
            timeout: Duration::from_secs(30),
        };
        let result = match deadline {
            Some(deadline) => {
                restore_with_environment_until(&candidate, options, &managed, deadline)
            }
            None => restore_with_environment(&candidate, options, &managed, lifetime),
        };
        assert_eq!(result.unwrap_err().code, expected);
        assert!(!candidate.state_root.exists());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[test]
    #[cfg(feature = "environment-launcher")]
    fn ingress_deadline_is_not_refreshed_and_over_budget_refuses_before_effects() {
        for deadline in [
            Instant::now() - Duration::from_secs(1),
            Instant::now() + Duration::from_secs(301),
        ] {
            refused_before_effects(Some(deadline), Duration::ZERO, "environment_expired");
        }
    }

    #[test]
    fn duration_api_retains_lifetime_bounds_before_effects() {
        for lifetime in [Duration::ZERO, Duration::from_secs(301)] {
            refused_before_effects(None, lifetime, "environment_input");
        }
    }

    #[test]
    #[cfg(feature = "environment-launcher")]
    fn valid_deadline_stale_plan_refuses_before_engine_effects() {
        let checkout = super::super::tests::Fixture::new();
        let project = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&checkout.0).unwrap();
        let path = project.0.join("compose.yaml");
        let document = |command: &str| json!({"services":{"app":{"image":format!("example.invalid/app@sha256:{}", "a".repeat(64)),"network_mode":"none","entrypoint":["/bin/true"],"command":[command],"environment":{"TOKEN":null}}}});
        fs::write(&path, serde_json::to_vec(&document("before")).unwrap()).unwrap();
        let project_options = || PlanOptions {
            project: &project.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        };
        let review = project::plan(&candidate, project_options()).unwrap();
        fs::write(&path, serde_json::to_vec(&document("after")).unwrap()).unwrap();
        let public = BTreeMap::new();
        let readiness = BTreeMap::new();
        let managed = BTreeMap::from([(
            "app".into(),
            BTreeMap::from([("TOKEN".into(), "synthetic-private-input".into())]),
        )]);
        let failure = restore_with_environment_until(
            &candidate,
            RunOptions {
                live_source: false,
                shared_source: false,
                release_initializer_cache: std::collections::BTreeSet::new(),
                routing_enrolled: false,
                project: project_options(),
                expected_plan: &review.plan_id,
                source_revision: None,
                non_secret_values: &public,
                readiness: &readiness,
                run_id: &"b".repeat(32),
                timeout: Duration::from_secs(30),
            },
            &managed,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap_err();
        assert_eq!(failure.code, "execution_plan_changed");
        assert!(!candidate.state_root.exists());
        assert_eq!(fs::read_dir(&checkout.0).unwrap().count(), 0);
    }

    #[test]
    #[cfg(not(feature = "environment-launcher"))]
    fn ingress_delivery_without_launcher_refuses_before_effects() {
        refused_before_effects(
            Some(Instant::now() + Duration::from_secs(120)),
            Duration::ZERO,
            "environment_launcher_disabled",
        );
    }
}
