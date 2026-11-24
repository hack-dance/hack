//! Dedicated transport never changes structured stderr; completed lines survive exits.
use hack_runtime_core::timings::{self, Outcome, Record, Step};
use std::io::{BufRead, BufReader, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

#[cfg(target_os = "macos")]
fn host_clock() -> libc::clockid_t {
    libc::CLOCK_UPTIME_RAW
}
#[cfg(not(target_os = "macos"))]
fn host_clock() -> libc::clockid_t {
    libc::CLOCK_MONOTONIC
}
fn mono() -> u64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: the writable timespec lives through the call and no pointer is retained.
    assert_eq!(unsafe { libc::clock_gettime(host_clock(), &mut t) }, 0);
    t.tv_sec as u64 * 1_000_000 + t.tv_nsec as u64 / 1000
}
fn spawn(mut command: Command, enabled: bool, helper: bool) -> (Child, std::fs::File, u64) {
    let mut fds = [0; 2];
    // SAFETY: pipe initializes exactly two descriptor slots on success.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: pipe returned two newly owned descriptors; each gets one owner.
    let read = unsafe { std::fs::File::from_raw_fd(fds[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    let fd = write.as_raw_fd();
    // SAFETY: set flags only on this test-owned descriptor.
    assert_eq!(
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
        0
    );
    let start = mono();
    let argument = format!(
        "{}3:4bf92f3577b34da6a3ce929d0e0e4736:53995c3f42cd8ad8:{start}:runtime",
        timings::REQUEST_PREFIX
    );
    command
        .env_clear()
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if enabled {
        if helper {
            command.env("TIMING_EXIT_HELPER", argument);
        } else {
            command.arg(argument);
        }
        // SAFETY: only async-signal-safe descriptor operations run after fork.
        // dup2 makes fd 3 the explicitly transferred timing pipe in this child.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child = command.spawn().unwrap();
    drop(write);
    (child, read, start)
}
fn read_records(mut pipe: std::fs::File) -> Vec<Record> {
    let mut text = String::new();
    pipe.read_to_string(&mut text).unwrap();
    text.lines()
        .map(|line| Record::parse_line(line).unwrap())
        .collect()
}
#[test]
fn timing_pipe_preserves_the_exact_stderr_error_parser_contract() {
    for enabled in [false, true] {
        let command = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"));
        let (child, pipe, start) = spawn(command, enabled, false);
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let failure: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(failure["code"], "missing_candidate_root");
        let data = read_records(pipe);
        if enabled {
            assert_eq!(data.len(), 2);
            assert_eq!(data[0].step, "process.startup");
            assert_eq!(data[0].origin_mono_us, start);
            assert_eq!(data[1].step, "runtime.dispatch");
            assert_eq!(data[1].outcome, Outcome::Error);
            assert_eq!(data[1].code.as_deref(), Some("missing_candidate_root"));
            assert!(
                data.iter()
                    .all(|r| r.parent.as_deref() == Some("53995c3f42cd8ad8"))
            );
            assert_eq!(data[1].host_start_us(start), Some(data[1].start_us as i64));
        } else {
            assert!(data.is_empty());
        }
    }
}

#[test]
fn host_children_join_by_anchor_and_identity_in_reverse_arrival_order() {
    let mut children = Vec::new();
    for _ in 0..2 {
        children.push(spawn(
            Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate")),
            true,
            false,
        ));
    }
    let parent_origin = children[0].2;
    let mut spans = std::collections::BTreeSet::new();
    while let Some((child, pipe, start)) = children.pop() {
        assert_eq!(child.wait_with_output().unwrap().status.code(), Some(2));
        let end = mono();
        for record in read_records(pipe) {
            assert_eq!(record.origin_mono_us, start);
            assert_eq!(record.trace, "4bf92f3577b34da6a3ce929d0e0e4736");
            assert_eq!(record.parent.as_deref(), Some("53995c3f42cd8ad8"));
            assert!(spans.insert(record.span.clone()));
            let placed = record.host_start_us(parent_origin).unwrap();
            assert_eq!(placed as u64, start - parent_origin + record.start_us);
            assert!(record.origin_mono_us + record.start_us + record.dur_us <= end);
        }
    }
    assert_eq!(spans.len(), 4);
}
#[test]
fn timing_exit_helper() {
    let Ok(argument) = std::env::var("TIMING_EXIT_HELPER") else {
        return;
    };
    assert!(timings::enable_argument(&argument));
    let _: Result<(), ()> = timings::measure(Step::RuntimeDispatch, None, |_| {
        timings::measure(Step::ContainerExec, None, |_| timings::exit(7))
    });
}
#[test]
fn explicit_exit_streams_known_dispatch_and_elapsed_incomplete_child() {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "timing_exit_helper"]);
    let (child, pipe, _) = spawn(command, true, true);
    assert_eq!(child.wait_with_output().unwrap().status.code(), Some(7));
    let data = read_records(pipe);
    let dispatch = data.iter().find(|r| r.step == "runtime.dispatch").unwrap();
    let exec = data.iter().find(|r| r.step == "container.exec").unwrap();
    assert_eq!(dispatch.outcome, Outcome::Error);
    assert_eq!(exec.outcome, Outcome::Incomplete);
    assert_eq!(exec.parent.as_ref(), Some(&dispatch.span));
}
#[test]
fn completed_line_is_available_before_process_exit_or_kill() {
    // Use the test helper, which can stay alive independently of any VM or daemon.
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "timing_wait_helper"]);
    let (mut child, pipe, _) = spawn(command, true, true);
    let mut pipe = BufReader::new(pipe);
    let mut line = String::new();
    pipe.read_line(&mut line).unwrap();
    assert_eq!(
        Record::parse_line(line.trim()).unwrap().step,
        "process.startup"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    let mut rest = String::new();
    pipe.read_to_string(&mut rest).unwrap();
    assert!(rest.lines().all(|l| Record::parse_line(l).is_some()));
}
#[test]
fn timing_wait_helper() {
    let Ok(argument) = std::env::var("TIMING_EXIT_HELPER") else {
        return;
    };
    assert!(timings::enable_argument(&argument));
    std::thread::sleep(std::time::Duration::from_secs(5));
}
#[test]
fn runtime_explicit_exit_sites_use_the_timing_boundary() {
    for source in [
        include_str!("../src/main.rs"),
        include_str!("../src/log_follow_cli.rs"),
    ] {
        assert!(!source.contains("std::process::exit("));
        assert!(source.contains("hack_runtime_core::timings::exit("));
    }
}

#[test]
fn cold_boot_observation_includes_provider_start_and_its_early_errors() {
    // Tie the observer's tested early-error behavior to the cold-start call-site boundary.
    // This source check does not qualify a real provider boot.
    let source = include_str!("../src/provider/lifecycle.rs");
    let cold = source
        .split("phase(candidate, &mut owner, \"booting\")?;")
        .nth(1)
        .unwrap();
    let cold = cold.split("\nfn pool_spec(").next().unwrap();
    let span = cold
        .find("crate::timings::measure(crate::timings::Step::VmBoot")
        .unwrap();
    let provider = cold
        .find("start_machine(&SmolvmCli::new(candidate, &owner), permit)?;")
        .unwrap();
    let readiness = cold.find("finish_boot(candidate, &mut owner").unwrap();
    let cleanup = cold
        .find("cleanup.map_err(failed_boot_stop_error)?;")
        .unwrap();
    assert!(span < provider && provider < readiness && readiness < cleanup);
    assert!(cold.trim_end().ends_with("})\n}"));
}

#[test]
fn parses_typescript_command_span() {
    // Captured from the Bun collector, with normalized IDs and clock anchors.
    let line = r#"{"schema":"hack.timings/1","trace":"11111111111111111111111111111111","span":"2222222222222222","parent":null,"proc":"cli","clock":"host","origin_unix_us":1,"origin_mono_us":1,"step":"command.total","start_us":0,"dur_us":1030674,"outcome":"ok","attrs":{}}"#;
    let record = Record::parse_line(line).expect("TypeScript command span");
    assert_eq!(record.step.as_str(), "command.total");
    assert_eq!(record.outcome, Outcome::Ok);
}
