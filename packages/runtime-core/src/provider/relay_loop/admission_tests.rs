use super::tests::{accept, fixture, guest, reactor, session, transport_pair};
use super::*;
use crate::provider::relay_auth::Credential;
use std::{net::TcpListener, thread};

fn authenticate(client: &mut UnixStream, credential: &Credential) -> Traffic {
    let (start, hello) = credential.begin().unwrap();
    for part in hello.chunks(3) {
        client.write_all(part).unwrap();
    }
    let mut challenge = [0; 64];
    client.read_exact(&mut challenge).unwrap();
    let (finish, proof) = start.answer(&challenge).unwrap();
    for byte in proof {
        client.write_all(&[byte]).unwrap();
    }
    let mut accepted = [0; 32];
    client.read_exact(&mut accepted).unwrap();
    finish.accept(&accepted).unwrap().into_traffic()
}
fn no_backend(listener: &TcpListener) {
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
fn ticks(reactor: &mut RelayLoop, count: usize) {
    for _ in 0..count {
        reactor.tick(Duration::ZERO).unwrap();
    }
}
#[test]
fn fragmented_handshake_streams_and_shares_flow_capacity() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut reactor = reactor(2);
    let (server, mut client) = transport_pair();
    reactor
        .admit(server, &endpoint, &authority, Duration::from_secs(2))
        .unwrap();
    assert_eq!(reactor.connections(), 1);
    thread::scope(|scope| {
        let backend = scope.spawn(|| {
            let mut peer = accept(&listener);
            let mut input = [0; 4096];
            loop {
                let n = peer.read(&mut input).unwrap();
                if n == 0 {
                    break;
                }
                peer.write_all(&input[..n]).unwrap();
            }
        });
        let client = scope.spawn(|| {
            let traffic = authenticate(&mut client, &credential);
            guest(&mut client, traffic, 128 * 1024, 11);
        });
        let deadline = Instant::now() + Duration::from_secs(4);
        while reactor.connections() > 0 {
            assert!(Instant::now() < deadline);
            reactor.tick(Duration::from_millis(10)).unwrap();
        }
        client.join().unwrap();
        backend.join().unwrap();
    });
    assert_eq!(reactor.stats().admitted, 1);
    assert_eq!(reactor.stats().finished, 1);
    assert_eq!(reactor.stats().failed, 0);
}
#[test]
fn partial_hello_has_fixed_deadline_and_never_connects() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut reactor = reactor(1);
    let (server, mut client) = transport_pair();
    reactor
        .admit(server, &endpoint, &authority, Duration::from_millis(40))
        .unwrap();
    let (_, hello) = credential.begin().unwrap();
    client.write_all(&hello[..1]).unwrap();
    ticks(&mut reactor, 2);
    let deadline = reactor.handshakes[0].deadline;
    client.write_all(&hello[1..2]).unwrap();
    ticks(&mut reactor, 2);
    assert_eq!(reactor.handshakes[0].deadline, deadline);
    reactor.tick(Duration::from_secs(1)).unwrap();
    assert_eq!(reactor.connections(), 0);
    assert_eq!(reactor.stats().timed_out, 1);
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    no_backend(&listener);
}
#[test]
fn bad_proof_and_truncated_hello_close_without_upstream() {
    for bad_proof in [false, true] {
        let (listener, endpoint, authority, credential) = fixture();
        let mut reactor = reactor(1);
        let (server, mut client) = transport_pair();
        reactor
            .admit(server, &endpoint, &authority, Duration::from_secs(1))
            .unwrap();
        let (_, hello) = credential.begin().unwrap();
        if bad_proof {
            client.write_all(&hello).unwrap();
            ticks(&mut reactor, 2);
            let mut challenge = [0; 64];
            client.read_exact(&mut challenge).unwrap();
            client.write_all(&[0; 32]).unwrap();
        } else {
            client.write_all(&hello[..13]).unwrap();
            client.shutdown(Shutdown::Write).unwrap();
        }
        ticks(&mut reactor, 4);
        assert_eq!(reactor.connections(), 0);
        assert_eq!(reactor.stats().failed, 1);
        assert_eq!(reactor.stats().revoked, 0);
        no_backend(&listener);
    }
}
#[test]
fn pending_and_active_share_capacity_and_cancellation_releases_it() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut reactor = reactor(2);
    let (server, _client) = transport_pair();
    let id = reactor
        .admit(server, &endpoint, &authority, Duration::from_secs(1))
        .unwrap();
    let (_, authorized) = session(&authority, &credential);
    let (server, _client2) = transport_pair();
    let active = reactor.add(server, &endpoint, authorized).unwrap();
    let (server, mut refused) = transport_pair();
    assert_eq!(
        reactor
            .admit(server, &endpoint, &authority, Duration::from_secs(1))
            .unwrap_err()
            .code,
        "relay_capacity"
    );
    assert_eq!(refused.read(&mut [0]).unwrap(), 0);
    assert!(reactor.cancel(id));
    assert!(!reactor.cancel(id));
    assert!(reactor.cancel(active));
    assert_eq!(reactor.connections(), 0);
    assert_eq!(reactor.stats().cancelled, 2);
    drop(listener);
}
#[test]
fn shared_revocation_wakes_all_pending_handshake_stages() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut reactor = reactor(4);
    let mut clients = Vec::new();
    for phase in 0..4 {
        let (server, mut client) = transport_pair();
        reactor
            .admit(server, &endpoint, &authority, Duration::from_secs(2))
            .unwrap();
        if phase > 0 {
            let (start, hello) = credential.begin().unwrap();
            client.write_all(&hello).unwrap();
            // Advance only this newest entry: older stages must remain parked.
            let index = reactor.handshakes.len() - 1;
            let mut event = reactor.handshakes[index].events();
            event[0].revents = libc::POLLIN;
            reactor.handshakes[index].step(&event).unwrap();
            if phase > 1 {
                event[0].revents = libc::POLLOUT;
                reactor.handshakes[index].step(&event).unwrap();
                let mut challenge = [0; 64];
                client.read_exact(&mut challenge).unwrap();
                if phase == 3 {
                    let (_, proof) = start.answer(&challenge).unwrap();
                    client.write_all(&proof).unwrap();
                    event[0].revents = libc::POLLIN;
                    reactor.handshakes[index].step(&event).unwrap();
                }
            }
        }
        clients.push(client);
    }
    assert_eq!(reactor.pending(), 4);
    no_backend(&listener);
    authority.revoke();
    reactor.tick(Duration::from_secs(1)).unwrap();
    assert_eq!(reactor.connections(), 0);
    assert_eq!(reactor.stats().revoked, 4);
    for mut client in clients {
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    }
    no_backend(&listener);
}

