use super::*;
use crate::provider::{
    relay_auth::{Authority, Binding, CLIENT_HELLO_BYTES},
    relay_integrity::Traffic,
};
use std::thread;

fn credential() -> Credential {
    Credential::from_private_input(
        Binding {
            owner: [1; 16],
            boot: [2; 16],
            endpoint: [3; 32],
            service: [4; 32],
        },
        [5; 32],
    )
    .unwrap()
}
fn limits() -> Limits {
    Limits {
        handshake_timeout: Duration::from_secs(2),
        idle_timeout: Duration::from_secs(3),
    }
}
fn pair() -> (UnixStream, UnixStream) {
    let pair = UnixStream::pair().unwrap();
    for stream in [&pair.0, &pair.1] {
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(4)))
            .unwrap();
    }
    pair
}
fn accept(stream: &mut UnixStream, authority: &Authority) -> Traffic {
    let mut hello = [0; CLIENT_HELLO_BYTES];
    stream.read_exact(&mut hello).unwrap();
    let (server, hello) = authority.challenge(&hello).unwrap();
    stream.write_all(&hello).unwrap();
    let mut proof = [0; 32];
    stream.read_exact(&mut proof).unwrap();
    let (mut session, proof) = server.finish(&proof).unwrap();
    stream.write_all(&proof).unwrap();
    session.take_traffic().unwrap()
}
fn payload_to_fin(stream: &mut UnixStream, traffic: &mut Traffic) -> Vec<u8> {
    let mut result = Vec::new();
    loop {
        let mut input = [0; MAX_WIRE];
        let limit = traffic.receive.read_capacity();
        let n = stream.read(&mut input[..limit]).unwrap();
        assert!(n > 0);
        let (used, frame) = traffic.receive.push(&input[..n]).unwrap();
        assert_eq!(used, n);
        match frame {
            Some(Frame::Data(data)) => result.extend_from_slice(data),
            Some(Frame::Fin) => return result,
            Some(Frame::Reset) => panic!("unexpected reset"),
            None => {}
        }
    }
}
#[test]
fn half_close_preserves_response_and_bounds_backpressure() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (mut server, transport) = pair();
    let (application, mut app) = pair();
    let payload: Vec<u8> = (0..512 * 1024).map(|i| (i % 251) as u8).collect();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut traffic = accept(&mut server, &authority);
            let request = payload_to_fin(&mut server, &mut traffic);
            assert_eq!(request, payload);
            for bytes in request.chunks(MAX_DATA) {
                server
                    .write_all(&traffic.send.encode(Frame::Data(bytes)).unwrap())
                    .unwrap();
            }
            server
                .write_all(&traffic.send.encode(Frame::Fin).unwrap())
                .unwrap();
        });
        let client = scope.spawn(|| run(transport, application, &credential, limits()));
        app.write_all(&payload).unwrap();
        app.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        app.read_to_end(&mut response).unwrap();
        assert_eq!(response, payload);
        let stats = client.join().unwrap().unwrap();
        assert_eq!(stats.application_bytes_sent, payload.len() as u64);
        assert_eq!(stats.application_bytes_received, payload.len() as u64);
        assert!(stats.peak_queued_bytes <= MAX_WIRE + MAX_DATA);
        server.join().unwrap();
    });
}
#[test]
fn failed_handshake_consumes_no_application_payload() {
    let credential = credential();
    let (mut server, transport) = pair();
    let (application, mut app) = pair();
    let mut witness = application.try_clone().unwrap();
    app.write_all(b"untouched-application").unwrap();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut hello = [0; CLIENT_HELLO_BYTES];
            server.read_exact(&mut hello).unwrap();
            server.write_all(&[0; SERVER_HELLO_BYTES]).unwrap();
            let mut received = Vec::new();
            server.read_to_end(&mut received).unwrap();
            assert!(received.is_empty());
        });
        assert!(run(transport, application, &credential, limits()).is_err());
        let mut bytes = [0; 21];
        witness.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"untouched-application");
        server.join().unwrap();
    });
}
#[test]
fn partial_authenticated_record_is_not_delivered() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (mut server, transport) = pair();
    let (application, mut app) = pair();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut traffic = accept(&mut server, &authority);
            let bytes = traffic.send.encode(Frame::Data(b"private-record")).unwrap();
            server.write_all(&bytes[..bytes.len() - 1]).unwrap();
            server.shutdown(Shutdown::Write).unwrap();
        });
        assert!(run(transport, application, &credential, limits()).is_err());
        let mut response = Vec::new();
        app.read_to_end(&mut response).unwrap();
        assert!(response.is_empty());
        server.join().unwrap();
    });
}
#[test]
fn handshake_budget_is_not_extended_by_trickle() {
    let credential = credential();
    let (mut server, transport) = pair();
    let (application, _app) = pair();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut hello = [0; CLIENT_HELLO_BYTES];
            server.read_exact(&mut hello).unwrap();
            for _ in 0..8 {
                if server.write_all(&[0]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let result = run(
            transport,
            application,
            &credential,
            Limits {
                handshake_timeout: Duration::from_millis(70),
                ..limits()
            },
        );
        assert_eq!(result.unwrap_err().code, "relay_client_timeout");
        server.join().unwrap();
    });
}

