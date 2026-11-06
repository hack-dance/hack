//! The relay against a fake provider socket. The fake provider plays the provider's side
//! of the hazard: it keeps sending after the client left and checks that the relay
//! neither fails those sends nor closes first.
use super::*;
use std::{net::Shutdown, os::unix::fs::FileTypeExt};

/// A fake provider socket in its own short private directory.
struct Provider {
    directory: PathBuf,
    listener: UnixListener,
}
impl Provider {
    fn new() -> Self {
        let directory = private_directory().unwrap();
        let listener = UnixListener::bind(directory.join("provider.sock")).unwrap();
        Self {
            directory,
            listener,
        }
    }
    fn path(&self) -> PathBuf {
        self.directory.join("provider.sock")
    }
    fn accept(&self) -> UnixStream {
        let (stream, _) = self.listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.path());
        let _ = fs::remove_dir(&self.directory);
    }
}

fn read_to_end(stream: &mut UnixStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn bytes_pass_both_ways_and_each_end_arrives_as_a_half_close() {
    let provider = Provider::new();
    let relay = ClientRelay::start(&provider.path()).unwrap();
    let mut client = UnixStream::connect(relay.socket()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut upstream = provider.accept();
    client.write_all(b"GET /_ping HTTP/1.1\r\n\r\n").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    // The client's end of stream reaches the provider after its bytes, as a half-close.
    assert_eq!(read_to_end(&mut upstream), b"GET /_ping HTTP/1.1\r\n\r\n");
    // The provider can still answer on the half-closed connection.
    upstream.write_all(b"HTTP/1.1 200 OK\r\n\r\nOK").unwrap();
    upstream.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_to_end(&mut client), b"HTTP/1.1 200 OK\r\n\r\nOK");
    let report = relay.finish(FINISH_GRACE);
    assert_eq!(
        report,
        RelayReport {
            connections: 1,
            ..RelayReport::default()
        }
    );
}

#[test]
fn provider_bytes_after_the_client_left_are_drained_and_the_provider_ends_the_connection() {
    let provider = Provider::new();
    let relay = ClientRelay::start(&provider.path()).unwrap();
    let mut client = UnixStream::connect(relay.socket()).unwrap();
    let mut upstream = provider.accept();
    client.write_all(b"request").unwrap();
    // The client leaves before reading any response, as the build client does.
    drop(client);
    assert_eq!(read_to_end(&mut upstream), b"request");
    // Every later provider send succeeds: the relay reads and discards it.
    upstream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let chunk = vec![7_u8; 256 * 1024];
    for _ in 0..16 {
        upstream.write_all(&chunk).unwrap();
    }
    // Later still, the relay has not closed the provider side: sends keep succeeding.
    std::thread::sleep(Duration::from_millis(200));
    upstream.write_all(&chunk).unwrap();
    // Only after the provider ends its side does the relay close.
    upstream.shutdown(Shutdown::Write).unwrap();
    assert!(read_to_end(&mut upstream).is_empty());
    let report = relay.finish(FINISH_GRACE);
    assert_eq!(report.discarded_bytes, 17 * 256 * 1024);
    assert_eq!(report.forced, 0);
}

#[test]
fn finish_closes_connections_the_provider_never_ends_after_its_bound() {
    let provider = Provider::new();
    let relay = ClientRelay::start(&provider.path()).unwrap();
    let client = UnixStream::connect(relay.socket()).unwrap();
    let mut upstream = provider.accept();
    drop(client);
    assert!(read_to_end(&mut upstream).is_empty());
    let started = Instant::now();
    let report = relay.finish(Duration::from_millis(300));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(report.forced, 1);
    // The forced close reaches the provider.
    assert!(read_to_end(&mut upstream).is_empty());
}

#[test]
fn a_refused_provider_connection_ends_only_that_client_connection() {
    let provider = Provider::new();
    let path = provider.path();
    drop(provider);
    let relay = ClientRelay::start(&path).unwrap();
    let mut client = UnixStream::connect(relay.socket()).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut bytes = Vec::new();
    // The client sees the connection end, as with an absent engine socket.
    let _ = client.read_to_end(&mut bytes);
    assert!(bytes.is_empty());
    let report = relay.finish(FINISH_GRACE);
    assert_eq!((report.connections, report.refused), (1, 1));
}

#[test]
fn the_listening_socket_is_short_private_and_removed_when_the_relay_finishes() {
    let relay = ClientRelay::start(Path::new("/nonexistent/docker.sock")).unwrap();
    let socket = relay.socket().to_path_buf();
    // sockaddr_un holds 104 bytes on macOS, including the terminator.
    assert!(socket.as_os_str().len() < 104);
    let directory = socket.parent().unwrap().to_path_buf();
    let metadata = fs::symlink_metadata(&directory).unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o700);
    // SAFETY: geteuid has no preconditions.
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert!(
        fs::symlink_metadata(&socket)
            .unwrap()
            .file_type()
            .is_socket()
    );
    assert_eq!(relay.finish(FINISH_GRACE), RelayReport::default());
    assert!(!directory.exists());
}

