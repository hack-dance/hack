//! Durable graph bridge ownership, with explicit relay intent and cleanup phases.
use super::*;
use std::os::unix::fs::DirBuilderExt;

#[cfg(any(test, target_os = "macos"))]
mod restart_rebind;
#[cfg(target_os = "macos")]
pub(super) use restart_rebind::{
    changed_publications, reserve_rebind, retire_rebind, supervise_probes, supervised_service,
};

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
    /// Set for a loopback TCP publication bridge: the reviewed host port and the
    /// container target it forwards to. Absent for route and legacy bridges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loopback_port: Option<LoopbackPort>,
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
            || !services.insert((&a.run, &a.service, a.loopback_port.map(|p| p.host_port)))
            || a.loopback_port
                .is_some_and(|p| p.host_port == 0 || p.target == 0)
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

/// The guest boot ids this run's slots record, from the pool's validated registry
/// (none without a bridge intent). Selection evidence only: dead-owner recovery still
/// matches each against the run's own receipt evidence (`boot_match::receipt_boot`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(in crate::provider) fn run_boots(
    candidate: &Candidate,
    owner: &state::Owner,
    run: &str,
) -> Result<Vec<String>, CandidateError> {
    let Some(intent) = owner.application_bridge else {
        return Ok(Vec::new());
    };
    let store = read_owner_registry(candidate, &owner.token, intent.slots, false)?;
    let mut boots: Vec<String> = Vec::new();
    for assignment in store.slots.values().filter(|a| a.run == run) {
        if !boots.contains(&assignment.boot_id) {
            boots.push(assignment.boot_id.clone());
        }
    }
    Ok(boots)
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

/// The endpoint a bridge forwards to: the route/probe endpoint, or for a
/// loopback publication the container's endpoint at that publication's target.
fn bridge_endpoint<'s>(snapshot: &'s Snapshot, a: &Assignment) -> Option<&'s GuestEndpoint> {
    match a.loopback_port {
        None => snapshot.guest_endpoints.get(&a.service),
        Some(port) => snapshot
            .port_endpoints
            .get(&port_endpoint_key(&a.service, port.target)),
    }
}
/// The bridge fence: the current identity of selected publication targets.
///
/// Endpoints are admitted exactly as [`inspect_using`] admits them (a committed
/// ready graph; route endpoints only while the target's probe is healthy, port
/// endpoints while it is healthy or has no healthcheck) and carry the same
/// generation (owned container id and labels, every declared network attachment,
/// endpoint id, address, start time, guest boot). They are read from one GET per
/// graph network and, per target container, its GET plus, when probed, its probe
/// exec and sample: never the rest of the graph. A target that is absent,
/// stopped, restarting, detached or unhealthy has no endpoint, so every
/// assignment on it reads as stale.
pub(super) struct Targets {
    receipt: Receipt,
    /// Route endpoints, keyed by service, at the service's probe port.
    endpoints: BTreeMap<String, GuestEndpoint>,
    /// Loopback endpoints, keyed by [`port_endpoint_key`].
    port_endpoints: BTreeMap<String, GuestEndpoint>,
    /// Container main process, keyed by service.
    pids: BTreeMap<String, u32>,
    pending_ports: bool,
}

impl Targets {
    fn endpoint(&self, a: &Assignment) -> Option<&GuestEndpoint> {
        match a.loopback_port {
            None => self.endpoints.get(&a.service),
            Some(port) => self
                .port_endpoints
                .get(&port_endpoint_key(&a.service, port.target)),
        }
    }
    fn current(&self, a: &Assignment, boot: &str) -> bool {
        self.endpoint(a)
            .is_some_and(|e| matches_endpoint(a, e, boot))
    }
}

#[cfg(test)]
fn inspect_targets(
    candidate: &Candidate,
    engine: &impl Inspection,
    run: &str,
    services: &std::collections::BTreeSet<&str>,
) -> Result<Targets, CandidateError> {
    inspect_targets_scoped(candidate, engine, run, services, None)
}

