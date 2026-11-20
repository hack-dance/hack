//! One publication batch: one reservation, one relay start, three identity
//! fences, and a target that restarts at each fence.
use super::*;
use std::cell::{Cell, RefCell};

const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN: &str = "ffffffffffffffffffffffffffffffff";
const BOOT: &str = "12345678-1234-1234-1234-123456789abc";
const NETWORK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const WEB: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const API: &str = "4444444444444444444444444444444444444444444444444444444444444444";

fn receipt() -> Receipt {
    let image = format!("sha256:{}", "3".repeat(64));
    serde_json::from_value(json!({
        "version":1,"run":RUN,"owner":OWNER,
        "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
        "phase":"ready-observed","readiness":{"web":"started","api":"started"},
        "resources":{
            "network:default":{"kind":"network","key":"default",
                "name":format!("hkg-{RUN}-network-0"),"id":NETWORK,"phase":"created"},
            "container:web":{"kind":"container","key":"web",
                "name":format!("hkg-{RUN}-container-0"),"id":WEB,"image":image,"phase":"started",
                "routing":{"hostnames":["web.example.test"],"port":8080}},
            "container:api":{"kind":"container","key":"api",
                "name":format!("hkg-{RUN}-container-1"),"id":API,"image":image,"phase":"started",
                "loopback_ports":[{"host_port":8787,"target":3000}]}
        },
        "probes":{"web":{"config":{"port":8080,"path":"/health","interval_ms":100,"timeout_ms":40,
            "retries":3,"start_period_ms":0},
            "allocation":"b".repeat(32),"generation":"a".repeat(32),
            "binary":format!("/storage/hack-native-http-probe/{}","f".repeat(64)),
            "uid":1000,"gid":1000,"exec_id":"c".repeat(64),"started_ms":1,"phase":"running"}}
    }))
    .unwrap()
}

/// A guest engine whose containers restart when the test says so: a restart
/// changes the start time and main pid, as the real engine does.
struct Guest {
    receipt: Receipt,
    restarts: RefCell<BTreeMap<String, u32>>,
    /// (stage, service): restart `service` when the batch reaches `stage`.
    restart_at: Cell<Option<(&'static str, &'static str)>>,
    gets: Cell<usize>,
    target_calls: RefCell<Vec<Vec<u32>>>,
    relay_calls: RefCell<Vec<Vec<u8>>>,
    stopped: RefCell<Vec<u8>>,
    candidate: Candidate,
}

impl Guest {
    fn new(candidate: Candidate) -> Self {
        Self {
            receipt: receipt(),
            restarts: RefCell::default(),
            restart_at: Cell::new(None),
            gets: Cell::new(0),
            target_calls: RefCell::default(),
            relay_calls: RefCell::default(),
            stopped: RefCell::default(),
            candidate,
        }
    }
    fn stage(&self, stage: &str) {
        if let Some((at, service)) = self.restart_at.get()
            && at == stage
        {
            *self
                .restarts
                .borrow_mut()
                .entry(service.into())
                .or_default() += 1;
        }
    }
    fn address(service: &str) -> &'static str {
        if service == "web" {
            "172.18.0.2"
        } else {
            "172.18.0.3"
        }
    }
}

impl Inspection for Guest {
    fn incarnation(&self) -> &str {
        OWNER
    }
    fn boot_id(&self) -> Result<&str, CandidateError> {
        Ok(BOOT)
    }
    fn verify(&self) -> Result<(), CandidateError> {
        Ok(())
    }
    fn get(&self, path: &str) -> Result<Value, CandidateError> {
        self.gets.set(self.gets.get() + 1);
        let network = &self.receipt.resources["network:default"];
        let endpoint =
            |service: &str| format!("{:0>64}", if service == "web" { "e1" } else { "e2" });
        if path == format!("/v1.53/networks/{NETWORK}") {
            return Ok(
                json!({"Id":NETWORK,"Name":network.name,"Driver":"bridge","Internal":true,
                "Labels":expected_labels(&self.receipt, network),
                "Containers":{
                    WEB:{"EndpointID":endpoint("web"),"IPv4Address":"172.18.0.2/16"},
                    API:{"EndpointID":endpoint("api"),"IPv4Address":"172.18.0.3/16"}}}),
            );
        }
        let service = if path == format!("/v1.53/containers/{WEB}/json") {
            "web"
        } else if path == format!("/v1.53/containers/{API}/json") {
            "api"
        } else {
            panic!("unexpected engine request {path}");
        };
        let resource = &self.receipt.resources[&format!("container:{service}")];
        let restarts = self.restarts.borrow().get(service).copied().unwrap_or(0);
        Ok(
            json!({"Id":resource.id,"Name":format!("/{}",resource.name),"Image":resource.image,
            "Config":{"Labels":expected_labels(&self.receipt, resource)},
            "State":{"Running":true,"Restarting":false,"Pid":100 + 10 * restarts + u32::from(service == "api"),
                "StartedAt":format!("2026-11-20T00:00:{restarts:02}Z")},
            "HostConfig":{"NetworkMode":network.name},
            "NetworkSettings":{"Networks":{network.name.clone():{"NetworkID":NETWORK,
                "EndpointID":endpoint(service),"IPAddress":Self::address(service)}}}}),
        )
    }
    fn probe_status(&self, _: &str) -> Result<Option<String>, CandidateError> {
        panic!("the bridge fence never samples health")
    }
}

