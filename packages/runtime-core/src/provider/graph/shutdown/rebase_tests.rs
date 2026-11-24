use super::super::{restore_history, tests::Fixture};
use super::*;

fn receipt() -> Receipt {
    let (mut resource, _) = super::tests::fixture();
    resource.phase = "absent".into();
    Receipt {
        started_from: None,
        normalized_input: None,
        relay_startup: None,
        relay_cleanup: None,
        version: 1,
        run: "a".repeat(32),
        owner: "b".repeat(32),
        namespace: "c".repeat(64),
        plan_id: "d".repeat(64),
        phase: "stopped-data-retained".into(),
        environment_attached: false,
        startup_failure: None,
        initializer_cache_release: BTreeMap::new(),
        source: None,
        readiness: BTreeMap::new(),
        probes: BTreeMap::new(),
        resources: BTreeMap::from([("container:service".into(), resource)]),
    }
}
fn evidence(receipt: &Receipt) -> Evidence {
    Evidence {
        version: 1,
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        plan: receipt.plan_id.clone(),
        containers: BTreeMap::from([(
            "container:service".into(),
            Terminal {
                id: "a".repeat(64),
                exit_code: 137,
                oom_killed: false,
                stop_requested: true,
            },
        )]),
    }
}

fn unacknowledged_create(resource_phase: &str) -> Receipt {
    let mut value = receipt();
    value.set_phase("cleanup-intent");
    value
        .readiness
        .insert("service".into(), super::super::Condition::Started);
    let resource = value.resources.get_mut("container:service").unwrap();
    resource.name = format!("hkg-{}-container-0", value.run);
    resource.id = None;
    resource.phase = resource_phase.into();
    value.resources.insert(
        "volume:data".into(),
        serde_json::from_value(serde_json::json!({
            "kind": "volume", "key": "data", "name": format!("hkg-{}-volume-0", value.run),
            "id": null, "image": null, "phase": "created"
        }))
        .unwrap(),
    );
    value
}

fn observe_created(receipt: &Receipt) -> BTreeMap<String, Terminal> {
    let resource = &receipt.resources["container:service"];
    let (_, mut value) = super::tests::fixture();
    value["Name"] = Value::String(resource.name.clone());
    value["Image"] = serde_json::to_value(&resource.image).unwrap();
    value["Config"]["Labels"] = super::super::expected_labels(receipt, resource);
    value["State"]["Status"] = "created".into();
    value["State"]["Running"] = false.into();
    value["State"]["Pid"] = 0.into();
    super::super::verify_resource_identity(receipt, resource, &value).unwrap();
    BTreeMap::from([(
        "container:service".into(),
        terminal(resource, &value, false).unwrap(),
    )])
}

fn finish_cleanup(root: &Path, receipt: &mut Receipt) {
    receipt
        .resources
        .get_mut("container:service")
        .unwrap()
        .phase = "absent".into();
    receipt.set_phase("stopped-data-retained");
    state::write(&root.join("state.json"), receipt).unwrap();
}