fn inspect_targets_scoped(
    candidate: &Candidate,
    engine: &impl Inspection,
    run: &str,
    services: &std::collections::BTreeSet<&str>,
    ready_service: Option<(&str, &str)>,
) -> Result<Targets, CandidateError> {
    let (receipt, root) = load_at(directory(candidate, run)?, run, engine.incarnation())?;
    let mut targets = Targets {
        receipt,
        endpoints: BTreeMap::new(),
        port_endpoints: BTreeMap::new(),
        pids: BTreeMap::new(),
        pending_ports: false,
    };
    let receipt = &targets.receipt;
    // The startup lease holder may inspect exactly the generation reported
    // ready by its scheduler. Standalone publishers still require a ready graph.
    let admitted = match ready_service {
        Some((service, id)) => {
            // A start that returned at started (`started-observed`) still
            // publishes each service as it becomes ready.
            matches!(super::start_phase(receipt), "preparing" | "restoring")
                && services.len() == 1
                && services.contains(service)
                && receipt
                    .resources
                    .get(&format!("container:{service}"))
                    .is_some_and(|r| r.id.as_deref() == Some(id) && r.phase == "started")
        }
        None => receipt.phase == "ready-observed",
    };
    if !admitted
        || root.join("state.pending").exists()
        || root.join("state.pending").is_symlink()
        || startup::require_dependency_rebind_complete(&root, receipt).is_err()
    {
        return Ok(targets);
    }
    let mut networks = BTreeMap::new();
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Network)
    {
        networks.insert(key.clone(), inspect_resource(engine, receipt, resource)?);
    }
    let boot = engine.boot_id()?;
    let mut endpoints = BTreeMap::new();
    let mut port_endpoints = BTreeMap::new();
    let mut pids = BTreeMap::new();
    for service in services {
        let Some(resource) = receipt
            .resources
            .get(&format!("container:{service}"))
            .filter(|r| r.kind == Kind::Container && r.key == *service && r.id.is_some())
        else {
            continue;
        };
        let Some(value) = inspect_resource(engine, receipt, resource)? else {
            continue;
        };
        let observation = probes::observe(engine, receipt, service, &value)?;
        targets.pending_ports |= ready_service.is_some()
            && !resource.loopback_ports.is_empty()
            && observation
                == (Observation::Running {
                    health: Health::Starting,
                });
        if ready_service.is_some()
            && !receipt
                .readiness
                .get(*service)
                .is_some_and(|goal| observation.satisfies(*goal))
        {
            continue;
        }
        if !matches!(observation, Observation::Running { .. })
            || endpoint_network(receipt, &value, &networks)?.is_none()
        {
            continue;
        }
        let scope = endpoints::EndpointScope {
            receipt,
            boot,
            service,
        };
        if observation
            == (Observation::Running {
                health: Health::Healthy,
            })
            && let Some(probe) = receipt.probes.get(*service)
        {
            endpoints.insert(
                (*service).to_owned(),
                endpoints::resolve_attached(&value, &networks, probe.config.port, &scope)?,
            );
        }
        if matches!(
            observation,
            Observation::Running {
                health: Health::Healthy | Health::None
            }
        ) {
            for port in &resource.loopback_ports {
                port_endpoints.insert(
                    port_endpoint_key(service, port.target),
                    endpoints::resolve_attached(&value, &networks, port.target, &scope)?,
                );
            }
        }
        if let Some(pid) = value["State"]["Pid"]
            .as_u64()
            .filter(|p| (2..=i32::MAX as u64).contains(p))
        {
            pids.insert((*service).to_owned(), pid as u32);
        }
    }
    targets.endpoints = endpoints;
    targets.port_endpoints = port_endpoints;
    targets.pids = pids;
    Ok(targets)
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
        if store.slots.values().any(|assignment| {
            assignment.run == run
                && assignment.service == *service
                && assignment.loopback_port.is_none()
        }) {
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

#[cfg(test)]
fn reserve_selected(
    candidate: &Candidate,
    mut store: Store,
    requested: &BTreeMap<String, RouteSlot>,
    capacity: u8,
    run: &str,
    boot_id: &str,
    endpoints: &BTreeMap<String, GuestEndpoint>,
) -> Result<BTreeMap<String, ReservedRoute>, CandidateError> {
    let reserved = add_routes(&mut store, requested, capacity, run, boot_id, endpoints)?;
    validate(&store, &store.owner, capacity)?;
    save(candidate, &store)?;
    Ok(reserved)
}

/// Adds the complete route set to `store` in memory; the caller validates and saves.
#[cfg(any(test, target_os = "macos"))]
fn add_routes(
    store: &mut Store,
    requested: &BTreeMap<String, RouteSlot>,
    capacity: u8,
    run: &str,
    boot_id: &str,
    endpoints: &BTreeMap<String, GuestEndpoint>,
) -> Result<BTreeMap<String, ReservedRoute>, CandidateError> {
    let selected = select_route_slots(store, requested, capacity, run)?;
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
            loopback_port: None,
        };
        store.slots.insert(slot, assignment.clone());
        reserved.insert(service, ReservedRoute { slot, assignment });
    }
    Ok(reserved)
}

/// Reserved bridges of one publication batch: routes by service, loopback
/// publications by reviewed host port.
#[cfg(any(test, target_os = "macos"))]
#[derive(Debug, Default)]
pub(in crate::provider::graph) struct Reserved {
    pub routes: BTreeMap<String, ReservedRoute>,
    pub ports: BTreeMap<u16, ReservedRoute>,
}

/// Reserve the complete route set and one bridge per declared loopback
/// publication against one validated graph snapshot, in one durable registry
/// update under the provider lease. Any refusal, including capacity and
/// `bridge_endpoint_pending`, writes no assignments and starts no relays.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph) fn reserve_publications(
    candidate: &Candidate,
    receipt: &Receipt,
    requested: &BTreeMap<String, RouteSlot>,
    deadline: std::time::Instant,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<Reserved, CandidateError> {
    if requested.len() > 32 {
        return Err(invalid());
    }
    let engine = Engine::connect_for_start(
        candidate,
        super::super::engine::ConnectionMode::Cleanup,
        deadline,
        check,
    )?;
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
    reserve_all(
        candidate,
        store,
        requested,
        capacity,
        &Observed {
            receipt: &snapshot.receipt,
            endpoints: &snapshot.guest_endpoints,
            port_endpoints: &snapshot.port_endpoints,
            observations: &snapshot.observations,
            boot_id: engine.guest().boot_id(),
        },
    )
}

