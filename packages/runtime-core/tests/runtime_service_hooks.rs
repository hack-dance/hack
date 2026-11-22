#![cfg(all(feature = "installed-candidate", feature = "service-test-hooks"))]
//! Real-process service tests that need the test-only `test.hold` and
//! `test.env` operations: a drain that runs out of time ends the process at
//! once with exit code 3, a signal drains the same way, and the service keeps
//! only the closed environment.
mod service_support;

use service_support::*;
use std::os::fd::AsRawFd;
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;

/// Hold one request in progress on its own session, and wait until the
/// service counts it as busy (a result, not a pause).
fn hold_a_request(home: &Home) -> std::os::unix::net::UnixStream {
    let mut held = session(home);
    send(&mut held, "x", "test.hold");
    let started = std::time::Instant::now();
    loop {
        let status = json(&run(home, &["service", "status"]));
        // Two in progress: the held request and this status request itself.
        if status["busy"] == 2 {
            return held;
        }
        assert!(
            started.elapsed() < WAIT,
            "the held request was never admitted"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn a_drain_that_runs_out_of_time_exits_at_once_with_code_3() {
    let home = Home::new();
    let (mut service, ready) = start_with(&home, &["--drain-seconds", "1"]);
    assert!(ready["listening"].is_object(), "{ready}");
    let _held = hold_a_request(&home);
    let _ = run(&home, &["service", "stop"]);
    // A service parked on its drain would never exit; `exit` gives up at WAIT.
    assert_eq!(service.exit().code(), Some(3));
    assert!(home.socket().symlink_metadata().is_err());
    assert!(serves_again(&home), "the locks were freed by the exit");
}

#[test]
fn a_signal_drains_and_removes_the_socket() {
    let home = Home::new();
    let (mut service, ready) = start(&home);
    assert!(ready["listening"].is_object(), "{ready}");
    // SAFETY: a signal to the child this test started and still owns.
    assert_eq!(
        unsafe { libc::kill(service.pid() as i32, libc::SIGTERM) },
        0
    );
    let status = service.exit();
    assert_eq!(
        status.code(),
        Some(0),
        "{status:?} (signal {:?})",
        status.signal()
    );
    assert!(home.socket().symlink_metadata().is_err());
    assert!(!home.0.join(".hack-local/run/service/service.json").exists());
    assert!(serves_again(&home));
}

#[test]
fn a_signal_with_a_request_in_progress_drains_within_its_deadline() {
    let home = Home::new();
    let (mut service, ready) = start_with(&home, &["--drain-seconds", "1"]);
    assert!(ready["listening"].is_object(), "{ready}");
    let _held = hold_a_request(&home);
    // SAFETY: a signal to the child this test started and still owns.
    assert_eq!(unsafe { libc::kill(service.pid() as i32, libc::SIGHUP) }, 0);
    assert_eq!(service.exit().code(), Some(3));
    assert!(serves_again(&home));
}

#[test]
fn the_service_keeps_only_the_closed_environment() {
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let mut command = command(&home, &["service", "serve", "--notify-fd", "3"]);
    command
        .env("TMPDIR", "/tmp")
        .env("A_STARTER_VARIABLE", "not for the service")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let raw = std::os::fd::AsRawFd::as_raw_fd(&writer);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, move || {
            if libc::setsid() < 0 || libc::dup2(raw, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut service = Service(command.spawn().unwrap());
    drop(writer);
    drop(spawning);
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(reader), &mut line).unwrap();
    assert!(line.contains("listening"), "{line}");
    let mut stream = session(&home);
    send(&mut stream, "e", "test.env");
    let reply = receive(&mut stream);
    let names: Vec<&str> = reply["result"]["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert!(
        names
            .iter()
            .all(|name| ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"].contains(name)),
        "{names:?}"
    );
    assert!(names.contains(&"TMPDIR"), "{names:?}");
    drop(stream);
    json(&run(&home, &["service", "stop"]));
    assert!(service.exit().success());
}

#[test]
fn a_drain_timeout_exits_even_when_stderr_is_full() {
    // Nothing may stand between deciding to exit and exiting: with stderr a
    // full pipe nobody reads, a message first would block the exit forever.
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (notify_reader, notify_writer) = pipe();
    let (_stderr_reader, stderr_writer) = full_pipe(true);
    let mut command = command(
        &home,
        &[
            "service",
            "serve",
            "--idle-seconds",
            "60",
            "--drain-seconds",
            "1",
            "--notify-fd",
            "3",
        ],
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr_writer);
    let raw = std::os::fd::AsRawFd::as_raw_fd(&notify_writer);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, move || {
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
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(notify_reader), &mut line).unwrap();
    assert!(line.contains("listening"), "{line}");
    let _held = hold_a_request(&home);
    let _ = run(&home, &["service", "stop"]);
    assert_eq!(service.exit().code(), Some(3));
    assert!(serves_again(&home));
}

/// Put a FIFO with no writer where the advisory record is.
fn plant_fifo_record(home: &Home) {
    let record = home.0.join(".hack-local/run/service/service.json");
    std::fs::remove_file(&record).unwrap();
    let path = std::ffi::CString::new(record.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: a valid C string.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}

#[test]
fn a_fifo_in_place_of_the_record_never_blocks_an_exit() {
    let home = Home::new();
    // A full drain: the record is read only as a regular file.
    let (mut service, ready) = start(&home);
    assert!(ready["listening"].is_object(), "{ready}");
    plant_fifo_record(&home);
    json(&run(&home, &["service", "stop"]));
    assert_eq!(service.exit().code(), Some(0));
    assert!(serves_again(&home));
    // A drain that runs out of time touches no file before its exit.
    let (mut service, ready) = start_with(&home, &["--drain-seconds", "1"]);
    assert!(ready["listening"].is_object(), "{ready}");
    plant_fifo_record(&home);
    let _held = hold_a_request(&home);
    let _ = run(&home, &["service", "stop"]);
    assert_eq!(service.exit().code(), Some(3));
    assert!(serves_again(&home));
}

#[test]
fn a_stop_signal_before_discovery_is_answered_not_fatal() {
    // The handlers are installed before anything else; the hook pauses right
    // after that, before the home is looked up, and the signal arrives there.
    let home = Home::new();
    let spawning = SPAWN.lock().unwrap_or_else(|p| p.into_inner());
    let (reader, writer) = pipe();
    let mut service = spawn_serve(
        &home,
        writer.as_raw_fd(),
        &[
            "service",
            "serve",
            "--notify-fd",
            "3",
            "--test-pause-before-discovery",
        ],
    );
    drop(writer);
    drop(spawning);
    let mut paused = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(service.0.stderr.take().unwrap()),
        &mut paused,
    )
    .unwrap();
    assert!(paused.contains("paused"), "{paused}");
    // SAFETY: a signal to the child this test started and still owns.
    assert_eq!(
        unsafe { libc::kill(service.pid() as i32, libc::SIGTERM) },
        0
    );
    let status = service.exit();
    assert_eq!(
        status.code(),
        Some(0),
        "{status:?} (signal {:?})",
        status.signal()
    );
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(reader), &mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap(),
        serde_json::json!({"refused": {"code": "service_signalled"}})
    );
    assert!(home.socket().symlink_metadata().is_err());
}
