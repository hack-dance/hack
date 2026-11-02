//! Durable graph bridge ownership, with explicit relay intent and cleanup phases.
use super::*;
use std::os::unix::fs::DirBuilderExt;

#[cfg(target_os = "macos")]
pub(super) mod cleanup;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
/// Called only while holding the provider mutation lock, immediately after
/// creating a previously absent owner. Existing owners must use verification.
/// Legacy enabled pools without a registry require explicit recovery; a missing
/// file is never promoted into evidence that no reservations previously existed.
pub(in crate::provider) fn initialize_owner_registry(
    candidate: &Candidate,
    owner: &state::Owner,
) -> Result<(), CandidateError> {
    if let Some(intent) = owner.application_bridge {
        initialize_registry(candidate, &owner.token, intent.slots)?;
    }
    Ok(())
}

fn initialize_registry(
    candidate: &Candidate,
    owner: &str,
    capacity: u8,
) -> Result<(), CandidateError> {
    if !hex(owner, 32) || capacity == 0 || capacity > 32 {
        return Err(invalid());
    }
    let directory = root(candidate);
    let store = Store {
        version: 1,
        owner: owner.into(),
        next_launch_serial: 0,
        slots: BTreeMap::new(),
    };
    validate(&store, owner, capacity)?;
    state::private_directory(directory.parent().ok_or_else(invalid)?)?;
    // create_dir, unlike create_dir_all, refuses all prior directories and aliases.
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(state::io)?;
    state::write(&directory.join("state.json"), &store)
}

pub(in crate::provider) fn verify_owner_registry(
    candidate: &Candidate,
    owner: &state::Owner,
) -> Result<(), CandidateError> {
    if let Some(intent) = owner.application_bridge {
        read_owner_registry(candidate, &owner.token, intent.slots, false)?;
    }
    Ok(())
}

fn read_owner_registry(
    candidate: &Candidate,
    owner: &str,
    capacity: u8,
    allow_pending: bool,
) -> Result<Store, CandidateError> {
    let directory = root(candidate);
    state::check_private_directory(&directory)?;
    if !allow_pending {
        match fs::symlink_metadata(directory.join("state.pending")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(invalid()),
        }
    }
    let store: Store = state::read_bounded(&directory.join("state.json"), 65536)?;
    validate(&store, owner, capacity)?;
    Ok(store)
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
    if let Some(intent) = engine.guest().bridge_intent() {
        return read_owner_registry(
            candidate,
            engine.guest().incarnation(),
            intent.slots,
            allow_pending,
        );
    }
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

/// Foreground route admission may select a fixed slot or ask the provider to
/// choose one while holding its pool-wide mutation lease.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteSlot {
    Auto,
    Explicit(u8),
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Debug)]
pub(in crate::provider::graph) struct ReservedRoute {
    pub slot: u8,
    pub assignment: Assignment,
}

#[cfg(any(test, target_os = "macos"))]
fn select_route_slots(
    store: &Store,
    requested: &BTreeMap<String, RouteSlot>,
    capacity: u8,
    run: &str,
) -> Result<BTreeMap<String, u8>, CandidateError> {
    let mut used = store
        .slots
        .keys()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut selected = BTreeMap::new();
    for (service, choice) in requested {
        if store
            .slots
            .values()
            .any(|assignment| assignment.run == run && assignment.service == *service)
        {
            return Err(error(
                "bridge_slot_busy",
                "The service is already reserved; no reassignment was attempted.",
            ));
        }
        if let RouteSlot::Explicit(slot) = choice {
            if *slot >= capacity {
                return Err(error(
                    "bridge_capacity",
                    "Requested socket slot is outside this pool's capacity.",
                ));
            }
            if !used.insert(*slot) {
                return Err(error(
                    "bridge_slot_busy",
                    "The slot is already reserved; no reassignment was attempted.",
                ));
            }
            selected.insert(service.clone(), *slot);
        }
    }
    for (service, choice) in requested {
        if *choice == RouteSlot::Auto {
            let slot = (0..capacity).find(|slot| !used.contains(slot)).ok_or_else(|| {
                error(
                    "bridge_capacity_exhausted",
                    "No free application bridge socket remains in this pool; no routes were reserved.",
                )
            })?;
            used.insert(slot);
            selected.insert(service.clone(), slot);
        }
    }
    Ok(selected)
}