/// The parts of one validated snapshot that a reservation reads.
#[cfg(any(test, target_os = "macos"))]
struct Observed<'a> {
    receipt: &'a Receipt,
    endpoints: &'a BTreeMap<String, GuestEndpoint>,
    port_endpoints: &'a BTreeMap<String, GuestEndpoint>,
    observations: &'a BTreeMap<String, Value>,
    boot_id: &'a str,
}

/// Reserve and start only the service named by the scheduler's ready event.
/// The scheduler keeps its provider lease throughout inspection and mutation.
#[cfg(target_os = "macos")]
pub(super) fn admit_ready_service(
    engine: &Engine<'_>,
    run: &str,
    service: &str,
    container_id: &str,
    route: Option<RouteSlot>,
) -> Result<Vec<(u8, Assignment)>, CandidateError> {
    let candidate = engine.guest().candidate();
    let scope = Some((service, container_id));
    let mut targets =
        inspect_targets_scoped(candidate, engine, run, &BTreeSet::from([service]), scope)?;
    if targets.pending_ports {
        return Err(error(
            "bridge_endpoint_pending",
            "A published port waits for its container's healthcheck; no ports were reserved.",
        ));
    }
    let key = format!("container:{service}");
    targets.receipt.resources.retain(|name, _| name == &key);
    let requested = BTreeMap::from_iter(route.map(|slot| (service.to_owned(), slot)));
    let capacity = engine.guest().bridge_intent().ok_or_else(invalid)?.slots;
    let reserved = reserve_all(
        candidate,
        load_store(candidate, engine, false)?,
        &requested,
        capacity,
        &Observed {
            receipt: &targets.receipt,
            endpoints: &targets.endpoints,
            port_endpoints: &targets.port_endpoints,
            observations: &BTreeMap::new(),
            boot_id: engine.guest().boot_id(),
        },
    )?;
    let selected = reserved
        .routes
        .values()
        .chain(reserved.ports.values())
        .map(|route| (route.slot, route.assignment.reservation.as_str()))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let (digest, input) = relay::payload()?;
    start_selected(
        candidate,
        engine,
        &LeasedRelays {
            candidate,
            engine,
            input: &input,
        },
        &mut load_store(candidate, engine, false)?,
        StartSelection {
            run,
            selected: &selected,
            ready_service: scope,
        },
        &digest,
    )
}

#[cfg(any(test, target_os = "macos"))]
fn reserve_all(
    candidate: &Candidate,
    mut store: Store,
    requested: &BTreeMap<String, RouteSlot>,
    capacity: u8,
    observed: &Observed<'_>,
) -> Result<Reserved, CandidateError> {
    let mut reserved = Reserved::default();
    if !requested.is_empty() {
        reserved.routes = add_routes(
            &mut store,
            requested,
            capacity,
            &observed.receipt.run,
            observed.boot_id,
            observed.endpoints,
        )?;
    }
    reserved.ports = add_loopback_ports(
        &mut store,
        capacity,
        observed.receipt,
        observed.port_endpoints,
        observed.observations,
        observed.boot_id,
    )?;
    if reserved.routes.is_empty() && reserved.ports.is_empty() {
        return Ok(reserved);
    }
    validate(&store, &store.owner, capacity)?;
    save(candidate, &store)?;
    Ok(reserved)
}

/// Loopback publications alone; kept for the native fixtures that reserve them. Those fixtures
/// are built only with the environment launcher feature, so this is too.
#[cfg(all(test, target_os = "macos", feature = "environment-launcher"))]
pub(in crate::provider::graph) fn reserve_loopback_ports(
    candidate: &Candidate,
    receipt: &Receipt,
) -> Result<BTreeMap<u16, ReservedRoute>, CandidateError> {
    reserve_publications(
        candidate,
        receipt,
        &BTreeMap::new(),
        std::time::Instant::now() + super::super::lifecycle::STARTUP_LEASE_WAIT,
        &|| Ok(()),
    )
    .map(|reserved| reserved.ports)
}

/// A container whose own healthcheck is still `starting` has no committed port
/// endpoint yet, but may still become ready within the caller's startup deadline;
/// `started` readiness does not wait for health. Every other missing endpoint is
/// a refusal the caller must not wait out.
#[cfg(any(test, target_os = "macos"))]
fn loopback_endpoint_pending(observation: Option<&Value>) -> bool {
    observation.and_then(|value| serde_json::from_value::<Observation>(value.clone()).ok())
        == Some(Observation::Running {
            health: Health::Starting,
        })
}