#[test]
fn observed_create_cleanup_retries_each_commit_boundary() {
    // Fence calls bracket the synced receipt rename, the gap between commits,
    // and the synced shutdown rename. With no interruption, simulate a crash
    // after shutdown and deletion but before the final stopped receipt commit.
    for resource_phase in ["create-intent", "uncertain"] {
        for (cut, recorded_id, receipt_pending, shutdown_pending, committed_stop) in [
            (1, false, true, false, false),
            (2, true, false, false, false),
            (3, true, false, true, false),
            (4, true, false, false, true),
        ] {
            let fixture = Fixture::new();
            let root = &fixture.0;
            let path = root.join("state.json");
            let mut attempt = unacknowledged_create(resource_phase);
            let data = serde_json::to_value(&attempt.resources["volume:data"]).unwrap();
            state::write(&path, &attempt).unwrap();
            let observed = observe_created(&attempt);
            let id = &observed["container:service"].id;
            let committed = begin_stop(root, &attempt).unwrap();
            let calls = std::cell::Cell::new(0);
            let result = publish_stop(root, &mut attempt, committed, observed.clone(), &|| {
                calls.set(calls.get() + 1);
                if calls.get() == cut {
                    return Err(error("test_crash", "Interrupted shutdown publication."));
                }
                Ok(())
            });
            if cut == 4 {
                result.unwrap();
            } else {
                assert_eq!(result.unwrap_err().code, "test_crash");
            }

            let (mut retry, _) =
                super::super::load_at(root.clone(), &attempt.run, &attempt.owner).unwrap();
            assert_eq!(
                retry.resources["container:service"].id.as_ref(),
                recorded_id.then_some(id)
            );
            assert_eq!(root.join(RECEIPT_PENDING).exists(), receipt_pending);
            assert_eq!(root.join("shutdown.pending").exists(), shutdown_pending);
            assert_eq!(root.join("shutdown.json").exists(), committed_stop);
            assert_eq!(
                rebase_stopped_with(root, &retry, |_, _| Ok(true))
                    .unwrap_err()
                    .code,
                "graph_shutdown_uncertain"
            );

            let committed = begin_stop(root, &retry).unwrap();
            assert!(!root.join(RECEIPT_PENDING).exists());
            assert!(!root.join("shutdown.pending").exists());
            if receipt_pending {
                assert!(
                    root.join("shutdown-receipt-recovery-1/interrupted.pending")
                        .is_file()
                );
            }
            if shutdown_pending {
                assert!(
                    root.join("shutdown-recovery-1/interrupted.pending")
                        .is_file()
                );
            }
            let reobserved = if committed_stop {
                // Removal completed, then the final state.json write tore. The
                // ordinary journal reconciliation preserves the committed ID.
                retry.set_phase("reconciled-cleanup-only");
                state::write(&path, &retry).unwrap();
                (retry, _) =
                    super::super::load_at(root.clone(), &attempt.run, &attempt.owner).unwrap();
                retry.set_phase("cleanup-intent");
                BTreeMap::new()
            } else {
                observe_created(&retry)
            };
            publish_stop(root, &mut retry, committed, reobserved, &|| Ok(())).unwrap();
            finish_cleanup(root, &mut retry);
            let stopped: Receipt = state::read(&path).unwrap();
            assert_eq!(stopped.resources["container:service"].id.as_ref(), Some(id));
            let stop: Evidence = state::read(&root.join("shutdown.json")).unwrap();
            assert_eq!(&stop.containers["container:service"].id, id);
            assert_eq!(
                serde_json::to_value(&stopped.resources["volume:data"]).unwrap(),
                data
            );
            rebase_stopped_with(root, &stopped, |_, _| {
                panic!("ID was recorded in the receipt")
            })
            .unwrap();
        }
    }
}

#[test]
fn observed_create_restore_accepts_exact_id_and_refuses_replaced_id() {
    for resource_phase in ["create-intent", "uncertain"] {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let mut receipt = unacknowledged_create(resource_phase);
        let observed = observe_created(&receipt);
        let committed = begin_stop(root, &receipt).unwrap();
        publish_stop(root, &mut receipt, committed, observed, &|| Ok(())).unwrap();
        finish_cleanup(root, &mut receipt);

        let mut replaced = receipt.clone();
        replaced.resources.get_mut("container:service").unwrap().id = Some("f".repeat(64));
        restore_history::retain(root, &replaced).unwrap();
        assert_eq!(
            rebase_stopped_with(root, &replaced, |_, _| Ok(true))
                .unwrap_err()
                .code,
            "graph_shutdown_uncertain"
        );
        assert!(!root.join("shutdown-history.json").exists());

        restore_history::retain(root, &receipt).unwrap();
        rebase_stopped_with(root, &receipt, |_, _| {
            panic!("exact ID needs no historical fallback")
        })
        .unwrap();
    }
}

#[test]
fn observed_create_advances_cleanup_selection_without_replacing_a_selected_id() {
    use super::super::cleanup_enrollment::matches_cleanup_progress;
    let fixture = Fixture::new();
    let root = &fixture.0;
    let original = unacknowledged_create("uncertain");
    let mut current = original.clone();
    publish_stop(
        root,
        &mut current,
        begin_stop(root, &original).unwrap(),
        observe_created(&original),
        &|| Ok(()),
    )
    .unwrap();
    assert!(matches_cleanup_progress(&original, &current).unwrap());
    finish_cleanup(root, &mut current);
    assert!(matches_cleanup_progress(&original, &current).unwrap());
    let before = &original.resources["container:service"];
    let after = &current.resources["container:service"];
    assert!(before.matches_cleanup_id(after, &current.phase));

    let mut different = current.clone();
    different.resources.get_mut("container:service").unwrap().id = Some("f".repeat(64));
    assert!(!matches_cleanup_progress(&current, &different).unwrap());
    let mut with_known_id = original.clone();
    with_known_id
        .resources
        .get_mut("container:service")
        .unwrap()
        .id = Some("f".repeat(64));
    assert!(!matches_cleanup_progress(&with_known_id, &current).unwrap());
    assert!(
        !with_known_id.resources["container:service"].matches_cleanup_id(after, &current.phase)
    );
}