#[cfg(any(test, target_os = "macos"))]
fn reserve_selected(
    candidate: &Candidate,
    mut store: Store,
    requested: &BTreeMap<String, RouteSlot>,
    capacity: u8,
    run: &str,
    boot_id: &str,
    endpoints: &BTreeMap<String, GuestEndpoint>,
) -> Result<BTreeMap<String, ReservedRoute>, CandidateError> {
    let selected = select_route_slots(&store, requested, capacity, run)?;
    let mut reserved = BTreeMap::new();
    for (service, slot) in selected {
        let endpoint = endpoints.get(&service).ok_or_else(|| {
            error(
                "bridge_endpoint_unavailable",
                "A committed healthy guest endpoint is required.",
            )
        })?;
        let assignment = Assignment {
            reservation: probes::token()?,
            run: run.into(),
            service: service.clone(),
            generation: endpoint.generation.clone(),
            container_id: endpoint.container_id.clone(),
            network_id: endpoint.network_id.clone(),
            boot_id: boot_id.into(),
            phase: "reserved".into(),
            relay: None,
        };
        store.slots.insert(slot, assignment.clone());
        reserved.insert(service, ReservedRoute { slot, assignment });
    }
    validate(&store, &store.owner, capacity)?;
    save(candidate, &store)?;
    Ok(reserved)
}

/// Reserve the complete route set against one validated graph snapshot. Capacity
/// refusal writes no assignments and starts no relays; the provider lease covers
/// the pool-wide selection and single durable registry update.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph) fn reserve_routes(
    candidate: &Candidate,
    receipt: &Receipt,
    requested: &BTreeMap<String, RouteSlot>,
) -> Result<BTreeMap<String, ReservedRoute>, CandidateError> {
    if requested.is_empty() || requested.len() > 32 {
        return Err(invalid());
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
    let snapshot = inspect_using(candidate, &engine, &receipt.run)?;
    if snapshot.receipt.owner != receipt.owner
        || snapshot.receipt.plan_id != receipt.plan_id
        || snapshot.receipt.namespace != receipt.namespace
        || snapshot.receipt.phase != "ready-observed"
    {
        return Err(error(
            "bridge_generation_stale",
            "The reviewed graph changed before bridge reservation.",
        ));
    }
    let store = load_store(candidate, &engine, false)?;
    reserve_selected(
        candidate,
        store,
        requested,
        capacity,
        &receipt.run,
        engine.guest().boot_id(),
        &snapshot.guest_endpoints,
    )
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
/// Declared routes authorize only their complete hostname set over Unix
/// publication. Legacy un-enrolled services retain the existing publication API.
fn validate_route_publication(
    routing: Option<&crate::project::RoutingPlan>,
    upstream_port: u16,
    host_port: Option<u16>,
    hostnames: &[String],
) -> Result<(), CandidateError> {
    let Some(routing) = routing else {
        return Ok(());
    };
    let refused = || {
        error(
            "graph_route_publication",
            "Publication differs from the graph's declared route.",
        )
    };
    if host_port.is_some()
        || upstream_port != routing.port
        || routing.port == 0
        || hostnames.is_empty()
        || hostnames.len() > 8
    {
        return Err(refused());
    }
    let mut names = std::collections::BTreeSet::new();
    for name in hostnames {
        let normalized =
            super::super::publication::normalize_hostname(name).map_err(|_| refused())?;
        if !names.insert(normalized) {
            return Err(refused());
        }
    }
    if names.into_iter().collect::<Vec<_>>() != routing.hostnames {
        return Err(refused());
    }
    Ok(())
}
pub fn publish_bridge(
    candidate: &Candidate,
    run: &str,
    slot: u8,
    reservation: &str,
    port: Option<u16>,
    hostnames: &[String],
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
    let resource = snapshot
        .receipt
        .resources
        .get(&format!("container:{}", a.service))
        .filter(|resource| resource.kind == Kind::Container && resource.key == a.service)
        .ok_or_else(invalid)?;
    validate_route_publication(
        resource.routing.as_ref(),
        a.relay.as_ref().ok_or_else(invalid)?.port,
        port,
        hostnames,
    )?;
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
            hostnames,
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
    stop_slot_fenced(candidate, engine, store, slot, &|| Ok(()), &|| Ok(()))
}
fn stop_slot_fenced(
    candidate: &Candidate,
    engine: &Engine<'_>,
    store: &mut Store,
    slot: u8,
    fence: &dyn Fn() -> Result<(), CandidateError>,
    finish_partial: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    fence()?;
    let a = store.slots.get(&slot).expect("selected slot");
    super::super::publication::release(
        candidate,
        engine.guest().incarnation(),
        Some((&a.run, &a.reservation)),
    )?;
    fence()?;
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
        fence()?;
        relay::operate(engine, slot, &store.slots[&slot], "stop", None)?;
        #[cfg(test)]
        fault_pause(
            &directory(candidate, &store.slots[&slot].run)?,
            &store.slots[&slot].run,
            "bridge-normalization-after-guest-stop",
        )?;
        fence()?;
        store.slots.get_mut(&slot).expect("selected slot").phase = "stopped".into();
        save(candidate, store)?;
    }
    fence()?;
    finish_partial()?;
    fence()?;
    relay::operate(engine, slot, &store.slots[&slot], "remove", None)?;
    fence()
}
pub fn inspect_bridges(candidate: &Candidate, run: &str) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    inspect_bridges_using(candidate, &engine, run)
}

