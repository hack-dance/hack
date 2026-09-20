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
    restore_inputs(candidate, options, inputs, BTreeMap::new(), false, None)
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
    restore_inputs(candidate, options, inputs, environments, true, None)
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
    )
}
fn restore_inputs(
    candidate: &Candidate,
    options: RunOptions<'_>,
    inputs: project::inputs::ExecutionInputs,
    environments: BTreeMap<String, super::super::environment::PendingEnvironment>,
    redelivery: bool,
    mut startup: Option<&mut dyn startup::Driver>,
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
    normalized::require_file_replay(&receipt)?;
    initializer_cache::require_resolved(&receipt)?;
    cleanup_enrollment::retention(&root, &receipt)?;
    if let Some(driver) = startup.as_mut() {
        driver.verify(&engine, &receipt)?;
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
    if let Some(mut marker) = receipt.relay_cleanup.clone() {
        super::restore_history::retain(&root, &receipt)?;
        marker.phase = cleanup_enrollment::Phase::Dormant;
        receipt.relay_cleanup = Some(marker);
        state::write(&root.join("state.json"), &receipt)?;
    }
    let mut prepared = config::prepare_delivery(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
        source.as_ref(),
        config::DeliveryOptions {
            environment: !environments.is_empty(),
            dependency_hosts: false,
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
    // Recheck retirement under the same engine guard before creating fresh allocations.
    for slot in environment::cleanup_slots(candidate, &engine, &receipt)? {
        super::super::environment_recovery::retire(candidate, engine.guest(), &slot, None)?;
    }
    let launcher = if environments.is_empty() {
        None
    } else {
        Some(launcher::publish(&engine)?)
    };
    if receipt.relay_cleanup.is_none() {
        super::restore_history::retain(&root, &receipt)?;
    }
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
    session.save()?;
    #[cfg(test)]
    session.fault_pause("restore-intent")?;
    let result = (|| {
        session.create_resources(true)?;
        execution::run(&prepared.graph, &mut session, options.timeout)
    })();
    if let Err(failure) = result {
        session.receipt.phase = "failed-retained".into();
        session.save()?;
        return Err(failure);
    }
    Ok(session.receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, time::Instant};

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
