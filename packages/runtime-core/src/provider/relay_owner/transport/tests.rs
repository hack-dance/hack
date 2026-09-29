use super::*;
use crate::provider::{
    host_endpoint::HostEndpoint,
    relay_loop::Limits,
    relay_owner::{Context, OwnerLimits},
};
use std::net::TcpListener;

fn peer() -> ProcessIdentity {
    identity::observe(std::process::id() as i32).unwrap()
}
fn fixture() -> (RelayOwner, TcpListener, RetireRequest) {
    let mut owner = RelayOwner::new(
        Context {
            runtime: [1; 16],
            boot: [2; 16],
        },
        OwnerLimits {
            registrations: 2,
            controls: 2,
            relay: Limits {
                max_flows: 2,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(2),
            },
        },
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let grant = owner.register([3; 32], endpoint).unwrap();
    let request = RetireRequest {
        version: 1,
        owner: owner.incarnation(),
        operation: [4; 16],
        targets: vec![grant.target],
    };
    (owner, listener, request)
}
fn frame(request: &RetireRequest) -> Vec<u8> {
    let bytes = request.encode().unwrap();
    let mut result = (bytes.len() as u32).to_be_bytes().to_vec();
    result.extend(bytes);
    result
}
fn retired(owner: &RelayOwner, request: &RetireRequest) -> bool {
    owner.entries[&request.targets[0].service].retired
}
#[test]
fn real_exchange_closes_pending_relay_before_acknowledgement() {
    let (mut owner, _listener, request) = fixture();
    let (relay, mut guest) = UnixStream::pair().unwrap();
    guest
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    owner
        .admit(&request.targets[0], relay, Duration::from_secs(1))
        .unwrap();
    let (server, client) = UnixStream::pair().unwrap();
    let mut server = ServerExchange::new(server, &peer(), Duration::from_secs(1)).unwrap();
    let mut client =
        ClientExchange::new(client, &peer(), request.clone(), Duration::from_secs(1)).unwrap();
    let mut done = false;
    let mut accepted = false;
    for _ in 0..100 {
        if !done {
            done = server.progress(&mut owner).unwrap();
        }
        if let Some(ack) = client.progress().unwrap() {
            assert!(done);
            assert!(Acknowledgement::verify(&ack.encode().unwrap(), &request).is_ok());
            assert_eq!(owner.connections(), 0);
            assert_eq!(guest.read(&mut [0]).unwrap(), 0);
            accepted = true;
            break;
        }
    }
    assert!(accepted);
    assert!(server.interest().is_none());
    assert!(client.interest().is_none());
}
#[test]
fn fragmented_request_waits_for_exact_eof_before_retirement() {
    let (mut owner, _listener, request) = fixture();
    let (server, mut client) = UnixStream::pair().unwrap();
    let mut server = ServerExchange::new(server, &peer(), Duration::from_secs(2)).unwrap();
    let deadline = server.deadline();
    for byte in frame(&request) {
        client.write_all(&[byte]).unwrap();
        assert!(!server.progress(&mut owner).unwrap());
        assert!(!retired(&owner, &request));
        assert_eq!(server.deadline(), deadline);
    }
    assert!(!server.progress(&mut owner).unwrap());
    client.shutdown(Shutdown::Write).unwrap();
    assert!(!server.progress(&mut owner).unwrap());
    assert!(retired(&owner, &request));
    assert!(server.progress(&mut owner).unwrap());
}
#[test]
fn suffix_truncation_oversize_and_malformed_requests_never_retire() {
    for mode in 0..4 {
        let (mut owner, _listener, request) = fixture();
        let (server, mut client) = UnixStream::pair().unwrap();
        let mut server = ServerExchange::new(server, &peer(), Duration::from_secs(1)).unwrap();
        let mut bytes = frame(&request);
        match mode {
            0 => bytes.push(0),
            1 => {
                bytes.pop();
            }
            2 => bytes = ((control::REQUEST_LIMIT + 1) as u32).to_be_bytes().to_vec(),
            _ => bytes = vec![0, 0, 0, 1, b'{'],
        }
        client.write_all(&bytes).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut failed = false;
        for _ in 0..20 {
            if server.progress(&mut owner).is_err() {
                failed = true;
                break;
            }
        }
        assert!(failed);
        assert!(!retired(&owner, &request));
        assert!(server.interest().is_none());
        assert!(server.wire.body.capacity() <= control::REQUEST_LIMIT);
    }
}
#[test]
fn expired_read_and_write_budgets_close_without_repeating_effect() {
    let (mut owner, _listener, request) = fixture();
    let (server, _client) = UnixStream::pair().unwrap();
    let mut server = ServerExchange::new(server, &peer(), Duration::from_secs(1)).unwrap();
    server.wire.deadline = Instant::now();
    assert!(server.progress(&mut owner).is_err());
    assert!(!retired(&owner, &request));
    let (stream, mut client) = UnixStream::pair().unwrap();
    let mut server = ServerExchange::new(stream, &peer(), Duration::from_secs(1)).unwrap();
    client.write_all(&frame(&request)).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    while !server.responded {
        assert!(!server.progress(&mut owner).unwrap());
    }
    server.wire.deadline = Instant::now();
    assert!(server.progress(&mut owner).is_err());
    assert!(retired(&owner, &request));
    assert!(server.interest().is_none());
}
#[test]
fn wrong_native_identity_is_rejected_before_any_request_bytes() {
    let (_owner, _listener, request) = fixture();
    for mode in 0..4 {
        let (server, mut client) = UnixStream::pair().unwrap();
        let mut wrong = peer();
        match mode {
            0 => wrong.pid += 1,
            1 => wrong.start_micros += 1,
            2 => wrong.uid = wrong.uid.wrapping_add(1),
            _ => wrong.executable = "/not/the/owner".into(),
        }
        assert!(
            ClientExchange::new(server, &wrong, request.clone(), Duration::from_secs(1)).is_err()
        );
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
        let (server, _client) = UnixStream::pair().unwrap();
        assert!(ServerExchange::new(server, &wrong, Duration::from_secs(1)).is_err());
    }
}
#[test]
fn lost_reply_can_be_retried_on_a_fresh_exchange() {
    let (mut owner, _listener, request) = fixture();
    let (stream, mut client) = UnixStream::pair().unwrap();
    let mut server = ServerExchange::new(stream, &peer(), Duration::from_secs(1)).unwrap();
    client.write_all(&frame(&request)).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    while !server.responded {
        server.progress(&mut owner).unwrap();
    }
    // Lose the transport after retirement but before any reply bytes are written.
    // A peer close alone need not make the next nonblocking write fail immediately.
    assert_eq!(server.wire.written, 0);
    assert!(!server.wire.output.is_empty());
    assert!(retired(&owner, &request));
    drop(client);
    drop(server);
    let before = owner.stats().revoked;
    let (stream, client) = UnixStream::pair().unwrap();
    let mut server = ServerExchange::new(stream, &peer(), Duration::from_secs(1)).unwrap();
    let mut client = ClientExchange::new(client, &peer(), request, Duration::from_secs(1)).unwrap();
    let mut done = false;
    let mut accepted = false;
    for _ in 0..100 {
        if !done {
            done = server.progress(&mut owner).unwrap();
        }
        if client.progress().unwrap().is_some() {
            accepted = true;
            break;
        }
    }
    assert!(accepted);
    assert_eq!(owner.stats().revoked, before);
}
#[test]
fn client_rejects_wrong_scope_suffix_and_missing_reply() {
    for mode in 0..3 {
        let (mut owner, _listener, request) = fixture();
        let mut wrong = request.clone();
        wrong.operation[0] ^= 1;
        let ack = owner
            .retire(if mode == 0 { &wrong } else { &request })
            .unwrap()
            .encode()
            .unwrap();
        let (mut server, stream) = UnixStream::pair().unwrap();
        let mut client =
            ClientExchange::new(stream, &peer(), request, Duration::from_secs(1)).unwrap();
        assert!(client.progress().unwrap().is_none());
        let mut bytes = (ack.len() as u32).to_be_bytes().to_vec();
        bytes.extend(ack);
        if mode == 1 {
            bytes.push(0);
        }
        if mode != 2 {
            server.write_all(&bytes).unwrap();
        }
        server.shutdown(Shutdown::Write).unwrap();
        let mut failed = false;
        for _ in 0..20 {
            if client.progress().is_err() {
                failed = true;
                break;
            }
        }
        assert!(failed);
        assert!(client.interest().is_none());
    }
}

#[test]
fn backpressured_request_does_not_extend_its_total_deadline() {
    let (_owner, _listener, mut request) = fixture();
    request.targets = (0u16..256)
        .map(|n| {
            let mut service = [7; 32];
            service[..2].copy_from_slice(&n.to_be_bytes());
            super::super::Target {
                service,
                generation: [9; 32],
            }
        })
        .collect();
    let (_server, stream) = UnixStream::pair().unwrap();
    let capacity: libc::c_int = 1024;
    // SAFETY: live socket descriptor and correctly sized immutable integer buffer.
    assert_eq!(
        unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                (&capacity as *const libc::c_int).cast(),
                std::mem::size_of_val(&capacity) as libc::socklen_t,
            )
        },
        0
    );
    let mut client = ClientExchange::new(stream, &peer(), request, Duration::from_secs(1)).unwrap();
    let deadline = client.deadline();
    for _ in 0..100 {
        assert!(client.progress().unwrap().is_none());
    }
    assert!(client.wire.sending);
    assert!(client.wire.written < client.wire.output.len());
    assert_eq!(client.deadline(), deadline);
    client.wire.deadline = Instant::now();
    assert!(client.progress().is_err());
    assert!(client.interest().is_none());
}

