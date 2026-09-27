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

/// Separate owned test process: replacing this child changes PID/listener while
/// retaining the native test process as its exact stable supervisor.
pub(in crate::provider::graph) struct RestartableBackend {
    child: std::process::Child,
    output: std::sync::mpsc::Receiver<String>,
    reader: Option<JoinHandle<()>>,
    pub(in crate::provider::graph) port: u16,
}
impl RestartableBackend {
    pub(in crate::provider::graph) fn start(port: u16) -> Self {
        use std::{io::BufRead, process::Stdio};
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::graph::startup::native_test::dependency_rebind_backend_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HACK_REBIND_CHILD_PORT", port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // This owned test process emits only fixture assertions and public
            // error kinds; retain them in the qualifier log when it exits early.
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, output) = std::sync::mpsc::channel();
        let reader = thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let port = loop {
            let line = output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if let Some((_, value)) = line.split_once("rebind-backend-ready-v1 port=") {
                let selected: u16 = value.parse().unwrap();
                assert!(selected > 0 && (port == 0 || port == selected));
                break selected;
            }
        };
        Self {
            child,
            output,
            reader: Some(reader),
            port,
        }
    }
    pub(in crate::provider::graph) fn endpoint(&self) -> HostEndpoint {
        HostEndpoint::capture(self.child.id() as i32, self.port).unwrap()
    }
    pub(in crate::provider::graph) fn traffic(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut count = 0;
        while count < expected {
            let line = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if line == "rebind-backend-echo-v1 bytes=65536" {
                count += 1;
            }
        }
    }
    pub(in crate::provider::graph) fn assert_no_traffic(&self) {
        let deadline = Instant::now() + Duration::from_millis(100);
        loop {
            match self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(line) => assert_ne!(
                    line, "rebind-backend-echo-v1 bytes=65536",
                    "unexpected authenticated dependency traffic"
                ),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("owned backend exited unexpectedly")
                }
            }
        }
    }
    pub(in crate::provider::graph) fn stop(&mut self) {
        self.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(6);
        while self.child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        if self.child.try_wait().unwrap().is_none() {
            self.child.kill().unwrap();
        }
        assert!(self.child.wait().unwrap().success(), "owned backend failed");
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
    }
}
impl Drop for RestartableBackend {
    fn drop(&mut self) {
        if self.reader.is_some() {
            self.child.stdin.take();
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }
}
#[test]
fn restartable_backend_reads_fragmented_request_until_bounded_fin() {
    let mut backend = RestartableBackend::start(0);
    let generation = backend.endpoint().fingerprint().unwrap();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", backend.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let body: Vec<u8> = (0..65536).map(|i| (i % 251) as u8).collect();
    stream.write_all(&body[..1024]).unwrap();
    thread::sleep(Duration::from_millis(25));
    stream.write_all(&body[1024..]).unwrap();
    thread::sleep(Duration::from_millis(25));
    stream.shutdown(Shutdown::Write).unwrap();
    let mut echoed = Vec::new();
    stream.take(65537).read_to_end(&mut echoed).unwrap();
    assert_eq!(echoed, body);
    backend.traffic(1);
    assert_eq!(backend.endpoint().fingerprint().unwrap(), generation);
    backend.stop();
}
#[test]
#[ignore = "Owned child fixture; invoked only by the active rebind native test"]
fn dependency_rebind_backend_child() {
    let port: u16 = std::env::var("HACK_REBIND_CHILD_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    listener.set_nonblocking(true).unwrap();
    println!(
        "rebind-backend-ready-v1 port={}",
        listener.local_addr().unwrap().port()
    );
    std::io::stdout().flush().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stdin_stop = stop.clone();
    let input = thread::spawn(move || {
        let _ = std::io::stdin().read(&mut [0]);
        stdin_stop.store(true, Ordering::Release);
    });
    let deadline = Instant::now() + Duration::from_secs(180);
    while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // macOS can inherit the listener's O_NONBLOCK on accepted
                // sockets; read_to_end must honor the bounded socket timeout.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut body = Vec::new();
                (&mut stream).take(65537).read_to_end(&mut body).unwrap();
                assert_eq!(body.len(), 65536);
                assert!(body.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
                stream.write_all(&body).unwrap();
                stream.shutdown(Shutdown::Write).unwrap();
                println!("rebind-backend-echo-v1 bytes=65536");
                std::io::stdout().flush().unwrap();
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2))
            }
            Err(error) => panic!("owned backend accept failed: {error}"),
        }
    }
    assert!(
        stop.load(Ordering::Acquire),
        "owned backend lifetime expired"
    );
    input.join().unwrap();
}
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
        shared_source: false,
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
            refresh: None,
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

