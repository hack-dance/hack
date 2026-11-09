//! Owner-only replacement of one retired publication. Every mutation reacquires
//! the provider lease and verifies the same admitted container and attachment.
use super::*;
use crate::provider::engine::ConnectionMode;

#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(in crate::provider::graph) struct Rebind {
    pub slot: u8,
    pub previous: Assignment,
    pub endpoint: GuestEndpoint,
}

fn refused() -> CandidateError {
    error(
        "bridge_rebind_identity",
        "Restart publication ownership changed or is uncertain; values omitted.",
    )
}

/// Only a failed acquisition may defer a tick. The admitted operation runs
/// once; even a provider_busy result from it is uncertainty, never a retry.
fn with_available_lease<L, T>(
    acquire: impl FnOnce() -> Result<L, CandidateError>,
    operation: impl FnOnce(L) -> Result<T, CandidateError>,
) -> Result<Option<T>, CandidateError> {
    let lease = match acquire() {
        Err(error) if error.code == "provider_busy" => return Ok(None),
        result => result?,
    };
    operation(lease).map(Some)
}

/// Route rearm creates/starts an exec, so its lease must admit allocation.
/// Initial enrollment cannot defer; subsequent ticks defer acquisition only.
fn with_probe_lease<L, T>(
    initialize: bool,
    acquire: impl FnOnce(ConnectionMode) -> Result<L, CandidateError>,
    operation: impl FnOnce(L) -> Result<T, CandidateError>,
) -> Result<Option<T>, CandidateError> {
    let acquire = || acquire(ConnectionMode::Allocation);
    if initialize {
        acquire().and_then(operation).map(Some)
    } else {
        with_available_lease(acquire, operation)
    }
}

/// A generation change is permission to retire only when the receipt admitted
/// restarts and the complete endpoint still belongs to the original container.
fn eligible(
    assignment: &Assignment,
    resource: &Resource,
    endpoint: &GuestEndpoint,
    boot: &str,
) -> Result<bool, CandidateError> {
    if resource.restart_policy.is_none() {
        return Ok(false);
    }
    if resource.kind != Kind::Container
        || resource.key != assignment.service
        || resource.id.as_deref() != Some(assignment.container_id.as_str())
        || endpoint.container_id != assignment.container_id
        || endpoint.network_id != assignment.network_id
        || boot != assignment.boot_id
    {
        return Err(refused());
    }
    Ok(endpoint.generation != assignment.generation)
}

#[cfg(target_os = "macos")]
fn current(
    candidate: &Candidate,
    engine: &Engine<'_>,
    selected: &Rebind,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    check()?;
    let snapshot = inspect_using(candidate, engine, &selected.previous.run)?;
    let resource = snapshot
        .receipt
        .resources
        .get(&format!("container:{}", selected.previous.service))
        .ok_or_else(refused)?;
    let endpoint = bridge_endpoint(&snapshot, &selected.previous).ok_or_else(refused)?;
    restart_policy::verify_admitted(
        resource,
        &inspect_resource(engine, &snapshot.receipt, resource)?.ok_or_else(refused)?,
    )?;
    if !eligible(
        &selected.previous,
        resource,
        endpoint,
        engine.guest().boot_id(),
    )? || endpoint.generation != selected.endpoint.generation
    {
        return Err(refused());
    }
    check()
}

/// Read only. `inspect_using` rechecks container identity, owned labels and the
/// complete network attachment through `resolve_attached`; missing readiness
/// does not authorize reuse. No engine-policy-only observation grants authority.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph) fn changed_publications(
    candidate: &Candidate,
    run: &str,
) -> Result<Vec<Rebind>, CandidateError> {
    with_available_lease(
        || Engine::connect_cleanup(candidate),
        |engine| {
            let snapshot = inspect_using(candidate, &engine, run)?;
            let store = load_store(candidate, &engine, false)?;
            let mut changed = Vec::new();
            for (&slot, assignment) in &store.slots {
                if assignment.run != run || assignment.phase != "running" {
                    continue;
                }
                let resource = snapshot
                    .receipt
                    .resources
                    .get(&format!("container:{}", assignment.service))
                    .ok_or_else(refused)?;
                let Some(endpoint) = bridge_endpoint(&snapshot, assignment) else {
                    continue;
                };
                if eligible(assignment, resource, endpoint, engine.guest().boot_id())? {
                    changed.push(Rebind {
                        slot,
                        previous: assignment.clone(),
                        endpoint: endpoint.clone(),
                    });
                }
            }
            Ok(changed)
        },
    )
    .map(Option::unwrap_or_default)
}

