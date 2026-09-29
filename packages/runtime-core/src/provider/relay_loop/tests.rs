use super::*;
use crate::provider::relay_auth::{Authority, Binding, Credential};
use std::{net::TcpListener, thread};
pub(super) fn fixture() -> (TcpListener, HostEndpoint, Authority, Credential) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let credential = Credential::from_private_input(
        Binding {
            owner: [1; 16],
            boot: [2; 16],
            endpoint: [3; 32],
            service: [4; 32],
        },
        [7; 32],
    )
    .unwrap();
    let authority = Authority::new(&credential);
    (listener, endpoint, authority, credential)
}
pub(super) fn session(
    authority: &Authority,
    credential: &Credential,
) -> (Traffic, AuthorizedSession) {
    let (client, hello) = credential.begin().unwrap();
    let (server, hello) = authority.challenge(&hello).unwrap();
    let (client, proof) = client.answer(&hello).unwrap();
    let (session, proof) = server.finish(&proof).unwrap();
    (client.accept(&proof).unwrap().into_traffic(), session)
}
pub(super) fn reactor(max_flows: usize) -> RelayLoop {
    RelayLoop::new(Limits {
        max_flows,
        connect_timeout: Duration::from_secs(2),
        idle_timeout: Duration::from_secs(3),
    })
    .unwrap()
}
pub(super) fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                return stream;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(2));
            }
            Err(e) => panic!("{e}"),
        }
    }
}
pub(super) fn transport_pair() -> (UnixStream, UnixStream) {
    let (server, client) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    (server, client)
}
pub(super) fn guest(transport: &mut UnixStream, mut traffic: Traffic, bytes: usize, seed: usize) {
    transport
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    transport
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut writer = transport.try_clone().unwrap();
    thread::scope(|scope| {
        let sender = scope.spawn(move || {
            for offset in (0..bytes).step_by(MAX_DATA) {
                let data: Vec<_> = (offset..(offset + MAX_DATA).min(bytes))
                    .map(|i| ((i + seed) % 251) as u8)
                    .collect();
                writer
                    .write_all(&traffic.send.encode(Frame::Data(&data)).unwrap())
                    .unwrap();
            }
            writer
                .write_all(&traffic.send.encode(Frame::Fin).unwrap())
                .unwrap();
        });
        let mut total = 0;
        let mut buffer = [0; MAX_WIRE];
        loop {
            let capacity = traffic.receive.read_capacity();
            assert!(capacity > 0);
            let read = transport.read(&mut buffer[..capacity]).unwrap();
            assert_ne!(read, 0);
            let (_, frame) = traffic.receive.push(&buffer[..read]).unwrap();
            match frame {
                Some(Frame::Data(data)) => {
                    for b in data {
                        assert_eq!(*b, ((total + seed) % 251) as u8);
                        total += 1;
                    }
                }
                Some(Frame::Fin) => {
                    assert_eq!(total, bytes);
                    break;
                }
                Some(Frame::Reset) => panic!("reset"),
                None => {}
            }
        }
        sender.join().unwrap();
    });
}