#[test]
fn removed_and_recreated_services_do_not_inherit_shutdown_claims() {
    let fixture = Fixture::new();
    let old = receipt();
    let prior = evidence(&old);
    state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
    restore_history::retain(&fixture.0, &old).unwrap();
    rebase_stopped_with(&fixture.0, &old, |_, _| Ok(true)).unwrap();
    // A crash before receipt publication retries the same acknowledged generation.
    rebase_stopped_with(&fixture.0, &old, |_, _| Ok(true)).unwrap();
    let fresh: Evidence = state::read(&fixture.0.join("shutdown.json")).unwrap();
    assert!(fresh.containers.is_empty());
    let history: Vec<Evidence> = state::read(&fixture.0.join("shutdown-history.json")).unwrap();
    assert_eq!(history.len(), 1);
    assert!(history[0] == prior);
    let mut next = old.clone();
    next.resources.clear();
    assert!(validate_current(&prior, &next).is_err());
    validate_current(&fresh, &next).unwrap();
    let mut fresh_terminal = prior.containers["container:service"].clone();
    fresh_terminal.id = "e".repeat(64);
    fresh_terminal.stop_requested = false;
    let mut recorded = fresh;
    record(&mut recorded, "container:service".into(), fresh_terminal);
    assert!(!recorded.containers["container:service"].stop_requested);
    // The new observation replaces only current evidence, not the retired exit.
    assert_eq!(history[0].containers["container:service"].exit_code, 137);
}

#[test]
fn rebase_refuses_unknown_or_unsettled_evidence_without_writes() {
    for change in ["foreign", "unknown", "generation", "present"] {
        let fixture = Fixture::new();
        let mut old = receipt();
        let mut prior = evidence(&old);
        match change {
            "foreign" => prior.owner = "f".repeat(32),
            "unknown" => old.resources.clear(),
            "generation" => {
                old.resources.get_mut("container:service").unwrap().id = Some("e".repeat(64))
            }
            "present" => {
                old.resources.get_mut("container:service").unwrap().phase = "started".into()
            }
            _ => unreachable!(),
        }
        state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
        assert!(
            rebase_stopped_with(&fixture.0, &old, |_, _| Ok(true)).is_err(),
            "{change}"
        );
        assert!(!fixture.0.join("shutdown-history.json").exists());
    }
}

#[test]
fn explicit_repair_requires_history_exact_identity_and_fresh_absence() {
    let fixture = Fixture::new();
    let old = receipt();
    let prior = evidence(&old);
    state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
    let mut current = old.clone();
    current.phase = "cleanup-intent".into();
    current.resources.clear();
    assert!(rebase_selection_with(&fixture.0, &current, |_, _| Ok(true)).is_err());
    restore_history::retain(&fixture.0, &old).unwrap();
    assert!(rebase_selection_with(&fixture.0, &current, |_, _| Ok(false)).is_err());
    assert!(rebase_selection_with(&fixture.0, &current, |_, _| Err(refused())).is_err());
    let (selection, before, next) = rebase_selection_with(&fixture.0, &current, |_, resource| {
        assert_eq!(resource.id.as_deref(), Some("a".repeat(64).as_str()));
        Ok(true)
    })
    .unwrap();
    assert!(hex(&selection, 64));
    assert!(before == prior);
    assert!(next.containers.is_empty());
    // Read-only selection cannot erase the evidence that stopped cleanup.
    let unchanged: Evidence = state::read(&fixture.0.join("shutdown.json")).unwrap();
    assert!(unchanged == prior);
    current.resources = old.resources.clone();
    current.resources.get_mut("container:service").unwrap().id = Some("e".repeat(64));
    let (changed, _, _) = rebase_selection_with(&fixture.0, &current, |_, _| Ok(true)).unwrap();
    assert_ne!(selection, changed);
    // A current matching instance never takes the stale-evidence repair path.
    current.resources = old.resources.clone();
    assert!(
        rebase_selection_with(&fixture.0, &current, |_, _| panic!(
            "current ID must not be pruned"
        ))
        .is_err()
    );
}

#[test]
fn shutdown_history_is_bounded_and_retries_do_not_duplicate() {
    let fixture = Fixture::new();
    let mut old = receipt();
    for index in 1..=12 {
        let mut prior = evidence(&old);
        prior.containers.get_mut("container:service").unwrap().id = format!("{index:064x}");
        old.resources.get_mut("container:service").unwrap().id = Some(format!("{index:064x}"));
        state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
        rebase_stopped_with(&fixture.0, &old, |_, _| Ok(true)).unwrap();
        rebase_stopped_with(&fixture.0, &old, |_, _| Ok(true)).unwrap();
    }
    let history: Vec<Evidence> = state::read(&fixture.0.join("shutdown-history.json")).unwrap();
    assert_eq!(history.len(), 8);
    assert_eq!(
        history[0].containers["container:service"].id,
        format!("{:064x}", 5)
    );
}

