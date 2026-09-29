#![cfg(target_os = "macos")]
//! Manual synthetic fixture only: no application authorization or production server.
use hack_runtime_core::provider::{
    host_endpoint::HostEndpoint,
    relay_frame::{Decoder, Encoder, Frame},
};
use std::{
    fs,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    os::unix::{fs::MetadataExt, net::UnixListener},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[test]
#[ignore = "Explicit private HACK_LOCAL_FRAME_ROOT plus external owned VM/watchdog required"]
fn mounted_frames_deliver_explicit_eof_to_owned_tcp_peer() {
    let root = PathBuf::from(std::env::var("HACK_LOCAL_FRAME_ROOT").unwrap());
    assert!(root.is_absolute());
    let metadata = fs::symlink_metadata(&root).unwrap();
    assert!(metadata.is_dir() && metadata.mode() & 0o077 == 0);
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
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
        let deadline = Instant::now() + Duration::from_secs(90);
        while !backend_stopped.load(Ordering::Relaxed) && Instant::now() < deadline {
            match backend.accept() {
                Ok((mut stream, _)) => {
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
                    assert!(
                        body.iter()
                            .enumerate()
                            .all(|(i, byte)| *byte == (i % 251) as u8)
                    );
                    stream.write_all(&body).unwrap();
                    backend_count.fetch_add(1, Ordering::Relaxed);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("fixture backend: {error}"),
            }
        }
    });
    fs::write(root.join("ready"), b"framed fixture only").unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut successes = 0;
    let mut rejected = 0;
    while successes + rejected < 3 {
        assert!(Instant::now() < deadline, "external probe did not finish");
        let (mut transport, _) = match listener.accept() {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            Err(error) => panic!("fixture listener: {error}"),
        };
        transport.set_nonblocking(false).unwrap();
        transport
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        transport
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut decoder = Decoder::default();
        let mut peer: Option<TcpStream> = None;
        let mut total = 0;
        let mut explicit_fin = false;
        let mut malformed = false;
        let mut input = [0; 4096];
        'request: while !explicit_fin {
            let read = transport.read(&mut input).unwrap();
            assert_ne!(read, 0, "raw EOF cannot replace a FIN frame");
            let mut offset = 0;
            while offset < read {
                let (used, frame) = match decoder.push(&input[offset..read]) {
                    Ok(value) => value,
                    Err(_) => {
                        malformed = true;
                        break 'request;
                    }
                };
                offset += used;
                match frame {
                    Some(Frame::Data(bytes)) => {
                        total += bytes.len();
                        assert!(total <= 65536);
                        if peer.is_none() {
                            peer = Some(endpoint.connect(Duration::from_secs(2)).unwrap());
                        }
                        peer.as_mut().unwrap().write_all(bytes).unwrap();
                    }
                    Some(Frame::Fin) => {
                        assert_eq!(offset, read, "fixture expects FIN last");
                        assert_eq!(total, 65536);
                        peer.as_mut().unwrap().shutdown(Shutdown::Write).unwrap();
                        explicit_fin = true;
                    }
                    Some(Frame::Reset) => panic!("unexpected fixture reset"),
                    None => {}
                }
            }
        }
        let mut encoder = Encoder::default();
        if malformed {
            assert!(peer.is_none(), "malformed header must not open an upstream");
            transport
                .write_all(&encoder.encode(Frame::Reset).unwrap())
                .unwrap();
            rejected += 1;
            continue;
        }
        let mut peer = peer.unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut body = [0; 16384];
        loop {
            let read = peer.read(&mut body).unwrap();
            if read == 0 {
                break;
            }
            transport
                .write_all(&encoder.encode(Frame::Data(&body[..read])).unwrap())
                .unwrap();
        }
        transport
            .write_all(&encoder.encode(Frame::Fin).unwrap())
            .unwrap();
        successes += 1;
    }
    stopped.store(true, Ordering::Relaxed);
    backend_thread.join().unwrap();
    assert_eq!(successes, 2);
    assert_eq!(rejected, 1);
    assert_eq!(count.load(Ordering::Relaxed), 2);
    drop(listener);
    let observed = fs::symlink_metadata(&path).unwrap();
    assert_eq!(
        (observed.dev(), observed.ino()),
        (socket_identity.dev(), socket_identity.ino())
    );
    fs::remove_file(path).unwrap();
    println!("two explicit-EOF TCP exchanges and malformed-frame no-upstream control passed");
}