/// Fully retire exactly the selected old reservation before the owner reaps its
/// publisher. The old target may already be absent; relay cleanup retains its
/// original launch identity and never targets the restarted container process.
/// Returns false only for pre-effect lease contention; retain the old publisher.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph) fn retire_rebind(
    candidate: &Candidate,
    selected: &Rebind,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<bool, CandidateError> {
    with_available_lease(
        || Engine::connect_cleanup(candidate),
        |engine| {
            let mut store = load_store(candidate, &engine, false)?;
            if store.slots.get(&selected.slot) != Some(&selected.previous) {
                return Err(refused());
            }
            let fence = || current(candidate, &engine, selected, check);
            stop_slot_fenced(
                candidate,
                &engine,
                &mut store,
                selected.slot,
                &fence,
                &|| Ok(()),
            )?;
            fence()?;
            store.slots.remove(&selected.slot);
            save(candidate, &store)
        },
    )
    .map(|retired| retired.is_some())
}

/// Reuse the now-empty slot with a fresh reservation. The owner invokes this
/// only after the exact old publisher has been reaped. A busy host port leaves
/// no assignment and is not automatically retried.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph) fn reserve_rebind(
    candidate: &Candidate,
    selected: &Rebind,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<Assignment, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    current(candidate, &engine, selected, check)?;
    let mut store = load_store(candidate, &engine, false)?;
    if store.slots.contains_key(&selected.slot) {
        return Err(refused());
    }
    if let Some(port) = selected.previous.loopback_port {
        super::super::super::publication::require_loopback_port_free(port.host_port)?;
    }
    let mut assignment = selected.previous.clone();
    assignment.reservation = probes::token()?;
    assignment.generation = selected.endpoint.generation.clone();
    assignment.phase = "reserved".into();
    assignment.relay = None;
    store.slots.insert(selected.slot, assignment.clone());
    let capacity = engine.guest().bridge_intent().ok_or_else(refused)?.slots;
    validate(&store, &store.owner, capacity)?;
    check()?;
    save(candidate, &store)?;
    Ok(assignment)
}

/// Resolve a running route incarnation independently of its exec probe's health.
/// This is observation authority only; publication still requires fresh health.
#[cfg(target_os = "macos")]
fn route_endpoint(
    engine: &Engine<'_>,
    receipt: &Receipt,
    name: &str,
) -> Result<Option<GuestEndpoint>, CandidateError> {
    let resource = receipt
        .resources
        .get(&format!("container:{name}"))
        .ok_or_else(refused)?;
    let route = resource.routing.as_ref().ok_or_else(refused)?;
    let inspected = inspect_resource(engine, receipt, resource)?.ok_or_else(refused)?;
    restart_policy::verify_admitted(resource, &inspected)?;
    if !matches!(observation(&inspected)?, Observation::Running { .. }) {
        return Ok(None);
    }
    let mut networks = BTreeMap::new();
    for (key, network) in receipt
        .resources
        .iter()
        .filter(|(_, r)| r.kind == Kind::Network)
    {
        networks.insert(key.clone(), inspect_resource(engine, receipt, network)?);
    }
    endpoints::resolve_attached(
        &inspected,
        &networks,
        route.port,
        &endpoints::EndpointScope {
            receipt,
            boot: engine.guest().boot_id(),
            service: name,
        },
    )
    .map(Some)
}