#[test]
fn multiple_streaming_flows_preserve_eof_and_bound_queues() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(4);
    thread::scope(|scope| {
        let mut guests = Vec::new();
        let mut peers = Vec::new();
        for flow in 0..4 {
            let (client, session) = session(&authority, &credential);
            let (server, mut transport) = transport_pair();
            relay.add(server, &endpoint, session).unwrap();
            let mut peer = accept(&listener);
            peers.push(scope.spawn(move || {
                peer.set_nonblocking(false).unwrap();
                peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                peer.set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut total = 0;
                let mut body = [0; MAX_DATA];
                loop {
                    let read = peer.read(&mut body).unwrap();
                    if read == 0 {
                        break;
                    }
                    total += read;
                    assert!(total <= 262144);
                    peer.write_all(&body[..read]).unwrap();
                }
                assert_eq!(total, 262144);
            }));
            guests.push(scope.spawn(move || guest(&mut transport, client, 262144, flow * 17)));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while relay.active() > 0 {
            assert!(Instant::now() < deadline);
            relay.tick(Duration::from_millis(100)).unwrap();
        }
        for guest in guests {
            guest.join().unwrap();
        }
        for peer in peers {
            peer.join().unwrap();
        }
    });
    assert_eq!(relay.stats.finished, 4);
    assert_eq!(relay.stats.failed, 0);
    assert!(relay.stats.peak_queued_bytes <= 4 * (MAX_DATA + MAX_WIRE));
}
#[test]
fn capacity_cancel_and_revocation_close_owned_flows() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    let (_, session1) = session(&authority, &credential);
    let (server, mut guest) = transport_pair();
    let id = relay.add(server, &endpoint, session1).unwrap();
    let mut peer = accept(&listener);
    let (_, session2) = session(&authority, &credential);
    let (server2, mut guest2) = transport_pair();
    assert_eq!(
        relay.add(server2, &endpoint, session2).unwrap_err().code,
        "relay_capacity"
    );
    assert_eq!(guest2.read(&mut [0]).unwrap(), 0);
    assert!(relay.cancel(id));
    assert!(!relay.cancel(id));
    assert_eq!(relay.active(), 0);
    assert_eq!(relay.stats.cancelled, 1);
    assert_eq!(guest.read(&mut [0]).unwrap(), 0);
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    let (_, session) = session(&authority, &credential);
    let (server, mut guest) = transport_pair();
    relay.add(server, &endpoint, session).unwrap();
    let _peer = accept(&listener);
    relay.tick(Duration::ZERO).unwrap();
    authority.revoke();
    relay.tick(Duration::from_secs(1)).unwrap();
    assert_eq!(relay.active(), 0);
    assert_eq!(relay.stats.revoked, 1);
    assert_eq!(guest.read(&mut [0]).unwrap(), 0);
}
#[test]
fn idle_and_pending_deadlines_retire_without_payload() {
    let (_listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    let (_, session) = session(&authority, &credential);
    let (server, mut guest) = transport_pair();
    relay.add(server, &endpoint, session).unwrap();
    relay.flows[0].last_activity = Instant::now() - Duration::from_secs(4);
    relay.tick(Duration::from_secs(1)).unwrap();
    assert_eq!(relay.stats.timed_out, 1);
    assert_eq!(guest.read(&mut [0]).unwrap(), 0);
    assert!(
        RelayLoop::new(Limits {
            max_flows: 0,
            connect_timeout: Duration::from_secs(1),
            idle_timeout: Duration::from_secs(1)
        })
        .is_err()
    );
}
#[test]
fn altered_record_closes_without_payload_delivery() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    let (mut client, session) = session(&authority, &credential);
    let (server, mut guest) = transport_pair();
    relay.add(server, &endpoint, session).unwrap();
    let mut peer = accept(&listener);
    let mut wire = client
        .send
        .encode(Frame::Data(b"must not reach peer"))
        .unwrap();
    wire[24] ^= 1;
    guest.write_all(&wire).unwrap();
    for _ in 0..4 {
        relay.tick(Duration::from_millis(10)).unwrap();
    }
    assert_eq!(relay.active(), 0);
    assert_eq!(relay.stats.failed, 1);
    assert_eq!(
        peer.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::ConnectionReset
    );
}

#[test]
fn stalled_guest_applies_backpressure_and_revocation_discards_queue() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    let (_, session) = session(&authority, &credential);
    let (server, _guest) = transport_pair();
    let size: libc::c_int = 1024;
    // SAFETY: server owns the descriptor; size is a readable native option integer.
    assert_eq!(
        unsafe {
            libc::setsockopt(
                server.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                (&size as *const libc::c_int).cast(),
                std::mem::size_of_val(&size) as libc::socklen_t,
            )
        },
        0
    );
    relay.add(server, &endpoint, session).unwrap();
    let mut peer = accept(&listener);
    peer.set_nonblocking(true).unwrap();
    let bytes = [42; MAX_DATA];
    for _ in 0..128 {
        match peer.write(&bytes) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => panic!("{e}"),
        }
        relay.tick(Duration::ZERO).unwrap();
    }
    assert_eq!(relay.active(), 1);
    assert!(!relay.flows[0].to_guest.empty());
    assert!(relay.stats.peak_queued_bytes <= MAX_DATA + MAX_WIRE);
    let start = Instant::now();
    relay.tick(Duration::from_millis(30)).unwrap();
    assert!(
        start.elapsed() >= Duration::from_millis(20),
        "stalled reader caused an immediate wake loop"
    );
    authority.revoke();
    relay.tick(Duration::from_secs(1)).unwrap();
    assert_eq!(relay.active(), 0);
    assert_eq!(relay.stats.revoked, 1);
}

