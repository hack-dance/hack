//! Retained bridge selection survives registry release and graph archival.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    version: u8,
    owner: String,
    boot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_boot: Option<String>,
    run: String,
    plan: String,
    capacity: u8,
    serial: u64,
    selected: BTreeMap<u8, Selected>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selected {
    assignment: Assignment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    helper: Option<relay::CleanupEvidence>,
}

fn strict_store(candidate: &Candidate, engine: &Engine<'_>) -> Result<Store, CandidateError> {
    let directory = root(candidate);
    match fs::symlink_metadata(directory.join("state.pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(invalid()),
    }
    // An enabled pool's lost registry is unknown, not evidence of an empty pool.
    if let Some(intent) = engine.guest().bridge_intent() {
        state::check_private_directory(&directory)?;
        let store: Store = state::read_bounded(&directory.join("state.json"), 65536)?;
        validate(&store, engine.guest().incarnation(), intent.slots)?;
        return Ok(store);
    }
    load_store(candidate, engine, false)
}

fn validate_selection(
    engine: &Engine<'_>,
    receipt: &Receipt,
    selection: &Selection,
) -> Result<(), CandidateError> {
    let capacity = engine.guest().bridge_intent().map_or(0, |v| v.slots);
    if selection.version != 1
        || selection.owner != engine.guest().incarnation()
        || selection.boot != engine.guest().boot_id()
        || selection.run != receipt.run
        || selection.plan != receipt.plan_id
        || selection.capacity != capacity
    {
        return Err(invalid());
    }
    let previous = if selection.previous_boot.is_some() {
        crate::provider::state::Owner::load(engine.guest().candidate())?.previous_guest_boot_id
    } else {
        None
    };
    validate_bindings(receipt, selection, previous.as_deref())
}

fn validate_bindings(
    receipt: &Receipt,
    selection: &Selection,
    previous_boot: Option<&str>,
) -> Result<(), CandidateError> {
    if let Some(previous) = &selection.previous_boot {
        if previous == &selection.boot
            || previous_boot != Some(previous.as_str())
            || selection.selected.is_empty()
        {
            return Err(invalid());
        }
    }
    let store = Store {
        version: 1,
        owner: selection.owner.clone(),
        next_launch_serial: selection.serial,
        slots: selection
            .selected
            .iter()
            .map(|(slot, v)| (*slot, v.assignment.clone()))
            .collect(),
    };
    validate(&store, &selection.owner, selection.capacity)?;
    for selected in selection.selected.values() {
        let a = &selected.assignment;
        if a.run != receipt.run
            || a.boot_id != *selection.previous_boot.as_ref().unwrap_or(&selection.boot)
            || a.phase != "running"
            || match (&selection.previous_boot, &selected.helper) {
                (None, Some(helper)) => !helper.valid(),
                (Some(_), None) => false,
                _ => true,
            }
            || !receipt
                .resources
                .get(&format!("container:{}", a.service))
                .is_some_and(|r| r.id.as_deref() == Some(a.container_id.as_str()))
            || !receipt
                .resources
                .values()
                .any(|r| r.kind == Kind::Network && r.id.as_deref() == Some(a.network_id.as_str()))
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn capture(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<Selection, CandidateError> {
    let store = strict_store(candidate, engine)?;
    let mut selection = Selection {
        version: 1,
        owner: engine.guest().incarnation().into(),
        boot: engine.guest().boot_id().into(),
        previous_boot: None,
        run: receipt.run.clone(),
        plan: receipt.plan_id.clone(),
        capacity: engine.guest().bridge_intent().map_or(0, |v| v.slots),
        serial: store.next_launch_serial,
        selected: BTreeMap::new(),
    };
    for (slot, a) in store.slots.iter().filter(|(_, a)| a.run == receipt.run) {
        if a.phase != "running" {
            return Err(invalid());
        }
        let helper = relay::capture_cleanup(engine, *slot, a)?;
        selection.selected.insert(
            *slot,
            Selected {
                assignment: a.clone(),
                helper: Some(helper),
            },
        );
    }
    validate_selection(engine, receipt, &selection)?;
    Ok(selection)
}

/// Explicit dead-owner recovery only: guest helper absence follows the audited
/// immediate boot transition, never a fabricated live-helper observation.
pub(crate) fn capture_previous_boot(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    previous: &str,
) -> Result<Selection, CandidateError> {
    let store = strict_store(candidate, engine)?;
    let selection = Selection {
        version: 1,
        owner: engine.guest().incarnation().into(),
        boot: engine.guest().boot_id().into(),
        previous_boot: Some(previous.into()),
        run: receipt.run.clone(),
        plan: receipt.plan_id.clone(),
        capacity: engine.guest().bridge_intent().map_or(0, |v| v.slots),
        serial: store.next_launch_serial,
        selected: store
            .slots
            .into_iter()
            .filter(|(_, a)| a.run == receipt.run)
            .map(|(slot, assignment)| {
                (
                    slot,
                    Selected {
                        assignment,
                        helper: None,
                    },
                )
            })
            .collect(),
    };
    validate_selection(engine, receipt, &selection)?;
    Ok(selection)
}

/// Pending recovery may resume only the exact remaining reservations. Released
/// slots may be absent; a replacement or new reservation is never adopted.
pub(crate) fn verify_remaining(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    selection: &Selection,
) -> Result<(), CandidateError> {
    validate_selection(engine, receipt, selection)?;
    if selection.previous_boot.is_none() {
        return Ok(());
    }
    let store = strict_store(candidate, engine)?;
    remaining_matches(&store, receipt, selection)
}
fn remaining_matches(
    store: &Store,
    receipt: &Receipt,
    selection: &Selection,
) -> Result<(), CandidateError> {
    if store.next_launch_serial < selection.serial {
        return Err(invalid());
    }
    for (slot, assignment) in &store.slots {
        if assignment.run == receipt.run || selection.selected.contains_key(slot) {
            let expected = selection.selected.get(slot).ok_or_else(invalid)?;
            let mut observed = assignment.clone();
            if !["running", "stopped"].contains(&observed.phase.as_str()) {
                return Err(invalid());
            }
            observed.phase = expected.assignment.phase.clone();
            if observed != expected.assignment {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn selection_path(root: &std::path::Path) -> Result<PathBuf, CandidateError> {
    state::check_private_directory(root)?;
    let path = root.join("relay-cleanup-bridges.json");
    match fs::symlink_metadata(path.with_extension("pending")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
        _ => Err(invalid()),
    }
}

/// Call only after Coordinator::begin_graph admits a new operation and before effects.
/// Its lock prevents replacing evidence for an unfinished earlier operation.
pub(crate) fn persist(root: &std::path::Path, selection: &Selection) -> Result<(), CandidateError> {
    if serde_json::to_vec_pretty(selection)
        .map_err(|_| invalid())?
        .len()
        > 65536
    {
        return Err(invalid());
    }
    state::write(&selection_path(root)?, selection)
}

/// Recover selection publication only while the caller retains both the VM lease
/// and an Intent-phase Coordinator whose effect matches a freshly captured selection.
/// Interrupted bytes are retained as evidence, never promoted into effect authority.
pub(crate) fn recover_persist(
    root: &std::path::Path,
    selection: &Selection,
) -> Result<(), CandidateError> {
    // Match the actual pretty-encoded writer size before retaining or replacing files.
    if serde_json::to_vec_pretty(selection)
        .map_err(|_| invalid())?
        .len()
        > 65536
    {
        return Err(invalid());
    }
    journal::retain_file(
        root,
        "relay-cleanup-bridges.pending",
        "relay-cleanup-bridges-recovery",
        65536,
    )?;
    persist(root, selection)
}

pub(crate) fn read(
    engine: &Engine<'_>,
    receipt: &Receipt,
    root: &std::path::Path,
) -> Result<Selection, CandidateError> {
    let selection = state::read_bounded(&selection_path(root)?, 65536)?;
    validate_selection(engine, receipt, &selection)?;
    Ok(selection)
}

pub(crate) fn verify(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
    selection: &Selection,
) -> Result<(), CandidateError> {
    validate_selection(engine, receipt, selection)?;
    let store = strict_store(candidate, engine)?;
    if store.next_launch_serial < selection.serial
        || store.slots.values().any(|a| a.run == receipt.run)
    {
        return Err(invalid());
    }
    for (slot, selected) in &selection.selected {
        if let Some(helper) = &selected.helper {
            relay::verify_cleanup(engine, *slot, &selected.assignment, helper)?;
        }
    }
    engine.guest().verify()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::graph::tests::Fixture;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn selection(serial: u64) -> Selection {
        Selection {
            version: 1,
            owner: "a".repeat(32),
            boot: "boot".into(),
            previous_boot: None,
            run: "b".repeat(32),
            plan: "c".repeat(64),
            capacity: 0,
            serial,
            selected: BTreeMap::new(),
        }
    }
    #[test]
    fn prior_boot_selection_refuses_mixed_current_foreign_and_replaced_reservations() {
        let mut selection = selection(1);
        selection.boot = "22222222-2222-2222-2222-222222222222".into();
        let previous = "11111111-1111-1111-1111-111111111111";
        selection.previous_boot = Some(previous.into());
        selection.capacity = 2;
        let assignment = Assignment {
            reservation: "d".repeat(32),
            run: selection.run.clone(),
            service: "web".into(),
            generation: "e".repeat(64),
            container_id: "f".repeat(64),
            network_id: "1".repeat(64),
            boot_id: previous.into(),
            phase: "running".into(),
            relay: Some(relay::Relay {
                transport: relay::Transport::ReservationV1,
                launch_serial: 1,
                binary_sha256: "2".repeat(64),
                target_pid: 10,
                target_start: 10,
                port: 8080,
            }),
        };
        selection.selected.insert(
            0,
            Selected {
                assignment: assignment.clone(),
                helper: None,
            },
        );
        let receipt: Receipt = serde_json::from_value(json!({"version":1,"run":selection.run,"owner":selection.owner,"namespace":"3".repeat(64),"plan_id":selection.plan,"phase":"ready-observed","readiness":{"web":"healthy"},"resources":{
            "container:web":{"kind":"container","key":"web","name":"owned","id":assignment.container_id,"image":null,"phase":"started"},
            "network:default":{"kind":"network","key":"default","name":"owned","id":assignment.network_id,"image":null,"phase":"created"}
        }})).unwrap();
        assert!(validate_bindings(&receipt, &selection, Some(previous)).is_ok());
        for boot in [
            selection.boot.as_str(),
            "33333333-3333-3333-3333-333333333333",
        ] {
            let mut changed = selection.clone();
            changed.selected.get_mut(&0).unwrap().assignment.boot_id = boot.into();
            assert!(validate_bindings(&receipt, &changed, Some(previous)).is_err());
        }
        let mut mixed = selection.clone();
        let mut extra = assignment.clone();
        extra.service = "foreign".into();
        extra.reservation = "7".repeat(32);
        extra.boot_id = selection.boot.clone();
        extra.relay.as_mut().unwrap().launch_serial = 2;
        mixed.serial = 2;
        mixed.selected.insert(
            1,
            Selected {
                assignment: extra,
                helper: None,
            },
        );
        assert!(validate_bindings(&receipt, &mixed, Some(previous)).is_err());
        let mut changed_receipt = receipt.clone();
        changed_receipt
            .resources
            .get_mut("container:web")
            .unwrap()
            .id = Some("8".repeat(64));
        assert!(validate_bindings(&changed_receipt, &selection, Some(previous)).is_err());
        assert!(validate_bindings(&receipt, &selection, None).is_err());
        assert!(validate_bindings(&receipt, &selection, Some(&selection.boot)).is_err());
        let mut changed = selection.clone();
        changed.selected.get_mut(&0).unwrap().assignment.run = "9".repeat(32);
        assert!(validate_bindings(&receipt, &changed, Some(previous)).is_err());
        let mut store = Store {
            version: 1,
            owner: selection.owner.clone(),
            next_launch_serial: 1,
            slots: BTreeMap::from([(0, assignment)]),
        };
        assert!(remaining_matches(&store, &receipt, &selection).is_ok());
        store.slots.get_mut(&0).unwrap().reservation = "8".repeat(32);
        assert!(remaining_matches(&store, &receipt, &selection).is_err());
        store.slots.clear();
        assert!(remaining_matches(&store, &receipt, &selection).is_ok());
    }
    fn pending(root: &std::path::Path, bytes: &[u8]) -> PathBuf {
        let path = root.join("relay-cleanup-bridges.pending");
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    #[test]
    fn recovery_creates_missing_selection_and_preserves_untrusted_pending_bytes() {
        let fixture = Fixture::new();
        recover_persist(&fixture.0, &selection(0)).unwrap();
        let committed = fixture.0.join("relay-cleanup-bridges.json");
        let loaded: Selection = state::read(&committed).unwrap();
        assert!(loaded == selection(0));
        let original = b"{truncated,not-authority";
        let partial = pending(&fixture.0, original);
        recover_persist(&fixture.0, &selection(1)).unwrap();
        assert!(!partial.exists());
        assert_eq!(
            fs::read(
                fixture
                    .0
                    .join("relay-cleanup-bridges-recovery-1/interrupted.pending")
            )
            .unwrap(),
            original
        );
        let loaded: Selection = state::read(&committed).unwrap();
        assert!(
            loaded == selection(1),
            "fresh matched selection is persisted instead of pending bytes"
        );
        assert!(
            fixture
                .0
                .join("relay-cleanup-bridges-recovery-1/retention.json")
                .is_file()
        );
    }
    #[test]
    fn recovery_retention_quota_preserves_pending_and_committed_evidence() {
        let fixture = Fixture::new();
        for index in 1..=8 {
            pending(&fixture.0, format!("interrupted-{index}").as_bytes());
            recover_persist(&fixture.0, &selection(index)).unwrap();
        }
        let committed = fixture.0.join("relay-cleanup-bridges.json");
        let previous = fs::read(&committed).unwrap();
        let partial = pending(&fixture.0, b"ninth-interruption");
        assert_eq!(
            recover_persist(&fixture.0, &selection(9)).unwrap_err().code,
            "graph_recovery_retention"
        );
        assert_eq!(fs::read(partial).unwrap(), b"ninth-interruption");
        assert_eq!(fs::read(committed).unwrap(), previous);
        for index in 1..=8 {
            assert_eq!(
                fs::read(fixture.0.join(format!(
                    "relay-cleanup-bridges-recovery-{index}/interrupted.pending"
                )))
                .unwrap(),
                format!("interrupted-{index}").as_bytes()
            );
        }
    }
    #[test]
    fn recovery_refuses_aliased_or_oversized_pending_without_replacing_selection() {
        let fixture = Fixture::new();
        recover_persist(&fixture.0, &selection(0)).unwrap();
        let committed = fixture.0.join("relay-cleanup-bridges.json");
        let previous = fs::read(&committed).unwrap();
        let partial = fixture.0.join("relay-cleanup-bridges.pending");
        symlink(&committed, &partial).unwrap();
        assert!(recover_persist(&fixture.0, &selection(1)).is_err());
        assert!(partial.is_symlink());
        fs::remove_file(&partial).unwrap();
        pending(&fixture.0, &vec![b'x'; 65537]);
        assert!(recover_persist(&fixture.0, &selection(1)).is_err());
        assert_eq!(fs::metadata(partial).unwrap().len(), 65537);
        assert_eq!(fs::read(committed).unwrap(), previous);
        assert!(!fixture.0.join("relay-cleanup-bridges-recovery-1").exists());
    }
}
