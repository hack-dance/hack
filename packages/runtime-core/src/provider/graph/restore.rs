use super::*;

/// Recreate acknowledged, removed compute around the same verified named data. This is explicit
/// execution of the unchanged reviewed graph, not replay of an interrupted attempt.
pub fn restore(candidate: &Candidate, options: RunOptions<'_>) -> Result<Receipt, CandidateError> {
    let inputs = project::inputs::compile(
        candidate,
        PlanOptions {
            branch: options.project.branch,
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
    verify_fresh_change(receipt, plan, fresh, generation, None)
}

fn verify_fresh_change(
    receipt: &Receipt,
    plan: &str,
    fresh: &FreshOwnerRestore<'_>,
    generation: &str,
    change: Option<&hostname_change::Verified>,
) -> Result<(), CandidateError> {
    if !hex(fresh.generation, 64)
        || generation != fresh.generation
        || (receipt.normalized_input.as_ref() != Some(&fresh.identity)
            && !change.is_some_and(|change| change.matches_fresh(receipt, &fresh.identity)))
        || (plan != receipt.plan_id
            && receipt
                .source
                .as_ref()
                .and_then(|binding| binding.shared_contract.as_ref())
                .is_none())
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
pub(super) fn observed_volumes(
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<BTreeMap<String, (String, String, String)>, CandidateError> {
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
        volumes.insert(
            key.clone(),
            (resource.name.clone(), created.to_owned(), directory),
        );
    }
    Ok(volumes)
}

pub(super) fn restore_generation(
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<String, CandidateError> {
    use sha2::{Digest, Sha256};
    let volumes = observed_volumes(engine, receipt)?;
    let bytes = serde_json::to_vec(&(receipt, engine.guest().boot_id(), &volumes))
        .map_err(|_| error("graph_receipt", "Restore selection unavailable."))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(target_os = "macos")]
pub(super) fn restore_generation_with_source_rebind(
    engine: &Engine<'_>,
    receipt: &Receipt,
    selected: Option<&super::source_device_rebind::Selected>,
) -> Result<String, CandidateError> {
    use sha2::{Digest, Sha256};
    let original = restore_generation(engine, receipt)?;
    let Some(selected) = selected else {
        return Ok(original);
    };
    let bytes = serde_json::to_vec(&(
        "hack-graph-restore-source-device-rebind-v1",
        original,
        selected.raw_sha256(),
    ))
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
    #[cfg(target_os = "macos")]
    let source_rebind = super::source_device_rebind::select(&engine, &receipt, &root)?;
    #[cfg(target_os = "macos")]
    if source_rebind.is_some() && fresh.is_none() {
        return Err(error(
            "graph_source_device_rebind",
            "Source-device continuity requires a new foreground restore owner.",
        ));
    }
    let hostname_change = if let Some(fresh) = &fresh {
        #[cfg(target_os = "macos")]
        let source_receipt = source_rebind
            .as_ref()
            .map_or(&receipt, |selected| selected.source_receipt());
        #[cfg(not(target_os = "macos"))]
        let source_receipt = &receipt;
        let change = hostname_change::prepare(
            &engine,
            &inputs.review.plan,
            source_receipt,
            &fresh.identity,
        )?;
        if change.is_some()
            && (!options.shared_source
                || options.live_source
                || !options.non_secret_values.is_empty())
        {
            return Err(error(
                "graph_hostname_change",
                "Hostname changes require the same normalized shared-source mode without external execution substitutions.",
            ));
        }
        change
    } else {
        None
    };
    if let Some(fresh) = &fresh {
        #[cfg(target_os = "macos")]
        let generation =
            restore_generation_with_source_rebind(&engine, &receipt, source_rebind.as_ref())?;
        #[cfg(not(target_os = "macos"))]
        let generation = restore_generation(&engine, &receipt)?;
        if let Some(change) = &hostname_change {
            verify_fresh_change(
                &receipt,
                &inputs.review.plan_id,
                fresh,
                &generation,
                Some(change),
            )?;
        } else {
            verify_fresh(&receipt, &inputs.review.plan_id, fresh, &generation)?;
        }
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
    #[cfg(target_os = "macos")]
    let source_receipt = source_rebind
        .as_ref()
        .map_or(&receipt, |selected| selected.source_receipt());
    #[cfg(not(target_os = "macos"))]
    let source_receipt = &receipt;
    let ordinary_source = if hostname_change.is_none() {
        source::prepare_replay(
            &engine,
            &inputs,
            source_receipt,
            options.source_revision,
            options.live_source,
            options.shared_source,
            options.non_secret_values,
        )?
    } else {
        let cached = inputs
            .review
            .plan
            .services
            .values()
            .any(|service| service.active && service.dependency_cache.is_some());
        if options.source_revision
            != cached
                .then(|| {
                    receipt
                        .source
                        .as_ref()
                        .map(|binding| binding.revision.as_str())
                })
                .flatten()
        {
            return Err(error(
                "graph_hostname_change",
                "Hostname change must retain the original cache source revision.",
            ));
        }
        None
    };
    let source = hostname_change
        .as_ref()
        .map(|change| &change.source)
        .or(ordinary_source.as_ref());
    let mut prepared = config::prepare_delivery(
        inputs,
        options.readiness,
        options.run_id,
        engine.guest().incarnation(),
        source,
        config::DeliveryOptions {
            environment: !environments.is_empty(),
            dependency_hosts: fresh.is_some(),
            routing_enrolled: options.routing_enrolled,
        },
    )?;
    if let Some(change) = &hostname_change {
        config::retain_hostname_change_ownership(&mut prepared, &receipt, change)?;
    } else {
        config::retain_replay_ownership(&mut prepared, &receipt)?;
    }
    if prepared.namespace != receipt.namespace
        || !hostname_change.as_ref().map_or_else(
            || same_resource_bindings(&prepared.resources, &receipt.resources),
            |change| change.matches_resources(&prepared.resources, &receipt),
        )
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
        #[cfg(target_os = "macos")]
        let generation =
            restore_generation_with_source_rebind(&engine, &receipt, source_rebind.as_ref())?;
        #[cfg(not(target_os = "macos"))]
        let generation = restore_generation(&engine, &receipt)?;
        if generation != fresh.generation {
            return Err(error(
                "graph_restore_refused",
                "Retained restore selection changed before effects.",
            ));
        }
    }
    if let Some(driver) = startup.as_ref() {
        driver.check_cancelled()?;
    }
    source::verify_cache_scope(source, options.project.project)?;
    #[cfg(target_os = "macos")]
    super::source_device_rebind::verify_cache_scope_origin(candidate, &receipt)?;
    // Retain the complete acknowledged old generation before replacing its
    // boot-bound dependency owner. Historical cleanup is verified in its own context.
    if fresh.is_some() {
        #[cfg(target_os = "macos")]
        if let Some(selected) = &source_rebind {
            selected.reverify(&engine)?;
        }
        super::restore_history::retain(&root, &receipt)?;
        #[cfg(target_os = "macos")]
        if let Some(selected) = &source_rebind {
            selected.apply_to_new_attempt(&mut receipt)?;
        }
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
    if let Some(change) = &hostname_change {
        change.apply(&mut receipt)?;
    }
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
        #[cfg(target_os = "macos")]
        if let Some(selected) = &source_rebind {
            selected.reverify(&session.engine)?;
        }
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
    use sha2::Digest;
    use std::{path::Path, time::Instant};

    #[test]
    fn hostname_restore_requires_fresh_proof_and_exact_retained_generation() {
        let (_fixture, receipt, proof) = hostname_change::tests::transition();
        let mut next = receipt.clone();
        proof.apply(&mut next).unwrap();
        let generation = "1".repeat(64);
        let fresh = FreshOwnerRestore {
            identity: next.normalized_input.unwrap(),
            generation: &generation,
            deadline: Instant::now() + Duration::from_secs(30),
        };
        let reviewed = "8".repeat(64);
        assert!(verify_fresh(&receipt, &reviewed, &fresh, &generation).is_err());
        verify_fresh_change(&receipt, &reviewed, &fresh, &generation, Some(&proof)).unwrap();
        // Rollback may review the original ownership plan; provenance still needs proof.
        verify_fresh_change(
            &receipt,
            &receipt.plan_id,
            &fresh,
            &generation,
            Some(&proof),
        )
        .unwrap();
        assert!(
            verify_fresh_change(&receipt, &reviewed, &fresh, &"2".repeat(64), Some(&proof))
                .is_err()
        );
        let mut replaced = receipt.clone();
        replaced.owner = "c".repeat(32);
        assert!(
            verify_fresh_change(&replaced, &reviewed, &fresh, &generation, Some(&proof)).is_err()
        );
        let mut altered = fresh;
        altered.identity.normalized_compose_sha256 = "7".repeat(64);
        assert!(
            verify_fresh_change(&receipt, &reviewed, &altered, &generation, Some(&proof)).is_err()
        );
    }

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
    fn changed_plan_requires_a_retained_shared_contract_before_any_restore_effect() {
        let identity = NormalizedInputIdentity {
            namespace: "c".repeat(64),
            original_compose_sha256: "e".repeat(64),
            normalized_compose_sha256: "f".repeat(64),
        };
        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"stopped-data-retained","readiness":{},"resources":{},
            "normalized_input":identity,
        }))
        .unwrap();
        let generation = "1".repeat(64);
        let fresh = FreshOwnerRestore {
            identity: identity.clone(),
            generation: &generation,
            deadline: Instant::now() + Duration::from_secs(30),
        };
        let changed = "2".repeat(64);
        assert!(verify_fresh(&receipt, &changed, &fresh, &generation).is_err());
        receipt.source = Some(serde_json::from_value(json!({
            "shared": {
                "project":"/tmp/fixture","guest_path":format!("/mnt/hack-projects/{:x}", sha2::Sha256::digest(b"/tmp/fixture")),
                "device":1,"inode":1,"unfiltered_source":true
            },
            "shared_contract": {
                "version":1,
                "execution_sha256":"1".repeat(64),
                "policy_sha256":"2".repeat(64),
                "cache_inputs_sha256":"3".repeat(64),
                "mount_roots_sha256":"4".repeat(64)
            },
            "revision":"5".repeat(64),
            "archive_sha256":"6".repeat(64),
            "selection_sha256":"7".repeat(64)
        }))
        .unwrap());
        // This first gate only permits the under-lease semantic and source checks to run.
        verify_fresh(&receipt, &changed, &fresh, &generation).unwrap();
        receipt.source.as_mut().unwrap().shared_contract = None;
        assert!(verify_fresh(&receipt, &changed, &fresh, &generation).is_err());
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
                branch: None,
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
            branch: None,
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
