//! Shared helpers for the real-process service tests: a private native home,
//! a service process that is killed and reaped on drop, the closed environment,
//! and the one notify line a starter reads.
#![allow(dead_code)]
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// A hang guard only: every wait the test makes is bounded by it, and nothing
/// asserts how fast a loaded machine is.
pub const WAIT: Duration = Duration::from_secs(30);
/// Held around every fork in this test binary and around creating a pipe until
/// its ends are close-on-exec: without pipe2 (macOS), a fork between `pipe` and
/// `FD_CLOEXEC` would otherwise let a child inherit a writer across exec.
pub static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A private native home short enough for the service socket path.
pub struct Home(pub PathBuf);
impl Home {
    pub fn new() -> Self {
        let mut parent = std::env::temp_dir().canonicalize().unwrap();
        if parent.as_os_str().len() > 40 {
            parent = Path::new("/tmp").canonicalize().unwrap();
        }
        let path = parent.join(format!(
            "hrsc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    pub fn socket(&self) -> PathBuf {
        self.0.join(".hack-local/run/service/hack-runtime.sock")
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A service process this test started. Dropping it kills and reaps it, so a
/// failed assertion never leaves a detached service behind.
pub struct Service(pub Child);
impl Service {
    pub fn pid(&self) -> u32 {
        self.0.id()
    }
    /// Wait for the process to end, at most `WAIT`.
    pub fn exit(&mut self) -> ExitStatus {
        let started = Instant::now();
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                return status;
            }
            assert!(started.elapsed() < WAIT, "the service did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

pub fn command(home: &Home, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-native"));
    command
        .arg("--candidate-root")
        .arg(&home.0)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home.0)
        .current_dir(&home.0);
    command
}

/// Run a one-shot command, at most `WAIT`; the spawn lock is held only for the
/// spawn, and the child is killed and reaped if it overruns.
pub fn run(home: &Home, args: &[&str]) -> Output {
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let mut child = Service(
        command(home, args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    drop(spawning);
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    };
    let stdout = drain(Box::new(child.0.stdout.take().unwrap()));
    let stderr = drain(Box::new(child.0.stderr.take().unwrap()));
    let status = child.exit();
    Output {
        status,
        stdout: stdout.join().unwrap(),
        stderr: stderr.join().unwrap(),
    }
}

pub fn json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// A pipe whose two ends are close-on-exec.
pub fn pipe() -> (File, File) {
    let mut fds = [0; 2];
    // SAFETY: a writable two-element array.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    for fd in fds {
        // SAFETY: F_SETFD on a descriptor just created.
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
    }
    // SAFETY: fresh descriptors from pipe(2), each wrapped once.
    unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) }
}

/// Its stderr is a pipe; `stderr_of` reads it after the process ended.
/// Run `serve` with `fd` placed at descriptor 3 as the only extra descriptor
/// that survives exec, in its own session, with the closed environment.
pub fn spawn_serve(home: &Home, fd: i32, args: &[&str]) -> Service {
    let mut command = command(home, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 || libc::dup2(fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // dup2 onto itself keeps close-on-exec; clear it on 3 explicitly.
            if libc::fcntl(3, libc::F_SETFD, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Service(command.spawn().unwrap())
}

/// Start the service the way a client will and return its one notify line. The
/// notify channel must reach end-of-file right after that line, while the
/// service keeps running: nobody else holds a writer.
pub fn start(home: &Home) -> (Service, Value) {
    start_with(home, &[])
}

/// `start` with extra `serve` options.
pub fn start_with(home: &Home, extra: &[&str]) -> (Service, Value) {
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let mut args = vec![
        "service",
        "serve",
        "--idle-seconds",
        "60",
        "--notify-fd",
        "3",
    ];
    args.extend_from_slice(extra);
    let service = spawn_serve(home, writer.as_raw_fd(), &args);
    drop(writer);
    drop(spawning);
    let (sender, received) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        let first = reader.read_line(&mut line).map(|_| line);
        let _ = sender.send(first);
        let mut rest = Vec::new();
        let _ = sender.send(
            reader
                .read_to_end(&mut rest)
                .map(|_| String::from_utf8_lossy(&rest).into()),
        );
    });
    let line = received
        .recv_timeout(WAIT)
        .expect("no notify line")
        .unwrap();
    let rest = received
        .recv_timeout(WAIT)
        .expect("the notify channel stayed open")
        .unwrap();
    assert_eq!(rest, "", "exactly one notify line");
    (service, serde_json::from_str(&line).unwrap())
}

/// One request frame (`u32` big-endian length, then the JSON body).
pub fn send(stream: &mut std::os::unix::net::UnixStream, id: &str, op: &str) {
    use std::io::Write;
    let body = serde_json::to_vec(&serde_json::json!({
        "v": 1, "id": id, "op": op, "args": {"client": {"kind": "cli"}}
    }))
    .unwrap();
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&body);
    stream.write_all(&frame).unwrap();
}

/// One reply frame, read within `WAIT`.
pub fn receive(stream: &mut std::os::unix::net::UnixStream) -> Value {
    stream.set_read_timeout(Some(WAIT)).unwrap();
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

/// A session on this home's service that has said hello.
pub fn session(home: &Home) -> std::os::unix::net::UnixStream {
    let mut stream = std::os::unix::net::UnixStream::connect(home.socket()).unwrap();
    send(&mut stream, "h", "hello");
    assert_eq!(receive(&mut stream)["ok"], true);
    stream
}

/// Whether a fresh start on this home serves (the locks are free again).
pub fn serves_again(home: &Home) -> bool {
    let (mut service, ready) = start(home);
    let serving = ready["listening"].is_object();
    if serving {
        json(&run(home, &["service", "stop"]));
        assert!(service.exit().success());
    }
    serving
}

/// A pipe whose buffer is already full and whose reader never reads. With
/// `blocking`, a write to it blocks forever; without, it fails at once.
pub fn full_pipe(blocking: bool) -> (File, File) {
    let (reader, writer) = pipe();
    let fd = writer.as_raw_fd();
    // SAFETY: scalar fcntl and write calls on this test's own descriptor.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        let chunk = [0u8; 4096];
        while libc::write(fd, chunk.as_ptr().cast(), chunk.len()) > 0 {}
        while libc::write(fd, chunk.as_ptr().cast(), 1) > 0 {}
        if blocking {
            libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
    }
    (reader, writer)
}

/// What an ended service wrote to stderr (spawned by `spawn_serve`).
pub fn stderr_of(service: &mut Service) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = service.0.stderr.take() {
        let _ = pipe.read_to_string(&mut text);
    }
    text
}
