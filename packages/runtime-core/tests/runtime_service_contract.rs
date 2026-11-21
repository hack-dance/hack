#![cfg(feature = "installed-candidate")]
//! Real-process contract for `hack-native service serve|status|stop` (HACK-2460 S1):
//! a SIGKILL at any moment loses nothing, and the next start serves again.
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

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

/// Start the service the way a client will: detached group, closed environment,
/// the ready line on fd 3.
fn start(home: &Home) -> (Child, Value) {
    let mut fds = [0; 2];
    // SAFETY: a writable two-element array.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: fresh descriptors from pipe(2), each wrapped once.
    let (reader, writer) = unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) };
    let ready_fd = writer.as_raw_fd();
    let mut command = command(
        home,
        &[
            "service",
            "serve",
            "--idle-seconds",
            "60",
            "--notify-fd",
            "3",
        ],
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 || libc::dup2(ready_fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    drop(writer);
    let mut line = String::new();
    BufReader::new(reader).read_line(&mut line).unwrap();
    (child, serde_json::from_str(&line).unwrap())
}

#[test]
fn a_killed_service_is_replaced_and_a_stopped_one_exits_cleanly() {
    let home = Home::new();
    let absent = run(&home, &["service", "status"]);
    assert!(!absent.status.success());
    assert!(String::from_utf8_lossy(&absent.stderr).contains("service_absent"));

    let (mut first, ready) = start(&home);
    let epoch = ready["listening"]["epoch"].as_str().unwrap().to_owned();
    assert_eq!(ready["listening"]["pid"], first.id());
    let status = json(&run(&home, &["service", "status"]));
    assert_eq!(status["service"]["epoch"], epoch.as_str());

    // A second start while the first serves loses the lock and leaves it alone.
    let (mut loser, lost) = start(&home);
    assert_eq!(lost, serde_json::json!({"lost": true}));
    assert!(loser.wait().unwrap().success());

    // SIGKILL: the socket path stays behind as a stale file and the lock is freed.
    // SAFETY: signalling a child this test started and has not reaped.
    assert_eq!(unsafe { libc::kill(first.id() as i32, libc::SIGKILL) }, 0);
    first.wait().unwrap();
    assert!(
        home.socket()
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_socket()
    );
    assert!(!run(&home, &["service", "status"]).status.success());

    let (mut second, ready) = start(&home);
    let replacement = ready["listening"]["epoch"].as_str().unwrap().to_owned();
    assert_ne!(replacement, epoch);
    let status = json(&run(&home, &["service", "status"]));
    assert_eq!(status["service"]["epoch"], replacement.as_str());

    let stopped = json(&run(&home, &["service", "stop"]));
    assert_eq!(stopped["draining"], true);
    assert!(second.wait().unwrap().success());
    assert!(home.socket().symlink_metadata().is_err());
    assert!(!home.0.join(".hack-local/run/service/service.json").exists());
}

#[test]
fn serve_refuses_unknown_arguments_and_a_closed_ready_descriptor() {
    let home = Home::new();
    for args in [
        &["service", "serve", "--idle-seconds", "0"][..],
        &["service", "serve", "--idle-seconds", "x"],
        &["service", "serve", "--notify-fd", "2"],
        &["service", "serve", "--notify-fd", "77"],
        &["service", "serve", "--wait"],
    ] {
        let output = run(&home, args);
        assert!(!output.status.success(), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("invalid_arguments"),
            "{args:?}"
        );
    }
}
