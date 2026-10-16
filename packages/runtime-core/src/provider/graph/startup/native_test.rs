//! Owned native application acceptance: no manual grant registration or release.
use super::*;
use crate::provider::host_endpoint::HostEndpoint;
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::Instant,
};
struct Backend {
    endpoint: HostEndpoint,
    connections: Arc<AtomicUsize>,
    bytes: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<(), &'static str>>>,
}
impl Backend {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = HostEndpoint::capture(
            std::process::id() as i32,
            listener.local_addr().unwrap().port(),
        )
        .unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (count, total, done) = (connections.clone(), bytes.clone(), stop.clone());
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(55);
            while !done.load(Ordering::Acquire) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if count.fetch_add(1, Ordering::AcqRel) != 0 {
                            return Err("unexpected additional dependency request");
                        }
                        stream.set_nonblocking(false).map_err(|_| "backend mode")?;
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .map_err(|_| "backend timeout")?;
                        stream
                            .set_write_timeout(Some(Duration::from_secs(5)))
                            .map_err(|_| "backend timeout")?;
                        let mut body = Vec::new();
                        (&mut stream)
                            .take(65537)
                            .read_to_end(&mut body)
                            .map_err(|_| "backend request")?;
                        total.store(body.len(), Ordering::Release);
                        if body.len() != 65536
                            || !body.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8)
                        {
                            return Err("backend payload mismatch");
                        }
                        stream.write_all(&body).map_err(|_| "backend response")?;
                        stream
                            .shutdown(Shutdown::Write)
                            .map_err(|_| "backend FIN")?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => return Err("backend accept"),
                }
            }
            if !done.load(Ordering::Acquire) {
                return Err("backend lifetime expired");
            }
            Ok(())
        });
        Self {
            endpoint,
            connections,
            bytes,
            stop,
            worker: Some(worker),
        }
    }
    fn finish(&mut self) -> Result<(), &'static str> {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "backend panic")??;
        }
        Ok(())
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
fn options<'a>(
    fixture: &'a Path,
    plan: &'a str,
    run: &'a str,
    readiness: &'a BTreeMap<String, Condition>,
    public: &'a BTreeMap<String, String>,
) -> RunOptions<'a> {
    RunOptions {
        live_source: false,
        release_initializer_cache: std::collections::BTreeSet::new(),
        routing_enrolled: false,
        project: PlanOptions {
            project: fixture,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
        expected_plan: plan,
        source_revision: None,
        non_secret_values: public,
        readiness,
        run_id: run,
        timeout: Duration::from_secs(30),
    }
}
#[test]
#[ignore = "Owned VM, pinned image with graph-startup-app, reviewed relay artifact and external watchdog required"]
fn graph_application_authenticates_dependency_before_initial_health() {
    qualify_startup(false);
}
#[test]
#[ignore = "Owned VM, pinned image with graph-startup-app, reviewed relay artifact and external watchdog required"]
fn stale_dependency_refuses_initial_release_and_still_cleans_up() {
    qualify_startup(true);
}
fn qualify_startup(stale_dependency: bool) {
    let started = Instant::now();
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit owned root"),
    ))
    .unwrap();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned fixture image");
    let artifact =
        PathBuf::from(std::env::var("HACK_GRAPH_RELAY_ARTIFACT").expect("reviewed guest artifact"));
    let hash = std::env::var("HACK_GRAPH_RELAY_SHA256").expect("pinned artifact digest");
    let fixture = super::super::tests::Fixture::new();
    state::write(&fixture.0.join("compose.yaml"),&json!({"services":{"web":{
        "image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
        "entrypoint":["/bin/hack-graph-startup-app","serve"],"command":[],
        "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","health"],"interval":"100ms","timeout":"2s","retries":10,"start_period":"500ms"}
    }}})).unwrap();
    let plan = project::plan(
        &candidate,
        PlanOptions {
            project: &fixture.0,
            compose_file: Path::new("compose.yaml"),
            profiles: &[],
        },
    )
    .unwrap();
    assert!(plan.plan.enrollment_compatible);
    let mut random = [0; 16];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let run: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let readiness = BTreeMap::from([("web".into(), Condition::Healthy)]);
    let public = BTreeMap::new();
    let mut backend = Backend::new();
    let mut runtime = HostRelayRuntime::new(
        &candidate,
        &artifact,
        &hash,
        vec![Dependency {
            aliases: vec![],
            service: "web".into(),
            binding: "default".into(),
            slot: 0,
            port: 25252,
            endpoint: backend.endpoint.clone(),
        }],
    )
    .unwrap();
    // Value-free journal location enables the external owner to account for retained evidence.
    println!(
        "graph-startup-control-root={}",
        runtime.endpoint().runtime_root().display()
    );
    if stale_dependency {
        // The captured listener generation has gone away before registration.
        backend.finish().unwrap();
    }
    let result = run_with_host_dependencies(
        &candidate,
        options(&fixture.0, &plan.plan_id, &run, &readiness, &public),
        &mut runtime,
        &BTreeMap::new(),
        Duration::from_secs(60),
    );
    if stale_dependency {
        assert_eq!(result.unwrap_err().code, "host_endpoint_identity");
        assert_eq!(backend.connections.load(Ordering::Acquire), 0);
        assert_eq!(backend.bytes.load(Ordering::Acquire), 0);
        let snapshot = inspect(&candidate, &run).unwrap();
        assert_eq!(snapshot.receipt.phase, "failed-retained");
        let service = &snapshot.receipt.relay_startup.as_ref().unwrap().services["web"];
        assert_eq!(service.phase, Phase::ProvisionIntent);
        assert!(service.bindings["default"].process.is_none());
        let engine = Engine::connect_cleanup(&candidate).unwrap();
        let observed = inspect_resource(
            &engine,
            &snapshot.receipt,
            &snapshot.receipt.resources["container:web"],
        )
        .unwrap()
        .unwrap();
        assert_ne!(observed["State"]["Health"]["Status"], "healthy");
        assert_eq!(engine.guest().execute(
            "test ! -e \"/storage/hack-graph-startup/$1/$2/release\"; printf 'startup-held-v1\\n'",
            &[&run, &service.generation], None,
        ).unwrap(), "startup-held-v1\n");
    } else {
        if let Err(error) = &result {
            eprintln!("graph-startup-error-code={}", error.code);
            let cleanup = runtime.cleanup(&candidate, false);
            assert!(
                cleanup.is_ok(),
                "startup failure retained uncertain cleanup: {:?}",
                cleanup.err().map(|error| error.code)
            );
        }
        let receipt = result.unwrap();
        assert_eq!(receipt.phase, "ready-observed");
        let service = &receipt.relay_startup.as_ref().unwrap().services["web"];
        assert_eq!(service.phase, Phase::Released);
        assert!(service.bindings["default"].process.is_some());
        assert!(service.started_at.is_some());
        assert_eq!(backend.connections.load(Ordering::Acquire), 1);
        assert_eq!(backend.bytes.load(Ordering::Acquire), 65536);
        let snapshot = inspect(&candidate, &run).unwrap();
        assert!(!snapshot.journal_incomplete);
        assert_eq!(snapshot.receipt.phase, "ready-observed");
    }
    assert_eq!(
        super::super::cleanup(&candidate, &run, false)
            .err()
            .unwrap()
            .code,
        "graph_relay_enrollment"
    );
    assert_eq!(
        restart(
            &candidate,
            options(&fixture.0, &plan.plan_id, &run, &readiness, &public)
        )
        .err()
        .unwrap()
        .code,
        "graph_relay_enrollment"
    );
    let cleaned = runtime.cleanup(&candidate, false).unwrap();
    assert_eq!(cleaned.phase, "stopped-data-retained");
    assert_eq!(
        cleaned.relay_cleanup.as_ref().unwrap().phase,
        cleanup_enrollment::Phase::Confirmed
    );
    host_relay::require_acknowledged_enrollment(&cleaned).unwrap();
    let snapshot = inspect(&candidate, &run).unwrap();
    assert!(!snapshot.journal_incomplete);
    assert_eq!(snapshot.receipt.phase, "stopped-data-retained");
    let engine = Engine::connect_cleanup(&candidate).unwrap();
    super::cleanup::absent(&engine, &cleaned).unwrap();
    assert!(
        inspect_resource(&engine, &cleaned, &cleaned.resources["container:web"])
            .unwrap()
            .is_none()
    );
    drop(engine);
    backend.finish().unwrap();
    drop(runtime);
    assert!(started.elapsed() < Duration::from_secs(60));
    if stale_dependency {
        println!(
            "graph-startup-stale-qualified-v1 backend_connections=0 bytes=0 startup_released=0 enrolled_cleanup_confirmed=1 startup_artifacts_absent=1"
        );
    } else {
        println!(
            "graph-startup-qualified-v1 backend_connections=1 bytes=65536 startup_released=1 enrolled_cleanup_confirmed=1 startup_artifacts_absent=1"
        );
    }
}