#[test]
#[ignore = "Owned capacity-one VM, static fixture image, reviewed relay artifact and external 180s watchdog required"]
fn active_shared_dependency_rebind_preserves_containers_and_data() {
    qualify_active_rebind(true, false);
}
#[test]
#[ignore = "Owned capacity-one VM, static fixture image, reviewed relay artifact and external 180s watchdog required"]
fn fixed_pid_dependency_refuses_active_rebind_before_effects() {
    qualify_active_rebind(false, false);
}
#[test]
#[ignore = "Owned capacity-one VM, static fixture image, reviewed relay artifact and external 240s watchdog required"]
fn cancelled_dependency_rebind_retains_evidence_and_restores_owned_data() {
    qualify_active_rebind(true, true);
}
fn fixture_exec(candidate: &Candidate, run: &str, service: &str, mode: &str) {
    let selected = service_selection(candidate, run, service).unwrap();
    let argv = vec!["/bin/hack-graph-startup-app".into(), mode.into()];
    let result = service_exec(
        candidate,
        ServiceExecOptions {
            run,
            service,
            expected_container: &selected.container,
            expected_boot: &selected.boot,
            expected_generation: &selected.generation,
            argv: &argv,
            workdir: None,
            timeout: Duration::from_secs(12),
        },
    )
    .unwrap();
    assert_eq!(result.exit_code, 0, "fixture command failed");
    assert!(!result.truncated);
}
fn qualify_active_rebind(refreshable: bool, cancel_after_fence: bool) {
    use sha2::{Digest, Sha256};
    let candidate = Candidate::discover(Path::new(
        &std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit owned root"),
    ))
    .unwrap();
    let image = std::env::var("HACK_LOCAL_TEST_IMAGE").expect("pinned fixture image");
    let artifact =
        PathBuf::from(std::env::var("HACK_GRAPH_RELAY_ARTIFACT").expect("reviewed guest artifact"));
    let hash = std::env::var("HACK_GRAPH_RELAY_SHA256").expect("pinned artifact digest");
    let fixture = super::super::tests::Fixture::new();
    let app = json!({"image":image,"read_only":true,"network_mode":"none","init":true,"user":"0:0",
        "entrypoint":["/bin/hack-graph-startup-app","serve"],"command":[],"volumes":["data:/data"],
        "healthcheck":{"test":["CMD","/bin/hack-graph-startup-app","health"],"interval":"200ms","timeout":"2s","retries":10,"start_period":"500ms"}});
    state::write(
        &fixture.0.join("compose.yaml"),
        &json!({"services":{"web":app,"search":app},"volumes":{"data":{}}}),
    )
    .unwrap();
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
    let compose_bytes = fs::read(fixture.0.join("compose.yaml")).unwrap();
    let compose_sha256 = format!("{:x}", Sha256::digest(&compose_bytes));
    let compose = project::NormalizedComposeOptions {
        project: &fixture.0,
        expected_namespace: &plan.plan.namespace,
        compose_file: Path::new("compose.yaml"),
        expected_compose_sha256: &compose_sha256,
        compose_bytes: &compose_bytes,
        profiles: &[],
    };
    let run = probes::token().unwrap();
    let readiness = BTreeMap::from([
        ("web".into(), Condition::Healthy),
        ("search".into(), Condition::Healthy),
    ]);
    let public = BTreeMap::new();
    let mut backend = RestartableBackend::start(0);
    let endpoint = backend.endpoint();
    let refresh = refreshable.then(|| {
        RefreshPolicy::capture(
            &endpoint,
            &std::env::current_exe().unwrap(),
            backend.port,
            1,
        )
        .unwrap()
    });
    let mut runtime = HostRelayRuntime::new(
        &candidate,
        &artifact,
        &hash,
        ["web", "search"]
            .into_iter()
            .map(|service| Dependency {
                service: service.into(),
                binding: "default".into(),
                slot: 0,
                port: 25252,
                aliases: vec![],
                endpoint: endpoint.clone(),
                refresh: refresh.clone(),
            })
            .collect(),
    )
    .unwrap();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let before = run_normalized_with_host_dependencies_until(
            &candidate,
            NormalizedRunOptions {
                compose,
                run: options(&fixture.0, &plan.plan_id, &run, &readiness, &public),
            },
            &mut runtime,
            &BTreeMap::new(),
            Instant::now() + Duration::from_secs(60),
        )
        .unwrap();
        backend.traffic(2);
        let generation = service_exec_generation(&before).unwrap();
        let selected = service_selection(&candidate, &run, "web").unwrap();
        fixture_exec(&candidate, &run, "web", "write-data");
        let noop = runtime
            .refresh_dependencies(&candidate, &run, &generation, || false)
            .unwrap();
        assert_eq!(noop["changed_slots"], json!([]));
        let original_resources = serde_json::to_value(&before.resources).unwrap();
        let root = directory(&candidate, &run).unwrap();
        assert!(!root.join("dependency-rebind.json").exists());
        let port = backend.port;
        backend.stop();
        backend = RestartableBackend::start(port);
        if !refreshable {
            assert_eq!(
                runtime
                    .refresh_dependencies(&candidate, &run, &generation, || false)
                    .unwrap_err()
                    .code,
                "graph_dependency_refresh_refused"
            );
            assert!(!root.join("dependency-rebind.json").exists());
            let after = inspect(&candidate, &run).unwrap();
            assert_eq!(
                serde_json::to_value(&after.receipt.resources).unwrap(),
                original_resources
            );
            assert_eq!(service_exec_generation(&after.receipt).unwrap(), generation);
            return;
        }
        if cancel_after_fence {
            let observations = std::cell::Cell::new(0usize);
            let error = runtime
                .refresh_dependencies(&candidate, &run, &generation, || {
                    if root.join("dependency-rebind.json").exists() {
                        observations.set(observations.get() + 1);
                    }
                    // First check follows prepared publication; the second is the
                    // per-binding check after slot fencing. No production test seam.
                    observations.get() >= 2
                })
                .unwrap_err();
            assert_eq!(error.code, "graph_dependency_rebind_cancelled");
            assert!(root.join("dependency-rebind.json").exists());
            assert!(inspect(&candidate, &run).unwrap().journal_incomplete);
            assert_eq!(
                service_selection(&candidate, &run, "web").unwrap_err().code,
                "graph_dependency_rebind_incomplete"
            );
            let argv = vec!["/bin/hack-graph-startup-app".into(), "read-data".into()];
            assert_eq!(
                service_exec(
                    &candidate,
                    ServiceExecOptions {
                        run: &run,
                        service: "web",
                        expected_container: &selected.container,
                        expected_boot: &selected.boot,
                        expected_generation: &generation,
                        argv: &argv,
                        workdir: None,
                        timeout: Duration::from_secs(3),
                    }
                )
                .err()
                .expect("fresh direct execution must refuse incomplete rebind")
                .code,
                "graph_dependency_rebind_incomplete"
            );
            backend.assert_no_traffic();
            return;
        }
        let rebound = runtime
            .refresh_dependencies(&candidate, &run, &generation, || false)
            .unwrap();
        assert_eq!(rebound["changed_slots"], json!([0]));
        let after = inspect(&candidate, &run).unwrap();
        assert!(!after.journal_incomplete);
        assert_eq!(
            serde_json::to_value(&after.receipt.resources).unwrap(),
            original_resources
        );
        assert_ne!(service_exec_generation(&after.receipt).unwrap(), generation);
        for service in ["web", "search"] {
            let old = &before.relay_startup.as_ref().unwrap().services[service];
            let new = &after.receipt.relay_startup.as_ref().unwrap().services[service];
            assert_eq!(old.generation, new.generation);
            assert_eq!(old.started_at, new.started_at);
            assert_ne!(
                old.bindings["default"].process,
                new.bindings["default"].process
            );
            fixture_exec(&candidate, &run, service, "read-data");
            fixture_exec(&candidate, &run, service, "dependency");
        }
        backend.traffic(2);
        let argv = vec!["/bin/hack-graph-startup-app".into(), "read-data".into()];
        assert!(
            service_exec(
                &candidate,
                ServiceExecOptions {
                    run: &run,
                    service: "web",
                    expected_container: &selected.container,
                    expected_boot: &selected.boot,
                    expected_generation: &generation,
                    argv: &argv,
                    workdir: None,
                    timeout: Duration::from_secs(3)
                }
            )
            .is_err()
        );
        assert_eq!(
            runtime
                .refresh_dependencies(&candidate, &run, &generation, || false)
                .unwrap_err()
                .code,
            "graph_dependency_refresh_refused"
        );
    }));
    let cleaned = runtime.cleanup(&candidate, false).unwrap();
    assert_eq!(cleaned.phase, "stopped-data-retained");
    let snapshot = inspect(&candidate, &run).unwrap();
    assert!(!snapshot.journal_incomplete);
    let continue_restore = outcome.is_ok() && refreshable;
    if !continue_restore {
        let removed = runtime.cleanup(&candidate, true).unwrap();
        assert_eq!(removed.phase, "removed");
        let engine = Engine::connect_cleanup(&candidate).unwrap();
        for resource in removed.resources.values() {
            assert!(
                inspect_resource(&engine, &removed, resource)
                    .unwrap()
                    .is_none()
            );
        }
    }
    drop(runtime);
    if continue_restore {
        let restored_outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let engine = Engine::connect_cleanup(&candidate).unwrap();
            let restored_generation =
                super::super::restore::restore_generation(&engine, &cleaned).unwrap();
            drop(engine);
            let endpoint = backend.endpoint();
            let refresh = RefreshPolicy::capture(
                &endpoint,
                &std::env::current_exe().unwrap(),
                backend.port,
                1,
            )
            .unwrap();
            let mut fresh = HostRelayRuntime::new_for_run(
                &candidate,
                &artifact,
                &hash,
                ["web", "search"]
                    .into_iter()
                    .map(|service| Dependency {
                        service: service.into(),
                        binding: "default".into(),
                        slot: 0,
                        port: 25252,
                        aliases: vec![],
                        endpoint: endpoint.clone(),
                        refresh: Some(refresh.clone()),
                    })
                    .collect(),
                &run,
            )
            .unwrap();
            let restored = super::super::restore::restore_normalized_foreground(
                &candidate,
                NormalizedRunOptions {
                    compose,
                    run: options(&fixture.0, &plan.plan_id, &run, &readiness, &public),
                },
                &BTreeMap::new(),
                Instant::now() + Duration::from_secs(60),
                &mut fresh,
                &restored_generation,
            );
            let assertions = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let restored = restored.as_ref().unwrap();
                assert_eq!(restored.phase, "ready-observed");
                for service in ["web", "search"] {
                    assert_ne!(
                        restored.resources[&format!("container:{service}")].id,
                        cleaned.resources[&format!("container:{service}")].id
                    );
                    fixture_exec(&candidate, &run, service, "read-data");
                }
                for (key, volume) in cleaned
                    .resources
                    .iter()
                    .filter(|(_, v)| v.kind == Kind::Volume)
                {
                    assert_eq!(restored.resources[key].id, volume.id);
                }
                backend.traffic(2);
                assert!(!inspect(&candidate, &run).unwrap().journal_incomplete);
            }));
            let removed = fresh.cleanup(&candidate, true).unwrap();
            assert_eq!(removed.phase, "removed");
            let engine = Engine::connect_cleanup(&candidate).unwrap();
            for resource in removed.resources.values() {
                assert!(
                    inspect_resource(&engine, &removed, resource)
                        .unwrap()
                        .is_none()
                );
            }
            drop(engine);
            drop(fresh);
            if let Err(panic) = assertions {
                std::panic::resume_unwind(panic)
            }
        }));
        backend.stop();
        if let Err(panic) = restored_outcome {
            std::panic::resume_unwind(panic)
        }
    } else {
        backend.stop();
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    println!(
        "graph-active-rebind-qualified-v1 refreshable={refreshable} cancelled={cancel_after_fence} shared_bindings=2 retained_data=1 owned_cleanup_confirmed=1"
    );
}