#[test]
fn partial_record_deadline_survives_opposite_direction_progress() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (mut server, transport) = pair();
    let (application, mut app) = pair();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut traffic = accept(&mut server, &authority);
            let bytes = traffic
                .send
                .encode(Frame::Data(b"incomplete-record"))
                .unwrap();
            for byte in bytes.iter().take(10) {
                if server.write_all(&[*byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let writer = scope.spawn(|| {
            for _ in 0..12 {
                if app.write_all(b"progress").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }
        });
        let result = run(
            transport,
            application,
            &credential,
            Limits {
                idle_timeout: Duration::from_millis(70),
                ..limits()
            },
        );
        assert_eq!(result.unwrap_err().code, "relay_client_timeout");
        writer.join().unwrap();
        server.join().unwrap();
    });
}

#[cfg(target_os = "macos")]
#[test]
fn production_owner_relays_real_backend_bytes_and_half_close() {
    use crate::provider::{
        host_endpoint::HostEndpoint,
        relay_loop,
        relay_owner::{Context, OwnerLimits, RelayOwner},
    };
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let mut owner = RelayOwner::new(
        Context {
            runtime: [1; 16],
            boot: [2; 16],
        },
        OwnerLimits {
            registrations: 2,
            controls: 2,
            relay: relay_loop::Limits {
                max_flows: 2,
                connect_timeout: Duration::from_secs(2),
                idle_timeout: Duration::from_secs(3),
            },
        },
    )
    .unwrap();
    let grant = owner.register([4; 32], endpoint).unwrap();
    // A mismatched private credential must never cause a backend connection or
    // consume queued application bytes, through the actual owner admission path.
    let (bad_server, bad_transport) = pair();
    let (bad_application, mut bad_app) = pair();
    let mut witness = bad_application.try_clone().unwrap();
    bad_app.write_all(b"not-forwarded").unwrap();
    owner
        .admit(&grant.target, bad_server, Duration::from_secs(2))
        .unwrap();
    thread::scope(|scope| {
        let reactor = scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(4);
            while owner.connections() != 0 {
                assert!(Instant::now() < deadline);
                owner.tick(Duration::from_millis(10)).unwrap();
            }
        });
        assert!(run(bad_transport, bad_application, &credential(), limits()).is_err());
        reactor.join().unwrap();
    });
    let mut untouched = [0; 13];
    witness.read_exact(&mut untouched).unwrap();
    assert_eq!(&untouched, b"not-forwarded");
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    let (server, transport) = pair();
    let (application, mut app) = pair();
    owner
        .admit(&grant.target, server, Duration::from_secs(2))
        .unwrap();
    thread::scope(|scope| {
        let backend = scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(4);
            let mut peer = loop {
                match listener.accept() {
                    Ok((peer, _)) => break peer,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            peer.set_nonblocking(false).unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
            peer.set_write_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let mut bytes = Vec::new();
            peer.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"owned-request");
            peer.write_all(b"owned-response").unwrap();
            peer.shutdown(Shutdown::Write).unwrap();
        });
        let reactor = scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(4);
            while owner.connections() != 0 {
                assert!(Instant::now() < deadline);
                owner.tick(Duration::from_millis(10)).unwrap();
            }
        });
        let client = scope.spawn(|| run(transport, application, &grant.credential, limits()));
        app.write_all(b"owned-request").unwrap();
        app.shutdown(Shutdown::Write).unwrap();
        let mut bytes = Vec::new();
        app.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"owned-response");
        client.join().unwrap().unwrap();
        backend.join().unwrap();
        reactor.join().unwrap();
    });
}

#[test]
fn tcp_application_preserves_request_and_response_half_close() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (mut server, transport) = pair();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut app =
        TcpStream::connect_timeout(&listener.local_addr().unwrap(), Duration::from_secs(2))
            .unwrap();
    let (application, _) = listener.accept().unwrap();
    drop(listener);
    for stream in [&app, &application] {
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(4)))
            .unwrap();
    }
    let request: Vec<u8> = (0..128 * 1024).map(|i| (i % 251) as u8).collect();
    let response: Vec<u8> = (0..96 * 1024).map(|i| (i % 239) as u8).collect();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut traffic = accept(&mut server, &authority);
            assert_eq!(payload_to_fin(&mut server, &mut traffic), request);
            for bytes in response.chunks(MAX_DATA) {
                server
                    .write_all(&traffic.send.encode(Frame::Data(bytes)).unwrap())
                    .unwrap();
            }
            server
                .write_all(&traffic.send.encode(Frame::Fin).unwrap())
                .unwrap();
        });
        let client = scope.spawn(|| run(transport, application, &credential, limits()));
        app.write_all(&request).unwrap();
        app.shutdown(Shutdown::Write).unwrap();
        let mut received = Vec::new();
        (&mut app)
            .take(response.len() as u64 + 1)
            .read_to_end(&mut received)
            .unwrap();
        assert_eq!(received, response);
        let stats = client.join().unwrap().unwrap();
        assert_eq!(stats.application_bytes_sent, request.len() as u64);
        assert_eq!(stats.application_bytes_received, response.len() as u64);
        assert!(stats.peak_queued_bytes <= MAX_WIRE + MAX_DATA);
        server.join().unwrap();
    });
}
