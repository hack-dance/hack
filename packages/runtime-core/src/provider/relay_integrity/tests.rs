use super::*;
use crate::provider::relay_auth::{Authority, AuthorizedSession, Binding, Credential};

fn pair() -> (Traffic, Traffic) {
    (
        Traffic::new(Zeroizing::new([7; 32]), Zeroizing::new([8; 32])),
        Traffic::new(Zeroizing::new([8; 32]), Zeroizing::new([7; 32])),
    )
}
fn credential() -> Credential {
    Credential::from_private_input(
        Binding {
            owner: [1; 16],
            boot: [2; 16],
            endpoint: [3; 32],
            service: [4; 32],
        },
        [7; 32],
    )
    .unwrap()
}
fn handshake(credential: &Credential, authority: &Authority) -> (Traffic, AuthorizedSession) {
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (client, proof) = client.answer(&response).unwrap();
    let (session, proof) = server.finish(&proof).unwrap();
    (client.accept(&proof).unwrap().into_traffic(), session)
}
fn record(inner: &[u8], sequence: u64) -> Vec<u8> {
    let mut wire = Vec::from(&MAGIC[..]);
    wire.extend_from_slice(&(inner.len() as u32).to_be_bytes());
    wire.extend_from_slice(&sequence.to_be_bytes());
    wire.extend_from_slice(inner);
    wire.extend_from_slice(&mac(&[7; 32], &wire).unwrap().finalize().into_bytes());
    wire
}
#[test]
fn independent_python_record_vector() {
    let (mut client, _) = pair();
    let wire = client.send.encode(Frame::Data(b"hello")).unwrap();
    let hex: String = wire.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex,
        "484b49310000000d0000000000000000484b46310100000568656c6c6f69b780bd1581b74ed462186583ea18d91b7c5a52f8f2a1f667e047004c96634b"
    );
}
#[test]
fn every_split_and_coalesced_backpressure() {
    let (mut client, _) = pair();
    let wire = client.send.encode(Frame::Data(b"hello")).unwrap();
    let fin = client.send.encode(Frame::Fin).unwrap();
    for split in 0..wire.len() {
        let (_, mut server) = pair();
        assert_eq!(server.receive.push(&wire[..split]).unwrap(), (split, None));
        assert_eq!(
            server.receive.push(&wire[split..]).unwrap(),
            (wire.len() - split, Some(Frame::Data(b"hello")))
        );
        assert_eq!(
            server.receive.push(&fin).unwrap(),
            (fin.len(), Some(Frame::Fin))
        );
        server.receive.finish_transport().unwrap();
    }
    let (_, mut server) = pair();
    let both = [wire.as_slice(), fin.as_slice()].concat();
    assert_eq!(
        server.receive.push(&both).unwrap(),
        (wire.len(), Some(Frame::Data(b"hello")))
    );
    assert_eq!(
        server.receive.push(&both[wire.len()..]).unwrap().1,
        Some(Frame::Fin)
    );
}
#[test]
fn every_byte_tampering_never_releases_payload() {
    let (mut client, _) = pair();
    let wire = client.send.encode(Frame::Data(b"hello")).unwrap();
    for index in 0..wire.len() {
        let (_, mut server) = pair();
        let mut bad = wire.clone();
        bad[index] ^= 1;
        // A length mutation may request more bytes: EOF must then refuse it.
        if let Ok((_, frame)) = server.receive.push(&bad) {
            assert_eq!(frame, None);
        }
        assert!(server.receive.finish_transport().is_err());
        assert!(server.receive.push(&wire).is_err());
    }
}
#[test]
fn replay_gaps_reflection_and_exhaustion() {
    let (mut client, mut server) = pair();
    let first = client.send.encode(Frame::Data(b"one")).unwrap();
    let second = client.send.encode(Frame::Data(b"two")).unwrap();
    server.receive.push(&first).unwrap();
    assert!(server.receive.push(&first).is_err());
    let (_, mut server) = pair();
    assert!(server.receive.push(&second).is_err());
    assert!(client.receive.push(&first).is_err());
    let (mut client, mut server) = pair();
    client.send.sequence = Some(u64::MAX);
    server.receive.sequence = Some(u64::MAX);
    let wire = client.send.encode(Frame::Fin).unwrap();
    assert_eq!(server.receive.push(&wire).unwrap().1, Some(Frame::Fin));
    server.receive.finish_transport().unwrap();
    assert!(client.send.encode(Frame::Reset).is_err());
    assert!(server.receive.push(&wire).is_err());
}
#[test]
fn every_truncated_prefix_and_missing_fin_refuse() {
    let (mut client, _) = pair();
    let wire = client.send.encode(Frame::Fin).unwrap();
    for length in 0..wire.len() {
        let (_, mut server) = pair();
        assert_eq!(server.receive.push(&wire[..length]).unwrap().1, None);
        assert!(server.receive.finish_transport().is_err());
    }
    let (mut client, mut server) = pair();
    server
        .receive
        .push(&client.send.encode(Frame::Data(b"data")).unwrap())
        .unwrap();
    assert!(server.receive.finish_transport().is_err());
}
#[test]
fn oversized_header_refuses_before_body_and_inner_must_be_exact() {
    for length in [
        0,
        7,
        (MIN_INNER + relay_frame::MAX_DATA + 1) as u32,
        u32::MAX,
    ] {
        let (_, mut server) = pair();
        let header = [MAGIC.as_slice(), &length.to_be_bytes()].concat();
        assert!(server.receive.push(&header).is_err());
        assert_eq!(server.receive.used, HEADER);
    }
    for inner in [
        b"HKF1\x02\0\0\0X".as_slice(),
        b"HKF1\x01\0\0\x02X",
        b"BAD!\x02\0\0\0",
        b"HKF1\x04\0\0\0",
    ] {
        let (_, mut server) = pair();
        assert!(server.receive.push(&record(inner, 0)).is_err());
        assert!(server.receive.push(&record(b"HKF1\x02\0\0\0", 1)).is_err());
    }
}
#[test]
fn authenticated_terminal_order_and_partial_after_fin() {
    let (mut client, mut server) = pair();
    server
        .receive
        .push(&client.send.encode(Frame::Fin).unwrap())
        .unwrap();
    assert!(client.send.encode(Frame::Data(b"late")).is_err());
    assert!(client.send.encode(Frame::Fin).is_err());
    assert_eq!(
        server
            .receive
            .push(&client.send.encode(Frame::Reset).unwrap())
            .unwrap()
            .1,
        Some(Frame::Reset)
    );
    assert!(server.receive.finish_transport().is_err());
    let (_, mut server) = pair();
    server.receive.push(&record(b"HKF1\x02\0\0\0", 0)).unwrap();
    assert!(
        server
            .receive
            .push(&record(b"HKF1\x01\0\0\x01X", 1))
            .is_err()
    );
    let (mut client, mut server) = pair();
    server
        .receive
        .push(&client.send.encode(Frame::Fin).unwrap())
        .unwrap();
    server.receive.push(b"H").unwrap();
    assert!(server.receive.finish_transport().is_err());
}
#[test]
fn maximum_payload_bytewise() {
    let (mut client, mut server) = pair();
    let payload = vec![42; relay_frame::MAX_DATA];
    let wire = client.send.encode(Frame::Data(&payload)).unwrap();
    assert_eq!(wire.len(), MAX_WIRE);
    for (index, byte) in wire.iter().enumerate() {
        let (_, frame) = server.receive.push(&[*byte]).unwrap();
        if index + 1 == wire.len() {
            assert_eq!(frame, Some(Frame::Data(&payload)));
        } else {
            assert_eq!(frame, None);
        }
    }
}
#[test]
fn accepted_handshake_keys_interoperate_and_new_session_refuses_old_record() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (mut client, mut session) = handshake(&credential, &authority);
    let mut server = session.take_traffic().unwrap();
    assert!(session.take_traffic().is_err());
    let wire = client.send.encode(Frame::Data(b"request")).unwrap();
    assert_eq!(
        server.receive.push(&wire).unwrap().1,
        Some(Frame::Data(b"request"))
    );
    let response = server.send.encode(Frame::Data(b"response")).unwrap();
    assert_eq!(
        client.receive.push(&response).unwrap().1,
        Some(Frame::Data(b"response"))
    );
    let (_, mut other) = handshake(&credential, &authority);
    assert!(other.take_traffic().unwrap().receive.push(&wire).is_err());
    let queued = client
        .send
        .encode(Frame::Data(b"queued-before-revoke"))
        .unwrap();
    authority.revoke();
    let (_, frame) = server.receive.push(&queued).unwrap();
    let Some(Frame::Data(payload)) = frame else {
        panic!("expected authenticated queued data")
    };
    let mut delivered = Vec::new();
    assert!(
        session
            .with_active(|| delivered.extend_from_slice(payload))
            .is_err()
    );
    assert!(delivered.is_empty());
    let authority = Authority::new(&credential);
    let (_, mut session) = handshake(&credential, &authority);
    authority.revoke();
    assert!(session.take_traffic().is_err());
}
