//! Durable graph bridge ownership, with explicit relay intent and cleanup phases.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub reservation: String,
    pub run: String,
    pub service: String,
    pub generation: String,
    pub container_id: String,
    pub network_id: String,
    pub boot_id: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<relay::Relay>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    owner: String,
    #[serde(default)]
    next_launch_serial: u64,
    slots: BTreeMap<u8, Assignment>,
}
fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/bridge-assignments")
}
fn invalid() -> CandidateError {
    error(
        "bridge_assignment",
        "Invalid or foreign bridge assignment receipt.",
    )
}
fn validate(store: &Store, owner: &str, capacity: u8) -> Result<(), CandidateError> {
    if store.version != 1
        || store.owner != owner
        || store.slots.len() > capacity as usize
        || store.next_launch_serial > i64::MAX as u64
    {
        return Err(invalid());
    }
    let mut services = std::collections::BTreeSet::new();
    let mut reservations = std::collections::BTreeSet::new();
    let mut serials = std::collections::BTreeSet::new();
    for (slot, a) in &store.slots {
        if *slot >= capacity
            || !hex(&a.reservation, 32)
            || !reservations.insert(&a.reservation)
            || !hex(&a.run, 32)
            || a.service.is_empty()
            || a.service.len() > 128
            || !services.insert((&a.run, &a.service))
            || !hex(&a.generation, 64)
            || !hex(&a.container_id, 64)
            || !hex(&a.network_id, 64)
            || a.boot_id.len() != 36
            || !a
                .boot_id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() || c == b'-')
            || !["reserved", "starting", "running", "stopping", "stopped"]
                .contains(&a.phase.as_str())
            || (a.phase == "reserved") != a.relay.is_none()
            || a.relay.as_ref().is_some_and(|r| {
                !r.valid()
                    || r.launch_serial > store.next_launch_serial
                    || (r.launch_serial != 0 && !serials.insert(r.launch_serial))
            })
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn matches_endpoint(a: &Assignment, e: &GuestEndpoint, boot: &str) -> bool {
    a.boot_id == boot
        && a.generation == e.generation
        && a.container_id == e.container_id
        && a.network_id == e.network_id
}
fn load_store(
    candidate: &Candidate,
    engine: &Engine<'_>,
    allow_pending: bool,
) -> Result<Store, CandidateError> {
    let root = root(candidate);
    let empty = || Store {
        version: 1,
        owner: engine.guest().incarnation().into(),
        slots: BTreeMap::new(),
        next_launch_serial: 0,
    };
    if !root.try_exists().map_err(state::io)? && !root.is_symlink() {
        return Ok(empty());
    }
    state::check_private_directory(&root)?;
    if !allow_pending
        && (root.join("state.pending").exists() || root.join("state.pending").is_symlink())
    {
        return Err(error(
            "bridge_journal_uncertain",
            "Reconcile the interrupted bridge reservation journal before reuse or cleanup.",
        ));
    }
    let path = root.join("state.json");
    let store = if path.try_exists().map_err(state::io)? || path.is_symlink() {
        state::read_bounded(&path, 65536)?
    } else {
        empty()
    };
    validate(
        &store,
        engine.guest().incarnation(),
        engine.guest().bridge_intent().map_or(0, |b| b.slots),
    )?;
    Ok(store)
}
fn save(candidate: &Candidate, store: &Store) -> Result<(), CandidateError> {
    let root = root(candidate);
    state::private_directory(&root)?;
    state::write(&root.join("state.json"), store)
}

pub struct ReserveBridgeOptions<'a> {
    pub run: &'a str,
    pub service: &'a str,
    pub slot: u8,
    pub expected_generation: &'a str,
}
pub fn reserve_bridge(
    candidate: &Candidate,
    options: ReserveBridgeOptions<'_>,
) -> Result<Assignment, CandidateError> {
    if !hex(options.expected_generation, 64) {
        return Err(error(
            "bridge_generation",
            "Expected a current 64-character endpoint generation.",
        ));
    }
    let engine = Engine::connect_cleanup(candidate)?;
    let capacity = engine
        .guest()
        .bridge_intent()
        .ok_or_else(|| {
            error(
                "bridge_unavailable",
                "The pool has no application bridge capacity.",
            )
        })?
        .slots;
    if options.slot >= capacity {
        return Err(error(
            "bridge_capacity",
            "Requested socket slot is outside this pool's capacity.",
        ));
    }
    let snapshot = inspect_using(candidate, &engine, options.run)?;
    let endpoint = snapshot
        .guest_endpoints
        .get(options.service)
        .ok_or_else(|| {
            error(
                "bridge_endpoint_unavailable",
                "A committed healthy guest endpoint is required.",
            )
        })?;
    if endpoint.generation != options.expected_generation {
        return Err(error(
            "bridge_generation_stale",
            "Endpoint generation changed; inspect before reserving again.",
        ));
    }
    let mut store = load_store(candidate, &engine, false)?;
    if store.slots.contains_key(&options.slot)
        || store
            .slots
            .values()
            .any(|a| a.run == options.run && a.service == options.service)
    {
        return Err(error(
            "bridge_slot_busy",
            "The slot or service is already reserved; no reassignment was attempted.",
        ));
    }
    let assignment = Assignment {
        reservation: probes::token()?,
        run: options.run.into(),
        service: options.service.into(),
        generation: endpoint.generation.clone(),
        container_id: endpoint.container_id.clone(),
        network_id: endpoint.network_id.clone(),
        boot_id: engine.guest().boot_id().into(),
        phase: "reserved".into(),
        relay: None,
    };
    store.slots.insert(options.slot, assignment.clone());
    save(candidate, &store)?;
    Ok(assignment)
}
pub fn start_bridge(
    candidate: &Candidate,
    run: &str,
    slot: u8,
    reservation: &str,
) -> Result<Assignment, CandidateError> {
    if !hex(reservation, 32) {
        return Err(invalid());
    }
    let (digest, input) = relay::payload()?;
    let engine = Engine::connect(candidate)?;
    let mut store = load_store(candidate, &engine, false)?;
    let a = store
        .slots
        .get(&slot)
        .filter(|a| a.run == run && a.reservation == reservation && a.phase == "reserved")
        .ok_or_else(|| {
            error(
                "bridge_reservation_changed",
                "Expected an exact reserved slot; no launch was replayed.",
            )
        })?
        .clone();
    let snapshot = inspect_using(candidate, &engine, run)?;
    let endpoint = snapshot
        .guest_endpoints
        .get(&a.service)
        .filter(|e| matches_endpoint(&a, e, engine.guest().boot_id()))
        .ok_or_else(|| {
            error(
                "bridge_generation_stale",
                "Endpoint changed before relay startup.",
            )
        })?;
    let container = engine.request(
        Method::GET,
        &format!("/containers/{}/json", a.container_id),
        None,
    )?;
    let pid = container["State"]["Pid"]
        .as_u64()
        .filter(|p| (2..=i32::MAX as u64).contains(p))
        .ok_or_else(|| error("bridge_target", "Target has no live process identity."))?
        as u32;
    let start = relay::target_start(&engine, pid)?;
    let checked = inspect_using(candidate, &engine, run)?;
    if !checked
        .guest_endpoints
        .get(&a.service)
        .is_some_and(|e| matches_endpoint(&a, e, engine.guest().boot_id()))
    {
        return Err(error(
            "bridge_generation_stale",
            "Endpoint changed during target verification.",
        ));
    }
    if store.next_launch_serial == i64::MAX as u64 {
        return Err(error(
            "bridge_serial_exhausted",
            "Bridge launch serials are exhausted; no launch was attempted.",
        ));
    }
    store.next_launch_serial += 1;
    let entry = store.slots.get_mut(&slot).expect("checked slot");
    entry.relay = Some(relay::Relay {
        transport: relay::Transport::ReservationV1,
        launch_serial: store.next_launch_serial,
        binary_sha256: digest,
        target_pid: pid,
        target_start: start,
        port: endpoint.port,
    });
    entry.phase = "starting".into();
    save(candidate, &store)?;
    relay::operate(&engine, slot, &store.slots[&slot], "start", Some(&input))?;
    let checked = inspect_using(candidate, &engine, run)?;
    if !checked
        .guest_endpoints
        .get(&a.service)
        .is_some_and(|e| matches_endpoint(&a, e, engine.guest().boot_id()))
    {
        stop_slot(candidate, &engine, &mut store, slot)?;
        return Err(error(
            "bridge_generation_stale",
            "Endpoint changed during startup; relay was stopped.",
        ));
    }
    store.slots.get_mut(&slot).expect("checked slot").phase = "running".into();
    save(candidate, &store)?;
    Ok(store.slots[&slot].clone())
}
pub fn publish_bridge(
    candidate: &Candidate,
    run: &str,
    slot: u8,
    reservation: &str,
    port: Option<u16>,
) -> Result<(), CandidateError> {
    let engine = Engine::connect(candidate)?;
    let store = load_store(candidate, &engine, false)?;
    let a = store
        .slots
        .get(&slot)
        .filter(|a| {
            a.run == run
                && a.reservation == reservation
                && a.phase == "running"
                && a.relay
                    .as_ref()
                    .is_some_and(|r| r.transport == relay::Transport::ReservationV1)
        })
        .ok_or_else(invalid)?;
    let snapshot = inspect_using(candidate, &engine, run)?;
    if !snapshot
        .guest_endpoints
        .get(&a.service)
        .is_some_and(|e| matches_endpoint(a, e, engine.guest().boot_id()))
        || relay::operate(&engine, slot, a, "inspect", None)? != "running"
    {
        return Err(invalid());
    }
    let upstream = engine
        .guest()
        .engine_socket()?
        .with_file_name(format!("bridge-{slot:02}.sock"));
    super::super::publication::launch(
        candidate,
        super::super::publication::Launch {
            owner: engine.guest().incarnation(),
            run,
            reservation,
            slot,
            port,
            upstream: &upstream,
        },
    )
}
fn stop_slot(
    candidate: &Candidate,
    engine: &Engine<'_>,
    store: &mut Store,
    slot: u8,
) -> Result<(), CandidateError> {
    let a = store.slots.get(&slot).expect("selected slot");
    super::super::publication::release(
        candidate,
        engine.guest().incarnation(),
        Some((&a.run, &a.reservation)),
    )?;
    if a.relay.is_none() {
        return Ok(());
    }
    if a.boot_id != engine.guest().boot_id() {
        // Guest allocations are boot-local tmpfs; an audited new boot has no old processes.
        store.slots.get_mut(&slot).expect("selected slot").phase = "stopped".into();
        return save(candidate, store);
    }
    if a.phase != "stopped" {
        store.slots.get_mut(&slot).expect("selected slot").phase = "stopping".into();
        save(candidate, store)?;
        relay::operate(engine, slot, &store.slots[&slot], "stop", None)?;
        store.slots.get_mut(&slot).expect("selected slot").phase = "stopped".into();
        save(candidate, store)?;
    }
    relay::operate(engine, slot, &store.slots[&slot], "remove", None)?;
    Ok(())
}
pub fn inspect_bridges(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let snapshot = inspect_using(candidate, &engine, run)?;
    let store = load_store(candidate, &engine, false)?;
    let slots = store
        .slots
        .iter()
        .filter(|(_, a)| a.run == run)
        .map(|(slot, a)| {
            let current = snapshot.guest_endpoints.get(&a.service)
                .is_some_and(|e| matches_endpoint(a, e, engine.guest().boot_id()));
            let status = if a.relay.is_some() && a.boot_id == engine.guest().boot_id() && a.phase != "stopped" {
                relay::operate(&engine, *slot, a, "inspect", None)?
            } else { "not-running".into() };
            Ok((slot.to_string(), json!({"assignment":a,"current":current,"relay_started":status == "running","relay_status":status})))
        })
        .collect::<Result<BTreeMap<_, _>, CandidateError>>()?;
    Ok(json!({"run":run,"slots":slots,"scope":"graph-owned-guest-relay"}))
}
pub fn release_bridge(
    candidate: &Candidate,
    run: &str,
    slot: u8,
    reservation: &str,
) -> Result<Value, CandidateError> {
    if !hex(reservation, 32) {
        return Err(invalid());
    }
    let engine = Engine::connect_cleanup(candidate)?;
    load(candidate, &engine, run)?;
    let mut store = load_store(candidate, &engine, false)?;
    let owned = store
        .slots
        .get(&slot)
        .is_some_and(|a| a.run == run && a.reservation == reservation);
    if !owned {
        return Err(error(
            "bridge_reservation_changed",
            "The selected reservation is absent or has changed; nothing was released.",
        ));
    }
    stop_slot(candidate, &engine, &mut store, slot)?;
    store.slots.remove(&slot);
    save(candidate, &store)?;
    Ok(json!({"run":run,"slot":slot,"released":reservation,"relay_started":false}))
}
pub(super) fn release_run(
    candidate: &Candidate,
    engine: &Engine<'_>,
    receipt: &Receipt,
) -> Result<(), CandidateError> {
    let mut store = load_store(candidate, engine, false)?;
    let selected = store
        .slots
        .iter()
        .filter(|(_, a)| a.run == receipt.run)
        .map(|(slot, _)| *slot)
        .collect::<Vec<_>>();
    for slot in selected {
        stop_slot(candidate, engine, &mut store, slot)?;
        store.slots.remove(&slot);
        save(candidate, &store)?;
    }
    Ok(())
}
pub fn reconcile_bridges(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    load(candidate, &engine, run)?;
    load_store(candidate, &engine, true)?;
    let root = root(candidate);
    let retained = if root.exists() {
        journal::retain_file(&root, "state.pending", "reservation-recovery", 65536)?
    } else {
        None
    };
    Ok(json!({"retained":retained,"replayed":false,"scope":"journal-preservation-only"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Store {
        Store {
            version: 1,
            owner: "owner".into(),
            next_launch_serial: 0,
            slots: BTreeMap::from([(
                0,
                Assignment {
                    reservation: "a".repeat(32),
                    run: "b".repeat(32),
                    service: "web".into(),
                    generation: "c".repeat(64),
                    container_id: "d".repeat(64),
                    network_id: "e".repeat(64),
                    boot_id: "12345678-1234-1234-1234-123456789abc".into(),
                    phase: "reserved".into(),
                    relay: None,
                },
            )]),
        }
    }
    #[test]
    fn matching_generation_cannot_authorize_a_different_container_or_network() {
        let a = fixture().slots.remove(&0).unwrap();
        let mut endpoint = GuestEndpoint {
            generation: a.generation.clone(),
            container_id: a.container_id.clone(),
            network_id: a.network_id.clone(),
            address: "172.17.0.2".parse().unwrap(),
            port: 3000,
            scope: "guest-only",
            reachability: "not-probed",
        };
        assert!(matches_endpoint(&a, &endpoint, &a.boot_id));
        endpoint.container_id = "f".repeat(64);
        assert!(!matches_endpoint(&a, &endpoint, &a.boot_id));
        endpoint.container_id = a.container_id.clone();
        endpoint.network_id = "f".repeat(64);
        assert!(!matches_endpoint(&a, &endpoint, &a.boot_id));
        endpoint.network_id = a.network_id.clone();
        assert!(!matches_endpoint(&a, &endpoint, "other-boot"));
    }
    #[test]
    fn launch_serials_remain_monotonic_when_slots_are_empty_and_reject_reuse() {
        let mut store = fixture();
        store.next_launch_serial = 7;
        let entry = store.slots.get_mut(&0).unwrap();
        entry.phase = "starting".into();
        entry.relay = Some(relay::Relay {
            transport: relay::Transport::Raw,
            launch_serial: 7,
            binary_sha256: "f".repeat(64),
            target_pid: 42,
            target_start: 123,
            port: 3000,
        });
        validate(&store, "owner", 2).unwrap();
        let mut legacy = serde_json::to_value(&store).unwrap();
        legacy.as_object_mut().unwrap().remove("next_launch_serial");
        legacy["slots"]["0"]["relay"]
            .as_object_mut()
            .unwrap()
            .remove("launch_serial");
        let legacy: Store = serde_json::from_value(legacy).unwrap();
        validate(&legacy, "owner", 2).unwrap();
        assert_eq!(legacy.slots[&0].relay.as_ref().unwrap().launch_serial, 0);
        store.next_launch_serial = 6;
        assert!(validate(&store, "owner", 2).is_err());
        store.next_launch_serial = 7;
        let mut other = store.slots[&0].clone();
        other.reservation = "f".repeat(32);
        other.service = "other".into();
        store.slots.insert(1, other);
        assert!(validate(&store, "owner", 2).is_err());
        store.slots.clear();
        let decoded: Store = serde_json::from_slice(&serde_json::to_vec(&store).unwrap()).unwrap();
        validate(&decoded, "owner", 2).unwrap();
        assert_eq!(decoded.next_launch_serial, 7);
        store.next_launch_serial = u64::MAX;
        assert!(validate(&store, "owner", 2).is_err());
    }
    #[test]
    fn relay_phases_require_complete_bounded_identity() {
        let mut store = fixture();
        let relay = relay::Relay {
            transport: relay::Transport::Raw,
            launch_serial: 0,
            binary_sha256: "f".repeat(64),
            target_pid: 42,
            target_start: 123,
            port: 3000,
        };
        store.slots.get_mut(&0).unwrap().relay = Some(relay.clone());
        assert!(validate(&store, "owner", 1).is_err());
        for phase in ["starting", "running", "stopping", "stopped"] {
            store.slots.get_mut(&0).unwrap().phase = phase.into();
            validate(&store, "owner", 1).unwrap();
        }
        for case in 0..5 {
            let mut broken = relay.clone();
            match case {
                0 => broken.target_pid = 1,
                1 => broken.target_start = 0,
                2 => broken.target_start = u64::MAX,
                3 => broken.port = 0,
                _ => broken.binary_sha256 = "bad".into(),
            }
            store.slots.get_mut(&0).unwrap().relay = Some(broken);
            assert!(validate(&store, "owner", 1).is_err());
        }
        store.slots.get_mut(&0).unwrap().relay = None;
        assert!(validate(&store, "owner", 1).is_err());
    }
    #[test]
    fn assignments_require_ownership_capacity_unique_identity_and_reserved_phase() {
        validate(&fixture(), "owner", 1).unwrap();
        assert!(validate(&fixture(), "foreign", 1).is_err());
        assert!(validate(&fixture(), "owner", 0).is_err());
        for case in 0..6 {
            let mut store = fixture();
            match case {
                0 => store.slots.get_mut(&0).unwrap().phase = "running".into(),
                1 => store.slots.get_mut(&0).unwrap().generation = "bad".into(),
                2 => store.slots.get_mut(&0).unwrap().boot_id = "bad".into(),
                3 => {
                    let a = store.slots[&0].clone();
                    store.slots.insert(1, a);
                }
                4 => store.slots.get_mut(&0).unwrap().container_id = "bad".into(),
                _ => store.version = 2,
            }
            assert!(validate(&store, "owner", 2).is_err());
        }
    }
}
