use super::*;
use crate::provider::{
    host_endpoint::HostEndpoint,
    relay_loop::Limits,
    relay_owner::{OwnerLimits, RelayOwner, publication::ControlListener},
};
use sha2::{Digest, Sha256};
use std::{
    net::TcpListener,
    os::{
        fd::AsFd,
        unix::{fs::PermissionsExt, net::UnixStream},
    },
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
};
const EFFECT: [u8; 32] = [9; 32];
fn context() -> Context {
    Context {
        runtime: [1; 16],
        boot: [2; 16],
    }
}
fn owner() -> RelayOwner {
    RelayOwner::new(
        context(),
        OwnerLimits {
            registrations: 4,
            controls: 4,
            relay: Limits {
                max_flows: 4,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(3),
            },
        },
    )
    .unwrap()
}
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = fs::canonicalize("/tmp").unwrap().join(format!(
            "hrintent-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Server {
    endpoint: PinnedEndpoint,
    target: Target,
    guest: UnixStream,
    _backend: TcpListener,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(root: &Root) -> Self {
        Self::scoped(root, None)
    }
    fn scoped(root: &Root, scope: Option<GraphScope>) -> Self {
        let mut owner = owner();
        let backend = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = HostEndpoint::capture(
            std::process::id() as i32,
            backend.local_addr().unwrap().port(),
        )
        .unwrap();
        let grant = match scope {
            Some(scope) => owner.register_graph(scope, [3; 32], host),
            None => owner.register([3; 32], host),
        }
        .unwrap();
        let (relay, guest) = UnixStream::pair().unwrap();
        guest
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        owner
            .admit(&grant.target, relay, Duration::from_secs(3))
            .unwrap();
        let listener = ControlListener::bind(&root.0, &mut owner).unwrap();
        let endpoint = listener.endpoint();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !stopping.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "test owner watchdog");
                if owner
                    .tick_with_wakeup(Duration::from_millis(10), listener.as_fd())
                    .unwrap()
                {
                    listener.accept(&mut owner, Duration::from_secs(3)).unwrap();
                }
            }
        });
        Self {
            endpoint,
            target: grant.target,
            guest,
            _backend: backend,
            stop,
            worker: Some(worker),
        }
    }
    fn mutation(&self) -> Mutation {
        Mutation {
            effect: EFFECT,
            targets: vec![self.target.clone()],
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn selection(c: &Coordinator) -> Selection {
    Selection {
        context: context(),
        operation: c.operation(),
        effect: EFFECT,
    }
}
fn observe(path: &Path) -> Result<[u8; 32], CandidateError> {
    let bytes = fs::read(path).map_err(|_| refused())?;
    if bytes != b"applied" {
        return Err(refused());
    }
    Ok(Sha256::digest(bytes).into())
}
#[test]
fn intent_precedes_retirement_and_effect_requires_separate_confirmation() {
    let root = Root::new();
    let mut server = Server::new(&root);
    let mut coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    assert_eq!(coordinator.phase(), Phase::Intent);
    let marker = root.0.join("effect");
    assert!(
        coordinator
            .execute::<()>(EFFECT, || {
                fs::write(&marker, b"bad").unwrap();
                Ok(())
            })
            .is_err()
    );
    assert!(!marker.exists());
    assert!(registration(&root.0).is_err());
    coordinator
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    assert_eq!(server.guest.read(&mut [0]).unwrap(), 0);
    coordinator
        .execute::<()>(EFFECT, || {
            fs::write(&marker, b"applied").unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(coordinator.phase(), Phase::EffectStarted);
    assert!(
        coordinator
            .execute::<()>(EFFECT, || panic!("replayed effect"))
            .is_err()
    );
    coordinator.confirm(EFFECT, || observe(&marker)).unwrap();
    assert_eq!(coordinator.phase(), Phase::Confirmed);
    drop(coordinator);
    assert!(registration(&root.0).is_ok());
}
#[test]
fn recovered_intent_needs_a_fresh_exchange_not_persisted_attempt_data() {
    let root = Root::new();
    let server = Server::new(&root);
    let mut first = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    first
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    let previous = first.retired.as_ref().unwrap().attempt;
    let selected = selection(&first);
    drop(first);
    let mut recovered = Coordinator::resume(&root.0, selected).unwrap();
    assert!(
        recovered
            .execute::<()>(EFFECT, || panic!("reused recovered proof"))
            .is_err()
    );
    recovered
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    assert_ne!(recovered.retired.as_ref().unwrap().attempt, previous);
    recovered.execute::<()>(EFFECT, || Ok(())).unwrap();
    assert_eq!(recovered.phase(), Phase::EffectStarted);
}
#[test]
fn effect_error_is_durable_uncertainty_and_observation_does_not_replay() {
    let root = Root::new();
    let server = Server::new(&root);
    let marker = root.0.join("effect");
    let mut first = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    first
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    let selected = selection(&first);
    assert!(
        first
            .execute::<()>(EFFECT, || {
                fs::write(&marker, b"applied").unwrap();
                Err(refused())
            })
            .is_err()
    );
    drop(first);
    let mut recovered = Coordinator::resume(&root.0, selected).unwrap();
    assert_eq!(recovered.phase(), Phase::EffectStarted);
    assert!(
        recovered
            .retire(&server.endpoint, Duration::from_secs(1))
            .is_err()
    );
    assert!(
        recovered
            .execute::<()>(EFFECT, || panic!("replayed uncertain effect"))
            .is_err()
    );
    assert!(recovered.confirm(EFFECT, || Err(refused())).is_err());
    assert_eq!(recovered.phase(), Phase::EffectStarted);
    recovered.confirm(EFFECT, || observe(&marker)).unwrap();
}
#[test]
fn pending_write_or_changed_selection_never_invokes_effect() {
    let root = Root::new();
    let server = Server::new(&root);
    let mut coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    let selected = selection(&coordinator);
    coordinator
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    let pending = coordinator.store.directory.join("state.pending");
    fs::write(&pending, b"partial").unwrap();
    assert!(
        coordinator
            .execute::<()>(EFFECT, || panic!("effect despite failed journal"))
            .is_err()
    );
    drop(coordinator);
    assert!(Coordinator::resume(&root.0, selected).is_err());
    assert!(registration(&root.0).is_err());
    assert_eq!(fs::read(&pending).unwrap(), b"partial");
}

#[test]
fn journal_write_refusal_consumes_proof_without_invoking_effect() {
    let root = Root::new();
    let server = Server::new(&root);
    let mut coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    coordinator
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    let marker = root.0.join("effect");
    fs::set_permissions(
        &coordinator.store.directory,
        fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    let result = coordinator.execute::<()>(EFFECT, || {
        fs::write(&marker, b"unexpected").unwrap();
        Ok(())
    });
    fs::set_permissions(
        &coordinator.store.directory,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert!(result.is_err());
    assert!(!marker.exists());
    assert!(coordinator.retired.is_none());
    assert_eq!(
        coordinator.store.read().unwrap().unwrap().record.phase,
        Phase::Intent
    );
}
#[test]
fn copied_or_replaced_receipt_and_wrong_effect_are_refused() {
    let root = Root::new();
    let server = Server::new(&root);
    let mut coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    coordinator
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    assert!(
        coordinator
            .execute::<()>([8; 32], || panic!("wrong mutation"))
            .is_err()
    );
    let other = Root::new();
    let other_store = Store::open(&other.0).unwrap();
    fs::write(
        other_store.directory.join("state.json"),
        &coordinator.snapshot.bytes,
    )
    .unwrap();
    fs::set_permissions(
        other_store.directory.join("state.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(other_store.read().is_err());
    let replacement = coordinator.store.directory.join("replacement");
    fs::write(&replacement, &coordinator.snapshot.bytes).unwrap();
    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(replacement, coordinator.store.directory.join("state.json")).unwrap();
    assert!(
        coordinator
            .retire(&server.endpoint, Duration::from_secs(1))
            .is_err()
    );
}
#[test]
fn confirmed_history_reuses_one_record_and_restart_keeps_unfinished_grants_fenced() {
    let root = Root::new();
    let server = Server::new(&root);
    for _ in 0..3 {
        let mut coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
        coordinator
            .retire(&server.endpoint, Duration::from_secs(2))
            .unwrap();
        coordinator.execute::<()>(EFFECT, || Ok(())).unwrap();
        coordinator.confirm(EFFECT, || Ok([7; 32])).unwrap();
    }
    let coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    drop(coordinator);
    drop(server);
    let mut restarted = owner();
    let _listener = ControlListener::bind(&root.0, &mut restarted).unwrap();
    let backend = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        backend.local_addr().unwrap().port(),
    )
    .unwrap();
    assert!(restarted.register([5; 32], endpoint).is_err());
    let names: std::collections::BTreeSet<_> = fs::read_dir(root.0.join("relay-lifecycle"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["operation.lock".into(), "state.json".into()].into());
}

#[test]
#[ignore = "owned coordinator crash fixture launched by crash_after_effect_start_cannot_replay"]
fn effect_crash_child() {
    let root = PathBuf::from(std::env::var_os("HACK_RELAY_INTENT_ROOT").expect("explicit root"));
    let target: Target =
        serde_json::from_slice(&fs::read(root.join("target.json")).unwrap()).unwrap();
    let endpoint = PinnedEndpoint::load(&root, context()).unwrap();
    let graph_empty = std::env::var("HACK_RELAY_GRAPH_EMPTY").as_deref() == Ok("1");
    let mut coordinator = if graph_empty {
        let scope = GraphScope::new(context(), [9; 32]).unwrap();
        let mut coordinator = Coordinator::begin_graph(&endpoint, scope, EFFECT).unwrap();
        coordinator
            .prepare_graph(&endpoint, Duration::from_secs(3))
            .unwrap();
        coordinator
    } else {
        let mut coordinator = Coordinator::begin(
            &endpoint,
            Mutation {
                effect: EFFECT,
                targets: vec![target],
            },
        )
        .unwrap();
        coordinator
            .retire(&endpoint, Duration::from_secs(3))
            .unwrap();
        coordinator
    };
    coordinator
        .execute::<()>(EFFECT, || {
            fs::write(root.join("effect"), b"applied").unwrap();
            std::process::exit(23);
        })
        .unwrap();
    panic!("crash fixture returned");
}
#[test]
fn crash_after_effect_start_cannot_replay() {
    crash_recovery(false);
}

#[test]
fn empty_graph_crash_after_effect_start_cannot_replay() {
    crash_recovery(true);
}

fn crash_recovery(graph_empty: bool) {
    use std::process::{Child, Command, Stdio};
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = Root::new();
    let server = Server::scoped(
        &root,
        graph_empty.then(|| GraphScope::new(context(), [8; 32]).unwrap()),
    );
    fs::write(
        root.0.join("target.json"),
        serde_json::to_vec(&server.target).unwrap(),
    )
    .unwrap();
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::relay_owner::lifecycle_intent::tests::effect_crash_child",
            ])
            .env("HACK_RELAY_INTENT_ROOT", &root.0)
            .env(
                "HACK_RELAY_GRAPH_EMPTY",
                if graph_empty { "1" } else { "0" },
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert_eq!(status.code(), Some(23));
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    }
    let inspection = Inspection::load(&root.0, context()).unwrap();
    assert_eq!(inspection.phase, Phase::EffectStarted);
    assert_eq!(inspection.selection.effect, EFFECT);
    if graph_empty {
        let graph = inspection.graph.expect("persisted graph scope");
        assert_eq!(graph.id, [9; 32]);
        assert_eq!(graph.context.runtime, context().runtime);
        assert_eq!(graph.context.boot, context().boot);
        assert!(inspection.selection_observed);
        assert!(inspection.targets.is_empty());
    } else {
        assert_eq!(inspection.targets, vec![server.target.clone()]);
    }
    let mut recovered = Coordinator::resume(&root.0, inspection.selection).unwrap();
    assert!(
        recovered
            .execute::<()>(EFFECT, || panic!("replayed crashed effect"))
            .is_err()
    );
    recovered
        .confirm(EFFECT, || observe(&root.0.join("effect")))
        .unwrap();
}

#[test]
fn inspection_never_initializes_missing_state_and_refuses_missing_lock() {
    let root = Root::new();
    assert!(Inspection::load(&root.0, context()).is_err());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    let server = Server::new(&root);
    let coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    assert!(Inspection::load(&root.0, context()).is_err());
    drop(coordinator);
    let path = root.0.join("relay-lifecycle/state.json");
    let before = fs::read(&path).unwrap();
    let metadata = fs::metadata(&path).unwrap();
    let inspection = Inspection::load(&root.0, context()).unwrap();
    assert_eq!(inspection.phase, Phase::Intent);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::metadata(&path).unwrap().ino(), metadata.ino());
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        metadata.modified().unwrap()
    );
    fs::remove_file(root.0.join("relay-lifecycle/operation.lock")).unwrap();
    assert!(Inspection::load(&root.0, context()).is_err());
    assert!(!root.0.join("relay-lifecycle/operation.lock").exists());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn inspection_refuses_wrong_context_partial_state_and_stale_selection() {
    let root = Root::new();
    let server = Server::new(&root);
    let mut coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    coordinator
        .retire(&server.endpoint, Duration::from_secs(1))
        .unwrap();
    coordinator.execute(EFFECT, || Ok(())).unwrap();
    coordinator.confirm(EFFECT, || Ok([4; 32])).unwrap();
    drop(coordinator);
    let inspection = Inspection::load(&root.0, context()).unwrap();
    assert_eq!(inspection.phase, Phase::Confirmed);
    assert!(
        Inspection::load(
            &root.0,
            Context {
                runtime: [7; 16],
                ..context()
            }
        )
        .is_err()
    );
    assert!(
        Inspection::load(
            &root.0,
            Context {
                boot: [7; 16],
                ..context()
            }
        )
        .is_err()
    );
    let coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    drop(coordinator);
    assert!(Coordinator::resume(&root.0, inspection.selection).is_err());
    let pending = root.0.join("relay-lifecycle/state.pending");
    fs::write(&pending, b"interrupted").unwrap();
    assert!(Inspection::load(&root.0, context()).is_err());
    assert_eq!(fs::read(pending).unwrap(), b"interrupted");
}

#[test]
fn graph_intent_selects_and_retires_before_effect_and_recovery_reselects() {
    let root = Root::new();
    let scope = GraphScope::new(context(), [8; 32]).unwrap();
    let mut server = Server::scoped(&root, Some(scope));
    let mut coordinator = Coordinator::begin_graph(&server.endpoint, scope, EFFECT).unwrap();
    assert!(coordinator.snapshot.record.selected.is_none());
    assert!(coordinator.snapshot.record.targets.is_empty());
    assert!(
        coordinator
            .retire(&server.endpoint, Duration::from_secs(1))
            .is_err()
    );
    assert!(
        coordinator
            .execute::<()>(EFFECT, || panic!("unselected effect"))
            .is_err()
    );
    coordinator
        .prepare_graph(&server.endpoint, Duration::from_secs(1))
        .unwrap();
    assert_eq!(server.guest.read(&mut [0]).unwrap(), 0);
    assert_eq!(
        coordinator.snapshot.record.targets,
        vec![server.target.clone()]
    );
    let first_attempt = coordinator.retired.as_ref().unwrap().attempt;
    let selected = selection(&coordinator);
    drop(coordinator);
    let mut recovered = Coordinator::resume(&root.0, selected).unwrap();
    assert!(
        recovered
            .execute::<()>(EFFECT, || panic!("stored selection was authority"))
            .is_err()
    );
    recovered
        .prepare_graph(&server.endpoint, Duration::from_secs(1))
        .unwrap();
    assert_ne!(recovered.retired.as_ref().unwrap().attempt, first_attempt);
    recovered
        .execute(EFFECT, || {
            fs::write(root.0.join("effect"), b"applied").map_err(|_| refused())
        })
        .unwrap();
    recovered
        .confirm(EFFECT, || observe(&root.0.join("effect")))
        .unwrap();
}

#[test]
fn empty_graph_requires_fresh_native_proof_and_preserves_unrelated_flow() {
    let root = Root::new();
    let other = GraphScope::new(context(), [8; 32]).unwrap();
    let scope = GraphScope::new(context(), [9; 32]).unwrap();
    let mut server = Server::scoped(&root, Some(other));
    let mut coordinator = Coordinator::begin_graph(&server.endpoint, scope, EFFECT).unwrap();
    coordinator
        .prepare_graph(&server.endpoint, Duration::from_secs(1))
        .unwrap();
    assert!(coordinator.snapshot.record.targets.is_empty());
    assert!(coordinator.snapshot.record.selected.is_some());
    server.guest.set_nonblocking(true).unwrap();
    assert_eq!(
        server.guest.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let selected = selection(&coordinator);
    drop(coordinator);
    let inspected = Inspection::load(&root.0, context()).unwrap();
    assert!(
        inspected.graph.is_some() && inspected.selection_observed && inspected.targets.is_empty()
    );
    let mut recovered = Coordinator::resume(&root.0, selected).unwrap();
    assert!(
        recovered
            .execute::<()>(EFFECT, || panic!("empty audit data was authority"))
            .is_err()
    );
    recovered
        .prepare_graph(&server.endpoint, Duration::from_secs(1))
        .unwrap();
    recovered
        .execute(EFFECT, || {
            fs::write(root.0.join("effect"), b"applied").map_err(|_| refused())
        })
        .unwrap();
    recovered
        .confirm(EFFECT, || observe(&root.0.join("effect")))
        .unwrap();
    assert_eq!(
        server.guest.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn failed_graph_selection_never_turns_unknown_into_empty_authority() {
    let root = Root::new();
    let server = Server::new(&root); // Deliberately unscoped registry cannot prove coverage.
    let scope = GraphScope::new(context(), [9; 32]).unwrap();
    let mut coordinator = Coordinator::begin_graph(&server.endpoint, scope, EFFECT).unwrap();
    assert!(
        coordinator
            .prepare_graph(&server.endpoint, Duration::from_secs(1))
            .is_err()
    );
    assert!(coordinator.snapshot.record.selected.is_none());
    assert!(coordinator.retired.is_none());
    assert!(
        coordinator
            .execute::<()>(EFFECT, || panic!("failed query admitted effect"))
            .is_err()
    );
    drop(coordinator);
    let observed = Inspection::load(&root.0, context()).unwrap();
    assert!(!observed.selection_observed && observed.targets.is_empty());
    assert!(registration(&root.0).is_err());
}

#[test]
fn graph_recovery_refuses_changed_target_set_and_invalid_budget() {
    let root = Root::new();
    let scope = GraphScope::new(context(), [8; 32]).unwrap();
    let server = Server::scoped(&root, Some(scope));
    let mut coordinator = Coordinator::begin_graph(&server.endpoint, scope, EFFECT).unwrap();
    assert!(
        coordinator
            .prepare_graph(&server.endpoint, Duration::ZERO)
            .is_err()
    );
    assert!(
        coordinator
            .prepare_graph(&server.endpoint, Duration::from_secs(6))
            .is_err()
    );
    coordinator
        .prepare_graph(&server.endpoint, Duration::from_secs(1))
        .unwrap();
    let mut changed = coordinator.snapshot.record.clone();
    changed.targets[0].generation = [99; 32];
    coordinator.snapshot = coordinator.store.write(changed).unwrap();
    assert!(
        coordinator
            .prepare_graph(&server.endpoint, Duration::from_secs(1))
            .is_err()
    );
    assert!(coordinator.retired.is_none());
    assert!(
        coordinator
            .execute::<()>(EFFECT, || panic!("changed coverage admitted effect"))
            .is_err()
    );
}

#[test]
fn enrolled_callback_failure_preserves_previous_confirmed_record() {
    let root = Root::new();
    let server = Server::new(&root);
    let mut previous = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    previous
        .retire(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    previous.execute(EFFECT, || Ok(())).unwrap();
    previous.confirm(EFFECT, || Ok([7; 32])).unwrap();
    let path = previous.store.directory.join("state.json");
    let original = fs::read(&path).unwrap();
    assert!(!String::from_utf8_lossy(&original).contains("ack_required"));
    drop(previous);
    let scope = GraphScope::new(context(), [8; 32]).unwrap();
    let callback = std::cell::Cell::new(false);
    assert!(
        Coordinator::begin_graph_enrolled(&server.endpoint, scope, EFFECT, None, |selection| {
            assert_ne!(selection.operation, [0; 16]);
            assert_eq!(fs::read(&path).unwrap(), original);
            callback.set(true);
            Err(refused())
        })
        .is_err()
    );
    assert!(callback.get());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(
        Coordinator::begin_graph_enrolled(
            &server.endpoint,
            scope,
            EFFECT,
            Some([0; 16]),
            |_| panic!("invalid operation reached persistence")
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn enrolled_preadmission_retry_preserves_supplied_operation_without_replaying_active_intent() {
    let root = Root::new();
    let server = Server::new(&root);
    let scope = GraphScope::new(context(), [9; 32]).unwrap();
    let operation = [6; 16];
    let marker = root.0.join("enrollment");
    assert!(
        Coordinator::begin_graph_enrolled(
            &server.endpoint,
            scope,
            EFFECT,
            Some(operation),
            |selection| {
                fs::write(&marker, selection.operation).unwrap();
                Err(refused())
            }
        )
        .is_err()
    );
    let mut coordinator = Coordinator::begin_graph_enrolled(
        &server.endpoint,
        scope,
        EFFECT,
        Some(operation),
        |selection| {
            assert_eq!(selection.operation, operation);
            assert_eq!(fs::read(&marker).unwrap(), operation);
            assert!(!root.0.join("relay-lifecycle/state.json").exists());
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(coordinator.operation(), operation);
    assert!(coordinator.acknowledgement_pending());
    assert!(coordinator.acknowledge().is_err());
    drop(coordinator);
    assert!(
        Coordinator::begin_graph_enrolled(
            &server.endpoint,
            scope,
            EFFECT,
            Some(operation),
            |_| panic!("unfinished operation replaced")
        )
        .is_err()
    );
    assert!(
        Inspection::load(&root.0, context())
            .unwrap()
            .acknowledgement_pending
    );
}

#[test]
fn enrolled_confirmation_requires_caller_acknowledgement_before_any_rollover() {
    let root = Root::new();
    let server = Server::scoped(&root, Some(GraphScope::new(context(), [8; 32]).unwrap()));
    let scope = GraphScope::new(context(), [9; 32]).unwrap();
    let operation = [6; 16];
    let mut coordinator =
        Coordinator::begin_graph_enrolled(&server.endpoint, scope, EFFECT, Some(operation), |_| {
            Ok(())
        })
        .unwrap();
    coordinator
        .prepare_graph(&server.endpoint, Duration::from_secs(2))
        .unwrap();
    coordinator.execute(EFFECT, || Ok(())).unwrap();
    assert!(coordinator.acknowledge().is_err());
    coordinator.confirm(EFFECT, || Ok([7; 32])).unwrap();
    assert!(coordinator.acknowledgement_pending());
    let selected = selection(&coordinator);
    drop(coordinator);
    let inspection = Inspection::load(&root.0, context()).unwrap();
    assert_eq!(inspection.phase, Phase::Confirmed);
    assert!(inspection.acknowledgement_pending);
    assert!(Coordinator::begin(&server.endpoint, server.mutation()).is_err());
    assert!(Coordinator::begin_graph(&server.endpoint, scope, EFFECT).is_err());
    assert!(
        Coordinator::begin_graph_enrolled(&server.endpoint, scope, EFFECT, None, |_| panic!(
            "acknowledgement bypassed"
        ))
        .is_err()
    );
    let mut recovered = Coordinator::resume(&root.0, selected).unwrap();
    recovered.acknowledge().unwrap();
    assert!(!recovered.acknowledgement_pending());
    let identity = recovered.snapshot.identity;
    recovered.acknowledge().unwrap();
    assert_eq!(
        recovered.snapshot.identity, identity,
        "idempotent acknowledgement must not rewrite"
    );
    drop(recovered);
    assert!(
        !Inspection::load(&root.0, context())
            .unwrap()
            .acknowledgement_pending
    );
    assert!(
        Coordinator::begin_graph_enrolled(
            &server.endpoint,
            scope,
            EFFECT,
            Some(operation),
            |_| panic!("confirmed operation replayed")
        )
        .is_err()
    );
    assert!(Coordinator::begin(&server.endpoint, server.mutation()).is_ok());
}

#[test]
fn legacy_record_cannot_claim_enrollment_acknowledgement() {
    let root = Root::new();
    let server = Server::new(&root);
    let coordinator = Coordinator::begin(&server.endpoint, server.mutation()).unwrap();
    let mut record = coordinator.snapshot.record.clone();
    record.ack_required = true;
    assert!(record.validate(coordinator.store.parent).is_err());
}
