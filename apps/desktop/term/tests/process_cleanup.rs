//! Dropping a PTY or a process stream leaves no process behind; queues stay
//! bounded; output written just before exit is not lost.
//!
//! Hermetic: `/bin/sh` and a few POSIX tools from `/usr/bin:/bin`, an
//! emptied environment, a private temporary HOME, no network, no daemon, no
//! Docker. Deadlines are generous (60 s) scheduling bounds, not latency
//! claims; each test first proves its processes were alive, and signals
//! only pids it recorded.
#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};

use common::{DEADLINE, Recorded, TempHome, read_until, sh, sh_source, tagged, wait_gone};
use hack_desktop_term::pty::{OUTPUT_QUEUE_BYTES, Pty, PtySize};
use hack_desktop_term::session::{ExitInfo, exists, is_alive};
use hack_desktop_term::stream::{ByteStream, STREAM_QUEUE_BYTES, StreamSource};

#[test]
fn dropping_a_pty_ends_the_shell_and_everything_in_its_group() {
    // A grandchild in the shell's group, and one that ignores SIGHUP and
    // SIGTERM, so SIGKILL escalation has to run. Both are reached by the
    // group signal on every platform.
    let script = r#"
        sleep 120 & echo "same=$!"
        ( trap '' HUP TERM; exec sleep 120 ) & echo "deaf=$!"
        echo "shell=$$"
        wait
    "#;
    let home = TempHome::new();
    let pty = Pty::spawn(&sh(script, &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    let out = read_until(&pty, |t| t.contains("shell="));
    let pids: Vec<libc::pid_t> = ["same", "deaf", "shell"]
        .iter()
        .map(|t| tagged(&out, t).unwrap_or_else(|| panic!("no {t}= in {out:?}")))
        .collect();
    assert_eq!(pids[2], leader, "the shell is the session leader");
    for &p in &pids {
        assert!(is_alive(p), "pid {p} should be running before drop");
    }
    drop(pty);
    let alive = wait_gone(&pids);
    assert!(alive.is_empty(), "still running after drop: {alive:?}");
    // The reaper thread reaps the leader after its last signal.
    let start = Instant::now();
    while exists(leader) && start.elapsed() < DEADLINE {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!exists(leader), "the leader was left as a zombie");
    rec.done();
}

#[test]
fn a_job_in_another_process_group_is_ended_or_reported() {
    // `set -m` puts the job in its own process group inside the session. A
    // non-interactive shell does not pass SIGHUP on to it.
    //
    // Linux reaches it through a pidfd. macOS has no race-free handle for
    // it, so it is left alone and named in `survivors`; there the job
    // sleeps only a few seconds and ends by itself.
    let job_seconds = if cfg!(target_os = "linux") { 120 } else { 4 };
    let script = format!(
        "set -m; sleep {job_seconds} & echo \"job=$!\"; set +m; sleep 120 & echo \"same=$!\"; wait"
    );
    let home = TempHome::new();
    let pty = Pty::spawn(&sh(&script, &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    let out = read_until(&pty, |t| t.contains("same="));
    let job = tagged(&out, "job").expect("job");
    let same = tagged(&out, "same").expect("same");
    assert!(is_alive(job) && is_alive(same));
    assert_ne!(
        unsafe { libc::getpgid(job) },
        leader,
        "its own process group"
    );
    assert_eq!(unsafe { libc::getsid(job) }, leader, "the same session");

    let done = pty
        .terminate_in_background()
        .wait(DEADLINE)
        .expect("teardown result");
    assert!(wait_gone(&[same, leader]).is_empty());
    if cfg!(target_os = "linux") {
        assert!(done.gone && done.survivors.is_empty(), "{done:?}");
        assert!(!is_alive(job));
    } else {
        assert!(!done.gone, "{done:?}");
        assert_eq!(done.survivors, vec![job], "reported, not signalled");
        assert!(wait_gone(&[job]).is_empty(), "it ends by itself");
    }
    assert!(!exists(leader));
    rec.done();
}

#[test]
fn terminate_blocking_reports_the_session_gone() {
    let home = TempHome::new();
    let pty = Pty::spawn(&sh("sleep 120 & echo \"kid=$!\"; wait", &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let out = read_until(&pty, |t| t.contains("kid="));
    let kid = tagged(&out, "kid").expect("kid pid");
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    assert!(is_alive(kid) && is_alive(leader));
    assert!(
        pty.terminate_blocking(DEADLINE).gone,
        "session should be gone"
    );
    assert!(!is_alive(kid) && !exists(leader));
    rec.done();
}

#[test]
fn resize_reaches_the_child() {
    let home = TempHome::new();
    let mut opts = sh("read _; stty size; read _", &home);
    opts.size = PtySize::cells(80, 24);
    let pty = Pty::spawn(&opts).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    pty.resize(PtySize::cells(101, 33)).expect("resize");
    pty.write(b"\n");
    let out = read_until(&pty, |t| t.contains("33 101"));
    assert!(out.contains("33 101"), "stty size after resize: {out:?}");
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn the_child_leads_a_session_with_a_controlling_terminal() {
    let home = TempHome::new();
    let pty = Pty::spawn(&sh("tty >/dev/null && echo has-tty; read _", &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    let out = read_until(&pty, |t| t.contains("has-tty"));
    assert!(out.contains("has-tty"), "{out:?}");
    assert_eq!(unsafe { libc::getsid(leader) }, leader);
    assert_eq!(unsafe { libc::getpgid(leader) }, leader);
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn the_child_sees_only_the_environment_it_was_given() {
    let home = TempHome::new();
    let pty = Pty::spawn(&sh("env; echo env-done", &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let out = read_until(&pty, |t| t.contains("env-done"));
    let names: Vec<&str> = out
        .lines()
        .filter_map(|l| l.split_once('=').map(|(k, _)| k.trim()))
        .filter(|k| !matches!(*k, "PWD" | "OLDPWD" | "SHLVL" | "_"))
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(sorted, ["HOME", "PATH", "TERM"], "{out:?}");
    assert!(out.contains(&format!("HOME={}", home.path().display())));
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn output_printed_just_before_exit_is_delivered_before_end_of_file() {
    // Small output, then exit at once: the child is gone long before the
    // first read. Nothing may be lost, and the end comes after the bytes.
    let home = TempHome::new();
    let pty = Pty::spawn(&sh("printf 'tiny-final-suffix\\n'", &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let start = Instant::now();
    while pty.exit().is_none() && start.elapsed() < DEADLINE {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(pty.exit(), Some(ExitInfo::Exited(0)));
    std::thread::sleep(Duration::from_millis(300));
    let out = read_until(&pty, |_| false);
    assert!(out.contains("tiny-final-suffix"), "{out:?}");
    assert!(pty.read(1).eof, "end of file after the last byte");
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();

    // Large output: more than the queue and the kernel hold, so the child
    // must wait for the reader (backpressure) and then exits right after
    // its last line.
    let pty = Pty::spawn(&sh("seq 1 300000; echo large-final-suffix", &home)).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    // Stall first: the reader fills the queue and stops reading.
    let start = Instant::now();
    while pty.pending_output_bytes() + 64 * 1024 < OUTPUT_QUEUE_BYTES && start.elapsed() < DEADLINE
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(200));
    assert!(pty.pending_output_bytes() <= OUTPUT_QUEUE_BYTES);
    assert!(
        pty.exit().is_none(),
        "the child is blocked on its own write"
    );
    let out = read_until(&pty, |_| false);
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    assert_eq!(lines.len(), 300_001, "every line arrived");
    assert_eq!(lines[0], "1");
    assert_eq!(lines[299_999], "300000");
    assert_eq!(lines[300_000], "large-final-suffix");
    let start = Instant::now();
    while pty.exit().is_none() && start.elapsed() < DEADLINE {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(pty.exit(), Some(ExitInfo::Exited(0)));
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn a_fast_stream_with_a_stalled_consumer_stays_under_the_byte_bound() {
    let home = TempHome::new();
    // `yes` writes as fast as the pipe accepts, forever.
    let mut stream = ByteStream::open(&sh_source(
        "echo \"sh=$$\"; exec yes 0123456789abcdef",
        &home,
    ))
    .expect("open");
    let leader = libc::pid_t::try_from(stream.pid().unwrap()).unwrap();
    let mut rec = Recorded::session(leader.unsigned_abs());
    // Do not drain. The reader fills the queue to the bound and then blocks.
    let start = Instant::now();
    while stream.pending_bytes() + 64 * 1024 < STREAM_QUEUE_BYTES && start.elapsed() < DEADLINE {
        std::thread::sleep(Duration::from_millis(5));
    }
    let filled = stream.pending_bytes();
    assert!(filled + 64 * 1024 >= STREAM_QUEUE_BYTES, "filled {filled}");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(stream.pending_bytes(), filled, "no growth while stalled");
    assert!(stream.high_water_bytes() <= STREAM_QUEUE_BYTES);
    assert!(is_alive(leader), "the producer is blocked, not killed");
    // Draining lets it continue; the bound still holds.
    let mut total = 0;
    while total < 8 * STREAM_QUEUE_BYTES && start.elapsed() < DEADLINE {
        total += stream.read_blocking(STREAM_QUEUE_BYTES, DEADLINE).len();
        assert!(stream.pending_bytes() <= STREAM_QUEUE_BYTES);
    }
    assert!(total >= 8 * STREAM_QUEUE_BYTES, "read {total}");
    assert!(stream.high_water_bytes() <= STREAM_QUEUE_BYTES);
    // Closing cancels the blocked reader and ends the producer.
    drop(stream);
    assert!(wait_gone(&[leader]).is_empty());
    rec.done();
}

#[test]
fn dropping_a_process_stream_ends_its_session() {
    let home = TempHome::new();
    let source = sh_source("sleep 120 & echo \"kid=$!\"; echo \"sh=$$\"; wait", &home);
    let mut stream = ByteStream::open(&source).expect("open");
    let mut rec = Recorded::session(stream.pid().unwrap());
    let mut out = String::new();
    let start = Instant::now();
    while !out.contains("sh=") && start.elapsed() < DEADLINE {
        out.push_str(&String::from_utf8_lossy(
            &stream.read_blocking(1, Duration::from_millis(200)),
        ));
    }
    let pids = [tagged(&out, "kid").unwrap(), tagged(&out, "sh").unwrap()];
    for &p in &pids {
        assert!(is_alive(p), "pid {p} should be running before drop");
    }
    drop(stream);
    let alive = wait_gone(&pids);
    assert!(alive.is_empty(), "still running after drop: {alive:?}");
    rec.done();
}

#[test]
fn a_file_stream_reads_to_the_end() {
    let home = TempHome::new();
    let path = home.path().join("log.txt");
    let body: String = (0..10_000).map(|i| format!("line {i}\n")).collect();
    std::fs::write(&path, &body).unwrap();
    let mut stream = ByteStream::open(&StreamSource::File(path)).expect("open");
    let got = stream.read_blocking(body.len(), DEADLINE);
    assert_eq!(got, body.as_bytes());
    // Nothing more arrives, and the end is reported after the last byte.
    assert!(stream.read_blocking(1, DEADLINE).is_empty());
    assert!(stream.is_ended(), "the end is reported");
}