#[test]
fn listener_accepts_one_and_preserves_owned_path() {
    let (backend, endpoint, authority, _) = fixture();
    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let root = Dir(std::env::temp_dir().join(format!(
        "hka-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    std::fs::create_dir(&root.0).unwrap();
    let path = root.0.join("relay.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let mut reactor = reactor(1);
    assert!(
        reactor
            .accept_one(&listener, &endpoint, &authority, Duration::from_secs(1))
            .unwrap()
            .is_none()
    );
    let _client = UnixStream::connect(&path).unwrap();
    let id = reactor
        .accept_one(&listener, &endpoint, &authority, Duration::from_secs(1))
        .unwrap()
        .unwrap();
    let _waiting = UnixStream::connect(&path).unwrap();
    assert_eq!(
        reactor
            .accept_one(&listener, &endpoint, &authority, Duration::from_secs(1))
            .unwrap_err()
            .code,
        "relay_capacity"
    );
    assert!(reactor.cancel(id));
    assert!(
        reactor
            .accept_one(&listener, &endpoint, &authority, Duration::from_secs(1))
            .unwrap()
            .is_some()
    );
    drop(reactor);
    assert!(path.exists());
    no_backend(&backend);
}

#[test]
fn authenticated_admission_rechecks_replaced_endpoint() {
    // The close/rebind fixture must not be inherited by unrelated parallel forks.
    // Keep its sockets in an isolated child and require the complete assertion path.
    use std::process::{Child, Command, Stdio};
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::relay_loop::admission_tests::replaced_endpoint_child",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "endpoint replacement child exceeded its watchdog"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let mut output = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .take(4097)
        .read_to_string(&mut output)
        .unwrap();
    assert!(output.len() <= 4096);
    assert!(
        output.contains("test result: ok. 1 passed"),
        "isolated assertion did not run"
    );
}
#[test]
#[ignore = "isolated close/rebind fixture launched by authenticated_admission_rechecks_replaced_endpoint"]
fn replaced_endpoint_child() {
    let (listener, endpoint, authority, credential) = fixture();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let replacement = TcpListener::bind(("127.0.0.1", port)).unwrap();
    replacement.set_nonblocking(true).unwrap();
    let mut reactor = reactor(1);
    let (server, mut client) = transport_pair();
    reactor
        .admit(server, &endpoint, &authority, Duration::from_secs(2))
        .unwrap();
    thread::scope(|scope| {
        let client = scope.spawn(|| {
            let _ = authenticate(&mut client, &credential);
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while reactor.connections() > 0 {
            assert!(Instant::now() < deadline);
            reactor.tick(Duration::from_millis(10)).unwrap();
        }
        client.join().unwrap();
    });
    assert_eq!(reactor.stats().admitted, 0);
    assert_eq!(reactor.stats().failed, 1);
    no_backend(&replacement);
}
#[test]
fn invalid_budget_and_revoked_authority_do_not_retain_transports() {
    let (listener, endpoint, authority, _) = fixture();
    let mut reactor = reactor(1);
    for budget in [Duration::ZERO, Duration::from_secs(6)] {
        let (server, mut client) = transport_pair();
        assert!(
            reactor
                .admit(server, &endpoint, &authority, budget)
                .is_err()
        );
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    }
    authority.revoke();
    let (server, mut client) = transport_pair();
    assert!(
        reactor
            .admit(server, &endpoint, &authority, Duration::from_secs(1))
            .is_err()
    );
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert_eq!(reactor.connections(), 0);
    no_backend(&listener);
}
