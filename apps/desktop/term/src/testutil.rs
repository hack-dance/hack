//! Helpers for this crate's unit tests.
//!
//! Children get an emptied environment with a fixed `PATH` and a private
//! temporary `HOME`, so a test does not depend on the caller's environment.
//! Tests signal only pids they recorded; nothing here matches by name.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use crate::pty::PtyOptions;
use crate::session::{is_alive, members};

/// A generous scheduling bound, not a latency claim.
pub const DEADLINE: Duration = Duration::from_secs(60);

/// A private directory, removed on drop.
pub struct TempHome(PathBuf);

impl TempHome {
    pub fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hack-term-test-{}-{}",
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
pub fn sh(script: &str) -> (PtyOptions, TempHome) {
    let home = TempHome::new();
    let mut opts = PtyOptions::new("/bin/sh").arg("-c").arg(script);
    opts.env_clear = true;
    opts.env = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), home.path().into()),
        ("TERM".into(), "dumb".into()),
    ];
    opts.cwd = Some(home.path().to_owned());
    (opts, home)
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

/// Assert that `pid`, a child this test recorded, is gone without leaving a
/// zombie. On failure the child is killed first, but only if it is provably
/// still ours: an unreaped child of this process, whose pid is anchored.
pub fn assert_no_trace(pid: libc::pid_t, what: &str) {
    if crate::session::exists(pid) {
        if crate::session::is_own_child(pid) {
            // SAFETY: an unreaped child of this process; its pid cannot have
            // been reused.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        panic!("{what}: pid {pid} was left behind");
    }
}

/// A session this test started. If the test fails before its own teardown,
/// dropping this kills what is left of that session through pidfds, after
/// checking each one is still in that session. Where there is no pidfd
/// (macOS) nothing is signalled: the fixtures there sleep for at most two
/// minutes and end by themselves.
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
        use crate::session::{Open, OsTable, ProcTable};
        for pid in members(self.sid) {
            if let Open::Handle(handle) = OsTable.open(pid)
                && OsTable
                    .identity(pid)
                    .is_some_and(|i| i.sid == self.sid && i.live)
            {
                handle.send(libc::SIGKILL);
            }
        }
    }
}
