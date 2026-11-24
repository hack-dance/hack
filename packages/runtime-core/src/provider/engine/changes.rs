//! Wake the start loop when the engine reports a change to one of a graph run's
//! containers, instead of always sleeping a whole pass.
//!
//! One read-only `GET /events` stream, filtered to the run's containers and to the
//! events that can change a readiness decision (`start`, `die`, `health_status`).
//! It grants nothing and decides nothing: every wake is followed by the start loop's
//! own fresh observations, and a wake that never comes only costs the pass interval,
//! exactly as before. Any failure to open or read the stream degrades to sleeping.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Set by the reader thread on each event, cleared by [`EngineChanges::wait`].
type Signal = Arc<(Mutex<bool>, Condvar)>;

pub(in crate::provider) struct EngineChanges {
    signal: Signal,
    /// The stream, kept to shut it down (which ends the reader) on drop.
    stream: Option<UnixStream>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl EngineChanges {
    /// Without a stream: [`EngineChanges::wait`] sleeps, as the start loop did.
    pub(in crate::provider) fn sleeping() -> Self {
        Self {
            signal: Signal::default(),
            stream: None,
            reader: None,
        }
    }

    /// Follow `run`'s container events on the engine socket at `path`. A socket
    /// that cannot be reached within a second gives [`EngineChanges::sleeping`].
    pub(in crate::provider) fn follow(path: &Path, run: &str) -> Self {
        Self::open(path, run).unwrap_or_else(Self::sleeping)
    }

    fn open(path: &Path, run: &str) -> Option<Self> {
        if !run.bytes().all(|b| b.is_ascii_hexdigit()) || run.is_empty() {
            return None;
        }
        let mut stream =
            crate::provider::agent::connect_until(path, Instant::now() + Duration::from_secs(1))
                .ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .ok()?;
        stream.write_all(request(run).as_bytes()).ok()?;
        let signal = Signal::default();
        let reader = {
            let signal = signal.clone();
            let stream = stream.try_clone().ok()?;
            std::thread::Builder::new()
                .name("engine-changes".into())
                .spawn(move || read_events(stream, &signal))
                .ok()?
        };
        Some(Self {
            signal,
            stream: Some(stream),
            reader: Some(reader),
        })
    }

    /// Wait until an event arrived since the last wait, or `timeout` passed. An
    /// event that arrived before this call returns at once, so none is missed.
    pub(in crate::provider) fn wait(&self, timeout: Duration) {
        if self.reader.is_none() {
            std::thread::sleep(timeout);
            return;
        }
        let (lock, changed) = &*self.signal;
        let Ok(guard) = lock.lock() else {
            std::thread::sleep(timeout);
            return;
        };
        if let Ok((mut seen, _)) = changed.wait_timeout_while(guard, timeout, |seen| !*seen) {
            *seen = false;
        }
    }
}

impl Drop for EngineChanges {
    fn drop(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn request(run: &str) -> String {
    // {"type":["container"],"label":["io.hack-local.graph=<run>"],
    //  "event":["start","die","health_status"]}, URL-encoded.
    format!(
        "GET /v1.53/events?filters=%7B%22type%22%3A%5B%22container%22%5D%2C%22label%22%3A%5B%22io.hack-local.graph%3D{run}%22%5D%2C%22event%22%3A%5B%22start%22%2C%22die%22%2C%22health_status%22%5D%7D HTTP/1.1\r\nHost: hack-local\r\nConnection: close\r\n\r\n"
    )
}

/// Every JSON line of the (chunked) event stream is one event. Chunk-size and
/// header lines do not start with `{` and wake nothing.
fn read_events(stream: UnixStream, signal: &Signal) {
    let mut lines = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match lines.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) if line.first() == Some(&b'{') => {
                let (lock, changed) = &**signal;
                let Ok(mut seen) = lock.lock() else {
                    return;
                };
                *seen = true;
                changed.notify_all();
            }
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixListener;

    const RUN: &str = "0123456789abcdef0123456789abcdef";

    /// A fresh socket path, removed when the guard drops.
    struct Socket(std::path::PathBuf);
    impl Drop for Socket {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn path(name: &str) -> Socket {
        Socket(std::env::temp_dir().join(format!("hc-changes-{}-{name}.sock", std::process::id())))
    }
    fn socket(name: &str) -> (Socket, std::path::PathBuf, UnixListener) {
        let socket = path(name);
        let _ = std::fs::remove_file(&socket.0);
        let listener = UnixListener::bind(&socket.0).unwrap();
        let path = socket.0.clone();
        (socket, path, listener)
    }

    #[test]
    fn an_event_wakes_the_wait_and_one_before_it_is_not_missed() {
        let (_socket, path, listener) = socket("wake");
        let engine = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let mut head = [0_u8; 512];
            let read = peer.read(&mut head).unwrap();
            let head = String::from_utf8_lossy(&head[..read]).into_owned();
            peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            // One event before the first wait, then one while it waits.
            peer.write_all(b"10\r\n{\"status\":\"x\"}\n\r\n").unwrap();
            std::thread::sleep(Duration::from_millis(300));
            peer.write_all(b"10\r\n{\"status\":\"y\"}\n\r\n").unwrap();
            std::thread::sleep(Duration::from_millis(300));
            head
        });
        let changes = EngineChanges::follow(&path, RUN);
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        changes.wait(Duration::from_secs(5));
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "missed the earlier event"
        );
        let started = Instant::now();
        changes.wait(Duration::from_secs(5));
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(100) && waited < Duration::from_secs(2),
            "{waited:?}"
        );
        // Nothing more: the pass interval bounds the wait, as the sleep did.
        let started = Instant::now();
        changes.wait(Duration::from_millis(150));
        assert!(started.elapsed() >= Duration::from_millis(150));
        drop(changes);
        let head = engine.join().unwrap();
        assert!(head.starts_with("GET /v1.53/events?filters="), "{head}");
        assert!(
            head.contains(&format!("io.hack-local.graph%3D{RUN}")),
            "{head}"
        );
        assert!(head.contains("health_status"), "{head}");
    }

    #[test]
    fn without_a_stream_the_wait_sleeps_the_whole_interval() {
        let absent = path("absent");
        for changes in [
            EngineChanges::follow(&absent.0, RUN),
            EngineChanges::follow(&absent.0, "not a run"),
            EngineChanges::sleeping(),
        ] {
            let started = Instant::now();
            changes.wait(Duration::from_millis(60));
            assert!(started.elapsed() >= Duration::from_millis(60));
        }
    }

    #[test]
    fn dropping_it_ends_the_reader_while_the_engine_keeps_the_stream_open() {
        let (_socket, path, listener) = socket("drop");
        let engine = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            std::thread::sleep(Duration::from_secs(2));
        });
        let changes = EngineChanges::follow(&path, RUN);
        let started = Instant::now();
        drop(changes);
        assert!(started.elapsed() < Duration::from_secs(1));
        engine.join().unwrap();
    }
}
