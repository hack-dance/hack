#![cfg(feature = "installed-candidate")]
//! Real-process contract for `hack-native service serve|status|stop` (HACK-2460 S1):
//! a SIGKILL at any moment loses nothing, and the next start serves again.
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const WAIT: Duration = Duration::from_secs(10);
/// Held from creating a pipe until the child that should get it has been
/// spawned: without pipe2 (macOS), a fork in another test thread between
/// `pipe` and `FD_CLOEXEC` would otherwise inherit the writer across exec.
static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A private native home short enough for the service socket path.
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
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
    fn socket(&self) -> PathBuf {
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
struct Service(Child);
impl Service {
    fn pid(&self) -> u32 {
        self.0.id()
    }
    /// Wait for the process to end, at most `WAIT`.
    fn exit(&mut self) -> ExitStatus {
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

fn command(home: &Home, args: &[&str]) -> Command {
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

fn run(home: &Home, args: &[&str]) -> Output {
    let _spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    command(home, args).stdin(Stdio::null()).output().unwrap()
}

fn json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// A pipe whose two ends are close-on-exec.
fn pipe() -> (File, File) {
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

/// Run `serve` with `fd` placed at descriptor 3 as the only extra descriptor
/// that survives exec, in its own session, with the closed environment.
fn spawn_serve(home: &Home, fd: i32, args: &[&str]) -> Service {
    let mut command = command(home, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
fn start(home: &Home) -> (Service, Value) {
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let service = spawn_serve(
        home,
        writer.as_raw_fd(),
        &[
            "service",
            "serve",
            "--idle-seconds",
            "60",
            "--notify-fd",
            "3",
        ],
    );
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

#[test]
fn a_killed_service_is_replaced_and_a_stopped_one_exits_cleanly() {
    let home = Home::new();
    let absent = run(&home, &["service", "status"]);
    assert!(!absent.status.success());
    assert!(String::from_utf8_lossy(&absent.stderr).contains("service_absent"));

    let (mut first, listening) = start(&home);
    let epoch = listening["listening"]["epoch"].as_str().unwrap().to_owned();
    assert_eq!(listening["listening"]["pid"], first.pid());
    // Ready means a request through the socket succeeded, not the line above.
    let status = json(&run(&home, &["service", "status"]));
    assert_eq!(status["service"]["epoch"], epoch.as_str());

    // A second start while the first serves loses the lock and leaves it alone.
    let (mut loser, lost) = start(&home);
    assert_eq!(lost, serde_json::json!({"lost": true}));
    assert!(loser.exit().success());

    // SIGKILL: the socket path stays behind as a stale file and the lock is freed.
    // SAFETY: signalling a child this test started and has not reaped.
    assert_eq!(unsafe { libc::kill(first.pid() as i32, libc::SIGKILL) }, 0);
    assert_eq!(first.exit().signal(), Some(libc::SIGKILL));
    assert!(
        home.socket()
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_socket()
    );
    assert!(!run(&home, &["service", "status"]).status.success());

    let (mut second, listening) = start(&home);
    let replacement = listening["listening"]["epoch"].as_str().unwrap().to_owned();
    assert_ne!(replacement, epoch);
    let status = json(&run(&home, &["service", "status"]));
    assert_eq!(status["service"]["epoch"], replacement.as_str());

    let stopped = json(&run(&home, &["service", "stop"]));
    assert_eq!(stopped["draining"], true);
    assert!(second.exit().success());
    assert!(home.socket().symlink_metadata().is_err());
    assert!(!home.0.join(".hack-local/run/service/service.json").exists());
}

#[test]
fn serve_refuses_bad_arguments_and_an_unusable_notify_descriptor() {
    let home = Home::new();
    for args in [
        &["service", "serve", "--idle-seconds", "0"][..],
        &["service", "serve", "--idle-seconds", "x"],
        &["service", "serve", "--notify-fd", "2"],
        &["service", "serve", "--wait"],
    ] {
        let output = run(&home, args);
        assert!(!output.status.success(), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("invalid_arguments"),
            "{args:?}"
        );
    }
    // A descriptor that is closed in the child, and one open only for reading.
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, _writer) = pipe();
    for (fd, close_77) in [(None, true), (Some(reader.as_raw_fd()), false)] {
        let mut command = command(&home, &["service", "serve", "--notify-fd", "77"]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if close_77 {
                    libc::close(77);
                }
                if let Some(fd) = fd {
                    if libc::dup2(fd, 77) < 0 || libc::fcntl(77, libc::F_SETFD, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let mut service = Service(command.spawn().unwrap());
        assert!(!service.exit().success(), "{fd:?}");
        let mut stderr = String::new();
        service
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(stderr.contains("invalid_arguments"), "{fd:?}: {stderr}");
    }
    drop(spawning);
    assert!(home.socket().symlink_metadata().is_err());
}
