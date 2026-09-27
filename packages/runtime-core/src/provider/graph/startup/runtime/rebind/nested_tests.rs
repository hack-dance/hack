//! A retained wrapper owns a rotating session parent, which owns the listener.
//! Every pipe and child is fixture-owned; closing the retained wrapper's input
//! propagates EOF through the session input and reaps the whole nested tree.
use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const PREFIX: &str = "nested-listener-ready-v1 ";
const WRAPPER: &str = "provider::graph::startup::runtime::rebind::nested_tests::wrapper_child";
const SESSION: &str = "provider::graph::startup::runtime::rebind::nested_tests::session_child";
const LISTENER: &str = "provider::graph::startup::runtime::rebind::nested_tests::listener_child";

fn helper(name: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "--ignored",
        "--exact",
        name,
        "--nocapture",
        "--test-threads=1",
    ]);
    command
}

fn ready(reader: &mut impl BufRead) -> Value {
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "owned child exited before readiness"
        );
        if let Some((_, document)) = line.split_once(PREFIX) {
            return serde_json::from_str(document).unwrap();
        }
    }
}

fn stop(child: &mut Child) {
    child.stdin.take();
    let deadline = Instant::now() + Duration::from_secs(4);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    if child.try_wait().unwrap().is_none() {
        // This unreaped Child is ours; EOF has already revoked descendant input.
        child.kill().unwrap();
    }
    assert!(
        child.wait().unwrap().success(),
        "nested fixture did not stop cleanly"
    );
}

