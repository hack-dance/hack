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
            "uid":1000,"gid":1000,"exec_id":"c".repeat(64),"started_ms":1,"phase":"running",
            "start_interval_argv":true}}
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
    /// Stage at which the routed service's probe exits; its container stays.
    unhealthy_at: Cell<Option<&'static str>>,
    unhealthy: Cell<bool>,
    api_health_starting: Cell<bool>,
    fail_relays: Cell<bool>,
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
            unhealthy_at: Cell::new(None),
            unhealthy: Cell::new(false),
            api_health_starting: Cell::new(false),
            fail_relays: Cell::new(false),
            gets: Cell::new(0),
            target_calls: RefCell::default(),
            relay_calls: RefCell::default(),
            stopped: RefCell::default(),
            candidate,
        }
    }
    fn stage(&self, stage: &str) {
        if self.unhealthy_at.get() == Some(stage) {
            self.unhealthy.set(true);
        }
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
        let probe = &self.receipt.probes["web"];
        if path == format!("/v1.53/exec/{}/json", probe.exec_id.as_ref().unwrap()) {
            return Ok(json!({"ContainerID":WEB,"Running":!self.unhealthy.get(),
                "ProcessConfig":{"entrypoint":"/run/hack-http-probe",
                    "arguments":probe.launch_arguments()?}}));
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
        let mut observed = json!({"Id":resource.id,"Name":format!("/{}",resource.name),"Image":resource.image,
            "Config":{"Labels":expected_labels(&self.receipt, resource)},
            "State":{"Running":true,"Restarting":false,"Pid":100 + 10 * restarts + u32::from(service == "api"),
                "StartedAt":format!("2026-11-20T00:00:{restarts:02}Z")},
            "HostConfig":{"NetworkMode":network.name},
            "NetworkSettings":{"Networks":{network.name.clone():{"NetworkID":NETWORK,
                "EndpointID":endpoint(service),"IPAddress":Self::address(service)}}}});
        if service == "api" && self.api_health_starting.get() {
            observed["State"]["Health"] = json!({"Status":"starting"});
        }
        Ok(observed)
    }
    fn probe_status(&self, id: &str) -> Result<Option<String>, CandidateError> {
        assert_eq!(id, WEB);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let generation = &self.receipt.probes["web"].generation;
        Ok(Some(format!("v1 {generation} 5 1 0 {now} 2\n")))
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
        if self.fail_relays.get() {
            return Err(error("bridge_relay", "Unconfirmed relay operation."));
        }
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

#[test]
fn early_port_waits_for_its_healthcheck_and_refuses_a_stale_ready_id() {
    early_port_waits_for_its_healthcheck("preparing", None, false);
}

/// `hack up` now returns at started (with and without `--wait`, the owner reports
/// started): the receipt is `started-observed` while a slow service warms, and its
/// port is still deferred while its healthcheck starts, then published once ready.
#[test]
fn after_started_a_slow_port_is_deferred_then_published_not_refused() {
    for from in ["preparing", "restoring"] {
        early_port_waits_for_its_healthcheck(super::super::STARTED_OBSERVED, Some(from), false);
    }
}

#[test]
fn targeted_append_publishes_its_port_without_selecting_existing_routes() {
    early_port_waits_for_its_healthcheck("ready-observed", None, true);
}

fn early_port_waits_for_its_healthcheck(phase: &str, started_from: Option<&str>, extending: bool) {
    let fixture = super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let root = directory(&candidate, RUN).unwrap();
    state::private_directory(root.parent().unwrap()).unwrap();
    state::private_directory(&root).unwrap();
    let mut receipt = receipt();
    receipt.phase = phase.into();
    receipt.started_from = started_from.map(Into::into);
    if extending {
        receipt.extending.insert("api".to_owned());
    }
    state::write(&root.join("state.json"), &receipt).unwrap();
    let guest = Guest::new(Candidate::discover(&fixture.0).unwrap());
    let services = BTreeSet::from(["api"]);
    let inspect =
        |id| inspect_targets_scoped(&candidate, &guest, RUN, &services, Some(("api", id))).unwrap();
    guest.api_health_starting.set(true);
    assert!(inspect(API).pending_ports);
    assert!(inspect(API).port_endpoints.is_empty());
    assert!(!inspect(WEB).pending_ports);
    assert!(inspect(WEB).port_endpoints.is_empty());
    guest.api_health_starting.set(false);
    assert!(!inspect(API).pending_ports);
    assert_eq!(inspect(API).port_endpoints.len(), 1);
    if extending {
        let web = BTreeSet::from(["web"]);
        let unselected =
            inspect_targets_scoped(&candidate, &guest, RUN, &web, Some(("web", WEB))).unwrap();
        assert!(unselected.endpoints.is_empty());
        assert_eq!(
            inspect_targets(&candidate, &guest, RUN, &web)
                .unwrap()
                .endpoints
                .len(),
            1
        );
    }
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
        StartSelection {
            run: RUN,
            selected: &selected,
            ready_service: None,
        },
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
    // Three fences, each one network, two container and one probe exec read:
    // never the rest of the graph.
    assert_eq!(guest.gets.get(), 3 * 4);
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
fn health_lost_after_reservation_refuses_like_a_restart() {
    // The routed probe exits while the container keeps its identity: every
    // fence still admits only healthy route endpoints, as the snapshot did.
    for stage in ["target_starts", "start_relays"] {
        let (batch, guest) = reserved_batch();
        guest.unhealthy_at.set(Some(stage));
        let before = registry(&batch);
        assert_eq!(
            start(&batch, &guest).unwrap_err().code,
            "bridge_generation_stale",
            "{stage}"
        );
        if stage == "target_starts" {
            assert_eq!(registry(&batch), before);
            assert!(guest.relay_calls.borrow().is_empty());
        } else {
            assert_eq!(*guest.stopped.borrow(), [0]);
            let persisted = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
            assert_eq!(persisted.slots[&1].phase, "running");
        }
    }
    // A publisher child fences the same way before it launches.
    let (batch, guest) = reserved_batch();
    guest.unhealthy.set(true);
    let targets = inspect_targets(
        &batch.candidate,
        &guest,
        RUN,
        &std::collections::BTreeSet::from(["web"]),
    )
    .unwrap();
    assert!(!targets.current(&batch.reserved.routes["web"].assignment, BOOT));
}

#[test]
fn unconfirmed_relay_start_retains_every_launch_intent_for_cleanup() {
    let (batch, guest) = reserved_batch();
    guest.fail_relays.set(true);
    assert_eq!(start(&batch, &guest).unwrap_err().code, "bridge_relay");
    let persisted = read_owner_registry(&batch.candidate, OWNER, 4, false).unwrap();
    for slot in [0, 1] {
        assert_eq!(persisted.slots[&slot].phase, "starting");
        assert!(persisted.slots[&slot].relay.is_some());
    }
    assert!(guest.stopped.borrow().is_empty());
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
                StartSelection {
                    run: RUN,
                    selected: &selected,
                    ready_service: None
                },
                &"9".repeat(64),
            )
            .is_err()
        );
    }
    assert_eq!(guest.gets.get(), 0);
    assert!(guest.target_calls.borrow().is_empty());
}