#[test]
fn a_relay_left_by_a_killed_process_is_removed_and_a_live_one_is_kept() {
    // A process that has exited: its PID names the abandoned directory.
    let mut exited = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    let dead = exited.id();
    exited.wait().unwrap();
    let mut running = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let make = |pid: u32| {
        let directory = temporary_root().join(format!("{DIRECTORY_PREFIX}{pid}-0123456789ab"));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        drop(UnixListener::bind(directory.join(SOCKET_NAME)).unwrap());
        directory
    };
    let abandoned = make(dead);
    let live = make(running.id());
    // A directory holding anything besides the socket is never removed.
    let kept = make(dead + 1_000_000);
    fs::write(kept.join("other"), "x").unwrap();
    let relay = ClientRelay::start(Path::new("/nonexistent/docker.sock")).unwrap();
    assert!(!abandoned.exists());
    assert!(live.join(SOCKET_NAME).exists());
    assert!(kept.join("other").exists());
    relay.finish(FINISH_GRACE);
    running.kill().unwrap();
    running.wait().unwrap();
    for directory in [live, kept] {
        let _ = fs::remove_dir_all(directory);
    }
}

/// A peer that takes a little at a time and then reports a full buffer, checking that the
/// bytes arrive in order.
struct SlowPeer {
    received: u64,
    calls: u64,
}
impl Write for SlowPeer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.calls += 1;
        if self.calls % 3 == 0 {
            return Err(ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(1500);
        for byte in &bytes[..count] {
            assert_eq!(*byte, (self.received % 251) as u8, "bytes out of order");
            self.received += 1;
        }
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn pending_storage_follows_the_queued_bytes_not_the_whole_transfer() {
    // Sustained backpressure: the queue is topped up to its limit while a slow peer
    // takes partial writes, for 128 times the limit in total.
    let total = 128 * TO_PROVIDER_LIMIT as u64;
    let mut pending = Pending::default();
    let mut peer = SlowPeer {
        received: 0,
        calls: 0,
    };
    let mut sent = 0_u64;
    let mut largest = 0;
    let mut chunk = vec![0_u8; CHUNK];
    while peer.received < total {
        if pending.len() < TO_PROVIDER_LIMIT && sent < total {
            let count = CHUNK.min((total - sent) as usize);
            for (offset, byte) in chunk[..count].iter_mut().enumerate() {
                *byte = ((sent + offset as u64) % 251) as u8;
            }
            pending.push(&chunk[..count]);
            sent += count as u64;
        }
        pending.flush(&mut peer).unwrap();
        largest = largest.max(pending.bytes.capacity());
    }
    assert!(pending.is_empty());
    assert_eq!(peer.received, total);
    // Delivered bytes are dropped: storage stays within a small multiple of the limit.
    assert!(
        largest <= 4 * (TO_PROVIDER_LIMIT + CHUNK),
        "buffer grew to {largest} bytes for a {TO_PROVIDER_LIMIT}-byte limit"
    );
}
