#![cfg(feature = "installed-candidate")]
//! Real-process contract for `hack-native service serve|status|stop` (HACK-2460 S1):
//! a SIGKILL at any moment loses nothing, and the next start serves again.
mod service_support;

use serde_json::Value;
use service_support::*;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::mpsc;
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
        let stderr = String::from_utf8_lossy(&output.stderr);
        if args.contains(&"--notify-fd") {
            // A starter waits on the notify line: the exit writes nothing else.
            assert_eq!(stderr, "", "{args:?}");
        } else {
            assert!(stderr.contains("invalid_arguments"), "{args:?}: {stderr}");
        }
    }
    // A descriptor that is closed in the child, and one open only for reading.
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, _writer) = pipe();
    drop(spawning);
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
        let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
        let mut service = Service(command.spawn().unwrap());
        drop(spawning);
        assert!(!service.exit().success(), "{fd:?}");
        let mut stderr = String::new();
        service
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert_eq!(
            stderr, "",
            "{fd:?}: a starter-mode exit writes no diagnostic"
        );
    }
    assert!(home.socket().symlink_metadata().is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn serve_refuses_a_notify_descriptor_open_for_neither_reading_nor_writing() {
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    // Access mode 3: Linux opens it for ioctl only, no read and no write.
    let path = std::ffi::CString::new("/dev/null").unwrap();
    // SAFETY: a valid C string; the descriptor is owned below.
    let fd = unsafe { libc::open(path.as_ptr(), 3 | libc::O_CLOEXEC) };
    assert!(fd >= 0, "{}", std::io::Error::last_os_error());
    // SAFETY: a fresh descriptor, wrapped once.
    let neither = unsafe { File::from_raw_fd(fd) };
    let raw = neither.as_raw_fd();
    let mut command = command(&home, &["service", "serve", "--notify-fd", "77"]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(raw, 77) < 0 || libc::fcntl(77, libc::F_SETFD, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut service = Service(command.spawn().unwrap());
    drop(spawning);
    assert!(!service.exit().success());
    let mut stderr = String::new();
    service
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr, "", "a starter-mode exit writes no diagnostic");
    assert!(home.socket().symlink_metadata().is_err());
}

/// `serve` with a leading timings argument naming `timings` and `--notify-fd
/// <notify>`; `fds` are placed at those numbers in the child, nothing else.
fn spawn_with_timings(home: &Home, timings: i32, notify: i32, fds: Vec<(i32, i32)>) -> Service {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-native"));
    command
        .arg(format!(
            "--internal-timings={timings}:{}:{}:1:runtime",
            "a".repeat(32),
            "b".repeat(16)
        ))
        .arg("--candidate-root")
        .arg(&home.0)
        .args(["service", "serve", "--idle-seconds", "60", "--notify-fd"])
        .arg(notify.to_string())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home.0)
        .current_dir(&home.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            for &(from, to) in &fds {
                if libc::dup2(from, to) < 0 || libc::fcntl(to, libc::F_SETFD, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Service(command.spawn().unwrap())
}

#[test]
fn serve_never_takes_the_timings_descriptor_as_its_notify_descriptor() {
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (_reader, writer) = pipe();
    let mut service = spawn_with_timings(&home, 77, 77, vec![(writer.as_raw_fd(), 77)]);
    drop(writer);
    drop(spawning);
    assert!(!service.exit().success());
    let mut stderr = String::new();
    service
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr, "", "a starter-mode exit writes no diagnostic");
    assert!(home.socket().symlink_metadata().is_err());
}

#[test]
fn serve_with_distinct_timings_and_notify_descriptors_listens() {
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let (_spans, spans_writer) = pipe();
    let service = spawn_with_timings(
        &home,
        78,
        77,
        vec![(writer.as_raw_fd(), 77), (spans_writer.as_raw_fd(), 78)],
    );
    drop((writer, spans_writer));
    drop(spawning);
    let (sender, received) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = sender.send(BufReader::new(reader).read_line(&mut line).map(|_| line));
    });
    let line = received
        .recv_timeout(WAIT)
        .expect("no notify line")
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert!(ready["listening"].is_object(), "{ready}");
    json(&run(&home, &["service", "stop"]));
    let mut service = service;
    assert!(service.exit().success());
}

#[test]
fn a_starter_learns_why_serve_refused_a_home_that_cannot_be_resolved() {
    // The candidate root does not exist: root resolution fails before any
    // command runs, and the starter must still get one refused line, not EOF.
    let home = Home::new();
    let missing = home.0.join("missing");
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let raw = writer.as_raw_fd();
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-native"));
    command
        .arg("--candidate-root")
        .arg(&missing)
        .args(["service", "serve", "--notify-fd", "3"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home.0)
        .current_dir(&home.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(raw, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut service = Service(command.spawn().unwrap());
    drop(writer);
    drop(spawning);
    assert!(!service.exit().success());
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.ends_with('\n'), "{line:?}");
    let refused: Value = serde_json::from_str(&line).unwrap();
    assert!(refused["refused"]["code"].is_string(), "{refused}");
    let mut rest = String::new();
    reader.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "", "exactly one refused line");
    assert!(!missing.exists());
}

#[test]
fn serve_refuses_a_repeated_option_and_tells_the_starter() {
    let home = Home::new();
    for args in [
        &[
            "service",
            "serve",
            "--notify-fd",
            "3",
            "--idle-seconds",
            "60",
            "--idle-seconds",
            "61",
        ][..],
        &["service", "serve", "--notify-fd", "3", "--notify-fd", "3"],
        &[
            "service",
            "serve",
            "--notify-fd",
            "3",
            "--drain-seconds",
            "1",
            "--drain-seconds",
            "2",
        ],
        &[
            "service",
            "serve",
            "--notify-fd",
            "3",
            "--idle-seconds",
            "0",
        ],
        &["service", "serve", "--idle-seconds", "--notify-fd", "3"],
    ] {
        let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
        let (reader, writer) = pipe();
        let mut service = spawn_serve(&home, writer.as_raw_fd(), args);
        drop(writer);
        drop(spawning);
        assert!(!service.exit().success(), "{args:?}");
        let mut line = String::new();
        BufReader::new(reader).read_line(&mut line).unwrap();
        let refused: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            refused,
            serde_json::json!({"refused": {"code": "invalid_arguments"}}),
            "{args:?}"
        );
    }
    assert!(home.socket().symlink_metadata().is_err());
}

#[test]
fn a_starter_that_never_reads_cannot_hold_the_service() {
    // The notify pipe is full and nobody reads it, blocking or not: the service
    // must not serve, must exit, and must leave the home free.
    let home = Home::new();
    for blocking in [false, true] {
        let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
        let (reader, writer) = full_pipe(blocking);
        let mut service = spawn_serve(
            &home,
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
        assert_eq!(service.exit().code(), Some(2), "blocking: {blocking}");
        assert!(home.socket().symlink_metadata().is_err());
        drop(reader);
        assert!(serves_again(&home), "blocking: {blocking}");
    }
}

#[test]
fn two_stops_at_once_give_success_or_absent_never_an_io_error() {
    let home = std::sync::Arc::new(Home::new());
    for _ in 0..30 {
        let (mut service, ready) = start(&home);
        assert!(ready["listening"].is_object(), "{ready}");
        let first = {
            let home = std::sync::Arc::clone(&home);
            std::thread::spawn(move || run(&home, &["service", "stop"]))
        };
        let second = run(&home, &["service", "stop"]);
        let first = first.join().unwrap();
        for output in [first, second] {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                assert!(stderr.contains("service_absent"), "{stderr}");
            }
        }
        assert!(service.exit().success());
    }
}

#[test]
fn a_full_socket_as_the_notify_descriptor_cannot_hold_the_service() {
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (ours, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
    ours.set_nonblocking(true).unwrap();
    let chunk = [0u8; 4096];
    while std::io::Write::write(&mut &ours, &chunk).is_ok() {}
    let mut service = spawn_serve(
        &home,
        ours.as_raw_fd(),
        &[
            "service",
            "serve",
            "--idle-seconds",
            "60",
            "--notify-fd",
            "3",
        ],
    );
    drop(ours);
    drop(spawning);
    assert_eq!(service.exit().code(), Some(2));
    assert!(home.socket().symlink_metadata().is_err());
    assert!(serves_again(&home));
}

#[test]
fn a_regular_file_is_not_a_notify_transport() {
    let home = Home::new();
    let file = File::create(home.0.join("notify.txt")).unwrap();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let mut service = spawn_serve(
        &home,
        file.as_raw_fd(),
        &[
            "service",
            "serve",
            "--idle-seconds",
            "60",
            "--notify-fd",
            "3",
        ],
    );
    drop(spawning);
    assert!(!service.exit().success());
    assert_eq!(
        stderr_of(&mut service),
        "",
        "a starter-mode exit writes no diagnostic"
    );
    assert!(home.socket().symlink_metadata().is_err());
    assert_eq!(std::fs::read(home.0.join("notify.txt")).unwrap(), b"");
}

/// `serve` with `args` (after the candidate root) and `notify` at descriptor 3,
/// stderr a pipe the test reads after exit.
fn spawn_raw(home: &Home, args: &[std::ffi::OsString], notify: i32) -> Service {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-native"));
    command
        .arg("--candidate-root")
        .arg(&home.0)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home.0)
        .current_dir(&home.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0
                || libc::dup2(notify, 3) < 0
                || libc::fcntl(3, libc::F_SETFD, 0) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Service(command.spawn().unwrap())
}

#[test]
fn refusals_before_the_command_is_parsed_still_reach_the_starter() {
    use std::os::unix::ffi::OsStringExt;
    let home = Home::new();
    let os = |s: &str| std::ffi::OsString::from(s);
    for args in [
        // A trailing argument that is not UTF-8.
        vec![
            os("service"),
            os("serve"),
            os("--notify-fd"),
            os("3"),
            std::ffi::OsString::from_vec(vec![0xff, 0xfe]),
        ],
        // A relative step store, refused before the command is split off.
        vec![
            os("--step-store"),
            os("relative"),
            os("service"),
            os("serve"),
            os("--notify-fd"),
            os("3"),
        ],
    ] {
        let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
        let (reader, writer) = pipe();
        let mut service = spawn_raw(&home, &args, writer.as_raw_fd());
        drop(writer);
        drop(spawning);
        assert_eq!(service.exit().code(), Some(2), "{args:?}");
        let mut line = String::new();
        BufReader::new(reader).read_line(&mut line).unwrap();
        let refused: Value = serde_json::from_str(&line).unwrap();
        assert!(
            refused["refused"]["code"].is_string(),
            "{args:?}: {refused}"
        );
    }
    assert!(home.socket().symlink_metadata().is_err());
}

#[test]
fn an_error_exit_never_waits_on_a_full_stderr() {
    // The notify pipe is full (so the service ends with an error) and stderr is
    // a full pipe nobody reads: the error print must not keep the process.
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (_notify_reader, notify_writer) = full_pipe(true);
    let (_stderr_reader, stderr_writer) = full_pipe(true);
    let mut command = command(
        &home,
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
        .stderr(stderr_writer);
    let raw = notify_writer.as_raw_fd();
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 || libc::dup2(raw, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut service = Service(command.spawn().unwrap());
    drop(notify_writer);
    drop(spawning);
    assert_eq!(service.exit().code(), Some(2));
    assert!(serves_again(&home));
}

#[test]
fn a_notify_number_the_starter_left_closed_is_never_one_of_ours() {
    // Descriptor 3 is closed at exec. The service's own signal channel must
    // not be taken as the notify descriptor: the number is refused instead.
    let home = Home::new();
    let mut command = command(
        &home,
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
        command.pre_exec(|| {
            libc::close(3);
            Ok(())
        });
    }
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let mut service = Service(command.spawn().unwrap());
    drop(spawning);
    assert_eq!(service.exit().code(), Some(2));
    assert!(home.socket().symlink_metadata().is_err());
}

#[test]
fn the_words_service_serve_inside_another_command_are_not_the_command() {
    // `info` followed by those words fails as `info`, without the service
    // prelude: nothing claims or writes descriptor 3.
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let args: Vec<std::ffi::OsString> = ["info", "service", "serve", "--notify-fd", "3"]
        .iter()
        .map(std::ffi::OsString::from)
        .collect();
    let mut service = spawn_raw(&home, &args, writer.as_raw_fd());
    drop(writer);
    drop(spawning);
    assert!(!service.exit().success());
    let stderr = stderr_of(&mut service);
    assert!(!stderr.is_empty(), "the ordinary error path still reports");
    let mut rest = String::new();
    BufReader::new(reader).read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "", "nothing was written to descriptor 3");
}