pub(super) fn inspect_bridges_using(
    candidate: &Candidate,
    engine: &Engine<'_>,
    run: &str,
) -> Result<Value, CandidateError> {
    let snapshot = inspect_using(candidate, engine, run)?;
    let store = load_store(candidate, engine, false)?;
    let slots = store
        .slots
        .iter()
        .filter(|(_, a)| a.run == run)
        .map(|(slot, a)| {
            let current = snapshot.guest_endpoints.get(&a.service)
                .is_some_and(|e| matches_endpoint(a, e, engine.guest().boot_id()));
            let status = if a.relay.is_some() && a.boot_id == engine.guest().boot_id() && a.phase != "stopped" {
                relay::operate(engine, *slot, a, "inspect", None)?
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
    let selected = owned_slots(&store, &receipt.run);
    for slot in selected {
        stop_slot(candidate, engine, &mut store, slot)?;
        store.slots.remove(&slot);
        save(candidate, &store)?;
    }
    Ok(())
}

fn owned_slots(store: &Store, run: &str) -> Vec<u8> {
    store
        .slots
        .iter()
        .filter(|(_, assignment)| assignment.run == run)
        .map(|(slot, _)| *slot)
        .collect()
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
    #[test]
    fn fresh_registry_is_exclusive_and_lost_registry_stays_unknown() {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let owner = "a".repeat(32);
        assert!(read_owner_registry(&candidate, &owner, 2, false).is_err());
        initialize_registry(&candidate, &owner, 2).unwrap();
        let store = read_owner_registry(&candidate, &owner, 2, false).unwrap();
        assert!(store.slots.is_empty());
        assert_eq!(store.owner, owner);
        assert!(initialize_registry(&candidate, &owner, 2).is_err());
        assert!(read_owner_registry(&candidate, &"b".repeat(32), 2, false).is_err());
        fs::remove_file(root(&candidate).join("state.json")).unwrap();
        assert!(read_owner_registry(&candidate, &owner, 2, false).is_err());
        assert!(initialize_registry(&candidate, &owner, 2).is_err());
    }

    #[test]
    fn pending_corrupt_and_aliased_registry_are_not_overwritten() {
        use std::os::unix::fs::symlink;
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let owner = "a".repeat(32);
        assert!(initialize_registry(&candidate, "bad", 2).is_err());
        assert!(!root(&candidate).exists());
        initialize_registry(&candidate, &owner, 2).unwrap();
        let state_path = root(&candidate).join("state.json");
        let before = fs::read(&state_path).unwrap();
        fs::write(root(&candidate).join("state.pending"), b"pending").unwrap();
        assert!(read_owner_registry(&candidate, &owner, 2, false).is_err());
        assert_eq!(fs::read(&state_path).unwrap(), before);
        fs::remove_file(root(&candidate).join("state.pending")).unwrap();
        fs::write(&state_path, b"corrupt").unwrap();
        assert!(read_owner_registry(&candidate, &owner, 2, false).is_err());
        assert!(initialize_registry(&candidate, &owner, 2).is_err());
        fs::remove_dir_all(root(&candidate)).unwrap();
        symlink(fixture.0.join("missing"), root(&candidate)).unwrap();
        assert!(initialize_registry(&candidate, &owner, 2).is_err());
    }

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
    fn automatic_routes_allocate_distinct_free_slots_without_stealing_foreign_owners() {
        let store = fixture();
        let requests = BTreeMap::from([
            ("api".into(), RouteSlot::Auto),
            ("worker".into(), RouteSlot::Auto),
            ("web".into(), RouteSlot::Explicit(3)),
        ]);
        let selected = select_route_slots(&store, &requests, 4, &"f".repeat(32)).unwrap();
        assert_eq!(selected["api"], 1);
        assert_eq!(selected["worker"], 2);
        assert_eq!(selected["web"], 3);
        assert_eq!(store.slots[&0].run, "b".repeat(32));
        assert_eq!(store.slots.len(), 1);
    }
    #[test]
    fn exhausted_batch_refuses_without_changing_registry_or_partial_selection() {
        let fixture_root = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture_root.0).unwrap();
        let owner = "a".repeat(32);
        initialize_registry(&candidate, &owner, 2).unwrap();
        let mut store = fixture();
        store.owner = owner.clone();
        save(&candidate, &store).unwrap();
        let before = fs::read(root(&candidate).join("state.json")).unwrap();
        let requests = BTreeMap::from([
            ("api".into(), RouteSlot::Auto),
            ("worker".into(), RouteSlot::Auto),
        ]);
        assert_eq!(
            reserve_selected(
                &candidate,
                read_owner_registry(&candidate, &owner, 2, false).unwrap(),
                &requests,
                2,
                &"f".repeat(32),
                "12345678-1234-1234-1234-123456789abc",
                &BTreeMap::new(),
            )
            .unwrap_err()
            .code,
            "bridge_capacity_exhausted"
        );
        assert_eq!(
            fs::read(root(&candidate).join("state.json")).unwrap(),
            before
        );
    }
    #[test]
    fn batch_commit_is_atomic_across_late_endpoint_failure_and_success() {
        let fixture_root = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture_root.0).unwrap();
        let owner = "a".repeat(32);
        let run = "f".repeat(32);
        let boot = "12345678-1234-1234-1234-123456789abc";
        initialize_registry(&candidate, &owner, 3).unwrap();
        let mut store = fixture();
        store.owner = owner.clone();
        save(&candidate, &store).unwrap();
        let before = fs::read(root(&candidate).join("state.json")).unwrap();
        let requested = BTreeMap::from([
            ("api".into(), RouteSlot::Auto),
            ("web".into(), RouteSlot::Auto),
        ]);
        let endpoint = GuestEndpoint {
            generation: "c".repeat(64),
            container_id: "d".repeat(64),
            network_id: "e".repeat(64),
            address: "172.17.0.2".parse().unwrap(),
            port: 3000,
            scope: "guest-only",
            reachability: "not-probed",
        };
        let mut endpoints = BTreeMap::from([("api".into(), endpoint.clone())]);
        assert_eq!(
            reserve_selected(
                &candidate,
                read_owner_registry(&candidate, &owner, 3, false).unwrap(),
                &requested,
                3,
                &run,
                boot,
                &endpoints,
            )
            .unwrap_err()
            .code,
            "bridge_endpoint_unavailable"
        );
        assert_eq!(
            fs::read(root(&candidate).join("state.json")).unwrap(),
            before
        );
        let mut invalid = endpoint.clone();
        invalid.generation = "invalid".into();
        endpoints.insert("web".into(), invalid);
        assert_eq!(
            reserve_selected(
                &candidate,
                read_owner_registry(&candidate, &owner, 3, false).unwrap(),
                &requested,
                3,
                &run,
                boot,
                &endpoints,
            )
            .unwrap_err()
            .code,
            "bridge_assignment"
        );
        assert_eq!(
            fs::read(root(&candidate).join("state.json")).unwrap(),
            before
        );
        endpoints.insert("web".into(), endpoint);
        let reserved = reserve_selected(
            &candidate,
            read_owner_registry(&candidate, &owner, 3, false).unwrap(),
            &requested,
            3,
            &run,
            boot,
            &endpoints,
        )
        .unwrap();
        assert_eq!(reserved["api"].slot, 1);
        assert_eq!(reserved["web"].slot, 2);
        let persisted = read_owner_registry(&candidate, &owner, 3, false).unwrap();
        assert_eq!(persisted.slots.len(), 3);
        for (service, route) in reserved {
            assert_eq!(persisted.slots[&route.slot].run, run);
            assert_eq!(persisted.slots[&route.slot].service, service);
            assert_eq!(
                persisted.slots[&route.slot].reservation,
                route.assignment.reservation
            );
        }
        assert_eq!(persisted.slots[&0].run, "b".repeat(32));
    }
    #[test]
    fn explicit_slot_and_existing_service_conflicts_still_refuse() {
        let store = fixture();
        for (run, choice, code) in [
            ("f".repeat(32), RouteSlot::Explicit(0), "bridge_slot_busy"),
            ("f".repeat(32), RouteSlot::Explicit(2), "bridge_capacity"),
            ("b".repeat(32), RouteSlot::Auto, "bridge_slot_busy"),
        ] {
            let requests = BTreeMap::from([("web".into(), choice)]);
            assert_eq!(
                select_route_slots(&store, &requests, 2, &run)
                    .unwrap_err()
                    .code,
                code
            );
        }
    }
    #[test]
    fn retained_restore_selection_respects_current_pool_ownership() {
        let mut store = fixture();
        let requests = BTreeMap::from([("web".into(), RouteSlot::Auto)]);
        let old_slot = select_route_slots(&store, &requests, 2, &"f".repeat(32)).unwrap()["web"];
        assert_eq!(old_slot, 1);
        store.slots.remove(&0);
        store.slots.insert(1, fixture().slots[&0].clone());
        let restored = select_route_slots(&store, &requests, 2, &"f".repeat(32)).unwrap();
        assert_eq!(restored["web"], 0);
        assert_eq!(store.slots[&1].run, "b".repeat(32));
    }
    #[test]
    fn stopping_slots_stay_occupied_and_cleanup_selects_only_owned_run() {
        let mut store = fixture();
        let entry = store.slots.get_mut(&0).unwrap();
        entry.phase = "stopping".into();
        entry.relay = Some(relay::Relay {
            transport: relay::Transport::Raw,
            launch_serial: 0,
            binary_sha256: "f".repeat(64),
            target_pid: 42,
            target_start: 123,
            port: 3000,
        });
        validate(&store, "owner", 2).unwrap();
        let requests = BTreeMap::from([("web".into(), RouteSlot::Auto)]);
        assert_eq!(
            select_route_slots(&store, &requests, 2, &"f".repeat(32)).unwrap()["web"],
            1
        );
        let mut other = fixture().slots.remove(&0).unwrap();
        other.run = "f".repeat(32);
        other.reservation = "9".repeat(32);
        store.slots.insert(1, other);
        assert_eq!(owned_slots(&store, &"b".repeat(32)), vec![0]);
        assert_eq!(owned_slots(&store, &"f".repeat(32)), vec![1]);
        assert!(
            select_route_slots(&store, &requests, 2, &"e".repeat(32))
                .unwrap_err()
                .code
                == "bridge_capacity_exhausted"
        );
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
    #[test]
    fn declared_route_publication_requires_complete_normalized_names_and_unix() {
        let route = crate::project::RoutingPlan {
            hostnames: vec![
                "search.example.hack".into(),
                "search.example.localhost".into(),
            ],
            port: 6980,
        };
        let exact = vec![
            "Search.Example.Localhost.".into(),
            "search.example.hack".into(),
        ];
        validate_route_publication(Some(&route), 6980, None, &exact).unwrap();
        for (upstream, host_port, names) in [
            (6981, None, exact.clone()),
            (6980, Some(8443), exact.clone()),
            (6980, None, vec![]),
            (6980, None, vec!["search.example.hack".into()]),
            (
                6980,
                None,
                vec![
                    "wrong.example.hack".into(),
                    "search.example.localhost".into(),
                ],
            ),
            (
                6980,
                None,
                vec![
                    "search.example.hack".into(),
                    "Search.Example.Hack.".into(),
                    "search.example.localhost".into(),
                ],
            ),
            (
                6980,
                None,
                vec![
                    "https://search.example.hack".into(),
                    "search.example.localhost".into(),
                ],
            ),
        ] {
            assert_eq!(
                validate_route_publication(Some(&route), upstream, host_port, &names)
                    .unwrap_err()
                    .code,
                "graph_route_publication"
            );
        }
        assert_eq!(
            route.hostnames,
            ["search.example.hack", "search.example.localhost"]
        );
    }

    #[test]
    fn legacy_publication_remains_subject_to_existing_publication_validation() {
        validate_route_publication(None, 3000, Some(8080), &[]).unwrap();
        validate_route_publication(None, 3000, None, &["legacy.example".into()]).unwrap();
    }
}