#[test]
fn revocation_closes_all_matching_flows_but_preserves_other_authority() {
    let (listener, endpoint, authority, credential) = fixture();
    let other = Authority::new(&credential);
    let mut relay = reactor(4);
    let mut clients = Vec::new();
    let mut peers = Vec::new();
    let mut survivor = 0;
    for owner in [&authority, &authority, &authority, &other] {
        let (_, session) = session(owner, &credential);
        let (server, guest) = transport_pair();
        survivor = relay.add(server, &endpoint, session).unwrap();
        clients.push(guest);
        peers.push(accept(&listener));
    }
    relay.tick(Duration::ZERO).unwrap();
    authority.revoke();
    relay.tick(Duration::from_secs(1)).unwrap();
    assert_eq!(relay.active(), 1);
    assert_eq!(relay.stats.revoked, 3);
    for client in &mut clients[..3] {
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    }
    assert!(relay.cancel(survivor));
    assert_eq!(relay.active(), 0);
}
#[test]
fn owner_control_wakes_even_when_no_flows_are_active() {
    let mut relay = reactor(1);
    let (mut sender, mut receiver) = transport_pair();
    assert!(
        !relay
            .tick_with_wakeup(Duration::from_millis(10), receiver.as_fd())
            .unwrap()
    );
    sender.write_all(b"x").unwrap();
    assert!(
        relay
            .tick_with_wakeup(Duration::from_secs(1), receiver.as_fd())
            .unwrap()
    );
    assert_eq!(receiver.read(&mut [0]).unwrap(), 1);
    assert!(
        !relay
            .tick_with_wakeup(Duration::ZERO, receiver.as_fd())
            .unwrap()
    );
}

#[test]
fn shared_external_descriptor_fans_out_only_requested_readiness() {
    let mut relay = reactor(1);
    let (mut sender, receiver) = transport_pair();
    let interests = [
        Interest {
            fd: receiver.as_fd(),
            events: libc::POLLIN,
        },
        Interest {
            fd: receiver.as_fd(),
            events: libc::POLLOUT,
        },
        Interest {
            fd: receiver.as_fd(),
            events: libc::POLLIN,
        },
    ];
    let ready = relay.poll_tick(Duration::ZERO, &interests).unwrap();
    assert_eq!(ready[0], 0);
    assert_eq!(ready[2], 0);
    assert_ne!(ready[1] & libc::POLLOUT, 0);
    sender.write_all(b"ready").unwrap();
    let ready = relay.poll_tick(Duration::ZERO, &interests).unwrap();
    assert_eq!(ready[0], libc::POLLIN);
    assert_eq!(ready[2], libc::POLLIN);
    assert_eq!(ready[1], libc::POLLOUT);
}

#[test]
fn invalid_external_interest_is_refused_without_consuming_input() {
    let mut relay = reactor(1);
    let (mut sender, mut receiver) = transport_pair();
    sender.write_all(b"x").unwrap();
    let interests = [Interest {
        fd: receiver.as_fd(),
        events: libc::POLLNVAL,
    }];
    assert!(relay.poll_tick(Duration::ZERO, &interests).is_err());
    assert_eq!(receiver.read(&mut [0]).unwrap(), 1);
}

