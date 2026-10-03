//! Metadata retirement for a completed prior-boot rebind. Historical receipts
//! select preserved evidence only; current ownership and live absence still
//! fence every archive write/rename under the caller's foreground lock.
use super::*;

fn require_retirement(
    root: &Path,
    current: &Receipt,
    intent: &Intent,
) -> Result<(), CandidateError> {
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    let retirement: Retirement = state::read_bounded(&root.join(RETIREMENT), 65536)?;
    if intent.original.phase != "ready-observed"
        || !super::super::hex(complete, 64)
        || retirement.version != 1
        || retirement.selection_sha256 != intent.selection_sha256
        || retirement.complete_sha256 != complete
        || retirement.run != current.run
        || retirement.owner != current.owner
        || current.run != intent.original.run
        || current.owner != intent.original.owner
        || current.namespace != intent.original.namespace
        || current.plan_id != intent.original.plan_id
        || current.phase != "stopped-data-retained"
    {
        return Err(refused());
    }
    Ok(())
}

fn completion(root: &Path, current: &Receipt, intent: &Intent) -> Result<Receipt, CandidateError> {
    require_retirement(root, current, intent)?;
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    let completed =
        if digest(&serde_json::to_vec_pretty(current).map_err(|_| refused())?) == complete {
            current.clone()
        } else {
            super::super::restore_history::completed_for_recovery(root, current, complete)?
                .ok_or_else(refused)?
        };
    if intent.original.phase != "ready-observed"
        || completed.phase != "stopped-data-retained"
        || !intent.selection.matches_graph(&completed)
        || dead_owner_cleanup::immutable(&completed)?
            != dead_owner_cleanup::immutable(&intent.original)?
        || intent.original.resources.len() != completed.resources.len()
        || intent.original.resources.iter().any(|(key, before)| {
            completed.resources.get(key).is_none_or(|after| {
                before.kind != after.kind
                    || before.id != after.id
                    || before.name != after.name
                    || (after.kind != Kind::Volume && after.phase != "absent")
            })
        })
        || completed
            .resources
            .iter()
            .filter(|(_, r)| r.kind == Kind::Volume)
            .any(|(key, old)| {
                current.resources.get(key).is_none_or(|now| {
                    now.kind != Kind::Volume || old.name != now.name || old.cache != now.cache
                })
            })
        || completed
            .resources
            .values()
            .filter(|r| r.kind == Kind::Volume)
            .count()
            != current
                .resources
                .values()
                .filter(|r| r.kind == Kind::Volume)
                .count()
    {
        return Err(refused());
    }
    Ok(completed)
}

/// Completed archival grants only a metadata no-op. Current retained compute
/// must still have its own exact recovery or acknowledged ordinary cleanup.
fn already_archived(
    root: &Path,
    current: &Receipt,
    intent: &Intent,
    verify_lock: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    verify_lock()?;
    if !startup::retired_dependency_rebind_archive_complete(
        root,
        &intent.original,
        &intent.selection.previous_guest_boot,
    )? {
        return Ok(false);
    }
    let verify = || {
        require_retirement(root, current, intent)?;
        no_pending(root)?;
        for name in [
            "live-owner-cleanup.pending",
            "source-device-rebind.pending",
            "restore-history.pending",
        ] {
            require_absent(&root.join(name))?;
        }
        let recorded = read_intent(root)?.ok_or_else(refused)?;
        if serde_json::to_vec_pretty(&recorded).map_err(|_| refused())?
            != serde_json::to_vec_pretty(intent).map_err(|_| refused())?
            || host_pin_recovery::read_raw(&root.join(INTENT), 4 * 1024 * 1024)?
                != serde_json::to_vec_pretty(intent).map_err(|_| refused())?
            || host_pin_recovery::read_raw(&root.join("state.json"), LIMIT)?
                != serde_json::to_vec_pretty(current).map_err(|_| refused())?
        {
            return Err(refused());
        }
        super::super::cleanup_enrollment::retention(root, current)
    };
    verify()?;
    verify_lock()?;
    if !startup::retired_dependency_rebind_archive_complete(
        root,
        &intent.original,
        &intent.selection.previous_guest_boot,
    )? {
        return Err(refused());
    }
    verify()?;
    Ok(true)
}