/// Keys of `port_endpoints` are [`port_endpoint_key`]s; `observations` are keyed
/// like `receipt.resources`. Refusal writes no assignments. A missing endpoint
/// is `bridge_endpoint_pending` only while its container's health is starting.
#[cfg(test)]
fn reserve_loopback_selected(
    candidate: &Candidate,
    mut store: Store,
    capacity: u8,
    receipt: &Receipt,
    port_endpoints: &BTreeMap<String, GuestEndpoint>,
    observations: &BTreeMap<String, Value>,
    boot_id: &str,
) -> Result<BTreeMap<u16, ReservedRoute>, CandidateError> {
    let reserved = add_loopback_ports(
        &mut store,
        capacity,
        receipt,
        port_endpoints,
        observations,
        boot_id,
    )?;
    if reserved.is_empty() {
        return Ok(reserved);
    }
    validate(&store, &store.owner, capacity)?;
    save(candidate, &store)?;
    Ok(reserved)
}

/// Adds one bridge per declared loopback publication to `store` in memory; the
/// caller validates and saves.
#[cfg(any(test, target_os = "macos"))]
fn add_loopback_ports(
    store: &mut Store,
    capacity: u8,
    receipt: &Receipt,
    port_endpoints: &BTreeMap<String, GuestEndpoint>,
    observations: &BTreeMap<String, Value>,
    boot_id: &str,
) -> Result<BTreeMap<u16, ReservedRoute>, CandidateError> {
    let run = &receipt.run;
    let mut used = store
        .slots
        .keys()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut reserved = BTreeMap::new();
    for (key, resource) in receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Container)
    {
        for port in &resource.loopback_ports {
            if store.slots.values().any(|a| {
                a.run == *run
                    && a.service == resource.key
                    && a.loopback_port.map(|p| p.host_port) == Some(port.host_port)
            }) {
                return Err(error(
                    "bridge_slot_busy",
                    "The published port is already reserved; no reassignment was attempted.",
                ));
            }
            let endpoint = port_endpoints
                .get(&port_endpoint_key(&resource.key, port.target))
                .ok_or_else(|| {
                    if loopback_endpoint_pending(observations.get(key)) {
                        error(
                            "bridge_endpoint_pending",
                            "A published port waits for its container's healthcheck; no ports were reserved.",
                        )
                    } else {
                        error(
                            "bridge_endpoint_unavailable",
                            "A published port requires a running, ready owned container endpoint.",
                        )
                    }
                })?;
            let slot = (0..capacity).find(|slot| !used.contains(slot)).ok_or_else(|| {
                error(
                    "bridge_capacity_exhausted",
                    "No free application bridge socket remains in this pool; no ports were reserved.",
                )
            })?;
            used.insert(slot);
            let assignment = Assignment {
                reservation: probes::token()?,
                run: run.clone(),
                service: resource.key.clone(),
                generation: endpoint.generation.clone(),
                container_id: endpoint.container_id.clone(),
                network_id: endpoint.network_id.clone(),
                boot_id: boot_id.into(),
                phase: "reserved".into(),
                relay: None,
                loopback_port: Some(*port),
            };
            store.slots.insert(slot, assignment.clone());
            reserved.insert(port.host_port, ReservedRoute { slot, assignment });
        }
    }
    Ok(reserved)
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
        || store.slots.values().any(|a| {
            a.run == options.run && a.service == options.service && a.loopback_port.is_none()
        })
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
        loopback_port: None,
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
    let mut started = start_bridges(
        candidate,
        run,
        &[(slot, reservation)],
        std::time::Instant::now() + super::super::lifecycle::STARTUP_LEASE_WAIT,
        &|| Ok(()),
    )?;
    started.pop().map(|(_, a)| a).ok_or_else(invalid)
}

