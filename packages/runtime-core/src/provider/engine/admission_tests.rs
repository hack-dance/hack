//! Dispatch-level controls: no VM, guest, or public network endpoint participates.
use super::*;
use std::{
    io::Write,
    os::unix::fs::DirBuilderExt,
    os::unix::net::{UnixListener, UnixStream},
};

struct Fixture {
    root: std::path::PathBuf,
    path: std::path::PathBuf,
    listener: UnixListener,
}
impl Fixture {
    fn new() -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "ha-{}-{}-{}",
            std::process::id(),
            crate::node::now(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .unwrap();
        let path = root.join("s");
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self {
            root,
            path,
            listener,
        }
    }
    fn transport(&self, deadline: Instant, timeout: Duration) -> Transport {
        let mut transport = Transport::new(&self.path, timeout).unwrap();
        transport.admission_deadline = Some(deadline);
        transport
    }
    fn assert_no_request(&self) {
        assert_eq!(
            self.listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn empty_admission() -> super::super::managed_environment::Managed {
    let plan = "a".repeat(64);
    let run = "b".repeat(32);
    let input = serde_json::json!({
        "version": 1, "plan": plan, "run": run, "lifetime_seconds": 1,
        "services": {},
    });
    let (reader, mut writer) = UnixStream::pair().unwrap();
    writer
        .write_all(&serde_json::to_vec(&input).unwrap())
        .unwrap();
    drop(writer);
    let managed =
        super::super::managed_environment::receive_for_one_off(reader.into(), &plan, &run, "web")
            .unwrap();
    managed.validate_binding(&plan, &run).unwrap();
    assert!(managed.values().is_empty());
    managed
}

fn expire(deadline: Instant) {
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        std::thread::sleep(remaining + Duration::from_millis(1));
    }
}

fn respond(
    listener: UnixListener,
    expected: &'static str,
    delay_until: Option<Instant>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let timeout = Instant::now() + Duration::from_secs(3);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < timeout, "expected dispatch did not arrive");
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("test socket failed: {error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut chunk = [0_u8; 512];
            let size = socket.read(&mut chunk).unwrap();
            assert!(size > 0, "request ended before complete headers");
            request.extend_from_slice(&chunk[..size]);
            assert!(
                request.len() <= 4096,
                "request headers exceed fixture bound"
            );
        }
        assert!(std::str::from_utf8(&request).unwrap().starts_with(expected));
        if let Some(deadline) = delay_until {
            expire(deadline);
        }
        let response = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        if delay_until.is_none() {
            response.unwrap();
        }
    })
}

#[test]
fn empty_admission_expiring_before_create_sends_no_request() {
    let fixture = Fixture::new();
    let managed = empty_admission();
    let transport = fixture.transport(managed.deadline(), Duration::from_millis(250));
    expire(managed.deadline());
    let failure = transport
        .request(Method::POST, "/v1.53/containers/create?name=owned", None)
        .unwrap_err();
    assert_eq!(failure.code, "graph_environment_input");
    fixture.assert_no_request();
}

#[test]
fn empty_admission_expiring_after_create_blocks_start_but_allows_owned_delete() {
    use super::super::graph::{
        Receipt, ServiceSelection,
        one_off::{JobIntent, JobPhase},
    };
    let fixture = Fixture::new();
    let managed = empty_admission();
    let transport = fixture.transport(managed.deadline(), Duration::from_millis(250));
    let receipt: Receipt = serde_json::from_value(serde_json::json!({
        "version":1, "run":"b".repeat(32), "owner":"c".repeat(32),
        "namespace":"d".repeat(64), "plan_id":"a".repeat(64),
        "phase":"ready-observed", "readiness":{}, "resources":{
            "container:web": {
                "kind":"container", "key":"web", "name":"owned-web",
                "id":"e".repeat(64), "phase":"started", "image":format!("sha256:{}", "0".repeat(64)),
            },
        },
    })).unwrap();
    let selection = ServiceSelection {
        run: receipt.run.clone(),
        owner: receipt.owner.clone(),
        namespace: receipt.namespace.clone(),
        plan: receipt.plan_id.clone(),
        service: "web".into(),
        container: "e".repeat(64),
        boot: "boot".into(),
        generation: super::super::graph::service_exec_generation(&receipt).unwrap(),
    };
    managed.remaining().unwrap();
    let mut intent = JobIntent::reserve(
        &fixture.root,
        &receipt,
        &selection,
        &"f".repeat(32),
        &format!("hkg-{}-container-1", receipt.run),
        &serde_json::json!({}),
    )
    .unwrap();
    intent
        .advance(&fixture.root, JobPhase::CreateIntent, None)
        .unwrap();
    let create = respond(
        fixture.listener.try_clone().unwrap(),
        "POST /v1.53/containers/create?name=owned HTTP/1.1\r\n",
        None,
    );
    transport
        .request(Method::POST, "/v1.53/containers/create?name=owned", None)
        .unwrap();
    create.join().unwrap();
    let id = "1".repeat(64);
    intent
        .advance(&fixture.root, JobPhase::Created, Some(&id))
        .unwrap();
    // Image inspection or dependency verification can consume the rest of admission.
    expire(managed.deadline());
    assert!(managed.remaining().is_err());
    intent
        .advance(&fixture.root, JobPhase::StartIntent, None)
        .unwrap();
    let failure = transport
        .request(Method::POST, "/v1.53/containers/owned-id/start", None)
        .unwrap_err();
    assert_eq!(failure.code, "graph_environment_input");
    fixture.assert_no_request();
    assert!(
        intent
            .advance(&fixture.root, JobPhase::StartIntent, None)
            .is_err()
    );
    intent
        .advance(&fixture.root, JobPhase::CleanupIntent, None)
        .unwrap();
    let cleanup = respond(
        fixture.listener.try_clone().unwrap(),
        "DELETE /v1.53/containers/owned-id?v=true HTTP/1.1\r\n",
        None,
    );
    transport
        .request(Method::DELETE, "/v1.53/containers/owned-id?v=true", None)
        .unwrap();
    cleanup.join().unwrap();
    intent
        .advance(&fixture.root, JobPhase::Removed, None)
        .unwrap();
    assert_eq!(intent.container_id.as_deref(), Some(id.as_str()));
    assert!(
        intent
            .advance(&fixture.root, JobPhase::CreateIntent, None)
            .is_err()
    );
    fixture.assert_no_request();
}

#[test]
fn in_flight_mutation_cannot_renew_empty_admission_transport_budget() {
    let fixture = Fixture::new();
    let managed = empty_admission();
    let transport = fixture.transport(managed.deadline(), Duration::from_secs(3));
    let delayed = respond(
        fixture.listener.try_clone().unwrap(),
        "POST /v1.53/containers/create?name=owned HTTP/1.1\r\n",
        Some(managed.deadline() + Duration::from_millis(150)),
    );
    // The request was dispatched while valid, but its response arrives after expiry.
    // Without the remaining-lifetime timeout it would succeed under the 3s default.
    let failure = transport
        .request(Method::POST, "/v1.53/containers/create?name=owned", None)
        .unwrap_err();
    assert_eq!(failure.code, "engine_protocol");
    assert!(failure.message.contains("effect may be uncertain"));
    assert!(managed.remaining().is_err());
    delayed.join().unwrap();
    fixture.assert_no_request();
}