#[test]
fn explicit_repair_admits_only_unchanged_receipt_and_empty_committed_evidence() {
    let fixture = Fixture::new();
    let mut current = receipt();
    current.phase = "cleanup-intent".into();
    let before = evidence(&current);
    let after = Evidence {
        containers: BTreeMap::new(),
        ..before.clone()
    };
    let selection = "e".repeat(64);
    let proof = RebaseProof {
        version: 1,
        selection: selection.clone(),
        receipt: digest(&current).unwrap(),
        evidence: digest(&after).unwrap(),
    };
    state::write(&fixture.0.join("shutdown-rebase.json"), &proof).unwrap();
    state::write(&fixture.0.join("shutdown.json"), &before).unwrap();
    assert!(
        !repaired(&fixture.0, &current).unwrap(),
        "proof publication alone cannot admit cleanup"
    );
    replace(&fixture.0, &before, &after, &current).unwrap();
    assert!(repaired(&fixture.0, &current).unwrap());
    assert_eq!(
        repaired_selection(&fixture.0, &current).unwrap(),
        Some(selection)
    );
    current.resources.get_mut("container:service").unwrap().id = Some("f".repeat(64));
    assert!(!repaired(&fixture.0, &current).unwrap());
    current = receipt();
    current.phase = "cleanup-intent".into();
    state::write(
        &fixture.0.join("shutdown.pending"),
        &serde_json::json!({"torn":true}),
    )
    .unwrap();
    assert!(repaired(&fixture.0, &current).is_err());
    assert!(
        repaired_selection_with(&fixture.0, &current, true)
            .unwrap()
            .is_some()
    );
    retain_rebase_pending(&fixture.0).unwrap();
    assert!(repaired(&fixture.0, &current).unwrap());
}

#[test]
fn stopped_upgrade_rebases_surviving_key_with_older_id_only_after_history_and_absence() {
    for current_id in [None, Some("b".repeat(64))] {
        let fixture = Fixture::new();
        let old = receipt();
        let prior = evidence(&old);
        restore_history::retain(&fixture.0, &old).unwrap();
        let mut current = old.clone();
        current.resources.get_mut("container:service").unwrap().id = current_id;
        restore_history::retain(&fixture.0, &current).unwrap();
        state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
        for failure in [false, true] {
            assert!(
                rebase_stopped_with(&fixture.0, &current, |_, _| {
                    if failure { Err(refused()) } else { Ok(false) }
                })
                .is_err()
            );
            let unchanged: Evidence = state::read(&fixture.0.join("shutdown.json")).unwrap();
            assert!(unchanged == prior);
        }
        rebase_stopped_with(&fixture.0, &current, |_, resource| {
            assert_eq!(resource.id.as_deref(), Some("a".repeat(64).as_str()));
            Ok(true)
        })
        .unwrap();
        let current_evidence: Evidence = state::read(&fixture.0.join("shutdown.json")).unwrap();
        validate_current(&current_evidence, &current).unwrap();
        assert!(current_evidence.containers.is_empty());
    }
}

#[test]
fn explicit_repair_inspects_committed_state_then_retains_torn_pending_bytes() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let fixture = Fixture::new();
    let old = receipt();
    restore_history::retain(&fixture.0, &old).unwrap();
    let prior = evidence(&old);
    state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
    let mut current = old.clone();
    current.phase = "cleanup-intent".into();
    current.resources.clear();
    let pending = fixture.0.join("shutdown.pending");
    fs::write(&pending, b"{torn").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
    let (_, before, next) = rebase_selection_with(&fixture.0, &current, |_, _| Ok(true)).unwrap();
    assert!(pending_rebase(&fixture.0));
    assert_eq!(
        fs::read(&pending).unwrap(),
        b"{torn",
        "inspection preserves pending bytes"
    );
    retain_rebase_pending(&fixture.0).unwrap();
    assert!(!pending.exists());
    assert_eq!(
        fs::read(fixture.0.join("shutdown-recovery-1/interrupted.pending")).unwrap(),
        b"{torn"
    );
    replace(&fixture.0, &before, &next, &current).unwrap();
    let committed: Evidence = state::read(&fixture.0.join("shutdown.json")).unwrap();
    assert!(committed.containers.is_empty());
}
