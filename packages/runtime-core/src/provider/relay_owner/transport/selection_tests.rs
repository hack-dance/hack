use super::*;
use crate::provider::{
    host_endpoint::HostEndpoint,
    relay_loop::Limits,
    relay_owner::{Context, GraphScope, OwnerLimits},
};
use std::net::TcpListener;
fn peer() -> ProcessIdentity {
    identity::observe(std::process::id() as i32).unwrap()
}
fn fixture() -> (RelayOwner, TcpListener, GraphScope) {
    let context = Context {
        runtime: [1; 16],
        boot: [2; 16],
    };
    let scope = GraphScope::new(context, [8; 32]).unwrap();
    let mut owner = RelayOwner::new(
        context,
        OwnerLimits {
            registrations: 4,
            controls: 2,
            relay: Limits {
                max_flows: 2,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(2),
            },
        },
    )
    .unwrap();
    let backend = TcpListener::bind("127.0.0.1:0").unwrap();
    owner
        .register_graph(
            scope,
            [3; 32],
            HostEndpoint::capture(
                std::process::id() as i32,
                backend.local_addr().unwrap().port(),
            )
            .unwrap(),
        )
        .unwrap();
    (owner, backend, scope)
}
#[test]
fn reactor_selects_populated_and_empty_sets_without_retirement() {
    let (mut owner, _backend, scope) = fixture();
    let expected = owner.targets_for_graph(scope).unwrap();
    for (scope, count) in [
        (scope, 1),
        (GraphScope::new(scope.context, [9; 32]).unwrap(), 0),
    ] {
        let (client, server) = UnixStream::pair().unwrap();
        let request = SelectionRequest::new(owner.incarnation(), [7; 16], scope).unwrap();
        let mut client =
            SelectionExchange::new(client, &peer(), request, Duration::from_secs(1)).unwrap();
        owner
            .admit_control(server, &peer(), Duration::from_secs(1))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let selected = loop {
            owner.tick(Duration::ZERO).unwrap();
            if let Some(value) = client.progress().unwrap() {
                break value;
            }
            assert!(Instant::now() < deadline);
        };
        assert_eq!(selected.targets().len(), count);
        if count == 1 {
            assert_eq!(selected.targets(), expected);
        }
        assert!(owner.entries.values().all(|entry| !entry.retired));
    }
}
#[test]
fn wrong_scope_or_unscoped_registry_is_not_an_empty_success() {
    for wrong_owner in [true, false] {
        let (mut owner, _backend, scope) = fixture();
        let scope = if wrong_owner {
            scope
        } else {
            GraphScope::new(
                Context {
                    boot: [9; 16],
                    ..scope.context
                },
                scope.id,
            )
            .unwrap()
        };
        let request = SelectionRequest::new(
            if wrong_owner {
                [9; 16]
            } else {
                owner.incarnation()
            },
            [7; 16],
            scope,
        )
        .unwrap();
        assert!(GraphSelection::for_owner(&owner, request).is_err());
        owner.entries.values_mut().next().unwrap().graph = None;
        let request = SelectionRequest::new(owner.incarnation(), [7; 16], scope).unwrap();
        assert!(GraphSelection::for_owner(&owner, request).is_err());
        assert!(owner.entries.values().all(|entry| !entry.retired));
    }
}
#[test]
fn response_scope_nonce_and_target_shape_are_strict() {
    let (owner, _backend, scope) = fixture();
    let request = SelectionRequest::new(owner.incarnation(), [7; 16], scope).unwrap();
    let response = GraphSelection::for_owner(&owner, request.clone()).unwrap();
    let bytes = response.encode().unwrap();
    assert!(
        GraphSelection::verify(
            &bytes,
            &SelectionRequest::new(owner.incarnation(), [6; 16], scope).unwrap()
        )
        .is_err()
    );
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for key in ["runtime", "boot", "graph", "owner"] {
        let mut changed = value.clone();
        let original = changed["request"][key][0].as_u64().unwrap();
        changed["request"][key][0] = serde_json::json!(original ^ 1);
        assert!(GraphSelection::verify(&serde_json::to_vec(&changed).unwrap(), &request).is_err());
    }
    let mut duplicate = value.clone();
    duplicate["targets"]
        .as_array_mut()
        .unwrap()
        .push(value["targets"][0].clone());
    assert!(GraphSelection::verify(&serde_json::to_vec(&duplicate).unwrap(), &request).is_err());
    let mut zero = value.clone();
    zero["targets"][0]["generation"] = serde_json::json!(vec![0; 32]);
    assert!(GraphSelection::verify(&serde_json::to_vec(&zero).unwrap(), &request).is_err());
    assert!(GraphSelection::verify(&vec![b' '; control::REQUEST_LIMIT + 1], &request).is_err());
}
#[test]
fn suffix_truncation_oversize_and_missing_reply_cannot_be_empty_selection() {
    let (owner, _backend, scope) = fixture();
    let request = SelectionRequest::new(owner.incarnation(), [7; 16], scope).unwrap();
    let reply = GraphSelection::for_owner(&owner, request.clone())
        .unwrap()
        .encode()
        .unwrap();
    let mut framed = (reply.len() as u32).to_be_bytes().to_vec();
    framed.extend(reply);
    let mut suffix = framed.clone();
    suffix.push(0);
    let truncated = framed[..framed.len() - 1].to_vec();
    for bytes in [
        suffix,
        truncated,
        ((control::REQUEST_LIMIT + 1) as u32).to_be_bytes().to_vec(),
        vec![],
    ] {
        let (client, mut server) = UnixStream::pair().unwrap();
        server
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut client =
            SelectionExchange::new(client, &peer(), request.clone(), Duration::from_secs(1))
                .unwrap();
        server.write_all(&bytes).unwrap();
        server.shutdown(Shutdown::Write).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match client.progress() {
                Err(_) => break,
                Ok(None) => {}
                Ok(Some(_)) => panic!("invalid reply accepted"),
            };
            assert!(Instant::now() < deadline);
        }
    }
    let (client, _server) = UnixStream::pair().unwrap();
    let mut client =
        SelectionExchange::new(client, &peer(), request, Duration::from_secs(1)).unwrap();
    client.wire.deadline = Instant::now();
    assert!(client.progress().is_err());
    assert!(client.interest().is_none());
}