fn compute_absent(engine: &Engine<'_>, receipt: &Receipt) -> Result<(), CandidateError> {
    for resource in receipt
        .resources
        .values()
        .filter(|r| r.kind != Kind::Volume)
    {
        let mut by_name = resource.clone();
        by_name.id = None;
        if resource.phase != "absent"
            || inspect_resource(engine, receipt, resource)?.is_some()
            || inspect_resource(engine, receipt, &by_name)?.is_some()
        {
            return Err(refused());
        }
    }
    Ok(())
}

/// Called after completed absence retirement, or before the first effect of a
/// newly selected retained restore. The verifier must bind the held foreground
/// lock descriptor to its pathname, including after interrupted archival.
pub(in crate::provider::graph) fn archive_retired_rebind_under(
    candidate: &Candidate,
    engine: &Engine<'_>,
    current: &Receipt,
    verify_lock: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let root = directory(candidate, &current.run)?;
    let Some(intent) = read_intent(&root)? else {
        return Ok(());
    };
    let boot = startup::dependency_rebind_boot(&root, current)?;
    // A later current-boot journal belongs to its own normal cleanup. The old
    // absence intent cannot authorize retiring that generation.
    if boot.as_deref() == Some(engine.guest().boot_id()) {
        return Ok(());
    }
    let generation = super::super::service_exec_generation(&intent.original)?;
    let history = root.join(format!("dependency-rebind-history-{generation}"));
    if boot.is_none() && absent(&root.join("dependency-rebind.pending"))? && absent(&history)? {
        return Ok(());
    }
    if boot
        .as_deref()
        .is_some_and(|boot| boot != intent.selection.previous_guest_boot)
    {
        return Err(refused());
    }
    if already_archived(&root, current, &intent, verify_lock)? {
        return Ok(());
    }
    let completed = completion(&root, current, &intent)?;
    let current_bytes = serde_json::to_vec_pretty(current).map_err(|_| refused())?;
    let intent_bytes = host_pin_recovery::read_raw(&root.join(INTENT), 4 * 1024 * 1024)?;
    let retirement_bytes = host_pin_recovery::read_raw(&root.join(RETIREMENT), 65536)?;
    if serde_json::to_vec_pretty(&intent).map_err(|_| refused())? != intent_bytes {
        return Err(refused());
    }
    let verify = || {
        verify_lock()?;
        no_pending(&root)?;
        for name in [
            "live-owner-cleanup.pending",
            "source-device-rebind.pending",
            "restore-history.pending",
        ] {
            require_absent(&root.join(name))?;
        }
        if host_pin_recovery::read_raw(&root.join("state.json"), LIMIT)? != current_bytes
            || host_pin_recovery::read_raw(&root.join(INTENT), 4 * 1024 * 1024)? != intent_bytes
            || host_pin_recovery::read_raw(&root.join(RETIREMENT), 65536)? != retirement_bytes
            || serde_json::to_vec_pretty(&completion(&root, current, &intent)?)
                .map_err(|_| refused())?
                != serde_json::to_vec_pretty(&completed).map_err(|_| refused())?
        {
            return Err(refused());
        }
        let selection = &intent.selection;
        if selection.candidate != candidate.checkout || selection.version != 1 {
            return Err(refused());
        }
        let old_bytes = private_input(&selection.original_owner_path, 1024 * 1024)?;
        let inspection_bytes = private_input(&selection.filesystem_inspection_path, 65536)?;
        if digest(&old_bytes) != selection.original_owner_sha256
            || digest(&inspection_bytes) != selection.filesystem_inspection_sha256
        {
            return Err(refused());
        }
        let old: Owner = serde_json::from_slice(&old_bytes).map_err(|_| refused())?;
        let inspection: FilesystemInspection =
            serde_json::from_slice(&inspection_bytes).map_err(|_| refused())?;
        inspection.verify(&old_bytes, &old)?;
        let (owner, owner_sha) = current_owner(candidate, &old, &inspection, engine)?;
        if owner_sha != selection.current_owner_sha256
            || owner.token != current.owner
            || owner.guest_boot_id.as_deref() != Some(&selection.current_guest_boot)
            || owner.previous_guest_boot_id.as_deref() != Some(&selection.previous_guest_boot)
            || inspection.host_boot_micros != selection.host_boot_micros
            || inspection.old_device != selection.old_device
            || inspection.new_device != selection.new_device
        {
            return Err(refused());
        }
        super::super::source_device_rebind::verify_cache_scope_cleanup_origin(
            candidate,
            current,
            &digest(&intent_bytes),
            &digest(&retirement_bytes),
        )?;
        host_pin_recovery::verify_volume_projections(
            engine,
            &completed,
            &selection.retained_volumes,
        )?;
        host_pin_recovery::verify_volume_projections(engine, current, &selection.retained_volumes)?;
        compute_absent(engine, &completed)?;
        compute_absent(engine, current)?;
        verify_lock()
    };
    startup::archive_retired_dependency_rebind(
        &root,
        &intent.original,
        &completed,
        &intent.selection.previous_guest_boot,
        &verify,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archived_fixture() -> (
        crate::provider::graph::tests::Fixture,
        Receipt,
        Intent,
        PathBuf,
    ) {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let root = &fixture.0;
        let original: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},
            "relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/control","artifact":"e".repeat(64),"services":{}},
            "resources":{"container:web":{"kind":"container","key":"web","name":"owned-web","id":"e".repeat(64),"image":null,"phase":"started"},
                "volume:data":{"kind":"volume","key":"data","name":"owned-data","id":null,"image":null,"phase":"created"}}
        })).unwrap();
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        stopped.resources.get_mut("container:web").unwrap().phase = "absent".into();
        let selection: Selection = serde_json::from_value(json!({
            "version":1,"candidate":root,"run":original.run,"owner":original.owner,
            "namespace":original.namespace,"plan":original.plan_id,
            "original_owner_path":"/private/owner","original_owner_sha256":"1".repeat(64),
            "filesystem_inspection_path":"/private/inspection","filesystem_inspection_sha256":"2".repeat(64),
            "current_owner_sha256":"3".repeat(64),"graph_sha256":digest(&serde_json::to_vec_pretty(&original).unwrap()),
            "host_boot_micros":1,"old_device":2,"new_device":3,"previous_guest_boot":"old","current_guest_boot":"current",
            "foreground_root":"/private/foreground","control_root":"/private/control","source_shared":null,
            "environment_inventory":{},"scoped_bridge_projection":{},"retained_volumes":{},"dependency_reservation":null,"qualification":"test"
        })).unwrap();
        let intent = Intent { version:1,selection_sha256:selection.digest().unwrap(),selection,
            original:original.clone(),environment:json!({}),bridges:serde_json::from_value(json!({
                "version":1,"owner":original.owner,"boot":"current","run":original.run,"plan":original.plan_id,"capacity":1,"serial":1,"selected":{}
            })).unwrap(),prior_bridges:None,complete_sha256:Some(digest(&serde_json::to_vec_pretty(&stopped).unwrap())) };
        state::write(&root.join(INTENT), &intent).unwrap();
        state::write(
            &root.join(RETIREMENT),
            &Retirement {
                version: 1,
                selection_sha256: intent.selection_sha256.clone(),
                complete_sha256: intent.complete_sha256.clone().unwrap(),
                owner: original.owner.clone(),
                run: original.run.clone(),
            },
        )
        .unwrap();
        for generation in 1..=12 {
            let mut newer = stopped.clone();
            newer.resources.get_mut("container:web").unwrap().id =
                Some(format!("{generation:064x}"));
            crate::provider::graph::restore_history::retain(root, &newer).unwrap();
        }
        let mut current = stopped.clone();
        current.resources.get_mut("container:web").unwrap().id = Some("f".repeat(64));
        let mut ready = current.clone();
        ready.phase = "ready-observed".into();
        ready.resources.get_mut("container:web").unwrap().phase = "started".into();
        state::write(&root.join("state.json"), &current).unwrap();
        state::write(&root.join("live-owner-cleanup.json"), &json!({
            "version":1,"boot":"current","original":ready,
            "original_sha256":digest(&serde_json::to_vec_pretty(&ready).unwrap()),
            "foreground_sha256":"f".repeat(64),"relay":{"bytes":[],"record_id":[1,1]},
            "environment":{},"bridges":intent.bridges,"prior_bridges":null,
            "listeners_retired":true,"complete_sha256":digest(&serde_json::to_vec_pretty(&current).unwrap())
        })).unwrap();
        let generation = crate::provider::graph::service_exec_generation(&original).unwrap();
        let history = root.join(format!("dependency-rebind-history-{generation}"));
        state::private_directory(&history).unwrap();
        state::write(&history.join("dependency-rebind.json"), &json!({
            "version":1,"operation":"1".repeat(32),"run":original.run,"owner":original.owner,
            "boot":"old","expected_generation":"2".repeat(64),"phase":"completed",
            "slots":{"0":{"before":"3".repeat(64),"after":"4".repeat(64),"bindings":[["web","content"]]}},
            "processes":{},"completed_generation":generation
        })).unwrap();
        state::write(&history.join("proof.json"), &json!({
            "version":1,"run":original.run,"owner":original.owner,"boot":"old",
            "original_generation":generation,
            "cleaned_generation":crate::provider::graph::service_exec_generation(&stopped).unwrap(),
            "artifacts":{"dependency-rebind.json":digest(&fs::read(history.join("dependency-rebind.json")).unwrap())},
            "complete":true
        })).unwrap();
        (fixture, current, intent, history)
    }

    fn retained_bytes(root: &Path, history: &Path) -> Vec<Option<Vec<u8>>> {
        [
            root.join(INTENT),
            root.join(RETIREMENT),
            root.join("state.json"),
            root.join("live-owner-cleanup.json"),
            root.join("restore-history.json"),
            root.join("dependency-rebind.json"),
            root.join("dependency-rebind.pending"),
            history.join("dependency-rebind.json"),
            history.join("proof.json"),
            history.join("proof.pending"),
        ]
        .iter()
        .map(|path| fs::read(path).ok())
        .collect()
    }

    #[test]
    fn completed_archive_is_read_only_after_stopped_receipt_eviction() {
        let (fixture, current, intent, history) = archived_fixture();
        let root = &fixture.0;
        assert!(completion(root, &current, &intent).is_err());
        let before = retained_bytes(root, &history);
        let checks = std::cell::Cell::new(0);
        assert!(
            already_archived(root, &current, &intent, &|| {
                checks.set(checks.get() + 1);
                Ok(())
            })
            .unwrap()
        );
        assert_eq!(checks.get(), 2);
        assert_eq!(retained_bytes(root, &history), before);
    }

    #[test]
    fn retirement_requires_the_original_ready_generation() {
        let (fixture, current, mut intent, history) = archived_fixture();
        let before = retained_bytes(&fixture.0, &history);
        require_retirement(&fixture.0, &current, &intent).unwrap();
        for phase in ["stopped-data-retained", "cleanup-intent", "failed"] {
            intent.original.phase = phase.into();
            assert!(require_retirement(&fixture.0, &current, &intent).is_err());
        }
        assert_eq!(retained_bytes(&fixture.0, &history), before);
    }

    #[test]
    fn first_or_interrupted_archive_keeps_exact_stopped_receipt_requirement() {
        for fault in [
            "missing",
            "incomplete",
            "active",
            "pending",
            "proof-pending",
        ] {
            let (fixture, current, intent, history) = archived_fixture();
            let root = &fixture.0;
            match fault {
                "missing" => fs::remove_file(history.join("proof.json")).unwrap(),
                "incomplete" => {
                    let mut proof: Value = state::read(&history.join("proof.json")).unwrap();
                    proof["complete"] = json!(false);
                    state::write(&history.join("proof.json"), &proof).unwrap();
                }
                "active" => fs::copy(
                    history.join("dependency-rebind.json"),
                    root.join("dependency-rebind.json"),
                )
                .map(|_| ())
                .unwrap(),
                "pending" => {
                    state::write(&root.join("dependency-rebind.pending"), &json!({})).unwrap()
                }
                "proof-pending" => {
                    state::write(&history.join("proof.pending"), &json!({})).unwrap()
                }
                _ => unreachable!(),
            }
            let before = retained_bytes(root, &history);
            assert!(
                !already_archived(root, &current, &intent, &|| Ok(())).unwrap(),
                "{fault}"
            );
            assert!(completion(root, &current, &intent).is_err(), "{fault}");
            assert_eq!(retained_bytes(root, &history), before);
        }
    }

    #[test]
    fn archive_noop_refuses_changed_proofs_or_unconfirmed_current_cleanup() {
        for fault in [
            "proof-owner",
            "proof-boot",
            "proof-generation",
            "proof-hash",
            "journal-phase",
            "journal-generation",
            "current-owner",
            "current-state",
            "retirement",
            "live-incomplete",
            "live-digest",
            "pending",
            "lock",
        ] {
            let (fixture, mut current, intent, history) = archived_fixture();
            let root = &fixture.0;
            match fault {
                "proof-owner" | "proof-boot" | "proof-generation" | "proof-hash" => {
                    let mut proof: Value = state::read(&history.join("proof.json")).unwrap();
                    match fault {
                        "proof-owner" => proof["owner"] = json!("9".repeat(32)),
                        "proof-boot" => proof["boot"] = json!("foreign"),
                        "proof-generation" => proof["original_generation"] = json!("9".repeat(64)),
                        _ => proof["artifacts"]["dependency-rebind.json"] = json!("9".repeat(64)),
                    }
                    state::write(&history.join("proof.json"), &proof).unwrap();
                }
                "journal-phase" | "journal-generation" => {
                    let mut journal: Value =
                        state::read(&history.join("dependency-rebind.json")).unwrap();
                    if fault == "journal-phase" {
                        journal["phase"] = json!("intent");
                    } else {
                        journal["completed_generation"] = json!("9".repeat(64));
                    }
                    state::write(&history.join("dependency-rebind.json"), &journal).unwrap();
                    let mut proof: Value = state::read(&history.join("proof.json")).unwrap();
                    proof["artifacts"]["dependency-rebind.json"] = json!(digest(
                        &fs::read(history.join("dependency-rebind.json")).unwrap()
                    ));
                    state::write(&history.join("proof.json"), &proof).unwrap();
                }
                "current-owner" => {
                    current.owner = "9".repeat(32);
                    state::write(&root.join("state.json"), &current).unwrap();
                }
                "current-state" => {
                    let mut changed = current.clone();
                    changed.resources.get_mut("container:web").unwrap().id = Some("9".repeat(64));
                    state::write(&root.join("state.json"), &changed).unwrap();
                }
                "retirement" => {
                    let mut retirement: Value = state::read(&root.join(RETIREMENT)).unwrap();
                    retirement["complete_sha256"] = json!("9".repeat(64));
                    state::write(&root.join(RETIREMENT), &retirement).unwrap();
                }
                "live-incomplete" | "live-digest" => {
                    let mut live: Value =
                        state::read(&root.join("live-owner-cleanup.json")).unwrap();
                    if fault == "live-incomplete" {
                        live["complete_sha256"] = Value::Null;
                    } else {
                        live["original_sha256"] = json!("9".repeat(64));
                    }
                    state::write(&root.join("live-owner-cleanup.json"), &live).unwrap();
                }
                "pending" => {
                    state::write(&root.join("live-owner-cleanup.pending"), &json!({})).unwrap()
                }
                "lock" => {}
                _ => unreachable!(),
            }
            let before = retained_bytes(root, &history);
            let checks = std::cell::Cell::new(0);
            assert!(
                already_archived(root, &current, &intent, &|| {
                    checks.set(checks.get() + 1);
                    if fault == "lock" && checks.get() == 2 {
                        Err(refused())
                    } else {
                        Ok(())
                    }
                })
                .is_err(),
                "{fault}"
            );
            assert_eq!(retained_bytes(root, &history), before);
        }
    }

    #[test]
    fn archive_noop_rechecks_evidence_after_final_lock_verification() {
        for fault in ["current-state", "current-cleanup", "archive", "pending"] {
            let (fixture, current, intent, history) = archived_fixture();
            let root = &fixture.0;
            let checks = std::cell::Cell::new(0);
            let expected = std::cell::RefCell::new(retained_bytes(root, &history));
            assert!(
                already_archived(root, &current, &intent, &|| {
                    checks.set(checks.get() + 1);
                    if checks.get() == 2 {
                        match fault {
                            "current-state" => {
                                let mut changed = current.clone();
                                changed.resources.get_mut("container:web").unwrap().id =
                                    Some("9".repeat(64));
                                state::write(&root.join("state.json"), &changed).unwrap();
                            }
                            "current-cleanup" => {
                                let mut live: Value =
                                    state::read(&root.join("live-owner-cleanup.json")).unwrap();
                                live["complete_sha256"] = Value::Null;
                                state::write(&root.join("live-owner-cleanup.json"), &live).unwrap();
                            }
                            "archive" => {
                                let mut proof: Value =
                                    state::read(&history.join("proof.json")).unwrap();
                                proof["complete"] = json!(false);
                                state::write(&history.join("proof.json"), &proof).unwrap();
                            }
                            "pending" => {
                                state::write(&root.join("dependency-rebind.pending"), &json!({}))
                                    .unwrap()
                            }
                            _ => unreachable!(),
                        }
                        *expected.borrow_mut() = retained_bytes(root, &history);
                    }
                    Ok(())
                })
                .is_err(),
                "{fault}"
            );
            assert_eq!(checks.get(), 2);
            assert_eq!(retained_bytes(root, &history), *expected.borrow());
        }
    }

    #[test]
    fn historical_completion_requires_exact_stopped_digest_and_retirement() {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let root = &fixture.0;
        let original: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),
            "plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},
            "resources":{"container:web":{"kind":"container","key":"web","name":"owned-web","id":"e".repeat(64),"image":null,"phase":"present"},
                "volume:data":{"kind":"volume","key":"data","name":"owned-data","id":null,"image":null,"phase":"present"}}
        })).unwrap();
        let mut stopped = original.clone();
        stopped.phase = "stopped-data-retained".into();
        stopped.resources.get_mut("container:web").unwrap().phase = "absent".into();
        let mut current = stopped.clone();
        current.resources.get_mut("container:web").unwrap().id = Some("f".repeat(64));
        let selection: Selection = serde_json::from_value(json!({
            "version":1,"candidate":root,"run":original.run,"owner":original.owner,
            "namespace":original.namespace,"plan":original.plan_id,
            "original_owner_path":"/private/owner","original_owner_sha256":"1".repeat(64),
            "filesystem_inspection_path":"/private/inspection","filesystem_inspection_sha256":"2".repeat(64),
            "current_owner_sha256":"3".repeat(64),"graph_sha256":digest(&serde_json::to_vec_pretty(&original).unwrap()),
            "host_boot_micros":1,"old_device":2,"new_device":3,"previous_guest_boot":"old","current_guest_boot":"current",
            "foreground_root":"/private/foreground","control_root":"/private/control","source_shared":null,
            "environment_inventory":{},"scoped_bridge_projection":{},"retained_volumes":{},"dependency_reservation":null,"qualification":"test"
        })).unwrap();
        let intent = Intent { version:1,selection_sha256:selection.digest().unwrap(),selection,
            original:original.clone(),environment:json!({}),bridges:serde_json::from_value(json!({
                "version":1,"owner":original.owner,"boot":"current","run":original.run,"plan":original.plan_id,"capacity":1,"serial":1,"selected":{}
            })).unwrap(),prior_bridges:None,complete_sha256:Some(digest(&serde_json::to_vec_pretty(&stopped).unwrap())) };
        let retirement = Retirement {
            version: 1,
            selection_sha256: intent.selection_sha256.clone(),
            complete_sha256: intent.complete_sha256.clone().unwrap(),
            owner: current.owner.clone(),
            run: current.run.clone(),
        };
        state::write(&root.join(RETIREMENT), &retirement).unwrap();
        assert!(completion(root, &current, &intent).is_err());
        crate::provider::graph::restore_history::retain(root, &stopped).unwrap();
        assert_eq!(
            serde_json::to_vec(&completion(root, &current, &intent).unwrap()).unwrap(),
            serde_json::to_vec(&stopped).unwrap()
        );
        for change in 0..4 {
            let mut changed = current.clone();
            match change {
                0 => changed.owner = "0".repeat(32),
                1 => changed.plan_id = "0".repeat(64),
                2 => changed.phase = "ready-observed".into(),
                _ => changed.resources.get_mut("volume:data").unwrap().name = "foreign-data".into(),
            }
            assert!(completion(root, &changed, &intent).is_err());
        }
        let mut changed = retirement.clone();
        changed.selection_sha256 = "0".repeat(64);
        state::write(&root.join(RETIREMENT), &changed).unwrap();
        assert!(completion(root, &current, &intent).is_err());
        state::write(&root.join(RETIREMENT), &retirement).unwrap();
        let mut changed = intent.clone();
        changed.complete_sha256 = Some("0".repeat(64));
        assert!(completion(root, &current, &changed).is_err());
        let mut changed = intent.clone();
        changed
            .original
            .resources
            .get_mut("container:web")
            .unwrap()
            .id = Some("0".repeat(64));
        assert!(completion(root, &current, &changed).is_err());
    }
}