impl RelayGuest for Guest {
    fn boot_id(&self) -> &str {
        BOOT
    }
    fn target_starts(&self, pids: &[u32]) -> Result<Vec<u64>, CandidateError> {
        self.target_calls.borrow_mut().push(pids.to_vec());
        self.stage("target_starts");
        Ok(pids.iter().map(|pid| u64::from(*pid) * 7).collect())
    }
    fn start_relays(&self, selected: &[(u8, &Assignment)]) -> Result<(), CandidateError> {
        assert!(selected.iter().all(|(_, a)| a.phase == "starting"));
        // Intent precedes the effect: the starting phases are already durable.
        let durable = read_owner_registry(&self.candidate, OWNER, 4, false).unwrap();
        assert!(
            selected
                .iter()
                .all(|(slot, _)| durable.slots[slot].phase == "starting")
        );
        self.relay_calls
            .borrow_mut()
            .push(selected.iter().map(|(slot, _)| *slot).collect());
        self.stage("start_relays");
        Ok(())
    }
    fn stop_slot(&self, store: &mut Store, slot: u8) -> Result<(), CandidateError> {
        self.stopped.borrow_mut().push(slot);
        store.slots.get_mut(&slot).unwrap().phase = "stopped".into();
        save(&self.candidate, store)
    }
}

struct Batch {
    _fixture: super::super::tests::Fixture,
    candidate: Candidate,
    reserved: Reserved,
}

/// One registry with the whole batch reserved from one observation.
fn reserved_batch() -> (Batch, Guest) {
    let fixture = super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let directory = directory(&candidate, RUN).unwrap();
    state::private_directory(directory.parent().unwrap()).unwrap();
    state::private_directory(&directory).unwrap();
    state::write(&directory.join("state.json"), &receipt()).unwrap();
    initialize_registry(&candidate, OWNER, 4).unwrap();
    let guest = Guest::new(Candidate::discover(&fixture.0).unwrap());
    let targets = inspect_targets(
        &candidate,
        &guest,
        RUN,
        &std::collections::BTreeSet::from(["web", "api"]),
    )
    .unwrap();
    let healthy = BTreeMap::from([(
        "container:api".to_owned(),
        json!({"state":"running","health":"healthy"}),
    )]);
    let reserved = reserve_all(
        &candidate,
        read_owner_registry(&candidate, OWNER, 4, false).unwrap(),
        &BTreeMap::from([("web".to_owned(), RouteSlot::Auto)]),
        4,
        &Observed {
            receipt: &targets.receipt,
            endpoints: &targets.endpoints,
            port_endpoints: &targets.port_endpoints,
            observations: &healthy,
            boot_id: BOOT,
        },
    )
    .unwrap();
    // Count only what the batch under test reads.
    guest.gets.set(0);
    (
        Batch {
            _fixture: fixture,
            candidate,
            reserved,
        },
        guest,
    )
}

fn start(batch: &Batch, guest: &Guest) -> Result<Vec<(u8, Assignment)>, CandidateError> {
    let selected = batch
        .reserved
        .routes
        .values()
        .chain(batch.reserved.ports.values())
        .map(|r| (r.slot, r.assignment.reservation.as_str()))
        .collect::<Vec<_>>();
    let mut store = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    start_selected(
        &batch.candidate,
        guest,
        guest,
        &mut store,
        RUN,
        &selected,
        &"9".repeat(64),
    )
}

fn registry(batch: &Batch) -> Vec<u8> {
    fs::read(root(&batch.candidate).join("state.json")).unwrap()
}