#[test]
fn maximum_selection_fits_and_over_capacity_refuses() {
    let (owner, _backend, scope) = fixture();
    let request = SelectionRequest::new(owner.incarnation(), [7; 16], scope).unwrap();
    let reply = GraphSelection::for_owner(&owner, request.clone())
        .unwrap()
        .encode()
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&reply).unwrap();
    let targets: Vec<_> = (0u16..256)
        .map(|index| {
            let mut service = [1; 32];
            service[30..].copy_from_slice(&index.to_be_bytes());
            serde_json::json!({"service":service,"generation":vec![2;32]})
        })
        .collect();
    value["targets"] = serde_json::json!(targets);
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(bytes.len() <= control::REQUEST_LIMIT);
    assert_eq!(
        GraphSelection::verify(&bytes, &request)
            .unwrap()
            .targets()
            .len(),
        256
    );
    let mut service = [1; 32];
    service[30..].copy_from_slice(&256u16.to_be_bytes());
    value["targets"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"service":service,"generation":vec![2;32]}));
    assert!(GraphSelection::verify(&serde_json::to_vec(&value).unwrap(), &request).is_err());
}

#[test]
fn selection_rejects_wrong_native_peer_before_sending() {
    let (owner, _backend, scope) = fixture();
    let request = SelectionRequest::new(owner.incarnation(), [7; 16], scope).unwrap();
    let (client, mut server) = UnixStream::pair().unwrap();
    server
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut wrong = peer();
    wrong.start_micros += 1;
    assert!(SelectionExchange::new(client, &wrong, request, Duration::from_secs(1)).is_err());
    assert_eq!(server.read(&mut [0]).unwrap(), 0);
}
