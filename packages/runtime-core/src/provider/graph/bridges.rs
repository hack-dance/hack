//! Durable reservations only. No relay may be launched from these receipts yet.
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
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    owner: String,
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
    if store.version != 1 || store.owner != owner || store.slots.len() > capacity as usize {
        return Err(invalid());
    }
    let mut services = std::collections::BTreeSet::new();
    let mut reservations = std::collections::BTreeSet::new();
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
            || a.phase != "reserved"
        {
            return Err(invalid());
        }
    }
    Ok(())
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
    };
    store.slots.insert(options.slot, assignment.clone());
    save(candidate, &store)?;
    Ok(assignment)
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
            let current = a.boot_id == engine.guest().boot_id()
                && snapshot.guest_endpoints.get(&a.service).is_some_and(|e| {
                    e.generation == a.generation
                        && e.container_id == a.container_id
                        && e.network_id == a.network_id
                });
            (
                slot.to_string(),
                json!({"assignment":a,"current":current,"relay_started":false}),
            )
        })
        .collect::<BTreeMap<_, _>>();
    Ok(json!({"run":run,"slots":slots,"scope":"reservation-only"}))
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
    let before = store.slots.len();
    store.slots.retain(|_, a| a.run != receipt.run);
    if store.slots.len() != before {
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
    Ok(json!({"retained":retained,"replayed":false,"scope":"reservation-only"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Store {
        Store {
            version: 1,
            owner: "owner".into(),
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
                },
            )]),
        }
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
