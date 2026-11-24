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

/// The open stream, kept to shut it down (which ends the reader); `closed` once the
/// waiter is dropped. The worker holds this lock from its `closed` check through its
/// connect, so a drop either comes first (nothing is opened) or waits for the connect
/// and shuts that stream before it returns: no socket is opened after a drop.
#[derive(Default)]
struct Stream {
    stream: Option<UnixStream>,
    closed: bool,
    /// Test only: runs inside the check-to-connect window, with the lock held.
    #[cfg(test)]
    pause: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// The reader thread connects, subscribes and reads; nothing of it runs on the
/// start loop's own path, so the loop's deadline is never spent on the subscribe.
/// Until the stream is up (or if it never is), a wait is the old sleep.
pub(in crate::provider) struct EngineChanges {
    signal: Signal,
    stream: Arc<Mutex<Stream>>,
}

impl EngineChanges {
    /// Without a stream: [`EngineChanges::wait`] sleeps, as the start loop did.
    pub(in crate::provider) fn sleeping() -> Self {
        Self {
            signal: Signal::default(),
            stream: Arc::new(Mutex::new(Stream {
                closed: true,
                ..Stream::default()
            })),
        }
    }

    /// Follow `run`'s container events on the engine socket at `path`, opened in
    /// the background: this returns at once.
    pub(in crate::provider) fn follow(path: &Path, run: &str) -> Self {
        if run.is_empty() || !run.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Self::sleeping();
        }
        let changes = Self {
            signal: Signal::default(),
            stream: Arc::default(),
        };
        let (signal, stream, path, run) = (
            changes.signal.clone(),
            changes.stream.clone(),
            path.to_owned(),
            run.to_owned(),
        );
        // Detached: a connect still pending when the waiter drops ends by itself
        // (bounded), and its stream is then shut at once.
        let _ = std::thread::Builder::new()
            .name("engine-changes".into())
            .spawn(move || {
                if let Some(reader) = subscribe(&path, &run, &stream) {
                    read_events(reader, &signal);
                }
            });
        changes
    }