/// Start the relays of several reserved slots of one run under one provider
/// lease. See [`start_selected`] for the fences and durable phases.
pub(in crate::provider::graph) fn start_bridges(
    candidate: &Candidate,
    run: &str,
    selected: &[(u8, &str)],
    deadline: std::time::Instant,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<Vec<(u8, Assignment)>, CandidateError> {
    if selected.is_empty()
        || selected.len() > 32
        || selected
            .iter()
            .any(|(_, reservation)| !hex(reservation, 32))
    {
        return Err(invalid());
    }
    let (digest, input) = relay::payload()?;
    let engine = Engine::connect_for_start(
        candidate,
        super::super::engine::ConnectionMode::Allocation,
        deadline,
        check,
    )?;
    let mut store = load_store(candidate, &engine, false)?;
    start_selected(
        candidate,
        &engine,
        &LeasedRelays {
            candidate,
            engine: &engine,
            input: &input,
        },
        &mut store,
        StartSelection {
            run,
            selected,
            ready_service: None,
        },
        &digest,
    )
}

/// Guest effects of a relay batch; the caller holds the provider lease throughout.
trait RelayGuest {
    fn boot_id(&self) -> &str;
    /// Start ticks of each process, in order.
    fn target_starts(&self, pids: &[u32]) -> Result<Vec<u64>, CandidateError>;
    /// Start every relay; all must confirm `running`.
    fn start_relays(&self, selected: &[(u8, &Assignment)]) -> Result<(), CandidateError>;
    /// The ordinary durable stop of one started slot.
    fn stop_slot(&self, store: &mut Store, slot: u8) -> Result<(), CandidateError>;
}

struct LeasedRelays<'a, 'e> {
    candidate: &'a Candidate,
    engine: &'a Engine<'e>,
    input: &'a str,
}

impl RelayGuest for LeasedRelays<'_, '_> {
    fn boot_id(&self) -> &str {
        self.engine.guest().boot_id()
    }
    fn target_starts(&self, pids: &[u32]) -> Result<Vec<u64>, CandidateError> {
        relay::target_starts(self.engine, pids)
    }
    fn start_relays(&self, selected: &[(u8, &Assignment)]) -> Result<(), CandidateError> {
        relay::start_all(self.engine, selected, self.input)
    }
    fn stop_slot(&self, store: &mut Store, slot: u8) -> Result<(), CandidateError> {
        stop_slot(self.candidate, self.engine, store, slot)
    }
}

/// The per-slot sequence of the former single start, applied to the whole batch:
///
/// 1. fence: every target is current (else refuse; nothing written);
/// 2. read each target's start ticks (one guest call);
/// 3. fence again, so each pid belongs to the fenced generation (else refuse);
/// 4. record every relay intent as `starting` (one journal save) before any effect;
/// 5. start every relay (one guest call);
/// 6. fence again: current slots become `running`; a slot whose target changed is
///    stopped through the ordinary durable stop, and the batch refuses.
///
/// A refusal after step 4 leaves every intent recorded for the caller's cleanup,
/// exactly as a refused single start did.
struct StartSelection<'a> {
    run: &'a str,
    selected: &'a [(u8, &'a str)],
    ready_service: Option<(&'a str, &'a str)>,
}

fn start_selected(
    candidate: &Candidate,
    inspection: &impl Inspection,
    guest: &impl RelayGuest,
    store: &mut Store,
    selection: StartSelection<'_>,
    digest: &str,
) -> Result<Vec<(u8, Assignment)>, CandidateError> {
    let StartSelection {
        run,
        selected,
        ready_service,
    } = selection;
    let inspect = |services: &std::collections::BTreeSet<&str>| {
        inspect_targets_scoped(candidate, inspection, run, services, ready_service)
    };
    let mut picked = BTreeMap::new();
    for (slot, reservation) in selected {
        let a = store
            .slots
            .get(slot)
            .filter(|a| a.run == run && a.reservation == *reservation && a.phase == "reserved")
            .ok_or_else(|| {
                error(
                    "bridge_reservation_changed",
                    "Expected an exact reserved slot; no launch was replayed.",
                )
            })?;
        if picked.insert(*slot, a.clone()).is_some() {
            return Err(invalid());
        }
    }
    let services = picked
        .values()
        .map(|a| a.service.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let boot = guest.boot_id();
    let stale = |targets: &Targets| {
        picked
            .iter()
            .filter(|(_, a)| !targets.current(a, boot))
            .map(|(slot, _)| *slot)
            .collect::<Vec<_>>()
    };
    let fenced = inspect(&services)?;
    if !stale(&fenced).is_empty() {
        return Err(error(
            "bridge_generation_stale",
            "Endpoint changed before relay startup.",
        ));
    }
    let pids = picked
        .values()
        .map(|a| fenced.pids.get(&a.service).copied())
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| error("bridge_target", "Target has no live process identity."))?;
    let starts = guest.target_starts(&pids)?;
    if starts.len() != pids.len() {
        return Err(error(
            "bridge_target",
            "Cannot establish target process identity.",
        ));
    }
    if !stale(&inspect(&services)?).is_empty() {
        return Err(error(
            "bridge_generation_stale",
            "Endpoint changed during target verification.",
        ));
    }
    if store
        .next_launch_serial
        .checked_add(picked.len() as u64)
        .is_none_or(|last| last > i64::MAX as u64)
    {
        return Err(error(
            "bridge_serial_exhausted",
            "Bridge launch serials are exhausted; no launch was attempted.",
        ));
    }
    for ((slot, a), (pid, start)) in picked.iter().zip(pids.into_iter().zip(starts)) {
        let port = fenced.endpoint(a).expect("fenced endpoint").port;
        store.next_launch_serial += 1;
        let entry = store.slots.get_mut(slot).expect("picked slot");
        entry.relay = Some(relay::Relay {
            transport: relay::Transport::ReservationV1,
            launch_serial: store.next_launch_serial,
            binary_sha256: digest.into(),
            target_pid: pid,
            target_start: start,
            port,
        });
        entry.phase = "starting".into();
    }
    save(candidate, store)?;
    let launched = picked
        .keys()
        .map(|slot| (*slot, &store.slots[slot]))
        .collect::<Vec<_>>();
    guest.start_relays(&launched)?;
    let changed = stale(&inspect(&services)?);
    for slot in picked.keys().filter(|slot| !changed.contains(slot)) {
        store.slots.get_mut(slot).expect("picked slot").phase = "running".into();
    }
    if changed.is_empty() {
        save(candidate, store)?;
    } else {
        // Each stop saves the store, which also commits the running phases above.
        for slot in &changed {
            guest.stop_slot(store, *slot)?;
        }
        return Err(error(
            "bridge_generation_stale",
            "Endpoint changed during startup; relay was stopped.",
        ));
    }
    Ok(picked
        .keys()
        .map(|slot| (*slot, store.slots[slot].clone()))
        .collect())
}
/// A loopback publication bridge authorizes exactly its reviewed host port over
/// TCP, forwarding to its reviewed target; never hostnames or another port.
fn validate_loopback_publication(
    resource: &Resource,
    loopback: LoopbackPort,
    upstream_port: u16,
    host_port: Option<u16>,
    hostnames: &[String],
) -> Result<(), CandidateError> {
    if !resource.loopback_ports.contains(&loopback)
        || upstream_port != loopback.target
        || host_port != Some(loopback.host_port)
        || !hostnames.is_empty()
    {
        return Err(error(
            "graph_port_publication",
            "Publication differs from the graph's declared loopback port.",
        ));
    }
    Ok(())
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
/// How long a publisher child waits for the provider lease. A foreground owner
/// starts every child of a batch at once; they take the lease in turn.
const PUBLISH_LEASE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
const PUBLISH_LEASE_POLL: std::time::Duration = std::time::Duration::from_millis(5);

/// Takes the provider lease, waiting only while another holder has it.
/// Acquisition admits nothing; every check below runs after it.
fn connect_waiting(candidate: &Candidate) -> Result<Engine<'_>, CandidateError> {
    let deadline = std::time::Instant::now() + PUBLISH_LEASE_WAIT;
    loop {
        match Engine::connect(candidate) {
            Err(error) if error.code == "provider_busy" && std::time::Instant::now() < deadline => {
                std::thread::sleep(PUBLISH_LEASE_POLL);
            }
            outcome => return outcome,
        }
    }
}

