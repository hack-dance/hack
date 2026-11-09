use super::super::{restore_history, tests::Fixture};
use super::*;

fn receipt() -> Receipt {
    let (mut resource, _) = super::tests::fixture();
    resource.phase = "absent".into();
    Receipt {
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

#[test]
fn removed_and_recreated_services_do_not_inherit_shutdown_claims() {
    let fixture = Fixture::new();
    let old = receipt();
    let prior = evidence(&old);
    state::write(&fixture.0.join("shutdown.json"), &prior).unwrap();
    restore_history::retain(&fixture.0, &old).unwrap();
    rebase_stopped(&fixture.0, &old).unwrap();
    // A crash before receipt publication retries the same acknowledged generation.
    rebase_stopped(&fixture.0, &old).unwrap();
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
        assert!(rebase_stopped(&fixture.0, &old).is_err(), "{change}");
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
        rebase_stopped(&fixture.0, &old).unwrap();
        rebase_stopped(&fixture.0, &old).unwrap();
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
}