/// Release fake: records each effect with the registry phases on disk at that moment.
struct Release {
    candidate: Candidate,
    calls: RefCell<Vec<String>>,
    fail_stop: Cell<bool>,
}

impl Release {
    fn phases(&self) -> String {
        read_owner_registry(&self.candidate, OWNER, 8, false)
            .unwrap()
            .slots
            .iter()
            .map(|(slot, a)| format!("{slot}={}", a.phase))
            .collect::<Vec<_>>()
            .join(",")
    }
}

impl ReleaseGuest for Release {
    fn boot_id(&self) -> &str {
        BOOT
    }
    fn release_publications(
        &self,
        run: &str,
        reservations: &std::collections::BTreeSet<&str>,
    ) -> Result<(), CandidateError> {
        assert_eq!(run, RUN);
        self.calls.borrow_mut().push(format!(
            "publications {} [{}]",
            reservations.len(),
            self.phases()
        ));
        Ok(())
    }
    fn relays(&self, action: &str, selected: &[(u8, &Assignment)]) -> Result<(), CandidateError> {
        let slots = selected
            .iter()
            .map(|(slot, _)| slot.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        self.calls
            .borrow_mut()
            .push(format!("{action} {slots} [{}]", self.phases()));
        if action == "stop" && self.fail_stop.get() {
            return Err(error("bridge_relay", "Unconfirmed relay operation."));
        }
        Ok(())
    }
    fn after_guest_stop(&self, _: &str) -> Result<(), CandidateError> {
        Ok(())
    }
}

fn release_store(candidate: &Candidate) -> Store {
    initialize_registry(candidate, OWNER, 8).unwrap();
    let mut store = read_owner_registry(candidate, OWNER, 8, false).unwrap();
    let assignment =
        |reservation: char, phase: &str, boot: &str, run: &str, serial: u64| Assignment {
            reservation: reservation.to_string().repeat(32),
            run: run.into(),
            service: format!("svc-{reservation}"),
            generation: "c".repeat(64),
            container_id: "d".repeat(64),
            network_id: "e".repeat(64),
            boot_id: boot.into(),
            phase: phase.into(),
            relay: (phase != "reserved").then(|| relay::Relay {
                transport: relay::Transport::ReservationV1,
                launch_serial: serial,
                binary_sha256: "9".repeat(64),
                target_pid: 42,
                target_start: 7,
                port: 3000,
            }),
            loopback_port: None,
        };
    let earlier = "87654321-4321-4321-4321-cba987654321";
    store.next_launch_serial = 5;
    store.slots = BTreeMap::from([
        (0, assignment('0', "running", BOOT, RUN, 1)),
        (1, assignment('1', "starting", BOOT, RUN, 2)),
        (2, assignment('2', "stopped", BOOT, RUN, 3)),
        (3, assignment('3', "running", earlier, RUN, 4)),
        (4, assignment('4', "reserved", BOOT, RUN, 0)),
        (5, assignment('5', "running", BOOT, &"e".repeat(32), 5)),
    ]);
    save(candidate, &store).unwrap();
    store
}

#[test]
fn release_retires_each_phase_for_the_whole_run_in_order() {
    let fixture = super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let mut store = release_store(&candidate);
    let guest = Release {
        candidate: Candidate::discover(&fixture.0).unwrap(),
        calls: RefCell::default(),
        fail_stop: Cell::new(false),
    };
    release_selected(&candidate, &guest, &mut store, RUN).unwrap();
    assert_eq!(
        *guest.calls.borrow(),
        [
            // Host listeners first, before any registry or guest change.
            "publications 5 [0=running,1=starting,2=stopped,3=running,4=reserved,5=running]",
            // Intent precedes the one guest stop; the earlier boot's relay needs none.
            "stop 0 1 [0=stopping,1=stopping,2=stopped,3=stopped,4=reserved,5=running]",
            "remove 0 1 2 [0=stopped,1=stopped,2=stopped,3=stopped,4=reserved,5=running]",
        ]
    );
    let persisted = read_owner_registry(&candidate, OWNER, 8, false).unwrap();
    assert_eq!(persisted.slots.keys().copied().collect::<Vec<_>>(), [5]);
    assert_eq!(persisted.slots[&5].phase, "running");
    assert_eq!(persisted.next_launch_serial, 5);
}

#[test]
fn refused_batch_stop_keeps_every_slot_and_the_next_release_resumes() {
    let fixture = super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let mut store = release_store(&candidate);
    let guest = Release {
        candidate: Candidate::discover(&fixture.0).unwrap(),
        calls: RefCell::default(),
        fail_stop: Cell::new(true),
    };
    assert_eq!(
        release_selected(&candidate, &guest, &mut store, RUN)
            .unwrap_err()
            .code,
        "bridge_relay"
    );
    assert_eq!(
        guest.phases(),
        "0=stopping,1=stopping,2=stopped,3=stopped,4=reserved,5=running"
    );
    guest.fail_stop.set(false);
    guest.calls.borrow_mut().clear();
    let mut store = read_owner_registry(&candidate, OWNER, 8, false).unwrap();
    release_selected(&candidate, &guest, &mut store, RUN).unwrap();
    assert_eq!(
        guest.calls.borrow()[1],
        "stop 0 1 [0=stopping,1=stopping,2=stopped,3=stopped,4=reserved,5=running]"
    );
    assert_eq!(guest.phases(), "5=running");
}