/// Seed only after original healthy publication; subsequent ticks can rearm a
/// dead route exec once for each new, ownership-verified endpoint generation.
#[cfg(target_os = "macos")]
pub(in crate::provider::graph) fn supervise_probes(
    candidate: &Candidate,
    run: &str,
    generations: &mut BTreeMap<String, String>,
    initialize: bool,
    check: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    check()?;
    let acquire = |mode| Engine::connect_in_mode(candidate, mode);
    let operation = |engine: Engine<'_>| {
        let (mut receipt, root) = load(candidate, &engine, run)?;
        let names = receipt
            .resources
            .values()
            .filter(|r| r.routing.is_some() && r.restart_policy.is_some())
            .map(|r| r.key.clone())
            .collect::<Vec<_>>();
        for name in names {
            check()?;
            let Some(endpoint) = route_endpoint(&engine, &receipt, &name)? else {
                continue;
            };
            if initialize {
                generations.insert(name, endpoint.generation);
                continue;
            }
            let previous = generations.get(&name).ok_or_else(refused)?;
            if *previous == endpoint.generation {
                continue;
            }
            // Resolve again across each await using the retained original receipt.
            let pinned = receipt.clone();
            let fence = || {
                check()?;
                if route_endpoint(&engine, &pinned, &name)?
                    .is_some_and(|e| e.generation == endpoint.generation)
                {
                    check()
                } else {
                    Err(refused())
                }
            };
            probes::rearm_route(&engine, &mut receipt, &root, &name, &fence)?;
            generations.insert(name, endpoint.generation);
        }
        Ok(())
    };
    with_probe_lease(initialize, acquire, operation).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rearm_fixture() -> (super::super::super::tests::Fixture, Receipt, PathBuf) {
        let fixture = super::super::super::tests::Fixture::new();
        let root = fixture.0.join("rearm");
        state::private_directory(&root).unwrap();
        let receipt = serde_json::from_value(json!({
            "version":2,"run":"b".repeat(32),"owner":"c".repeat(32),"namespace":"synthetic",
            "plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{},
            "resources":{"container:web":{"kind":"container","key":"web","name":"owned",
                "id":"e".repeat(64),"phase":"started","routing":{"hostnames":["web.example.test"],"port":8080},"restart_policy":{"name":"always"}}},
            "probes":{"web":{"config":{"port":8080,"path":"/health","interval_ms":100,"timeout_ms":40,"retries":3,"start_period_ms":0},
                "allocation":"b".repeat(32),"generation":"a".repeat(32),"binary":format!("/storage/hack-native-http-probe/{}","f".repeat(64)),"uid":1000,"gid":1000,"exec_id":"c".repeat(64),"started_ms":1,"phase":"running"}}
        })).unwrap();
        (fixture, receipt, root)
    }

    #[test]
    fn probe_connection_mode_admits_exactly_one_journaled_exec_create_and_start() {
        use std::cell::RefCell;
        let (_fixture, mut receipt, root) = rearm_fixture();
        let posts = RefCell::new(Vec::new());
        let result = with_probe_lease(
            false,
            |mode| {
                assert_eq!(mode, ConnectionMode::Allocation);
                Ok(mode)
            },
            |mode| {
                probes::rearm_after_inactive(
                    &mut receipt,
                    &root,
                    "web",
                    &|| Ok(()),
                    |saved, previous| {
                        assert_eq!(previous, "a".repeat(32));
                        assert_eq!(saved.probes["web"].phase, "exec-intent");
                        let journal: Receipt =
                            state::read_bounded(&root.join("state.json"), 65536)?;
                        assert_eq!(journal.probes["web"].phase, "exec-intent");
                        Ok(())
                    },
                    |method, path, _body| {
                        // This is the same method guard used by Engine::request and request_until.
                        mode.admit(&method)?;
                        assert_eq!(method, Method::POST);
                        posts.borrow_mut().push(path.to_owned());
                        Ok(if path.ends_with("/exec") {
                            json!({"Id":"f".repeat(64)})
                        } else {
                            Value::Null
                        })
                    },
                )
            },
        )
        .unwrap();
        assert!(result.is_some());
        assert_eq!(
            *posts.borrow(),
            vec![
                format!("/v1.53/containers/{}/exec", "e".repeat(64)),
                format!("/v1.53/exec/{}/start", "f".repeat(64))
            ]
        );
        assert_eq!(receipt.probes["web"].phase, "running");
        assert_ne!(receipt.probes["web"].generation, "a".repeat(32));
        for method in [Method::GET, Method::HEAD, Method::DELETE] {
            assert!(ConnectionMode::Cleanup.admit(&method).is_ok());
        }
        assert!(ConnectionMode::Cleanup.admit(&Method::POST).is_err());
    }

    #[test]
    fn probe_acquisition_contention_precedes_intent_preparation_and_dispatch() {
        let (_fixture, mut receipt, root) = rearm_fixture();
        let before = serde_json::to_vec(&receipt).unwrap();
        let result = with_probe_lease(
            false,
            |mode| {
                assert_eq!(mode, ConnectionMode::Allocation);
                Err::<(), _>(error("provider_busy", "Busy lease."))
            },
            |_| {
                probes::rearm_after_inactive(
                    &mut receipt,
                    &root,
                    "web",
                    &|| Ok(()),
                    |_, _| panic!("busy acquisition must not prepare samples"),
                    |_, _, _| panic!("busy acquisition must not dispatch"),
                )
            },
        )
        .unwrap();
        assert!(result.is_none());
        assert_eq!(serde_json::to_vec(&receipt).unwrap(), before);
        assert!(!root.join("state.json").exists());
        let initial: Result<Option<()>, _> = with_probe_lease(
            true,
            |_| Err::<(), _>(error("provider_busy", "Busy lease.")),
            |_| panic!("initial enrollment must not silently defer"),
        );
        assert_eq!(initial.unwrap_err().code, "provider_busy");
    }

    #[test]
    fn unknown_exec_create_cannot_replay_preparation_or_another_post() {
        use std::cell::Cell;
        let (_fixture, mut receipt, root) = rearm_fixture();
        let posts = Cell::new(0);
        assert!(
            probes::rearm_after_inactive(
                &mut receipt,
                &root,
                "web",
                &|| Ok(()),
                |_, _| Ok(()),
                |_, _, _| {
                    posts.set(posts.get() + 1);
                    Err(error("engine_response", "Unknown exec creation."))
                }
            )
            .is_err()
        );
        assert_eq!(receipt.probes["web"].phase, "exec-intent");
        let refused = probes::rearm_after_inactive(
            &mut receipt,
            &root,
            "web",
            &|| Ok(()),
            |_, _| panic!("uncertain intent cannot prepare again"),
            |_, _, _| panic!("uncertain intent cannot dispatch again"),
        );
        assert_eq!(refused.unwrap_err().code, "graph_probe_replay");
        assert_eq!(posts.get(), 1);
    }

    #[test]
    fn inspection_lease_contention_defers_ticks_without_effects_then_admits_once() {
        use std::cell::Cell;
        let fixture = super::super::super::tests::Fixture::new();
        let root = fixture.0.join("provider");
        let held = state::Lock::acquire(&root).unwrap();
        let effects = Cell::new(0);
        for _ in 0..3 {
            let deferred = with_available_lease(
                || state::Lock::acquire_existing(&root),
                |_lease| {
                    effects.set(effects.get() + 1);
                    Ok(())
                },
            )
            .unwrap();
            assert!(deferred.is_none());
            assert_eq!(effects.get(), 0);
        }
        drop(held);
        assert!(
            with_available_lease(
                || state::Lock::acquire_existing(&root),
                |_lease| {
                    effects.set(effects.get() + 1);
                    Ok(())
                },
            )
            .unwrap()
            .is_some()
        );
        assert_eq!(effects.get(), 1);
    }

    #[test]
    fn admitted_busy_or_unknown_outcome_is_not_deferred_or_replayed() {
        use std::cell::Cell;
        let attempts = Cell::new(0);
        for code in ["provider_busy", "graph_foreign_resource", "bridge_relay"] {
            let result = with_available_lease(
                || Ok(()),
                |_| {
                    attempts.set(attempts.get() + 1);
                    Err::<(), _>(error(code, "Uncertain admitted operation."))
                },
            );
            assert_eq!(result.unwrap_err().code, code);
        }
        assert_eq!(attempts.get(), 3);
        let invalid: Result<Option<()>, CandidateError> = with_available_lease(
            || Err::<(), _>(error("provider_owner", "Foreign lease.")),
            |_| panic!("foreign acquisition must not admit work"),
        );
        assert_eq!(invalid.unwrap_err().code, "provider_owner");
    }

    #[test]
    fn changed_generation_requires_receipt_policy_and_original_identity() {
        let mut assignment = Assignment {
            reservation: "a".repeat(32),
            run: "b".repeat(32),
            service: "web".into(),
            generation: "c".repeat(64),
            container_id: "d".repeat(64),
            network_id: "e".repeat(64),
            boot_id: "12345678-1234-1234-1234-123456789abc".into(),
            phase: "running".into(),
            relay: None,
            loopback_port: None,
        };
        let mut resource: Resource = serde_json::from_value(json!({"kind":"container", "key":assignment.service, "name":"owned", "phase":"started", "id":assignment.container_id})).unwrap();
        let mut endpoint = GuestEndpoint {
            generation: "f".repeat(64),
            container_id: assignment.container_id.clone(),
            network_id: assignment.network_id.clone(),
            address: "172.18.0.2".parse().unwrap(),
            port: 3000,
            scope: "guest-only",
            reachability: "not-probed",
        };
        assert!(!eligible(&assignment, &resource, &endpoint, &assignment.boot_id).unwrap());
        resource.restart_policy = Some(restart_policy::RestartPolicy::Always);
        assert!(eligible(&assignment, &resource, &endpoint, &assignment.boot_id).unwrap());
        assignment.generation = endpoint.generation.clone();
        assert!(!eligible(&assignment, &resource, &endpoint, &assignment.boot_id).unwrap());
        endpoint.generation = "e".repeat(64);
        for case in 0..4 {
            let mut foreign = endpoint.clone();
            let mut receipt = resource.clone();
            match case {
                0 => foreign.container_id = "9".repeat(64),
                1 => foreign.network_id = "9".repeat(64),
                2 => receipt.id = Some("9".repeat(64)),
                _ => receipt.key = "foreign".into(),
            }
            assert_eq!(
                eligible(&assignment, &receipt, &foreign, &assignment.boot_id)
                    .unwrap_err()
                    .code,
                "bridge_rebind_identity"
            );
        }
        assert!(eligible(&assignment, &resource, &endpoint, "other-boot").is_err());
    }
}
