#![cfg(target_os = "macos")]
//! Sequential synthetic interop fixture, not a production relay or credential service.
use hack_runtime_core::provider::{
    host_endpoint::HostEndpoint,
    relay_auth::{Authority, AuthorizedSession, Binding, CLIENT_HELLO_BYTES, Credential},
    relay_frame::Frame,
    relay_loop::{Limits, RelayLoop},
};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::{fs::MetadataExt, net::UnixListener},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

// Every actual write is nonblocking and rechecks authority, including short writes.
fn guarded_write(stream: &mut impl Write, mut bytes: &[u8], session: &AuthorizedSession) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !bytes.is_empty() {
        assert!(Instant::now() < deadline, "fixture write deadline");
        match session.with_active(|| stream.write(bytes)).unwrap() {
            Ok(0) => panic!("fixture write closed"),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2))
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => panic!("fixture write: {e}"),
        }
    }
}

#[test]
#[ignore = "Private HACK_LOCAL_AUTH_ROOT, stdin fixture credential and owned VM/watchdog required"]
fn mounted_authenticated_frames_and_refusals() {
    let root = PathBuf::from(std::env::var("HACK_LOCAL_AUTH_ROOT").unwrap());
    let metadata = fs::symlink_metadata(&root).unwrap();
    assert!(root.is_absolute() && metadata.is_dir() && metadata.mode() & 0o077 == 0);
    // SAFETY: geteuid has no pointer or resource-lifetime preconditions.
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    let mut packet = Zeroizing::new([0; 128]);
    std::io::stdin().read_exact(&mut packet[..]).unwrap();
    let mut binding = Binding {
        owner: packet[..16].try_into().unwrap(),
        boot: packet[16..32].try_into().unwrap(),
        endpoint: packet[32..64].try_into().unwrap(),
        service: packet[64..96].try_into().unwrap(),
    };
    let key = Zeroizing::new(<[u8; 32]>::try_from(&packet[96..]).unwrap());
    let credential = Credential::from_private_input(binding, *key).unwrap();
    let mut authority = Authority::new(&credential);
    let path = root.join("service.sock");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let socket_identity = fs::symlink_metadata(&path).unwrap();
    let backend = TcpListener::bind("127.0.0.1:0").unwrap();
    backend.set_nonblocking(true).unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        backend.local_addr().unwrap().port(),
    )
    .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let backend_count = count.clone();
    let backend_stopped = stopped.clone();
    let backend_thread = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(180);
        while !backend_stopped.load(Ordering::Relaxed) && Instant::now() < deadline {
            match backend.accept() {
                Ok((mut stream, _)) => {
                    backend_count.fetch_add(1, Ordering::Relaxed);
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut body = Vec::new();
                    Read::by_ref(&mut stream)
                        .take(65537)
                        .read_to_end(&mut body)
                        .unwrap();
                    assert_eq!(body.len(), 65536);
                    assert!(body.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
                    stream.write_all(&body).unwrap();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(e) => panic!("fixture backend: {e}"),
            }
        }
    });
    fs::write(root.join("ready"), b"auth fixture only").unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    for (index, expected) in [
        "echo",
        "wrong-key",
        "tamper",
        "replay",
        "revoke",
        "stale",
        "echo",
    ]
    .iter()
    .enumerate()
    {
        let mut transport = loop {
            assert!(Instant::now() < deadline, "external fixture timeout");
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(e) => panic!("fixture listener: {e}"),
            }
        };
        assert_eq!(fs::read_to_string(root.join("mode")).unwrap(), *expected);
        if *expected == "stale" {
            authority.revoke();
            binding.boot[0] ^= 1;
            authority = Authority::new(&Credential::from_private_input(binding, *key).unwrap());
        }
        if *expected == "echo" {
            let mut relay = RelayLoop::new(Limits {
                max_flows: 1,
                connect_timeout: Duration::from_secs(2),
                idle_timeout: Duration::from_secs(5),
            })
            .unwrap();
            relay
                .admit(transport, &endpoint, &authority, Duration::from_secs(5))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while relay.connections() > 0 {
                assert!(Instant::now() < deadline);
                relay.tick(Duration::from_secs(1)).unwrap();
            }
            assert_eq!(relay.stats().finished, 1);
            assert_eq!(relay.stats().failed, 0);
            assert!(relay.stats().peak_queued_bytes <= 16384 + 16440);
            fs::write(root.join(format!("receipt-{index}")), b"authenticated-echo").unwrap();
            continue;
        }
        transport.set_nonblocking(false).unwrap();
        transport
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        transport
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut hello = [0; CLIENT_HELLO_BYTES];
        transport.read_exact(&mut hello).unwrap();
        let challenge = authority.challenge(&hello);
        if *expected == "stale" {
            assert!(challenge.is_err());
            fs::write(
                root.join(format!("receipt-{index}")),
                b"stale-binding-refused",
            )
            .unwrap();
            continue;
        }
        let (handshake, response) = challenge.unwrap();
        transport.write_all(&response).unwrap();
        let mut proof = [0; 32];
        transport.read_exact(&mut proof).unwrap();
        let finished = handshake.finish(&proof);
        if *expected == "wrong-key" {
            assert!(finished.is_err());
            fs::write(
                root.join(format!("receipt-{index}")),
                b"wrong-proof-refused",
            )
            .unwrap();
            continue;
        }
        let (mut session, accepted) = finished.unwrap();
        transport.set_nonblocking(true).unwrap();
        guarded_write(&mut transport, &accepted, &session);
        transport.set_nonblocking(false).unwrap();
        let mut traffic = session.take_traffic().unwrap();
        let mut request = Vec::new();
        let mut malformed = false;
        let mut complete = false;
        let mut buffer = [0; 4096];
        while !complete && !malformed {
            assert!(Instant::now() < deadline, "fixture request deadline");
            let read = transport.read(&mut buffer).unwrap();
            assert_ne!(read, 0);
            let mut offset = 0;
            while offset < read {
                let (used, frame) = match traffic.receive.push(&buffer[offset..read]) {
                    Ok(value) => value,
                    Err(_) => {
                        malformed = true;
                        break;
                    }
                };
                offset += used;
                match frame {
                    Some(Frame::Data(data)) => {
                        assert!(request.len() + data.len() <= 65536);
                        request.extend_from_slice(data);
                    }
                    Some(Frame::Fin) => {
                        assert_eq!(offset, read);
                        complete = true;
                        break;
                    }
                    Some(Frame::Reset) => panic!("unexpected fixture reset"),
                    None => {}
                }
            }
        }
        transport.set_nonblocking(true).unwrap();
        if *expected == "tamper" || *expected == "replay" {
            assert!(malformed && !complete);
            assert_eq!(request.len(), if *expected == "replay" { 16384 } else { 0 });
            guarded_write(
                &mut transport,
                &traffic.send.encode(Frame::Reset).unwrap(),
                &session,
            );
            fs::write(
                root.join(format!("receipt-{index}")),
                b"record-refused-before-upstream",
            )
            .unwrap();
            continue;
        }
        assert!(!malformed && complete);
        assert_eq!(request.len(), 65536);
        if *expected == "revoke" {
            authority.revoke();
            let mut delivered = false;
            assert!(session.with_active(|| delivered = true).is_err());
            assert!(!delivered);
            fs::write(
                root.join(format!("receipt-{index}")),
                b"revoked-before-upstream",
            )
            .unwrap();
            continue;
        }
        panic!("unexpected authenticated control case");
    }
    stopped.store(true, Ordering::Relaxed);
    backend_thread.join().unwrap();
    assert_eq!(count.load(Ordering::Relaxed), 2);
    authority.revoke();
    drop(listener);
    let observed = fs::symlink_metadata(&path).unwrap();
    assert_eq!(
        (observed.dev(), observed.ino()),
        (socket_identity.dev(), socket_identity.ino())
    );
    fs::remove_file(path).unwrap();
    fs::write(root.join("host-complete"), b"2 upstreams, 5 refusals").unwrap();
}
