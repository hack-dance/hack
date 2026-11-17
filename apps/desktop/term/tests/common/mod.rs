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
use hack_desktop_term::session::is_alive;
#[cfg(target_os = "linux")]
use hack_desktop_term::session::members;
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

/// A stand-in for the `hack` CLI, written into `home`. It checks the argv
/// the app passes and then starts a plain shell, so tests need no Docker,
/// daemon or project:
///
/// - `exec <service> -- <shell>` prints `container:<service>:<shell>` and
///   runs `/bin/sh`. With `FAKE_HACK_NO_BASH` set, `bash` fails the way a
///   container without it does: a message and exit status 127.
///   `FAKE_HACK_FAIL_AFTER` (seconds) delays the message, as a slow
///   `docker exec` does; `FAKE_HACK_EXIT_AFTER` delays the exit after it,
///   and `FAKE_HACK_EXIT_MARK` names a file created just before that exit.
///   `FAKE_HACK_SILENT` starts the shell with no banner and no prompt.
/// - `host shell --env <overlay> --scope <scope>` prints
///   `host-shell env=<overlay> scope=<scope>` and runs `$SHELL -l`, as the
///   real command does.
pub fn fake_hack(home: &TempHome) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = r#"#!/bin/sh
case "$1" in
  exec)
    [ "$#" -eq 4 ] && [ "$3" = "--" ] || { echo "fake hack: bad exec argv: $*" >&2; exit 2; }
    if [ "$4" = bash ] && [ -n "$FAKE_HACK_NO_BASH" ]; then
      [ -n "$FAKE_HACK_FAIL_AFTER" ] && sleep "$FAKE_HACK_FAIL_AFTER"
      echo 'exec: "bash": executable file not found in $PATH' >&2
      [ -n "$FAKE_HACK_EXIT_AFTER" ] && sleep "$FAKE_HACK_EXIT_AFTER"
      [ -n "$FAKE_HACK_EXIT_MARK" ] && : > "$FAKE_HACK_EXIT_MARK"
      exit 127
    fi
    # FAKE_HACK_SILENT: a shell that starts but prints nothing, no prompt.
    if [ -n "$FAKE_HACK_SILENT" ]; then
      exec /bin/sh -c 'while IFS= read -r line; do eval "$line"; done'
    fi
    echo "container:$2:$4"
    PS1='container$ ' exec /bin/sh
    ;;
  host)
    [ "$#" -eq 6 ] && [ "$2" = shell ] && [ "$3" = --env ] && [ "$5" = --scope ] \
      || { echo "fake hack: bad host argv: $*" >&2; exit 2; }
    echo "host-shell env=$4 scope=$6"
    exec "${SHELL:-/bin/sh}" -l
    ;;
  *) echo "fake hack: unknown command: $*" >&2; exit 2 ;;
esac
"#;
    // Write, close, mark executable, then rename into place, so nothing can
    // try to run a file that is still open for writing.
    let pending = home.path().join("hack.pending");
    std::fs::write(&pending, script).expect("write fake hack");
    std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let path = home.path().join("hack");
    std::fs::rename(&pending, &path).expect("rename");
    path
}

/// Make a session plan hermetic: an emptied environment with a fixed
/// `PATH`, the private `HOME`, `SHELL=/bin/sh`, the plan's own terminal
/// identity variables, and `extra`.
pub fn hermetic(
    plan: &mut hack_desktop_term::launch::SessionPlan,
    home: &TempHome,
    extra: &[(&str, &str)],
) {
    for attempt in &mut plan.attempts {
        let o = &mut attempt.options;
        o.env_clear = true;
        o.env.push(("PATH".into(), "/usr/bin:/bin".into()));
        o.env.push(("HOME".into(), home.path().into()));
        o.env.push(("SHELL".into(), "/bin/sh".into()));
        for (k, v) in extra {
            o.env.push(((*k).into(), (*v).into()));
        }
    }
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
/// dropping this kills what is left of that session, through pidfds only,
/// after checking each one is still in that session. No pid is signalled by
/// number. Where there is no pidfd (macOS) nothing is signalled: the
/// fixtures sleep for at most two minutes and end by themselves.
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
        #[cfg(target_os = "linux")]
        if !self.done {
            for pid in members(self.sid) {
                kill_through_pidfd(pid, self.sid);
            }
        }
        // Elsewhere there is no race-free handle, so nothing is signalled.
        #[cfg(not(target_os = "linux"))]
        let _ = (self.sid, self.done);
    }
}

/// SIGKILL `pid` through a pidfd, only if that pidfd's process is still in
/// session `sid`.
#[cfg(target_os = "linux")]
fn kill_through_pidfd(pid: libc::pid_t, sid: libc::pid_t) {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // SAFETY: pidfd_open returns a new descriptor or -1.
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0 as libc::c_uint) };
    if raw < 0 {
        return;
    }
    // SAFETY: a fresh descriptor this function owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw as libc::c_int) };
    // The pidfd pins one process; check what the pid names now.
    let in_session = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|t| {
            let rest = t[t.rfind(')')? + 1..].to_owned();
            rest.split_ascii_whitespace()
                .nth(3)?
                .parse::<libc::pid_t>()
                .ok()
        })
        == Some(sid);
    if in_session {
        // SAFETY: a valid pidfd; a null siginfo means a kill-style signal.
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0 as libc::c_uint,
            );
        }
    }
}