#[test]
fn routes_and_ports_reserve_from_one_observation_in_one_update() {
    let (batch, guest) = reserved_batch();
    assert_eq!(batch.reserved.routes["web"].slot, 0);
    assert_eq!(batch.reserved.ports[&8787].slot, 1);
    let persisted = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    assert_eq!(persisted.slots.len(), 2);
    assert!(persisted.slots.values().all(|a| a.phase == "reserved"));
    // The narrow fence resolves the same endpoint identity a reservation used.
    assert_eq!(
        persisted.slots[&0].container_id, WEB,
        "route bridge targets its own container"
    );
    // A port whose healthcheck is still starting refuses the whole batch and
    // writes nothing, so the owner can wait and retry within its deadline.
    let before = registry(&batch);
    let targets = inspect_targets(
        &batch.candidate,
        &guest,
        RUN,
        &std::collections::BTreeSet::from(["web", "api"]),
    )
    .unwrap();
    let starting = BTreeMap::from([(
        "container:api".to_owned(),
        json!({"state":"running","health":"starting"}),
    )]);
    let mut fresh = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    fresh.slots.clear();
    let refused = reserve_all(
        &batch.candidate,
        fresh,
        &BTreeMap::from([("web".to_owned(), RouteSlot::Auto)]),
        4,
        &Observed {
            receipt: &targets.receipt,
            endpoints: &targets.endpoints,
            port_endpoints: &BTreeMap::new(),
            observations: &starting,
            boot_id: BOOT,
        },
    )
    .unwrap_err();
    assert_eq!(refused.code, "bridge_endpoint_pending");
    assert_eq!(registry(&batch), before);
}

#[test]
fn one_lease_starts_every_relay_with_one_guest_call_per_step() {
    let (batch, guest) = reserved_batch();
    let started = start(&batch, &guest).unwrap();
    assert_eq!(started.len(), 2);
    assert_eq!(*guest.target_calls.borrow(), [vec![100, 101]]);
    assert_eq!(*guest.relay_calls.borrow(), [vec![0, 1]]);
    // Three fences, each one network and two container reads: no whole-graph
    // snapshot and no health reads.
    assert_eq!(guest.gets.get(), 3 * 3);
    let persisted = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    for (slot, target_pid, port) in [(0, 100, 8080), (1, 101, 3000)] {
        let entry = &persisted.slots[&slot];
        assert_eq!(entry.phase, "running");
        let relay = entry.relay.as_ref().unwrap();
        assert_eq!(relay.launch_serial, u64::from(slot) + 1);
        assert_eq!(
            (relay.target_pid, relay.target_start, relay.port),
            (target_pid, u64::from(target_pid) * 7, port)
        );
    }
    assert_eq!(persisted.next_launch_serial, 2);
    assert!(guest.stopped.borrow().is_empty());
}

#[test]
fn target_restarted_before_relay_intent_refuses_with_nothing_recorded() {
    for stage in ["before", "target_starts"] {
        let (batch, guest) = reserved_batch();
        if stage == "before" {
            *guest.restarts.borrow_mut().entry("api".into()).or_default() += 1;
        } else {
            guest.restart_at.set(Some((stage, "api")));
        }
        let before = registry(&batch);
        let refused = start(&batch, &guest).unwrap_err();
        assert_eq!(refused.code, "bridge_generation_stale", "{stage}");
        assert_eq!(registry(&batch), before, "{stage}");
        assert!(guest.relay_calls.borrow().is_empty(), "{stage}");
        assert!(guest.stopped.borrow().is_empty(), "{stage}");
    }
}

#[test]
fn target_restarted_mid_batch_stops_only_its_relay_and_refuses() {
    let (batch, guest) = reserved_batch();
    guest.restart_at.set(Some(("start_relays", "api")));
    let refused = start(&batch, &guest).unwrap_err();
    assert_eq!(refused.code, "bridge_generation_stale");
    assert_eq!(*guest.relay_calls.borrow(), [vec![0, 1]]);
    assert_eq!(*guest.stopped.borrow(), [1]);
    let persisted = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    // The unchanged route keeps its running relay for the caller's cleanup or
    // later supervision; the restarted port's relay was stopped durably.
    assert_eq!(persisted.slots[&0].phase, "running");
    assert_eq!(persisted.slots[&1].phase, "stopped");
    assert_eq!(persisted.next_launch_serial, 2);
}

#[test]
fn a_changed_or_repeated_reservation_refuses_before_any_guest_call() {
    let (batch, guest) = reserved_batch();
    let web = &batch.reserved.routes["web"];
    let mut store = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    for selected in [
        vec![(web.slot, "e".repeat(32))],
        vec![(web.slot, web.assignment.reservation.clone()); 2],
        vec![(3, web.assignment.reservation.clone())],
    ] {
        let selected = selected
            .iter()
            .map(|(slot, reservation)| (*slot, reservation.as_str()))
            .collect::<Vec<_>>();
        assert!(
            start_selected(
                &batch.candidate,
                &guest,
                &guest,
                &mut store,
                RUN,
                &selected,
                &"9".repeat(64),
            )
            .is_err()
        );
    }
    assert_eq!(guest.gets.get(), 0);
    assert!(guest.target_calls.borrow().is_empty());
}
