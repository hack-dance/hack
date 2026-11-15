//! Shared helpers for the integration tests.
//!
//! Children get an emptied environment with a fixed `PATH` and a private
//! temporary `HOME`, so a test does not depend on the caller's environment.
//! Tests signal only pids they recorded; nothing here matches by name.
#![allow(dead_code, reason = "each test file uses a subset")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use hack_desktop_term::pty::{Pty, PtyOptions};
use hack_desktop_term::session::{is_alive, members};
use hack_desktop_term::stream::{ProcessSpec, StreamSource};

/// A generous scheduling bound, not a latency claim.
pub const DEADLINE: Duration = Duration::from_secs(60);

/// A private directory, removed on drop.
pub struct TempHome(PathBuf);

impl TempHome {
    pub fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hack-term-itest-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).expect("create temp home");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `/bin/sh -c script` on a PTY with a hermetic environment.
pub fn sh(script: &str, home: &TempHome) -> PtyOptions {
    let mut opts = PtyOptions::new("/bin/sh").arg("-c").arg(script);
    opts.env_clear = true;
    opts.env = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), home.path().into()),
        ("TERM".into(), "dumb".into()),
    ];
    opts.cwd = Some(home.path().to_owned());
    opts
}

/// `/bin/sh -c script` as a stream source with a hermetic environment.
pub fn sh_source(script: &str, home: &TempHome) -> StreamSource {
    StreamSource::Process(ProcessSpec {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: Some(home.path().to_owned()),
        env: vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.path().into()),
        ],
        env_clear: true,
    })
}

/// Collect PTY output until `done` accepts it, the end, or the deadline.
pub fn read_until(pty: &Pty, done: impl Fn(&str) -> bool) -> String {
    let start = Instant::now();
    let mut out = Vec::new();
    while start.elapsed() < DEADLINE {
        let r = pty.read_timeout(usize::MAX, Duration::from_millis(100));
        out.extend_from_slice(&r.bytes);
        if r.eof || done(&String::from_utf8_lossy(&out)) {
            break;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The integer following `tag=` in `text`.
pub fn tagged(text: &str, tag: &str) -> Option<libc::pid_t> {
    let at = text.find(&format!("{tag}="))? + tag.len() + 1;
    text[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// Wait for every pid to stop running; returns the ones still alive.
pub fn wait_gone(pids: &[libc::pid_t]) -> Vec<libc::pid_t> {
    let start = Instant::now();
    loop {
        let alive: Vec<_> = pids.iter().copied().filter(|&p| is_alive(p)).collect();
        if alive.is_empty() || start.elapsed() >= DEADLINE {
            return alive;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A session this test started. If the test fails before its own teardown,
/// dropping this kills what is left of that session, and only that session.
pub struct Recorded {
    sid: libc::pid_t,
    done: bool,
}

impl Recorded {
    pub fn session(leader: u32) -> Self {
        Self {
            sid: libc::pid_t::try_from(leader).expect("pid"),
            done: false,
        }
    }

    pub fn done(&mut self) {
        self.done = true;
    }
}

impl Drop for Recorded {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // The session id stays reserved while any member is alive, so these
        // pids are members of the session this test started.
        for pid in members(self.sid) {
            // SAFETY: SIGKILL to a process of this test's own session.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}