struct NestedBackend {
    child: Child,
    reader: Option<JoinHandle<()>>,
    output: mpsc::Receiver<Value>,
    selected: Value,
    observed: Vec<identity::ProcessIdentity>,
}
impl NestedBackend {
    fn start(port: u16) -> Self {
        let mut child = helper(WRAPPER)
            .env("HACK_NESTED_PORT", port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Some((_, document)) = line.split_once(PREFIX) {
                    let value = serde_json::from_str(document).unwrap();
                    if send.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        let mut backend = Self {
            child,
            reader: Some(reader),
            output,
            selected: Value::Null,
            observed: Vec::new(),
        };
        backend.receive();
        backend
    }
    fn receive(&mut self) {
        self.selected = self.output.recv_timeout(Duration::from_secs(5)).unwrap();
        for key in ["listener", "session", "wrapper"] {
            let pid = self.selected[key].as_i64().unwrap() as i32;
            self.observed.push(identity::observe(pid).unwrap());
        }
    }
    fn port(&self) -> u16 {
        self.selected["port"].as_u64().unwrap() as u16
    }
    fn endpoint(&self) -> HostEndpoint {
        HostEndpoint::capture(
            self.selected["listener"].as_i64().unwrap() as i32,
            self.port(),
        )
        .unwrap()
    }
    fn rotate(&mut self, kind: &str) {
        writeln!(self.child.stdin.as_mut().unwrap(), "rotate {kind}").unwrap();
        self.receive();
    }
    fn pause(&mut self) {
        writeln!(self.child.stdin.as_mut().unwrap(), "stop").unwrap();
        let stopped = self.output.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(stopped["stopped"], true);
    }
    fn finish(&mut self) {
        stop(&mut self.child);
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        for observed in &self.observed {
            while identity::alive(observed.pid).unwrap() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            assert!(
                !identity::alive(observed.pid).unwrap(),
                "nested child was not reclaimed"
            );
        }
    }
}
impl Drop for NestedBackend {
    fn drop(&mut self) {
        if self.reader.is_none() {
            return;
        }
        self.child.stdin.take();
        let deadline = Instant::now() + Duration::from_secs(4);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

struct Session {
    child: Child,
    _output: BufReader<std::process::ChildStdout>,
}
impl Session {
    fn start(port: u16, kind: &str) -> (Self, Value) {
        let mut command = if kind == "same" {
            helper(SESSION)
        } else {
            assert_eq!(kind, "wrong-chain");
            let mut shell = Command::new("/bin/sh");
            // The shell deliberately remains between wrapper and listener.
            shell.args(["-c", "\"$1\" --ignored --exact \"$2\" --nocapture --test-threads=1 <&0 & child=$!; wait \"$child\"", "owned-nested-session"])
                .arg(std::env::current_exe().unwrap()).arg(LISTENER);
            shell
        };
        let mut child = command
            .env("HACK_NESTED_PORT", port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut selected = ready(&mut output);
        selected["session"] = serde_json::json!(child.id());
        selected["wrapper"] = serde_json::json!(std::process::id());
        (
            Self {
                child,
                _output: output,
            },
            selected,
        )
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        stop(&mut self.child);
    }
}

fn publish(value: &Value) {
    println!("{PREFIX}{value}");
    std::io::stdout().flush().unwrap();
}

#[test]
#[ignore = "Owned nested wrapper; invoked only by the ancestry regression"]
fn wrapper_child() {
    let mut port: u16 = std::env::var("HACK_NESTED_PORT").unwrap().parse().unwrap();
    let (child, selected) = Session::start(port, "same");
    port = selected["port"].as_u64().unwrap() as u16;
    let mut session = Some(child);
    publish(&selected);
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        session.take();
        if line == "stop" {
            publish(&serde_json::json!({"stopped":true}));
            continue;
        }
        let kind = line.strip_prefix("rotate ").unwrap();
        let (child, selected) = Session::start(port, kind);
        session = Some(child);
        publish(&selected);
    }
    drop(session);
}

#[test]
#[ignore = "Owned AWS-like session parent; invoked only by the ancestry regression"]
fn session_child() {
    let mut child = helper(LISTENER)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
#[ignore = "Owned loopback listener; invoked only by the ancestry regression"]
fn listener_child() {
    let port: u16 = std::env::var("HACK_NESTED_PORT").unwrap().parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    listener.set_nonblocking(true).unwrap();
    publish(
        &serde_json::json!({"listener":std::process::id(),"port":listener.local_addr().unwrap().port()}),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let stop_input = stop.clone();
    let input = thread::spawn(move || {
        let _ = std::io::stdin().read(&mut [0]);
        stop_input.store(true, Ordering::Release);
    });
    let deadline = Instant::now() + Duration::from_secs(45);
    while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut marker = Vec::new();
                (&mut stream).take(65).read_to_end(&mut marker).unwrap();
                stream.write_all(&marker).unwrap();
                stream.shutdown(Shutdown::Write).unwrap();
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2))
            }
            Err(error) => panic!("nested listener failed: {error}"),
        }
    }
    assert!(
        stop.load(Ordering::Acquire),
        "nested fixture lifetime expired"
    );
    input.join().unwrap();
}

fn echo(endpoint: &HostEndpoint) {
    let mut stream: TcpStream = endpoint.connect(Duration::from_secs(1)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(b"retained-wrapper-marker").unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut response = Vec::new();
    stream.take(65).read_to_end(&mut response).unwrap();
    assert_eq!(response, b"retained-wrapper-marker");
}

#[test]
fn nested_session_rotation_retains_exact_wrapper_and_refuses_foreign_anchor_or_chain() {
    let executable = std::env::current_exe().unwrap();
    let mut owned = NestedBackend::start(0);
    let original = owned.endpoint();
    let port = owned.port();
    let original_lineage = identity::lineage(&original.process_identity(), 2).unwrap();
    assert_eq!(
        original_lineage[0].pid,
        owned.selected["session"].as_i64().unwrap() as i32
    );
    assert_eq!(original_lineage[1].pid, owned.child.id() as i32);
    let direct = RefreshPolicy::capture(&original, &executable, port, 1).unwrap();
    let wrapped = RefreshPolicy::capture(&original, &executable, port, 2).unwrap();
    echo(&original);
    owned.rotate("same");
    let replacement = owned.endpoint();
    let replaced_lineage = identity::lineage(&replacement.process_identity(), 2).unwrap();
    assert_ne!(original.process_identity(), replacement.process_identity());
    assert_ne!(original_lineage[0], replaced_lineage[0]);
    assert_eq!(original_lineage[1], replaced_lineage[1]);
    assert!(direct.validate(&replacement).is_err());
    wrapped.validate(&replacement).unwrap();
    assert_eq!(
        wrapped.discover().unwrap().fingerprint().unwrap(),
        replacement.fingerprint().unwrap()
    );
    echo(&replacement);
    owned.rotate("wrong-chain");
    let wrong = owned.endpoint();
    let wrong_lineage = identity::lineage(&wrong.process_identity(), 2).unwrap();
    assert_eq!(wrong_lineage[1], original_lineage[1]);
    assert_ne!(wrong_lineage[0].executable, original_lineage[0].executable);
    assert!(wrapped.validate(&wrong).is_err());
    owned.pause();
    let mut foreign = NestedBackend::start(port);
    assert!(wrapped.validate(&foreign.endpoint()).is_err());
    assert!(wrapped.discover().is_err());
    foreign.finish();
    owned.finish();
    let mut new_anchor = NestedBackend::start(port);
    assert!(wrapped.validate(&new_anchor.endpoint()).is_err());
    new_anchor.finish();
    let _reclaimed = TcpListener::bind(("127.0.0.1", port)).unwrap();
}
