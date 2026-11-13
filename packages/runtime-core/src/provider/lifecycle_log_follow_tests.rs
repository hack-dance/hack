//! Real socket transport and production lease APIs, with fake container state.
//! Host process/disk identity and VM relay behavior remain native acceptance gates.
use super::*;
use std::io::{BufRead, Write};
use std::os::unix::net::UnixListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "log-leases-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        state::private_directory(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Output(mpsc::Sender<()>);
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.send(()).map_err(std::io::Error::other)
    }
}
fn accept(listener: &UnixListener) -> std::os::unix::net::UnixStream {
    listener.set_nonblocking(true).unwrap();
    let limit = Instant::now() + Duration::from_secs(3);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < limit => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("follower did not connect: {e}"),
        }
    }
}
fn headers(stream: &mut std::os::unix::net::UnixStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut request = String::new();
    let mut reader = std::io::BufReader::new(&mut *stream);
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        request.push_str(&line);
        if line == "\r\n" {
            break;
        }
        assert!(request.len() < 4096);
    }
    assert!(request.contains("/logs?follow=1&stdout=1&stderr=1&timestamps=0&tail=0"));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
        .unwrap();
}
fn frame(stream: &mut std::os::unix::net::UnixStream, received: &mpsc::Receiver<()>) {
    stream.write_all(b"\x01\0\0\0\0\0\0\x02x\n").unwrap();
    received.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[test]
fn active_log_transport_does_not_hold_or_wait_for_lifecycle_leases() {
    let fixture = Fixture::new();
    let socket = fixture.0.join("engine.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let running = AtomicBool::new(true);
    let (tx, rx) = mpsc::channel();
    std::thread::scope(|scope| {
        // An already held mutation lease must not stop the follower connecting.
        let held = state::Lock::acquire(&fixture.0).unwrap();
        let follower = scope.spawn(|| {
            crate::provider::engine::log_follow::follow_socket(
                &socket,
                &"a".repeat(64),
                "web",
                crate::provider::engine::log_follow::LogOptions {
                    tail: 0,
                    since: None,
                    timestamps: false,
                },
                || Ok(running.load(Ordering::SeqCst)),
                &mut Output(tx),
            )
        });
        let mut engine = accept(&listener);
        headers(&mut engine);
        rx.recv_timeout(Duration::from_secs(3)).unwrap(); // Attached control event.
        frame(&mut engine, &rx);
        drop(held);
        assert!(!follower.is_finished());

        let startup = startup_lease(&fixture.0, Duration::from_millis(100)).unwrap();
        frame(&mut engine, &rx);
        assert!(!follower.is_finished());
        // Positive control: these are the same exclusive lease, not a different root.
        assert!(
            matches!(operation_lease(&fixture.0, None, || Ok(())), Err(e) if e.code == "provider_busy")
        );
        drop(startup);

        let (operation, ()) = operation_lease(&fixture.0, None, || Ok(())).unwrap();
        frame(&mut engine, &rx);
        assert!(!follower.is_finished());
        drop(operation);
        running.store(false, Ordering::SeqCst);
        drop(engine); // Actual EOF plus confirmed stop is the clean completion.
        follower.join().unwrap().unwrap();
    });
}

#[test]
fn stopped_service_idle_timeout_is_not_a_clean_stream_end() {
    let fixture = Fixture::new();
    let socket = fixture.0.join("engine.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    std::thread::scope(|scope| {
        let follower = scope.spawn(|| {
            let mut output = Vec::new();
            let result = crate::provider::engine::log_follow::follow_socket(
                &socket,
                &"a".repeat(64),
                "web",
                crate::provider::engine::log_follow::LogOptions {
                    tail: 0,
                    since: None,
                    timestamps: false,
                },
                || Ok(false),
                &mut output,
            );
            (result, output)
        });
        let mut engine = accept(&listener);
        headers(&mut engine);
        // Deliberately stop halfway through a mux payload. The prefix must be
        // delivered before the five-second idle refusal, even without frame EOF.
        engine.write_all(b"\x01\0\0\0\0\0\0\x08tail").unwrap();
        // Keep the fake transport open: a stopped container is not an HTTP EOF.
        let (result, output) = follower.join().unwrap();
        assert_eq!(result.unwrap_err().code, "native_log_stopped_idle");
        let events: Vec<serde_json::Value> = output
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(events[1]["data"], "dGFpbA==");
        drop(engine);
    });
}
