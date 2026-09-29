//! Native lifecycle qualification; synthetic data and a disposable candidate only.
use super::{NetworkIntent, Profile, lifecycle::OwnedGuest, state::Owner};
use crate::Candidate;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

struct StopPool<'a>(&'a Candidate);
impl Drop for StopPool<'_> {
    fn drop(&mut self) {
        if let Err(error) = super::down(self.0) {
            eprintln!("Owned pool cleanup requires inspection: {}", error.code);
        }
    }
}

#[test]
#[ignore = "Manual fresh candidate; requires HACK_LOCAL_TEST_ROOT and external watchdog"]
fn owned_gateway_pool_restarts_without_widening_intent() {
    let root = std::env::var("HACK_LOCAL_TEST_ROOT").expect("explicit disposable root");
    let candidate = Candidate::discover(Path::new(&root)).unwrap();
    assert_eq!(super::status(&candidate).unwrap().phase, "uninitialized");
    let cleanup = StopPool(&candidate);
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        while !server_stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    socket
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0; 4096];
                    if socket.read(&mut request).is_ok() {
                        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\ngateway-probe-ok");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("fixture accept: {error}"),
            }
        }
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let initial = super::up_with_capabilities(
            &candidate,
            Profile::Development,
            None,
            Some(NetworkIntent::HostGateway),
        )
        .unwrap();
        assert_eq!(initial.network, Some(NetworkIntent::HostGateway));
        assert_eq!(initial.phase, "running");
        let owner = Owner::load(&candidate).unwrap();
        let receipt = candidate.state_root.join("run/smolvm/owner.json");
        let before = fs::read(&receipt).unwrap();
        assert_eq!(
            super::up_with_capabilities(
                &candidate,
                Profile::Development,
                None,
                Some(NetworkIntent::Isolated)
            )
            .unwrap_err()
            .code,
            "network_conflict"
        );
        assert_eq!(fs::read(&receipt).unwrap(), before);
        {
            let guest = OwnedGuest::connect(&candidate).unwrap();
            let output = guest.execute("test ! -e /storage/hack-gateway-probe-marker; printf synthetic-gateway-marker > /storage/hack-gateway-probe-marker; wget -q -T 3 -O - http://100.96.0.1:$1/", &[&port], None).unwrap();
            assert_eq!(output, "gateway-probe-ok");
        }
        let stopped = super::down(&candidate).unwrap();
        assert_eq!(stopped.process_alive, Some(false));
        let restarted = super::up_with_profile(&candidate, Profile::Development).unwrap();
        assert_eq!(restarted.network, Some(NetworkIntent::HostGateway));
        assert_ne!(restarted.guest_boot_id, initial.guest_boot_id);
        let current = Owner::load(&candidate).unwrap();
        assert_eq!(current.storage, owner.storage);
        assert_eq!(current.overlay, owner.overlay);
        {
            let guest = OwnedGuest::connect(&candidate).unwrap();
            let output = guest.execute("test \"$(cat /storage/hack-gateway-probe-marker)\" = synthetic-gateway-marker; rm /storage/hack-gateway-probe-marker; wget -q -T 3 -O - http://100.96.0.1:$1/", &[&port], None).unwrap();
            assert_eq!(output, "gateway-probe-ok");
        }
        let stopped = super::down(&candidate).unwrap();
        assert_eq!(stopped.process_alive, Some(false));
        println!(
            "gateway lifecycle: fresh boot, conflict refusal, restart, stable disks, marker readback and shutdown passed"
        );
    }));
    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
    drop(cleanup);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "Manual stopped gateway candidate, pinned image, loopback HTTP fixture and external watchdog"]