#[test]
fn peer_fin_keeps_the_request_direction_open() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    let (mut client, session) = session(&authority, &credential);
    let (server, mut transport) = transport_pair();
    relay.add(server, &endpoint, session).unwrap();
    let mut peer = accept(&listener);
    relay.tick(Duration::ZERO).unwrap();
    assert!(relay.flows[0].peer.is_some());
    peer.shutdown(Shutdown::Write).unwrap();
    thread::scope(|scope| {
        let guest = scope.spawn(move || {
            let mut input = [0; MAX_WIRE];
            loop {
                let cap = client.receive.read_capacity();
                let n = transport.read(&mut input[..cap]).unwrap();
                assert_ne!(n, 0);
                match client.receive.push(&input[..n]).unwrap().1 {
                    Some(Frame::Fin) => break,
                    None => {}
                    _ => panic!("unexpected response"),
                }
            }
            transport
                .write_all(
                    &client
                        .send
                        .encode(Frame::Data(b"after response FIN"))
                        .unwrap(),
                )
                .unwrap();
            transport
                .write_all(&client.send.encode(Frame::Fin).unwrap())
                .unwrap();
        });
        let server = scope.spawn(move || {
            let mut request = Vec::new();
            Read::by_ref(&mut peer)
                .take(128)
                .read_to_end(&mut request)
                .unwrap();
            assert_eq!(request, b"after response FIN");
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while relay.active() > 0 {
            assert!(Instant::now() < deadline);
            relay.tick(Duration::from_millis(100)).unwrap();
        }
        guest.join().unwrap();
        server.join().unwrap();
    });
    assert_eq!(relay.stats.finished, 1);
}
#[test]
fn unaccepted_peer_expires_on_the_connection_budget() {
    let (_listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    relay.limits.connect_timeout = Duration::from_millis(25);
    let (_, session) = session(&authority, &credential);
    let (server, mut guest) = transport_pair();
    relay.add(server, &endpoint, session).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    while relay.active() > 0 {
        assert!(Instant::now() < deadline);
        relay.tick(Duration::from_millis(100)).unwrap();
    }
    assert_eq!(relay.stats.timed_out, 1);
    assert_eq!(guest.read(&mut [0]).unwrap(), 0);
}

#[test]
fn truncated_request_is_reset_not_graceful_backend_eof() {
    let (listener, endpoint, authority, credential) = fixture();
    let mut relay = reactor(1);
    let (mut client, session) = session(&authority, &credential);
    let (server, mut guest) = transport_pair();
    relay.add(server, &endpoint, session).unwrap();
    let mut peer = accept(&listener);
    guest
        .write_all(&client.send.encode(Frame::Data(b"partial request")).unwrap())
        .unwrap();
    guest.shutdown(Shutdown::Write).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    while relay.active() > 0 {
        assert!(Instant::now() < deadline);
        relay.tick(Duration::from_millis(20)).unwrap();
    }
    let mut data = Vec::new();
    let error = Read::by_ref(&mut peer)
        .take(64)
        .read_to_end(&mut data)
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
    assert!(data.len() <= 15);
    assert_eq!(relay.stats.failed, 1);
}

#[test]
fn retirement_matches_authority_instance_not_equal_binding_or_listener() {
    let (_listener, endpoint, first, credential) = fixture();
    let second = Authority::new(&credential);
    let mut reactor = reactor(3);
    let (_, authorized) = session(&first, &credential);
    let (server, mut retired) = transport_pair();
    reactor.add(server, &endpoint, authorized).unwrap();
    let (server, mut retired_pending) = transport_pair();
    reactor
        .admit(server, &endpoint, &first, Duration::from_secs(1))
        .unwrap();
    let (server, mut unaffected) = transport_pair();
    reactor
        .admit(server, &endpoint, &second, Duration::from_secs(1))
        .unwrap();
    assert_eq!(reactor.retire_authority(&first), 2);
    assert_eq!(reactor.connections(), 1);
    assert_eq!(retired.read(&mut [0]).unwrap(), 0);
    assert_eq!(retired_pending.read(&mut [0]).unwrap(), 0);
    assert_eq!(reactor.retire_authority(&first), 0);
    assert_eq!(reactor.retire_authority(&second), 1);
    assert_eq!(unaffected.read(&mut [0]).unwrap(), 0);
    assert_eq!(reactor.stats().revoked, 3);
}