    /// Wait until an event arrived since the last wait, or `timeout` passed. An
    /// event that arrived before this call returns at once, so none is missed.
    pub(in crate::provider) fn wait(&self, timeout: Duration) {
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
        if let Ok(mut shared) = self.stream.lock() {
            shared.closed = true;
            if let Some(stream) = shared.stream.take() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

/// The bound on the worker's one connect attempt, made under the lock a drop also
/// takes. A Unix-socket connect completes or fails at once; it only waits (in
/// progress) when the engine's listen queue is full. This is all a teardown can
/// wait for the worker, so it stays a few milliseconds; a connect that does not
/// finish within it leaves the waiter sleeping, as when the socket is absent.
const CONNECT: Duration = Duration::from_millis(5);

/// Connect and send the subscription, on the reader thread. The check of `closed`
/// and the connect happen under one lock (see [`Stream`]): a waiter already dropped
/// (a start that returned before this thread ran) opens nothing, and a drop that
/// arrives meanwhile waits and then shuts the registered stream. The stream is
/// registered for shutdown before the request.
fn subscribe(path: &Path, run: &str, shared: &Mutex<Stream>) -> Option<UnixStream> {
    let mut stream = {
        let mut shared = shared.lock().ok()?;
        if shared.closed {
            return None;
        }
        #[cfg(test)]
        if let Some(pause) = shared.pause.clone() {
            pause();
        }
        let stream = crate::provider::agent::connect_until(path, Instant::now() + CONNECT).ok()?;
        shared.stream = Some(stream.try_clone().ok()?);
        stream
    };
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .ok()?;
    stream.write_all(request(run).as_bytes()).ok()?;
    Some(stream)
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
    /// A bounded accept: `None` when nothing connected in `limit`.
    fn accept_within(listener: &UnixListener, limit: Duration) -> Option<(UnixStream, ())> {
        listener.set_nonblocking(true).unwrap();
        let end = Instant::now() + limit;
        let accepted = loop {
            match listener.accept() {
                Ok((peer, _)) => break Some((peer, ())),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= end {
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        listener.set_nonblocking(false).unwrap();
        accepted.inspect(|(peer, _)| peer.set_nonblocking(false).unwrap())
    }
    fn socket(name: &str) -> (Socket, std::path::PathBuf, UnixListener) {
        let socket = path(name);
        let _ = std::fs::remove_file(&socket.0);
        let listener = UnixListener::bind(&socket.0).unwrap();
        let path = socket.0.clone();
        (socket, path, listener)
    }

    /// The reader has seen an event the next wait has not consumed yet.
    fn observed(changes: &EngineChanges) -> bool {
        *changes.signal.0.lock().unwrap()
    }
    fn until(condition: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < end, "condition not reached in 5 s");
            std::thread::yield_now();
        }
    }

    #[test]
    fn an_event_wakes_the_wait_and_one_before_it_is_not_missed() {
        use std::sync::mpsc::channel;
        let (_socket, path, listener) = socket("wake");
        let (sent, first) = channel();
        let (go, second) = channel::<()>();
        let (done, finished) = channel::<()>();
        let engine = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let mut head = [0_u8; 512];
            let read = peer.read(&mut head).unwrap();
            let head = String::from_utf8_lossy(&head[..read]).into_owned();
            peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            peer.write_all(b"10\r\n{\"status\":\"x\"}\n\r\n").unwrap();
            sent.send(()).unwrap();
            // The test ending (or failing) drops the sender and ends this wait too.
            if second.recv_timeout(Duration::from_secs(10)).is_err() {
                return String::new();
            }
            peer.write_all(b"10\r\n{\"status\":\"y\"}\n\r\n").unwrap();
            // Keep the stream open until the test is done with it.
            let _ = finished.recv_timeout(Duration::from_secs(10));
            head
        });
        let changes = EngineChanges::follow(&path, RUN);
        // The first event is read before the first wait begins: that wait must
        // return at once rather than wait for the next one.
        first
            .recv_timeout(Duration::from_secs(5))
            .expect("the fake engine saw no subscription");
        until(|| observed(&changes));
        changes.wait(Duration::from_secs(5));
        assert!(!observed(&changes), "the wait did not consume the event");
        // The second event wakes a wait already in progress (or one about to start).
        go.send(()).unwrap();
        let started = Instant::now();
        changes.wait(Duration::from_secs(5));
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "the event did not wake the wait"
        );
        // Nothing more: the pass interval bounds the wait, as the sleep did.
        let started = Instant::now();
        changes.wait(Duration::from_millis(150));
        assert!(started.elapsed() >= Duration::from_millis(150));
        done.send(()).unwrap();
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
    fn opening_never_waits_and_without_a_stream_the_wait_sleeps_the_interval() {
        // An absent socket: the subscribe retries its connect in the background
        // for up to a second; `follow` and `drop` do not wait for it.
        let absent = path("absent");
        for (follow, changes) in [
            (true, EngineChanges::follow(&absent.0, RUN)),
            (true, EngineChanges::follow(&absent.0, "not a run")),
            (false, EngineChanges::sleeping()),
        ] {
            let started = Instant::now();
            changes.wait(Duration::from_millis(60));
            assert!(started.elapsed() >= Duration::from_millis(60), "{follow}");
            let started = Instant::now();
            drop(changes);
            assert!(started.elapsed() < Duration::from_millis(500), "{follow}");
        }
        let started = Instant::now();
        let changes = EngineChanges::follow(&absent.0, RUN);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "follow waited on the connect"
        );
        drop(changes);
    }

    #[test]
    fn a_waiter_dropped_before_its_worker_runs_opens_no_socket() {
        let (_socket, path, listener) = socket("late");
        listener.set_nonblocking(true).unwrap();
        // What the worker finds when the start returned before it first ran.
        let shared = Mutex::new(Stream {
            closed: true,
            ..Stream::default()
        });
        assert!(subscribe(&path, RUN, &shared).is_none());
        // Nothing connected: the engine has no pending connection to accept.
        assert_eq!(
            listener.accept().map(|_| ()).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        // An open waiter does connect.
        let open = Mutex::new(Stream::default());
        assert!(subscribe(&path, RUN, &open).is_some());
        listener.set_nonblocking(false).unwrap();
        assert!(listener.accept().is_ok());
    }

    #[test]
    fn a_drop_while_the_worker_is_between_its_check_and_its_connect_waits_and_shuts_it() {
        use std::sync::mpsc::channel;
        let (_socket, path, listener) = socket("window");
        let (paused, at_pause) = channel();
        let (go, resume) = channel::<()>();
        let resume = Mutex::new(resume);
        let changes = EngineChanges {
            signal: Signal::default(),
            stream: Arc::new(Mutex::new(Stream {
                pause: Some(Arc::new(move || {
                    paused.send(()).unwrap();
                    let _ = resume.lock().unwrap().recv_timeout(Duration::from_secs(10));
                })),
                ..Stream::default()
            })),
        };
        // The worker passes its `closed` check and pauses before connecting.
        let shared = changes.stream.clone();
        let worker = std::thread::spawn(move || subscribe(&path, RUN, &shared).is_some());
        at_pause
            .recv_timeout(Duration::from_secs(5))
            .expect("the worker did not reach its connect");
        // The start returns now: its drop waits for the worker's connect decision.
        let (dropped, at_drop) = channel();
        let dropper = std::thread::spawn(move || {
            drop(changes);
            dropped.send(()).unwrap();
        });
        assert!(
            at_drop.recv_timeout(Duration::from_millis(200)).is_err(),
            "the drop returned while the worker could still connect"
        );
        go.send(()).unwrap();
        at_drop
            .recv_timeout(Duration::from_secs(5))
            .expect("the drop did not return");
        dropper.join().unwrap();
        let _ = worker.join().unwrap();
        // The one connection, made before the drop returned, is already shut.
        let (mut peer, _) = accept_within(&listener, Duration::from_secs(5))
            .expect("the worker made no connection");
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut rest = Vec::new();
        assert!(
            peer.read_to_end(&mut rest).is_ok(),
            "the stream was left open"
        );
        // And nothing connects after the drop.
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            listener.accept().map(|_| ()).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn teardown_while_the_worker_subscribes_returns_at_once_and_nothing_connects_later() {
        // No engine socket yet: the worker's connect fails within its bound. A
        // teardown at any point returns within a few milliseconds (it waits for at
        // most that one bounded attempt), and nothing connects once it has.
        let late = path("teardown");
        for _ in 0..20 {
            let changes = EngineChanges::follow(&late.0, RUN);
            let started = Instant::now();
            drop(changes);
            assert!(
                started.elapsed() < Duration::from_millis(50),
                "teardown waited {:?}",
                started.elapsed()
            );
        }
        let _ = std::fs::remove_file(&late.0);
        let listener = UnixListener::bind(&late.0).unwrap();
        assert!(
            accept_within(&listener, Duration::from_millis(200)).is_none(),
            "a worker connected after its waiter was dropped"
        );
    }

    #[test]
    fn dropping_it_ends_the_reader_while_the_engine_keeps_the_stream_open() {
        use std::sync::mpsc::channel;
        let (_socket, path, listener) = socket("drop");
        let (subscribed, accepted) = channel();
        let engine = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let mut head = [0_u8; 512];
            let _ = peer.read(&mut head).unwrap();
            peer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .unwrap();
            subscribed.send(()).unwrap();
            // The reader closing its end ends this read.
            let mut rest = Vec::new();
            let _ = peer.read_to_end(&mut rest);
        });
        let changes = EngineChanges::follow(&path, RUN);
        accepted
            .recv_timeout(Duration::from_secs(5))
            .expect("the fake engine saw no subscription");
        until(|| changes.stream.lock().unwrap().stream.is_some());
        let started = Instant::now();
        drop(changes);
        assert!(started.elapsed() < Duration::from_secs(1));
        // The engine side sees the stream shut down.
        engine.join().unwrap();
    }
}
