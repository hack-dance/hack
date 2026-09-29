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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    predecessor_owner: Option<String>,
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
    validate_bindings(receipt, selection, previous.as_deref())?;
    if let Some(expected) = &selection.predecessor_owner {
        if predecessor_owner(
            receipt,
            selection.previous_boot.as_deref().ok_or_else(invalid)?,
        )? != *expected
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn validate_bindings(
    receipt: &Receipt,
    selection: &Selection,
    previous_boot: Option<&str>,
) -> Result<(), CandidateError> {
    if let Some(previous) = &selection.previous_boot {
        if previous == &selection.boot
            || previous_boot != Some(previous.as_str())
            || (selection.selected.is_empty() && selection.predecessor_owner.is_none())
        {
            return Err(invalid());
        }
    }
    if selection.predecessor_owner.as_ref().is_some_and(|hash| {
        !hex(hash, 64)
            || selection.previous_boot.is_none()
            || !selection.selected.is_empty()
            || !receipt
                .relay_startup
                .as_ref()
                .is_some_and(|startup| startup.control_only && startup.services.is_empty())
    }) {
        return Err(invalid());
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
        predecessor_owner: None,
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

fn predecessor_owner(receipt: &Receipt, previous: &str) -> Result<String, CandidateError> {
    let startup = receipt
        .relay_startup
        .as_ref()
        .filter(|s| s.control_only && s.services.is_empty())
        .ok_or_else(invalid)?;
    let pin = crate::provider::relay_owner::publication::PinnedEndpoint::load(
        &startup.control_root,
        super::super::host_relay::context(&receipt.owner, previous)?,
    )?;
    pin.verify_dead()?;
    Ok(pin
        .fingerprint()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
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
    let mut selection = Selection {
        version: 1,
        owner: engine.guest().incarnation().into(),
        boot: engine.guest().boot_id().into(),
        previous_boot: Some(previous.into()),
        predecessor_owner: None,
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
    if selection.selected.is_empty() {
        let interrupted = receipt.phase == "cleanup-intent"
            && receipt.relay_cleanup.as_ref().is_some_and(|marker| {
                marker.valid() && marker.phase == super::super::cleanup_enrollment::Phase::Pending
            });
        if interrupted {
            let root = super::super::directory(candidate, &receipt.run)?;
            let prior: Selection = state::read_bounded(&selection_path(&root)?, 65536)?;
            if prior.version != 1
                || prior.owner != selection.owner
                || prior.boot != previous
                || prior.previous_boot.is_some()
                || prior.predecessor_owner.is_some()
                || prior.run != selection.run
                || prior.plan != selection.plan
                || prior.capacity != selection.capacity
                || prior.selected.is_empty()
                || prior.serial > selection.serial
                || validate_bindings(receipt, &prior, None).is_err()
            {
                return Err(invalid());
            }
            selection.selected = prior
                .selected
                .into_iter()
                .map(|(slot, selected)| {
                    (
                        slot,
                        Selected {
                            assignment: selected.assignment,
                            helper: None,
                        },
                    )
                })
                .collect();
        } else {
            selection.predecessor_owner = Some(predecessor_owner(receipt, previous)?);
        }
    }
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

fn prior_generation(
    root: &std::path::Path,
    prior: &Selection,
    current: &Selection,
    stopped: Option<&Receipt>,
    receipt: &Receipt,
) -> bool {
    let interrupted_release = receipt.phase == "cleanup-intent"
        && receipt.relay_cleanup.as_ref().is_some_and(|marker| {
            marker.valid() && marker.phase == super::super::cleanup_enrollment::Phase::Pending
        })
        && prior.version == 1
        && prior.owner == current.owner
        && prior.boot == current.previous_boot.as_deref().unwrap_or_default()
        && prior.previous_boot.is_none()
        && prior.predecessor_owner.is_none()
        && prior.run == current.run
        && prior.plan == current.plan
        && prior.capacity == current.capacity
        && prior.serial <= current.serial
        && !prior.selected.is_empty()
        && prior.selected.len() == current.selected.len()
        && prior.selected.iter().all(|(slot, selected)| {
            current
                .selected
                .get(slot)
                .is_some_and(|now| now.assignment == selected.assignment && now.helper.is_none())
        })
        && validate_bindings(receipt, prior, None).is_ok()
        && validate_bindings(receipt, current, Some(&prior.boot)).is_ok();
    if interrupted_release {
        return true;
    }
    prior.version == 1
        && prior.owner == current.owner
        && prior.boot == current.previous_boot.as_deref().unwrap_or_default()
        && prior.previous_boot.is_none()
        && prior.predecessor_owner.is_none()
        && prior.run == current.run
        && prior.plan == current.plan
        && prior.capacity == current.capacity
        && !current.selected.is_empty()
        && current.selected.values().all(|selected| {
            selected
                .assignment
                .relay
                .as_ref()
                .is_some_and(|relay| relay.launch_serial > prior.serial)
        })
        && (prior.selected.is_empty()
            || stopped.is_some_and(|receipt| stopped_prior_bindings(root, prior, receipt)))
}

fn stopped_prior_bindings(root: &std::path::Path, prior: &Selection, receipt: &Receipt) -> bool {
    let acknowledged =
        receipt.relay_cleanup.as_ref().is_some_and(|cleanup| {
            cleanup.phase() == super::super::cleanup_enrollment::Phase::Confirmed
        }) || super::super::dead_owner_cleanup::retired_prior_bridges(root, receipt, prior)
            .unwrap_or(false);
    acknowledged
        && validate_bindings(receipt, prior, None).is_ok()
        && prior.selected.values().all(|selected| {
            let assignment = &selected.assignment;
            receipt
                .resources
                .get(&format!("container:{}", assignment.service))
                .is_some_and(|resource| resource.phase == "absent")
                && receipt.resources.values().any(|resource| {
                    resource.kind == Kind::Network
                        && resource.id.as_deref() == Some(assignment.network_id.as_str())
                        && resource.phase == "absent"
                })
        })
}

/// A completed selection from an earlier restored generation may precede every
/// currently reserved route. Capture its exact bytes in the recovery intent before
/// replacing the sidecar; a partial or changed selection remains a refusal.
pub(crate) fn capture_prior_generation(
    root: &std::path::Path,
    current: &Selection,
    receipt: &Receipt,
) -> Result<Option<Value>, CandidateError> {
    let path = selection_path(root)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(state::io(error)),
        Ok(_) => {}
    }
    let prior: Selection = state::read_bounded(&path, 65536)?;
    let stopped = if prior.selected.is_empty() {
        None
    } else {
        super::super::restore_history::latest_for_bridge_recovery(root, receipt)?
    };
    if !prior_generation(root, &prior, current, stopped.as_ref(), receipt) {
        return Err(invalid());
    }
    serde_json::to_value(prior).map(Some).map_err(|_| invalid())
}

pub(crate) fn verify_recovery_file(
    root: &std::path::Path,
    current: &Selection,
    prior: Option<&Value>,
) -> Result<(), CandidateError> {
    let path = selection_path(root)?;
    let observed: Value = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && prior.is_none() => {
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(invalid()),
        Err(error) => return Err(state::io(error)),
        Ok(_) => state::read_bounded(&path, 65536)?,
    };
    let selected = serde_json::to_value(current).map_err(|_| invalid())?;
    if prior == Some(&observed) || observed == selected {
        Ok(())
    } else {
        Err(invalid())
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
            predecessor_owner: None,
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
    #[test]
    fn empty_prior_boot_requires_pinned_control_only_predecessor() {
        let mut selection = selection(0);
        selection.boot = "current".into();
        selection.previous_boot = Some("prior".into());
        let mut receipt: Receipt = serde_json::from_value(json!({"version":1,"run":selection.run,"owner":selection.owner,"namespace":"d".repeat(64),"plan_id":selection.plan,"phase":"ready-observed","readiness":{},"resources":{},"relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}}})).unwrap();
        assert!(validate_bindings(&receipt, &selection, Some("prior")).is_err());
        selection.predecessor_owner = Some("f".repeat(64));
        assert!(validate_bindings(&receipt, &selection, Some("prior")).is_ok());
        assert!(validate_bindings(&receipt, &selection, Some("foreign")).is_err());
        assert!(validate_bindings(&receipt, &selection, Some("current")).is_err());
        receipt.relay_startup.as_mut().unwrap().control_only = false;
        assert!(validate_bindings(&receipt, &selection, Some("prior")).is_err());
        receipt.relay_startup = None;
        assert!(validate_bindings(&receipt, &selection, Some("prior")).is_err());
    }
    #[test]
    fn prior_generation_selection_is_retained_only_before_all_current_routes() {
        let fixture = Fixture::new();
        let mut current = selection(101);
        current.boot = "current".into();
        current.previous_boot = Some("prior".into());
        current.capacity = 1;
        current.selected.insert(
            0,
            Selected {
                assignment: Assignment {
                    reservation: "d".repeat(32),
                    run: current.run.clone(),
                    service: "web".into(),
                    generation: "e".repeat(64),
                    container_id: "f".repeat(64),
                    network_id: "1".repeat(64),
                    boot_id: "prior".into(),
                    phase: "running".into(),
                    relay: Some(relay::Relay {
                        transport: relay::Transport::ReservationV1,
                        launch_serial: 100,
                        binary_sha256: "2".repeat(64),
                        target_pid: 10,
                        target_start: 10,
                        port: 8080,
                    }),
                },
                helper: None,
            },
        );
        let receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":current.run,"owner":current.owner,
            "namespace":"3".repeat(64),"plan_id":current.plan,
            "phase":"ready-observed","readiness":{},"resources":{}
        }))
        .unwrap();
        let mut prior = selection(99);
        prior.boot = "prior".into();
        prior.capacity = 1;
        let path = fixture.0.join("relay-cleanup-bridges.json");
        state::write(&path, &prior).unwrap();
        let captured = capture_prior_generation(&fixture.0, &current, &receipt)
            .unwrap()
            .unwrap();
        verify_recovery_file(&fixture.0, &current, Some(&captured)).unwrap();
        state::write(&path, &current).unwrap();
        verify_recovery_file(&fixture.0, &current, Some(&captured)).unwrap();

        prior.serial = 100;
        state::write(&path, &prior).unwrap();
        assert!(capture_prior_generation(&fixture.0, &current, &receipt).is_err());
        assert!(verify_recovery_file(&fixture.0, &current, Some(&captured)).is_err());
        prior.serial = 99;
        prior.boot = "foreign".into();
        state::write(&path, &prior).unwrap();
        assert!(capture_prior_generation(&fixture.0, &current, &receipt).is_err());
    }
    #[test]
    fn prior_routed_generation_requires_exact_latest_stopped_receipt() {
        let fixture = Fixture::new();
        let old_boot = "11111111-1111-1111-1111-111111111111";
        let new_boot = "22222222-2222-2222-2222-222222222222";
        let mut current = selection(2);
        current.boot = new_boot.into();
        current.previous_boot = Some(old_boot.into());
        current.capacity = 1;
        let assignment = Assignment {
            reservation: "d".repeat(32),
            run: current.run.clone(),
            service: "web".into(),
            generation: "e".repeat(64),
            container_id: "f".repeat(64),
            network_id: "1".repeat(64),
            boot_id: old_boot.into(),
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
        let mut prior = selection(1);
        prior.boot = old_boot.into();
        prior.capacity = 1;
        prior.selected.insert(
            0,
            Selected {
                assignment: assignment.clone(),
                helper: Some(
                    serde_json::from_value(json!({
                        "pid":10,"start":10,"executable_device":1,"executable_inode":1,
                        "socket_device":1,"socket_inode":1,"kernel_socket_inode":1
                    }))
                    .unwrap(),
                ),
            },
        );
        let mut newer = assignment.clone();
        newer.container_id = "a".repeat(64);
        newer.network_id = "b".repeat(64);
        newer.relay.as_mut().unwrap().launch_serial = 2;
        current.selected.insert(
            0,
            Selected {
                assignment: newer,
                helper: None,
            },
        );
        let mut stopped: Receipt = serde_json::from_value(json!({
            "version":1,"run":current.run,"owner":current.owner,
            "namespace":"3".repeat(64),"plan_id":current.plan,
            "phase":"stopped-data-retained","readiness":{},"resources":{
                "container:web":{"kind":"container","key":"web","name":"old-web",
                    "id":assignment.container_id,"image":null,"phase":"absent"},
                "network:default":{"kind":"network","key":"default","name":"old-network",
                    "id":assignment.network_id,"image":null,"phase":"absent"}
            },
            "relay_cleanup":{"version":1,"runtime":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                "boot":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                "operation":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                "effect":vec![1;32],
                "control_root":"/private/old","phase":"confirmed"}
        }))
        .unwrap();
        let path = fixture.0.join("relay-cleanup-bridges.json");
        state::write(&path, &prior).unwrap();
        let mut active = stopped.clone();
        active.phase = "ready-observed".into();
        active.relay_cleanup = None;
        active.resources.get_mut("container:web").unwrap().id = Some("a".repeat(64));
        active.resources.get_mut("network:default").unwrap().id = Some("b".repeat(64));
        assert!(capture_prior_generation(&fixture.0, &current, &active).is_err());
        super::super::restore_history::retain(&fixture.0, &stopped).unwrap();
        assert!(
            capture_prior_generation(&fixture.0, &current, &active)
                .unwrap()
                .is_some()
        );
        stopped.resources.get_mut("container:web").unwrap().id = Some("c".repeat(64));
        super::super::restore_history::retain(&fixture.0, &stopped).unwrap();
        assert!(capture_prior_generation(&fixture.0, &current, &active).is_err());
        stopped.resources.get_mut("container:web").unwrap().id = Some(assignment.container_id);
        stopped.resources.get_mut("container:web").unwrap().phase = "started".into();
        super::super::restore_history::retain(&fixture.0, &stopped).unwrap();
        assert!(capture_prior_generation(&fixture.0, &current, &active).is_err());
    }
    #[test]
    fn interrupted_release_reuses_only_the_exact_prior_bridge_selection() {
        let fixture = Fixture::new();
        let old_boot = "11111111-1111-1111-1111-111111111111";
        let mut prior = selection(2);
        prior.boot = old_boot.into();
        prior.capacity = 1;
        let assignment = Assignment {
            reservation: "d".repeat(32),
            run: prior.run.clone(),
            service: "web".into(),
            generation: "e".repeat(64),
            container_id: "f".repeat(64),
            network_id: "1".repeat(64),
            boot_id: old_boot.into(),
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
        prior.selected.insert(
            0,
            Selected {
                assignment: assignment.clone(),
                helper: Some(
                    serde_json::from_value(json!({
                        "pid":10,"start":10,"executable_device":1,"executable_inode":1,
                        "socket_device":1,"socket_inode":1,"kernel_socket_inode":1
                    }))
                    .unwrap(),
                ),
            },
        );
        let mut current = selection(2);
        current.boot = "22222222-2222-2222-2222-222222222222".into();
        current.previous_boot = Some(old_boot.into());
        current.capacity = 1;
        current.selected.insert(
            0,
            Selected {
                assignment: assignment.clone(),
                helper: None,
            },
        );
        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":current.run,"owner":current.owner,
            "namespace":"3".repeat(64),"plan_id":current.plan,
            "phase":"cleanup-intent","readiness":{},"resources":{
                "container:web":{"kind":"container","key":"web","name":"owned-web",
                    "id":assignment.container_id,"image":null,"phase":"started"},
                "network:default":{"kind":"network","key":"default","name":"owned-network",
                    "id":assignment.network_id,"image":null,"phase":"created"}
            },
            "relay_cleanup":{"version":1,"runtime":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                "boot":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                "operation":[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
                "effect":vec![1;32],
                "control_root":"/private/owned","phase":"pending"}
        }))
        .unwrap();
        assert!(prior_generation(
            &fixture.0, &prior, &current, None, &receipt
        ));
        receipt.phase = "ready-observed".into();
        assert!(!prior_generation(
            &fixture.0, &prior, &current, None, &receipt
        ));
        receipt.phase = "cleanup-intent".into();
        current
            .selected
            .get_mut(&0)
            .unwrap()
            .assignment
            .container_id = "9".repeat(64);
        assert!(!prior_generation(
            &fixture.0, &prior, &current, None, &receipt
        ));
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