/// Publisher child: under the provider lease, fence the one target, confirm its
/// relay and launch (exec) the host publication.
pub fn publish_bridge(
    candidate: &Candidate,
    run: &str,
    slot: u8,
    reservation: &str,
    port: Option<u16>,
    hostnames: &[String],
) -> Result<(), CandidateError> {
    let engine = connect_waiting(candidate)?;
    let upstream = publication_upstream(&engine, run, slot, reservation, port, hostnames, None)?;
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

/// Revalidate the exact frontend and relay under the caller's provider lease.
pub(super) fn publication_upstream(
    engine: &Engine<'_>,
    run: &str,
    slot: u8,
    reservation: &str,
    port: Option<u16>,
    hostnames: &[String],
    ready_service: Option<(&str, &str)>,
) -> Result<std::path::PathBuf, CandidateError> {
    let candidate = engine.guest().candidate();
    let store = load_store(candidate, engine, false)?;
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
    let targets = inspect_targets_scoped(
        candidate,
        engine,
        run,
        &std::collections::BTreeSet::from([a.service.as_str()]),
        ready_service,
    )?;
    if !targets.current(a, engine.guest().boot_id())
        || relay::operate(engine, slot, a, "inspect", None)? != "running"
    {
        return Err(invalid());
    }
    let resource = targets
        .receipt
        .resources
        .get(&format!("container:{}", a.service))
        .filter(|resource| resource.kind == Kind::Container && resource.key == a.service)
        .ok_or_else(invalid)?;
    let upstream_port = a.relay.as_ref().ok_or_else(invalid)?.port;
    match a.loopback_port {
        Some(loopback) => {
            validate_loopback_publication(resource, loopback, upstream_port, port, hostnames)?;
            super::super::publication::require_loopback_port_free(loopback.host_port)?;
        }
        None => {
            validate_route_publication(resource.routing.as_ref(), upstream_port, port, hostnames)?
        }
    }
    Ok(engine
        .guest()
        .engine_socket()?
        .with_file_name(format!("bridge-{slot:02}.sock")))
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
            let current = bridge_endpoint(&snapshot, a)
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
    release_selected(
        candidate,
        &LeasedRelease { candidate, engine },
        &mut store,
        &receipt.run,
    )
}

/// Effects of releasing one run's bridges; the caller holds the provider lease.
trait ReleaseGuest {
    fn boot_id(&self) -> &str;
    /// Retire the host publications of these reservations of `run`.
    fn release_publications(
        &self,
        run: &str,
        reservations: &std::collections::BTreeSet<&str>,
    ) -> Result<(), CandidateError>;
    /// `stop` or `remove` every selected relay; each must confirm.
    fn relays(&self, action: &str, selected: &[(u8, &Assignment)]) -> Result<(), CandidateError>;
    /// Test pause point between the guest stop and its durable `stopped` phase.
    fn after_guest_stop(&self, run: &str) -> Result<(), CandidateError>;
}

struct LeasedRelease<'a, 'e> {
    candidate: &'a Candidate,
    engine: &'a Engine<'e>,
}

impl ReleaseGuest for LeasedRelease<'_, '_> {
    fn boot_id(&self) -> &str {
        self.engine.guest().boot_id()
    }
    fn release_publications(
        &self,
        run: &str,
        reservations: &std::collections::BTreeSet<&str>,
    ) -> Result<(), CandidateError> {
        super::super::publication::release_reservations(
            self.candidate,
            self.engine.guest().incarnation(),
            run,
            reservations,
        )
    }
    fn relays(&self, action: &str, selected: &[(u8, &Assignment)]) -> Result<(), CandidateError> {
        relay::operate_all(self.engine, selected, action, None)
    }
    fn after_guest_stop(&self, _run: &str) -> Result<(), CandidateError> {
        #[cfg(test)]
        fault_pause(
            &directory(self.candidate, _run)?,
            _run,
            "bridge-normalization-after-guest-stop",
        )?;
        Ok(())
    }
}

/// [`stop_slot`] for every slot of one run, phase by phase instead of slot by
/// slot. Each slot passes through the same durable phases in the same order:
///
/// 1. host publications retired (all at once, before any guest effect);
/// 2. `stopping` recorded for every same-boot relay (one save); a relay from an
///    earlier guest boot is recorded `stopped`, since boot-local guest state is gone;
/// 3. every same-boot relay stopped (one guest call), then `stopped` (one save);
/// 4. every same-boot allocation removed (one guest call);
/// 5. every slot of the run dropped from the registry (one save).
///
/// A refusal leaves each slot at its last recorded phase. Stop and remove are
/// idempotent per slot, so the next release resumes from there, as before.
fn release_selected(
    candidate: &Candidate,
    guest: &impl ReleaseGuest,
    store: &mut Store,
    run: &str,
) -> Result<(), CandidateError> {
    let selected = owned_slots(store, run);
    if selected.is_empty() {
        return Ok(());
    }
    let reservations = selected
        .iter()
        .map(|slot| store.slots[slot].reservation.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    guest.release_publications(run, &reservations)?;
    let boot = guest.boot_id().to_owned();
    let mut stopping = Vec::new();
    let mut removing = Vec::new();
    let mut changed = false;
    for slot in &selected {
        let a = store.slots.get_mut(slot).expect("owned slot");
        if a.relay.is_none() {
            continue;
        }
        if a.boot_id != boot {
            changed |= a.phase != "stopped";
            a.phase = "stopped".into();
            continue;
        }
        if a.phase != "stopped" {
            a.phase = "stopping".into();
            changed = true;
            stopping.push(*slot);
        }
        removing.push(*slot);
    }
    if changed {
        save(candidate, store)?;
    }
    if !stopping.is_empty() {
        let batch = stopping
            .iter()
            .map(|slot| (*slot, &store.slots[slot]))
            .collect::<Vec<_>>();
        guest.relays("stop", &batch)?;
        guest.after_guest_stop(run)?;
        for slot in &stopping {
            store.slots.get_mut(slot).expect("owned slot").phase = "stopped".into();
        }
        save(candidate, store)?;
    }
    if !removing.is_empty() {
        let batch = removing
            .iter()
            .map(|slot| (*slot, &store.slots[slot]))
            .collect::<Vec<_>>();
        guest.relays("remove", &batch)?;
    }
    for slot in &selected {
        store.slots.remove(slot);
    }
    save(candidate, store)
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
                    loopback_port: None,
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
    fn loopback_bridges_coexist_with_routes_but_own_one_host_port_each() {
        let mut store = fixture();
        let loopback = |host_port, target| {
            let mut a = store.slots[&0].clone();
            a.reservation = format!("{host_port:032x}");
            a.loopback_port = Some(LoopbackPort { host_port, target });
            a
        };
        let first = loopback(8787, 3000);
        let second = loopback(8788, 3000);
        store.slots.insert(1, first.clone());
        store.slots.insert(2, second);
        validate(&store, "owner", 4).unwrap();
        // The route bridge for the same service still counts as that service's route.
        let requests = BTreeMap::from([("web".into(), RouteSlot::Auto)]);
        assert_eq!(
            select_route_slots(&store, &requests, 4, &"b".repeat(32))
                .unwrap_err()
                .code,
            "bridge_slot_busy"
        );
        store.slots.remove(&0);
        assert_eq!(
            select_route_slots(&store, &requests, 4, &"b".repeat(32)).unwrap()["web"],
            0
        );
        let mut duplicate = first.clone();
        duplicate.reservation = "f".repeat(32);
        store.slots.insert(3, duplicate);
        assert!(validate(&store, "owner", 4).is_err());
        store.slots.remove(&3);
        let mut zero = first;
        zero.reservation = "e".repeat(32);
        zero.loopback_port = Some(LoopbackPort {
            host_port: 9999,
            target: 0,
        });
        store.slots.insert(3, zero);
        assert!(validate(&store, "owner", 4).is_err());
    }
    #[test]
    fn loopback_publication_authorizes_only_its_reviewed_port_and_target() {
        let port = LoopbackPort {
            host_port: 8787,
            target: 3000,
        };
        let resource = Resource {
            routing: None,
            loopback_ports: vec![port],
            networks: None,
            outbound: false,
            cache: None,
            cache_provenance: None,
            disposable_caches: Vec::new(),
            restart_policy: None,
            kind: Kind::Container,
            key: "web".into(),
            name: "owned-web".into(),
            id: None,
            cleanup_observed_create: false,
            image: None,
            phase: "running".into(),
            amd64_emulation: None,
        };
        validate_loopback_publication(&resource, port, 3000, Some(8787), &[]).unwrap();
        for (upstream, host, hostnames) in [
            (3001, Some(8787), vec![]),
            (3000, Some(8788), vec![]),
            (3000, None, vec![]),
            (3000, Some(8787), vec!["web.example".to_owned()]),
        ] {
            assert_eq!(
                validate_loopback_publication(&resource, port, upstream, host, &hostnames)
                    .unwrap_err()
                    .code,
                "graph_port_publication"
            );
        }
        let undeclared = LoopbackPort {
            host_port: 9090,
            target: 3000,
        };
        assert!(
            validate_loopback_publication(&resource, undeclared, 3000, Some(9090), &[]).is_err()
        );
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
    fn loopback_reservation_waits_only_for_starting_health_and_commits_atomically() {
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
        let receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":run,"owner":owner,
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"ready-observed","readiness":{"web":"started"},
            "resources":{"container:web":{
                "kind":"container","key":"web","name":"owned-web","id":"d".repeat(64),
                "phase":"started","loopback_ports":[{"host_port":8787,"target":3000}]
            }}
        }))
        .unwrap();
        let reserve = |endpoints: &BTreeMap<String, GuestEndpoint>, observation: Value| {
            reserve_loopback_selected(
                &candidate,
                read_owner_registry(&candidate, &owner, 3, false).unwrap(),
                3,
                &receipt,
                endpoints,
                &BTreeMap::from([("container:web".to_owned(), observation)]),
                boot,
            )
        };
        let none = BTreeMap::new();
        // `started` readiness can complete while an image healthcheck is starting:
        // that is the one refusal the foreground publisher waits out.
        for (observation, code) in [
            (
                json!({"state":"running","health":"starting"}),
                "bridge_endpoint_pending",
            ),
            (
                json!({"state":"running","health":"unhealthy"}),
                "bridge_endpoint_unavailable",
            ),
            (
                json!({"state":"exited","code":1}),
                "bridge_endpoint_unavailable",
            ),
            (json!({"state":"absent"}), "bridge_endpoint_unavailable"),
        ] {
            assert_eq!(reserve(&none, observation).unwrap_err().code, code);
            assert_eq!(
                fs::read(root(&candidate).join("state.json")).unwrap(),
                before
            );
        }
        let endpoints = BTreeMap::from([(
            port_endpoint_key("web", 3000),
            GuestEndpoint {
                generation: "c".repeat(64),
                container_id: "d".repeat(64),
                network_id: "e".repeat(64),
                address: "172.17.0.2".parse().unwrap(),
                port: 3000,
                scope: "guest-only",
                reachability: "not-probed",
            },
        )]);
        let reserved = reserve(&endpoints, json!({"state":"running","health":"healthy"})).unwrap();
        assert_eq!(reserved[&8787].slot, 1);
        let persisted = read_owner_registry(&candidate, &owner, 3, false).unwrap();
        assert_eq!(
            persisted.slots[&1].loopback_port,
            Some(LoopbackPort {
                host_port: 8787,
                target: 3000
            })
        );
        assert_eq!(persisted.slots[&1].run, run);
        assert_eq!(persisted.slots[&0].run, "b".repeat(32));
    }
    #[test]
    fn missing_ready_endpoints_refuse_new_routes_without_retiring_running_relays() {
        let fixture_root = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture_root.0).unwrap();
        let owner = "a".repeat(32);
        let run = "f".repeat(32);
        let boot = "12345678-1234-1234-1234-123456789abc";
        initialize_registry(&candidate, &owner, 3).unwrap();
        let mut store = fixture();
        store.owner = owner.clone();
        let existing = store.slots.get_mut(&0).unwrap();
        existing.phase = "running".into();
        existing.relay = Some(relay::Relay {
            transport: relay::Transport::ReservationV1,
            launch_serial: 1,
            binary_sha256: "f".repeat(64),
            target_pid: 42,
            target_start: 123,
            port: 3000,
        });
        store.next_launch_serial = 1;
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
        assert_eq!(persisted.slots[&0].phase, "running");
        assert_eq!(persisted.slots[&0].relay.as_ref().unwrap().launch_serial, 1);
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

#[cfg(test)]
#[path = "bridges/batch_tests.rs"]
mod batch_tests;