fn owned_gateway_container_egress_and_aliases() {
    use super::engine::Engine;
    use reqwest::Method;
    use serde_json::json;
    let root = std::env::var("HACK_LOCAL_TEST_ROOT").unwrap();
    let archive = std::env::var("HACK_LOCAL_TEST_IMAGE_ARCHIVE").unwrap();
    let port = std::env::var("HACK_LOCAL_TEST_HTTP_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    assert_ne!(port, 0);
    let candidate = Candidate::discover(Path::new(&root)).unwrap();
    let status = super::status(&candidate).unwrap();
    assert_eq!(status.phase, "stopped");
    assert_eq!(status.network, Some(NetworkIntent::HostGateway));
    let cleanup = StopPool(&candidate);
    super::up_with_profile(&candidate, Profile::Development).unwrap();
    let image = "sha256:862bef9be2a18d4c737c040c247594ad9810bfe8166cc67b0f85f7aa5dc5479c";
    super::load_image(
        &candidate,
        Path::new(&archive),
        "74bb8d8c567eb02d5019ac0117efff81571c67d66899e6ad9b6c6cdf74d5dbfe",
        image,
    )
    .unwrap();
    let engine = Engine::connect(&candidate).unwrap();
    let owner = Owner::load(&candidate).unwrap();
    let name = format!("gateway-probe-{}", std::process::id());
    let labels = json!({"io.hack-local.gateway-probe":name,"io.hack-local.owner":owner.token});
    let baseline = engine
        .request(Method::GET, "/v1.53/containers/json?all=true", None)
        .unwrap();
    assert!(
        baseline.as_array().unwrap().is_empty(),
        "use the disposable empty cell only"
    );
    let network = engine
        .request(
            Method::POST,
            "/v1.53/networks/create",
            Some(&json!({"Name":name,"Driver":"bridge","Internal":false,"Labels":labels})),
        )
        .unwrap();
    let network_id = network["Id"].as_str().unwrap().to_owned();
    let mut ids = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for (case, mode, host, extra, expected) in [
            ("direct", network_id.as_str(), "100.96.0.1", json!([]), true),
            (
                "alias",
                network_id.as_str(),
                "synthetic.hack.local",
                json!(["synthetic.hack.local:100.96.0.1"]),
                true,
            ),
            ("isolated", "none", "100.96.0.1", json!([]), false),
            (
                "docker-gateway",
                network_id.as_str(),
                "synthetic.hack.local",
                json!(["synthetic.hack.local:host-gateway"]),
                true,
            ),
            (
                "stopped",
                network_id.as_str(),
                "100.96.0.1",
                json!([]),
                false,
            ),
        ] {
            if case == "stopped" {
                let path = std::env::var("HACK_LOCAL_TEST_STOP_HTTP").unwrap();
                fs::write(path, b"stop fixture").unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(6);
                while std::net::TcpStream::connect_timeout(
                    &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                    Duration::from_millis(100),
                )
                .is_ok()
                {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "host fixture did not stop"
                    );
                    thread::sleep(Duration::from_millis(20));
                }
            }
            let script = format!(
                "try {{ const r = await fetch('http://{host}:{port}/', {{signal:AbortSignal.timeout(3000)}}); if(await r.text() !== 'gateway-probe-ok') process.exit(3); console.log('connected'); }} catch {{ console.log('unreachable'); process.exit(2); }}"
            );
            let body = json!({"Image":image,"Entrypoint":["/usr/local/bin/bun","-e",script],"Cmd":[],"Labels":labels,"HostConfig":{"NetworkMode":mode,"ExtraHosts":extra,"ReadonlyRootfs":true,"Memory":67108864,"NanoCpus":100000000,"PidsLimit":32}});
            let created = engine
                .request(
                    Method::POST,
                    &format!("/v1.53/containers/create?name={name}-{case}"),
                    Some(&body),
                )
                .unwrap();
            let id = created["Id"].as_str().unwrap().to_owned();
            ids.push(id.clone());
            engine
                .request(Method::POST, &format!("/v1.53/containers/{id}/start"), None)
                .unwrap();
            let exit = engine
                .request(
                    Method::POST,
                    &format!("/v1.53/containers/{id}/wait?condition=not-running"),
                    None,
                )
                .unwrap();
            let logs = engine.logs(&id).unwrap();
            assert_eq!(
                exit["StatusCode"],
                if expected { json!(0) } else { json!(2) },
                "{case}: {logs:?}"
            );
            assert!(
                logs.0
                    .contains(if expected { "connected" } else { "unreachable" })
            );
            println!("container gateway case {case}: expected outcome verified");
        }
    }));
    for id in ids {
        let observed = engine
            .request(Method::GET, &format!("/v1.53/containers/{id}/json"), None)
            .unwrap();
        assert_eq!(observed["Config"]["Labels"], labels);
        engine
            .request(
                Method::DELETE,
                &format!("/v1.53/containers/{id}?force=true"),
                None,
            )
            .unwrap();
    }
    let observed = engine
        .request(Method::GET, &format!("/v1.53/networks/{network_id}"), None)
        .unwrap();
    assert_eq!(observed["Labels"], labels);
    engine
        .request(
            Method::DELETE,
            &format!("/v1.53/networks/{network_id}"),
            None,
        )
        .unwrap();
    assert_eq!(
        engine
            .request(Method::GET, "/v1.53/containers/json?all=true", None)
            .unwrap(),
        baseline
    );
    println!("owned container and network cleanup verified");
    drop(engine);
    drop(cleanup);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