#[test]
#[ignore = "private child fixture launched by native_peer_identity_comes_from_connected_process"]
fn connected_peer_child() {
    let path = std::env::var_os("HACK_RELAY_TEST_PEER_SOCKET").expect("explicit child socket");
    let mut stream = UnixStream::connect(path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    assert_eq!(stream.read(&mut [0]).unwrap(), 0);
}

#[test]
fn native_peer_identity_comes_from_connected_process() {
    use std::{
        fs,
        os::unix::{fs::PermissionsExt, net::UnixListener},
        process::{Child, Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Cleanup {
        path: std::path::PathBuf,
        child: Option<Child>,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Some(child) = &mut self.child {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = fs::remove_file(self.path.join("peer.sock"));
            let _ = fs::remove_dir(&self.path);
        }
    }
    let path = std::path::PathBuf::from(format!(
        "/tmp/hack-rctl-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    let mut cleanup = Cleanup { path, child: None };
    fs::set_permissions(&cleanup.path, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = cleanup.path.join("peer.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    cleanup.child = Some(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::relay_owner::transport::tests::connected_peer_child",
            ])
            .env("HACK_RELAY_TEST_PEER_SOCKET", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(e) => panic!("{e}"),
        }
    };
    let child = cleanup.child.as_mut().unwrap();
    let expected = identity::observe(child.id() as i32).unwrap();
    assert_ne!(expected.pid, peer().pid);
    assert!(verify_peer(&stream, &peer()).is_err());
    verify_peer(&stream, &expected).unwrap();
    drop(ServerExchange::new(stream, &expected, Duration::from_secs(1)).unwrap());
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    cleanup.child.take();
}
