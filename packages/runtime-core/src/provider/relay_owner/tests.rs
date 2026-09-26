use super::*;
use crate::provider::{relay_frame::Frame, relay_integrity::Traffic};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
};
mod reactor;
fn owner() -> RelayOwner {
    RelayOwner::new(
        Context {
            runtime: [1; 16],
            boot: [2; 16],
        },
        OwnerLimits {
            registrations: 4,
            controls: 4,
            relay: Limits {
                max_flows: 8,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(2),
            },
        },
    )
    .unwrap()
}
fn grant(owner: &mut RelayOwner, service: u8) -> (TcpListener, Grant) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let grant = owner.register([service; 32], endpoint).unwrap();
    (listener, grant)
}
fn pair() -> (UnixStream, UnixStream) {
    let (server, client) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    client
        .set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    (server, client)
}
fn request(owner: &RelayOwner, targets: Vec<Target>) -> RetireRequest {
    RetireRequest {
        version: 1,
        owner: owner.incarnation(),
        operation: [9; 16],
        targets,
    }
}
fn ticks(owner: &mut RelayOwner, n: usize) {
    for _ in 0..n {
        owner.tick(Duration::ZERO).unwrap();
    }
}
fn connected(
    owner: &mut RelayOwner,
    grant: &Grant,
    listener: &TcpListener,
) -> (UnixStream, Traffic, TcpStream) {
    let (server, mut client) = pair();
    owner
        .admit(&grant.target, server, Duration::from_secs(1))
        .unwrap();
    let (start, hello) = grant.credential.begin().unwrap();
    client.write_all(&hello).unwrap();
    ticks(owner, 2);
    let mut response = [0; 64];
    client.read_exact(&mut response).unwrap();
    let (finish, proof) = start.answer(&response).unwrap();
    client.write_all(&proof).unwrap();
    ticks(owner, 2);
    let mut accepted = [0; 32];
    client.read_exact(&mut accepted).unwrap();
    let traffic = finish.accept(&accepted).unwrap().into_traffic();
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    let peer = loop {
        match listener.accept() {
            Ok((peer, _)) => break peer,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
            Err(e) => panic!("{e}"),
        }
    };
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    ticks(owner, 1);
    (client, traffic, peer)
}
#[test]
fn acknowledgement_follows_selective_pending_and_active_socket_retirement() {
    let mut owner = owner();
    let (first, one) = grant(&mut owner, 3);
    let (second, two) = grant(&mut owner, 4);
    let (mut first_client, _, mut first_peer) = connected(&mut owner, &one, &first);
    let (mut second_client, mut traffic, mut second_peer) = connected(&mut owner, &two, &second);
    let (pending, mut pending_client) = pair();
    owner
        .admit(&one.target, pending, Duration::from_secs(1))
        .unwrap();
    let request = request(&owner, vec![one.target.clone()]);
    let ack = owner.retire(&request).unwrap();
    assert_eq!(owner.connections(), 1);
    assert_eq!(pending_client.read(&mut [0]).unwrap(), 0);
    assert_eq!(first_client.read(&mut [0]).unwrap(), 0);
    assert_eq!(
        first_peer.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::ConnectionReset
    );
    assert_eq!(
        Acknowledgement::verify(&ack.encode().unwrap(), &request).unwrap(),
        ack
    );
    second_client
        .write_all(&traffic.send.encode(Frame::Data(b"still-live")).unwrap())
        .unwrap();
    ticks(&mut owner, 4);
    let mut bytes = [0; 10];
    second_peer.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"still-live");
    let before = owner.stats().revoked;
    assert_eq!(owner.retire(&request).unwrap(), ack);
    assert_eq!(owner.stats().revoked, before);
    let (server, mut client) = pair();
    assert!(
        owner
            .admit(&one.target, server, Duration::from_secs(1))
            .is_err()
    );
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
}
#[test]
fn invalid_batch_does_not_partially_revoke_valid_target() {
    let mut owner = owner();
    let (_one, first) = grant(&mut owner, 3);
    let (_two, second) = grant(&mut owner, 4);
    let (server, _client) = pair();
    owner
        .admit(&first.target, server, Duration::from_secs(1))
        .unwrap();
    let mut stale = second.target.clone();
    stale.generation[0] ^= 1;
    let invalid = request(&owner, vec![first.target.clone(), stale]);
    assert!(owner.retire(&invalid).is_err());
    assert_eq!(owner.connections(), 1);
    assert!(!owner.entries[&first.target.service].retired);
    let (start, hello) = first.credential.begin().unwrap();
    let (_, challenge) = owner.entries[&first.target.service]
        .authority
        .challenge(&hello)
        .unwrap();
    assert!(start.answer(&challenge).is_ok());
}
#[test]
fn stale_owner_and_acknowledgement_scopes_are_rejected() {
    let mut owner = owner();
    let (_listener, grant) = grant(&mut owner, 3);
    let current = request(&owner, vec![grant.target.clone()]);
    let mut wrong = current.clone();
    wrong.owner[0] ^= 1;
    assert!(owner.retire(&wrong).is_err());
    assert!(!owner.entries[&grant.target.service].retired);
    let ack = owner.retire(&current).unwrap().encode().unwrap();
    for field in 0..4 {
        let mut changed = current.clone();
        match field {
            0 => changed.owner[0] ^= 1,
            1 => changed.operation[0] ^= 1,
            2 => changed.targets[0].service[0] ^= 1,
            _ => changed.targets[0].generation[0] ^= 1,
        }
        assert!(Acknowledgement::verify(&ack, &changed).is_err());
    }
    let mut reordered = current.clone();
    reordered.targets.reverse();
    assert!(Acknowledgement::verify(&ack, &reordered).is_ok());
}
#[test]
fn bounded_codec_refuses_duplicate_unknown_and_oversized_fields() {
    let mut owner = owner();
    let (_listener, grant) = grant(&mut owner, 3);
    let request = request(&owner, vec![grant.target.clone()]);
    let encoded = request.encode().unwrap();
    assert!(RetireRequest::parse(&encoded).is_ok());
    let mut duplicate = request.clone();
    duplicate.targets.push(grant.target);
    assert!(duplicate.encode().is_err());
    assert!(owner.retire(&duplicate).is_err());
    let mut value = serde_json::to_value(&request).unwrap();
    value["extra"] = serde_json::json!(true);
    assert!(RetireRequest::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(RetireRequest::parse(&vec![b' '; 96 * 1024 + 1]).is_err());
    assert!(Acknowledgement::verify(&vec![b' '; 2049], &request).is_err());
    let mut empty = request.clone();
    empty.targets.clear();
    assert!(empty.encode().is_err());
    let mut too_many = request.clone();
    too_many.targets = vec![request.targets[0].clone(); 257];
    assert!(too_many.encode().is_err());
    assert!(RetireRequest::parse(b"{malformed").is_err());
}
#[test]
fn retired_registration_is_not_reused_and_owner_drop_revokes_escaped_sessions() {
    let mut owner = owner();
    let (listener, grant) = grant(&mut owner, 3);
    let authority = owner.entries[&grant.target.service].authority.clone();
    let (start, hello) = grant.credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (_, proof) = start.answer(&response).unwrap();
    let (session, _) = server.finish(&proof).unwrap();
    let (pending, mut client) = pair();
    owner
        .admit(&grant.target, pending, Duration::from_secs(1))
        .unwrap();
    let request = request(&owner, vec![grant.target.clone()]);
    owner.retire(&request).unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    assert!(owner.register(grant.target.service, endpoint).is_err());
    assert!(session.with_active(|| ()).is_err());
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    let (_listener, next) = self::grant(&mut owner, 4);
    let authority = owner.entries[&next.target.service].authority.clone();
    let (pending, mut client) = pair();
    owner
        .admit(&next.target, pending, Duration::from_secs(1))
        .unwrap();
    drop(owner);
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    let (_, hello) = next.credential.begin().unwrap();
    assert!(authority.challenge(&hello).is_err());
}
#[test]
fn complete_batches_are_order_independent_and_retry_without_new_effects() {
    let mut owner = owner();
    let (_one, first) = grant(&mut owner, 3);
    let (_two, second) = grant(&mut owner, 4);
    let mut request = request(&owner, vec![first.target, second.target]);
    let ack = owner.retire(&request).unwrap();
    request.targets.reverse();
    assert_eq!(owner.retire(&request).unwrap(), ack);
    assert!(Acknowledgement::verify(&ack.encode().unwrap(), &request).is_ok());
    request.operation[0] ^= 1;
    assert!(Acknowledgement::verify(&ack.encode().unwrap(), &request).is_err());
    assert!(
        Acknowledgement::verify(&owner.retire(&request).unwrap().encode().unwrap(), &request)
            .is_ok()
    );
    assert_eq!(owner.stats().revoked, 0);
}
#[test]
fn registration_capacity_includes_retired_fences() {
    let mut owner = owner();
    owner.capacity = 1;
    let (listener, grant) = grant(&mut owner, 3);
    let request = request(&owner, vec![grant.target]);
    owner.retire(&request).unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    assert!(owner.register([4; 32], endpoint).is_err());
    assert_eq!(owner.entries.len(), 1);
}

#[test]
fn graph_selection_retires_all_generations_without_closing_another_graph() {
    let mut owner = owner();
    let scope = |id| GraphScope::new(owner.context, [id; 32]).unwrap();
    let graph = scope(1);
    let other = scope(2);
    let mut backends = Vec::new();
    let mut clients = Vec::new();
    for (index, scope) in [(1, graph), (2, graph), (3, graph), (4, other)] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = HostEndpoint::capture(
            std::process::id() as i32,
            listener.local_addr().unwrap().port(),
        )
        .unwrap();
        let grant = owner.register_graph(scope, [index; 32], endpoint).unwrap();
        let (server, client) = pair();
        owner
            .admit(&grant.target, server, Duration::from_secs(3))
            .unwrap();
        backends.push(listener);
        clients.push(client);
    }
    let targets = owner.targets_for_graph(graph).unwrap();
    assert_eq!(targets.len(), 3);
    assert_eq!(owner.targets_for_graph(other).unwrap().len(), 1);
    let request = request(&owner, targets.clone());
    owner.retire(&request).unwrap();
    for client in &mut clients[..3] {
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    }
    clients[3].set_nonblocking(true).unwrap();
    assert_eq!(
        clients[3].read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(owner.connections(), 1);
    assert_eq!(
        owner.targets_for_graph(graph).unwrap(),
        targets,
        "retired evidence must remain selectable for retry"
    );
    owner.retire(&request).unwrap();
    assert_eq!(owner.connections(), 1);
}

#[test]
fn graph_selection_refuses_unknown_scope_and_unscoped_registry() {
    let mut owner = owner();
    let current = GraphScope::new(owner.context, [1; 32]).unwrap();
    assert!(owner.targets_for_graph(current).unwrap().is_empty());
    let wrong = GraphScope::new(
        Context {
            boot: [8; 16],
            ..owner.context
        },
        [1; 32],
    )
    .unwrap();
    assert!(owner.targets_for_graph(wrong).is_err());
    let (_backend, _grant) = grant(&mut owner, 1);
    assert!(
        owner.targets_for_graph(current).is_err(),
        "unknown membership cannot prove complete coverage"
    );
    assert_eq!(owner.entries.len(), 1);
    assert!(owner.entries.values().all(|entry| !entry.retired));
}

#[test]
fn shared_listener_selects_distinct_credentials_and_retirement_is_per_grant() {
    let mut owner = owner();
    let (listener, first) = grant(&mut owner, 31);
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let second = owner.register([32; 32], endpoint).unwrap();
    let targets = vec![first.target.clone(), second.target.clone()];
    let mut clients = Vec::new();
    for grant in [&first, &second] {
        let (server, mut client) = pair();
        let (start, hello) = grant.credential.begin().unwrap();
        owner
            .admit_shared(
                &targets,
                server,
                Instant::now() + Duration::from_secs(1),
                &hello,
            )
            .unwrap();
        // Selecting a public hint must not open the backend.
        assert!(listener.accept().is_err());
        ticks(&mut owner, 2);
        let mut response = [0; 64];
        client.read_exact(&mut response).unwrap();
        let (finish, proof) = start.answer(&response).unwrap();
        client.write_all(&proof).unwrap();
        ticks(&mut owner, 3);
        let mut accepted = [0; 32];
        client.read_exact(&mut accepted).unwrap();
        let traffic = finish.accept(&accepted).unwrap().into_traffic();
        let deadline = Instant::now() + Duration::from_secs(1);
        let peer = loop {
            assert!(Instant::now() < deadline);
            owner.tick(Duration::from_millis(1)).unwrap();
            match listener.accept() {
                Ok((peer, _)) => break peer,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => panic!("{e}"),
            }
        };
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        clients.push((client, traffic, peer));
    }
    owner
        .retire(&request(&owner, vec![first.target.clone()]))
        .unwrap();
    assert_eq!(clients[0].0.read(&mut [0]).unwrap(), 0);
    let (client, traffic, peer) = &mut clients[1];
    client
        .write_all(&traffic.send.encode(Frame::Data(b"live")).unwrap())
        .unwrap();
    ticks(&mut owner, 3);
    let mut bytes = [0; 4];
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut used = 0;
    while used < bytes.len() {
        assert!(Instant::now() < deadline);
        owner.tick(Duration::from_millis(1)).unwrap();
        match peer.read(&mut bytes[used..]) {
            Ok(0) => panic!("unexpected EOF"),
            Ok(n) => used += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => panic!("{e}"),
        }
    }
    assert_eq!(&bytes, b"live");
    let (_, stale) = first.credential.begin().unwrap();
    assert!(
        owner
            .admit_shared(
                &targets,
                pair().0,
                Instant::now() + Duration::from_secs(1),
                &stale
            )
            .is_err()
    );
    let (_, hello) = second.credential.begin().unwrap();
    for altered in [
        Vec::new(),
        hello[..135].to_vec(),
        {
            let mut h = hello;
            h[8] ^= 1;
            h.to_vec()
        },
        {
            let mut h = hello;
            h[72] ^= 1;
            h.to_vec()
        },
    ] {
        assert!(
            owner
                .admit_shared(
                    &targets,
                    pair().0,
                    Instant::now() + Duration::from_secs(1),
                    &altered
                )
                .is_err()
        );
    }
    assert!(
        owner
            .admit_shared(
                &[first.target],
                pair().0,
                Instant::now() + Duration::from_secs(1),
                &hello
            )
            .is_err()
    );
    assert!(
        owner
            .admit_shared(&targets, pair().0, Instant::now(), &hello)
            .is_err()
    );
}

#[test]
fn retained_grant_budget_supports_full_app_restore_then_refuses_exhaustion() {
    let mut owner = RelayOwner::new(
        Context {
            runtime: [1; 16],
            boot: [2; 16],
        },
        OwnerLimits {
            registrations: 256,
            controls: 1,
            relay: Limits {
                max_flows: 8,
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
    for index in 0u16..256 {
        let mut service = [9; 32];
        service[..2].copy_from_slice(&index.to_be_bytes());
        let grant = owner.register(service, endpoint.clone()).unwrap();
        if index < 72 {
            owner.retire(&request(&owner, vec![grant.target])).unwrap();
        }
        if index == 143 {
            assert_eq!(owner.entries.len(), 144);
            assert_eq!(
                owner
                    .entries
                    .values()
                    .filter(|entry| !entry.retired)
                    .count(),
                72
            );
        }
    }
    assert!(owner.register([10; 32], endpoint).is_err());
    assert_eq!(owner.entries.len(), 256);
}
