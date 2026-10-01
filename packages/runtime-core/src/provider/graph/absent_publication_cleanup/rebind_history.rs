//! Metadata retirement for a completed prior-boot rebind. Historical receipts
//! select preserved evidence only; current ownership and live absence still
//! fence every archive write/rename under the caller's foreground lock.
use super::*;

fn completion(root: &Path, current: &Receipt, intent: &Intent) -> Result<Receipt, CandidateError> {
    let complete = intent.complete_sha256.as_deref().ok_or_else(refused)?;
    let retirement: Retirement = state::read_bounded(&root.join(RETIREMENT), 65536)?;
    if retirement.version != 1
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
