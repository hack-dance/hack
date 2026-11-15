//! Dropping a PTY or a process stream leaves no process behind.
//!
//! Hermetic: only `/bin/sh`, `sleep` and `stty`, no network, no daemon, no
//! Docker. Deadlines are generous (60 s) scheduling bounds, not latency
//! claims; each test first proves its processes were alive.
#![cfg(unix)]

use std::sync::mpsc;
use std::time::{Duration, Instant};

use hack_desktop_term::pty::{self, Pty, PtyOptions, PtySize};
use hack_desktop_term::session::is_alive;
use hack_desktop_term::stream::{ByteStream, StreamSource};

const DEADLINE: Duration = Duration::from_secs(60);

fn sh(script: &str) -> PtyOptions {
    PtyOptions::new("/bin/sh").arg("-c").arg(script)
}

/// Collect PTY output until `done` accepts it or the deadline passes.
fn read_until(pty: &Pty, done: impl Fn(&str) -> bool) -> String {
    let (tx, rx) = mpsc::channel();
    let _reader = pty::spawn_reader(pty.reader().expect("reader"), move |b| tx.send(b).is_ok())
        .expect("reader thread");
    let start = Instant::now();
    let mut out = Vec::new();
    while start.elapsed() < DEADLINE {
        if let Ok(b) = rx.recv_timeout(Duration::from_millis(100)) {
            out.extend_from_slice(&b);
            if done(&String::from_utf8_lossy(&out)) {
                break;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The integers following `tag=` in `text`.
fn tagged(text: &str, tag: &str) -> Option<libc::pid_t> {
    let at = text.find(&format!("{tag}="))? + tag.len() + 1;
    text[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn wait_gone(pids: &[libc::pid_t]) -> Vec<libc::pid_t> {
    let start = Instant::now();
    loop {
        let alive: Vec<_> = pids.iter().copied().filter(|&p| is_alive(p)).collect();
        if alive.is_empty() || start.elapsed() >= DEADLINE {
            return alive;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn dropping_a_pty_ends_the_shell_its_children_and_its_job_groups() {
    // A grandchild in the shell's group, one in its own job group (set -m),
    // and one that ignores SIGHUP and SIGTERM, so SIGKILL escalation runs.
    let script = r#"
        sleep 300 & echo "same=$!"
        ( trap '' HUP TERM; exec sleep 300 ) & echo "deaf=$!"
        set -m
        sleep 300 & echo "job=$!"
        echo "shell=$$"
        wait
    "#;
    let pty = Pty::spawn(&sh(script)).expect("spawn");
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    let out = read_until(&pty, |t| t.contains("shell="));
    let pids: Vec<libc::pid_t> = ["same", "deaf", "job", "shell"]
        .iter()
        .map(|t| tagged(&out, t).unwrap_or_else(|| panic!("no {t}= in {out:?}")))
        .collect();
    assert_eq!(pids[3], leader, "the shell is the session leader");
    for &p in &pids {
        assert!(is_alive(p), "pid {p} should be running before drop");
    }
    // The job really is in another process group of the same session.
    let job_pgid = unsafe { libc::getpgid(pids[2]) };
    assert_ne!(job_pgid, leader, "set -m job has its own process group");
    assert_eq!(unsafe { libc::getsid(pids[2]) }, leader);

    drop(pty);
    let alive = wait_gone(&pids);
    assert!(alive.is_empty(), "still running after drop: {alive:?}");
}

#[test]
fn terminate_blocking_reports_the_session_gone() {
    let pty = Pty::spawn(&sh("sleep 300 & echo \"kid=$!\"; wait")).expect("spawn");
    let out = read_until(&pty, |t| t.contains("kid="));
    let kid = tagged(&out, "kid").expect("kid pid");
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    assert!(is_alive(kid) && is_alive(leader));
    assert!(pty.terminate_blocking(DEADLINE), "session should be gone");
    assert!(!is_alive(kid) && !is_alive(leader));
}

#[test]
fn resize_reaches_the_child() {
    let mut opts = sh("read _; stty size; read _");
    opts.size = PtySize::cells(80, 24);
    let pty = Pty::spawn(&opts).expect("spawn");
    pty.resize(PtySize::cells(101, 33)).expect("resize");
    pty.write_all(b"\n").expect("write");
    let out = read_until(&pty, |t| t.contains("33 101"));
    assert!(out.contains("33 101"), "stty size after resize: {out:?}");
    assert!(pty.terminate_blocking(DEADLINE));
}

#[test]
fn the_child_leads_a_session_with_a_controlling_terminal() {
    let pty = Pty::spawn(&sh("tty >/dev/null && echo has-tty; read _")).expect("spawn");
    let leader = libc::pid_t::try_from(pty.pid()).unwrap();
    let out = read_until(&pty, |t| t.contains("has-tty"));
    assert!(out.contains("has-tty"), "{out:?}");
    assert_eq!(unsafe { libc::getsid(leader) }, leader);
    assert_eq!(unsafe { libc::getpgid(leader) }, leader);
    assert!(pty.terminate_blocking(DEADLINE));
}

#[test]
fn dropping_a_process_stream_ends_its_group() {
    let source = StreamSource::Process {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "sleep 300 & echo \"kid=$!\"; echo \"sh=$$\"; wait".into(),
        ],
        cwd: None,
    };
    let mut stream = ByteStream::open(&source).expect("open");
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
}

#[test]
fn a_file_stream_reads_to_the_end() {
    let dir = std::env::temp_dir().join(format!("hack-term-file-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("log.txt");
    let body: String = (0..10_000).map(|i| format!("line {i}\n")).collect();
    std::fs::write(&path, &body).unwrap();
    let mut stream = ByteStream::open(&StreamSource::File(path)).expect("open");
    let got = stream.read_blocking(body.len(), DEADLINE);
    assert_eq!(got, body.as_bytes());
    std::fs::remove_dir_all(&dir).unwrap();
}
