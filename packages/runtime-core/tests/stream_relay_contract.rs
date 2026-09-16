#![cfg(feature = "native-stream-relay")]
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener},
    os::{
        fd::AsRawFd,
        unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const BINARY: &str = concat!(env!("OUT_DIR"), "/stream-relay-host");
struct Relay {
    child: Child,
    root: PathBuf,
    socket: PathBuf,
}
impl Relay {
    fn start(port: u16, idle: u32) -> Self {
        Self::start_with_inherited_fd(port, idle, None)
    }
    fn start_with_inherited_fd(port: u16, idle: u32, inherited: Option<i32>) -> Self {
        Self::start_options(port, idle, inherited, None, None)
    }
    fn start_options(
        port: u16,
        idle: u32,
        inherited: Option<i32>,
        reservation: Option<&str>,
        existing: Option<PathBuf>,
    ) -> Self {
        let reuse = existing.is_some();
        let root = existing.unwrap_or_else(|| {
            PathBuf::from(format!(
                "/tmp/hkr-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ))
        });
        if !reuse {
            fs::create_dir(&root).unwrap();
        }
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("app.sock");
        let mut command = Command::new(BINARY);
        if let Some(fd) = inherited {
            unsafe {
                command.pre_exec(move || {
                    if libc::dup2(fd, 100) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        command
            .arg(&socket)
            .arg("127.0.0.1")
            .arg(port.to_string())
            .arg(idle.to_string());
        if let Some(reservation) = reservation {
            command.args(["--reservation", reservation]);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let mut descriptor = libc::pollfd {
            fd: output.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(unsafe { libc::poll(&mut descriptor, 1, 3000) }, 1);
        let mut line = String::new();
        BufReader::new(output).read_line(&mut line).unwrap();
        assert_eq!(line, "ready\n");
        assert_eq!(
            fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o700
        );
        Self {
            child,
            root,
            socket,
        }
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
    }
    fn stop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            unsafe {
                libc::kill(self.child.id() as i32, libc::SIGTERM);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() > deadline {
                self.child.kill().unwrap();
                self.child.wait().unwrap();
                panic!("relay ignored termination");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Relay {
    fn drop(&mut self) {
        self.stop();
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn large_stream_half_close_drains_all_buffered_bytes() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let relay = Relay::start(target.local_addr().unwrap().port(), 30000);
    let expected = (0..8 * 1024 * 1024)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    let server = thread::spawn(move || {
        let (mut stream, _) = target.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut data = Vec::new();
        Read::by_ref(&mut stream)
            .take(9 * 1024 * 1024)
            .read_to_end(&mut data)
            .unwrap();
        assert_eq!(data.len(), 8 * 1024 * 1024);
        stream.write_all(&data).unwrap();
    });
    let mut client = relay.connect();
    client.write_all(&expected).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    let mut actual = Vec::new();
    client.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, expected);
    server.join().unwrap();
}
#[test]
fn thirty_two_concurrent_streams_keep_payloads_separate() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let relay = Relay::start(target.local_addr().unwrap().port(), 30000);
    let server = thread::spawn(move || {
        let workers = (0..32)
            .map(|_| {
                let (mut stream, _) = target.accept().unwrap();
                thread::spawn(move || {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(10)))
                        .unwrap();
                    let mut bytes = vec![0; 262144];
                    stream.read_exact(&mut bytes).unwrap();
                    stream.write_all(&bytes).unwrap();
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }
    });
    let workers = (0..32)
        .map(|i| {
            let mut client = relay.connect();
            thread::spawn(move || {
                let expected = vec![i as u8; 262144];
                client.write_all(&expected).unwrap();
                client.shutdown(Shutdown::Write).unwrap();
                let mut actual = Vec::new();
                client.read_to_end(&mut actual).unwrap();
                assert_eq!(actual, expected);
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    server.join().unwrap();
}
#[test]
fn idle_streams_expire_and_cleanup_preserves_replaced_path() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut relay = Relay::start(target.local_addr().unwrap().port(), 100);
    let mut client = relay.connect();
    let (_upstream, _) = target.accept().unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(relay.child.try_wait().unwrap().is_none());
    fs::rename(&relay.socket, relay.root.join("original.sock")).unwrap();
    fs::write(&relay.socket, b"replacement").unwrap();
    relay.stop();
    assert_eq!(fs::read(&relay.socket).unwrap(), b"replacement");
}
#[test]
fn occupied_socket_is_not_unlinked_and_unavailable_target_fails_connection() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = target.local_addr().unwrap().port();
    drop(target);
    let mut relay = Relay::start(port, 1000);
    let status = Command::new(BINARY)
        .arg(&relay.socket)
        .arg("127.0.0.1")
        .arg(port.to_string())
        .arg("1000")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(73));
    let mut client = relay.connect();
    assert_refused(client.read(&mut [0]));
    assert!(relay.child.try_wait().unwrap().is_none());
}

#[test]
fn connection_limit_refuses_excess_without_disrupting_existing_streams() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut relay = Relay::start(target.local_addr().unwrap().port(), 30000);
    let mut clients = Vec::new();
    let mut upstreams = Vec::new();
    for _ in 0..32 {
        let mut client = relay.connect();
        let (mut upstream, _) = target.accept().unwrap();
        upstream.write_all(b"ready").unwrap();
        let mut ready = [0; 5];
        client.read_exact(&mut ready).unwrap();
        assert_eq!(&ready, b"ready");
        clients.push(client);
        upstreams.push(upstream);
    }
    let mut excess = relay.connect();
    assert_refused(excess.read(&mut [0]));
    assert!(relay.child.try_wait().unwrap().is_none());
    for (client, upstream) in clients.iter_mut().zip(&mut upstreams) {
        upstream.write_all(b"alive").unwrap();
        let mut alive = [0; 5];
        client.read_exact(&mut alive).unwrap();
        assert_eq!(&alive, b"alive");
    }
}

fn assert_refused(result: std::io::Result<usize>) {
    match result {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
            ) => {}
        other => panic!("expected prompt refusal, received {other:?}"),
    }
}

#[test]
fn inherited_descriptors_do_not_keep_parent_channels_alive() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let (mut reader, writer) = UnixStream::pair().unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut relay = Relay::start_with_inherited_fd(
        target.local_addr().unwrap().port(),
        1000,
        Some(writer.as_raw_fd()),
    );
    drop(writer);
    assert_eq!(reader.read(&mut [0]).unwrap(), 0);
    assert!(relay.child.try_wait().unwrap().is_none());
}

#[test]
fn namespace_requests_reject_invalid_identity_before_publishing() {
    let root = PathBuf::from(format!("/tmp/hkr-netns-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.join("app.sock");
    for (address, option, pid, start, code) in [
        ("127.0.0.1", "--wrong", "2", "1", 64),
        ("172.17.0.2", "--netns", "2", "1", 64),
        ("127.0.0.1", "--netns", "0", "1", 64),
        ("127.0.0.1", "--netns", "2", "0", 64),
        ("127.0.0.1", "--netns", "2", "999999999999999999999999", 64),
        ("127.0.0.1", "--netns", "1", "1", 78),
    ] {
        let status = Command::new(BINARY)
            .arg(&path)
            .args([address, "3000", "1000", option, pid, start])
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(code));
        assert!(!path.exists());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stop_refuses_malformed_or_protected_process_identity() {
    for (args, expected) in [
        (vec!["--stop"], 64),
        (vec!["--stop", "0", "1"], 64),
        (vec!["--stop", "2", "0"], 64),
        (vec!["--stop", "2", "1", "extra"], 64),
        (vec!["--stop", "1", "1"], 78),
    ] {
        assert_eq!(
            Command::new(BINARY).args(args).status().unwrap().code(),
            Some(expected)
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn pidfd_stop_preserves_wrong_identity_and_closes_owned_listener() {
    let mut relay = Relay::start(1, 1000);
    let pid = relay.child.id().to_string();
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let start: u64 = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .parse()
        .unwrap();
    let wrong = (start + 1).to_string();
    assert_eq!(
        Command::new(BINARY)
            .args(["--stop", &pid, &wrong])
            .status()
            .unwrap()
            .code(),
        Some(78)
    );
    assert!(relay.child.try_wait().unwrap().is_none());
    assert!(relay.socket.exists());
    let start = start.to_string();
    assert!(
        Command::new(BINARY)
            .args(["--stop", &pid, &start])
            .status()
            .unwrap()
            .success()
    );
    assert!(relay.child.wait().unwrap().success());
    assert!(!relay.socket.exists());
    assert_eq!(
        Command::new(BINARY)
            .args(["--stop", &pid, &start])
            .status()
            .unwrap()
            .code(),
        Some(78)
    );
}

#[test]
fn reservation_handshake_precedes_backend_connection_and_preserves_payload() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let token = "0123456789abcdef0123456789abcdef";
    let relay = Relay::start_options(
        target.local_addr().unwrap().port(),
        10000,
        None,
        Some(token),
        None,
    );
    let mut client = relay.connect();
    client.write_all(b"HKR1").unwrap();
    let mut observed = libc::pollfd {
        fd: target.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut observed, 1, 100) }, 0);
    let worker = thread::spawn(move || {
        let (mut stream, _) = target.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut data = Vec::new();
        stream.read_to_end(&mut data).unwrap();
        assert_eq!(data, b"application-payload");
        stream.write_all(b"application-reply").unwrap();
    });
    client.write_all(&token.as_bytes()[..11]).unwrap();
    client.write_all(&token.as_bytes()[11..]).unwrap();
    client.write_all(b"application-payload").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert_eq!(response, b"\x01application-reply");
    worker.join().unwrap();
}

#[test]
fn reused_socket_rejects_old_reservation_and_expiring_partial_handshakes() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let old = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let new = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let port = target.local_addr().unwrap().port();
    let mut previous = Relay::start_options(port, 10000, None, Some(old), None);
    let socket = previous.socket.clone();
    previous.stop();
    let relay = Relay::start_options(port, 10000, None, Some(new), Some(previous.root.clone()));
    assert_eq!(relay.socket, socket);
    for header in [
        format!("HKR1{old}"),
        "GET / HTTP/1.1\r\n".into(),
        "HKR1".into(),
    ] {
        let mut client = relay.connect();
        let started = Instant::now();
        client.write_all(header.as_bytes()).unwrap();
        let mut byte = [0];
        match client.read(&mut byte) {
            Ok(0) => (),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => (),
            other => panic!("invalid handshake remained usable: {other:?}"),
        }
        assert!(started.elapsed() < Duration::from_secs(3));
        let mut observed = libc::pollfd {
            fd: target.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(unsafe { libc::poll(&mut observed, 1, 0) }, 0);
    }
    let mut client = relay.connect();
    client.write_all(format!("HKR1{new}").as_bytes()).unwrap();
    let mut ack = [0];
    client.read_exact(&mut ack).unwrap();
    assert_eq!(ack, [1]);
    let (_backend, _) = target.accept().unwrap();
}

#[test]
fn malformed_reservations_refuse_before_socket_creation() {
    let root = PathBuf::from(format!("/tmp/hkr-reservation-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let socket = root.join("app.sock");
    for token in [
        "",
        "short",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "gggggggggggggggggggggggggggggggg",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        let status = Command::new(BINARY)
            .arg(&socket)
            .args(["127.0.0.1", "3000", "1000", "--reservation", token])
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(64));
        assert!(!socket.exists());
    }
    fs::remove_dir_all(root).unwrap();
}
