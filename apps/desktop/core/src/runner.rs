//! Runs `hack ... --json` as the user, with a timeout.
//!
//! Contract:
//! - Each command runs in its own process group. On timeout the whole group
//!   is killed (SIGKILL) and reaped, so no `docker compose` child outlives it.
//! - stdout is parsed as JSON. The CLI result envelope (`{ok,data}` /
//!   `{ok:false,error}`) is unwrapped; raw objects are returned as they are.
//! - stderr is kept (last 8 KB) only for error messages; it is never parsed.
//! - `HACK_NO_INTERACTIVE=1` is always set: the app never answers prompts.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::models::{CliError, LogEvent};

const STDERR_KEEP: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum RunError {
    /// The `hack` executable was not found.
    NotFound,
    Spawn(String),
    Timeout {
        after: Duration,
    },
    /// The CLI returned an error envelope.
    Cli(CliError),
    /// Non-zero exit without an error envelope.
    Exit {
        code: Option<i32>,
        stderr: String,
    },
    /// stdout was not the JSON we expected.
    BadJson {
        error: String,
        stdout_head: String,
    },
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "hack was not found on PATH"),
            Self::Spawn(e) => write!(f, "could not run hack: {e}"),
            Self::Timeout { after } => write!(f, "hack did not answer within {after:?}"),
            Self::Cli(e) => write!(f, "{}: {}", e.code, e.message),
            Self::Exit { code, stderr } => {
                write!(f, "hack exited with {code:?}: {}", stderr.trim())
            }
            Self::BadJson { error, .. } => write!(f, "unexpected output from hack: {error}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CliRunner {
    program: PathBuf,
    env: Vec<(String, String)>,
    /// `on_path` found no executable: spawn reports `NotFound`.
    missing: bool,
    /// How long a timed-out command gets after SIGTERM before SIGKILL.
    term_grace: Duration,
}

/// Default grace after SIGTERM. The CLI forwards SIGTERM to the detached
/// subprocess groups it owns (for example a Compose build) and waits for
/// them; SIGKILL alone would orphan those and kill the CLI's own timer.
pub const TERM_GRACE: Duration = Duration::from_secs(15);

impl CliRunner {
    /// Run `program` (normally `hack`, resolved through PATH).
    #[must_use]
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            env: vec![("HACK_NO_INTERACTIVE".into(), "1".into())],
            missing: false,
            term_grace: TERM_GRACE,
        }
    }

    /// Change the SIGTERM-to-SIGKILL grace for timed-out commands.
    #[must_use]
    pub fn with_term_grace(mut self, grace: Duration) -> Self {
        self.term_grace = grace;
        self
    }

    /// Find `name` on `PATH` and run it by absolute path.
    ///
    /// Only absolute `PATH` entries are searched: an empty or relative entry
    /// (such as `.`) would resolve against the working directory, which
    /// another local user may control. When nothing is found the runner
    /// reports `NotFound` without spawning anything.
    #[must_use]
    pub fn on_path(name: &str) -> Self {
        let path = std::env::var_os("PATH");
        match resolve_on_path(name, path.as_deref()) {
            Some(p) => Self::new(p),
            None => {
                let mut r = Self::new(name);
                r.missing = true;
                r
            }
        }
    }

    /// Add an environment variable for every command (tests use this for
    /// a temporary `HACK_HOME`).
    #[must_use]
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    fn command(&self, args: &[&str], path: Option<&Path>) -> Command {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(&self.program);
        cmd.args(args);
        if let Some(p) = path {
            cmd.arg("--path").arg(p);
        }
        // Children (and their own children, such as `docker` run by
        // `hack doctor`) get a PATH with only absolute entries: an empty or
        // relative entry would resolve against the working directory.
        if let Some(path) = std::env::var_os("PATH") {
            cmd.env("PATH", sanitize_path(&path));
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        cmd
    }

    fn spawn(&self, args: &[&str], path: Option<&Path>) -> Result<Child, RunError> {
        if self.missing {
            return Err(RunError::NotFound);
        }
        // ETXTBSY: the executable was just written (a fresh upgrade, or a test
        // script whose write descriptor a concurrent fork still holds). Retry
        // briefly instead of reporting a spawn failure.
        let mut attempt = 0;
        loop {
            match self.command(args, path).spawn() {
                Ok(c) => return Ok(c),
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && attempt < 20 => {
                    attempt += 1;
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(RunError::NotFound);
                }
                Err(e) => return Err(RunError::Spawn(e.to_string())),
            }
        }
    }

    /// Run and return raw stdout, stderr tail and exit code.
    ///
    /// # Errors
    /// `NotFound`, `Spawn` or `Timeout`.
    pub fn run_raw(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Duration,
    ) -> Result<(String, String, Option<i32>), RunError> {
        self.run_inner(args, path, Some(timeout))
    }

    /// Run with no deadline from the app: wait until the command exits and
    /// its output pipes close. For lifecycle commands, whose timeouts the
    /// CLI owns; terminating them from outside can orphan the detached
    /// build subprocesses the CLI starts.
    ///
    /// # Errors
    /// Any [`RunError`] except `Timeout`.
    pub fn run_json_to_completion<T: DeserializeOwned>(
        &self,
        args: &[&str],
        path: Option<&Path>,
    ) -> Result<T, RunError> {
        let (stdout, stderr, code) = self.run_inner(args, path, None)?;
        let value = parse_result(&stdout, &stderr, code)?;
        serde_json::from_value(value).map_err(|e| RunError::BadJson {
            error: e.to_string(),
            stdout_head: head(&stdout),
        })
    }

    fn run_inner(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Option<Duration>,
    ) -> Result<(String, String, Option<i32>), RunError> {
        let mut child = self.spawn(args, path)?;
        let out = read_all(child.stdout.take());
        let err = read_all(child.stderr.take());
        let deadline = timeout.map(|t| (Instant::now() + t, t));
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if deadline.is_some_and(|(d, _)| Instant::now() >= d) => {
                    terminate_group(&mut child, self.term_grace);
                    let after = deadline.map_or(Duration::ZERO, |(_, t)| t);
                    return Err(RunError::Timeout { after });
                }
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(e) => return Err(RunError::Spawn(e.to_string())),
            }
        };
        // A deadline also covers draining: a descendant that keeps a pipe
        // open after `hack` exits must not hold the caller past the timeout.
        // Without a deadline, wait for the pipes to close.
        let grace = self.term_grace;
        let drain = |rx: &mpsc::Receiver<String>, child: &mut Child| match deadline {
            Some((d, t)) => {
                let left = d.saturating_duration_since(Instant::now());
                rx.recv_timeout(left).map_err(|_| {
                    terminate_group(child, grace);
                    RunError::Timeout { after: t }
                })
            }
            None => rx
                .recv()
                .map_err(|_| RunError::Spawn("output reader stopped".into())),
        };
        let stdout = drain(&out, &mut child)?;
        let mut stderr = drain(&err, &mut child)?;
        if stderr.len() > STDERR_KEEP {
            let cut = stderr.len() - STDERR_KEEP;
            let cut = (cut..stderr.len())
                .find(|i| stderr.is_char_boundary(*i))
                .unwrap_or(cut);
            stderr = stderr.split_off(cut);
        }
        Ok((stdout, stderr, status.code()))
    }

    /// Run a `--json` command and deserialize its (unwrapped) result.
    ///
    /// # Errors
    /// Any [`RunError`].
    pub fn run_json<T: DeserializeOwned>(
        &self,
        args: &[&str],
        path: Option<&Path>,
        timeout: Duration,
    ) -> Result<T, RunError> {
        let (stdout, stderr, code) = self.run_raw(args, path, timeout)?;
        let value = parse_result(&stdout, &stderr, code)?;
        serde_json::from_value(value).map_err(|e| RunError::BadJson {
            error: e.to_string(),
            stdout_head: head(&stdout),
        })
    }

    /// `hack --version` → `"5.0.0"` (text output until request R1).
    ///
    /// # Errors
    /// Any [`RunError`].
    pub fn version(&self, timeout: Duration) -> Result<String, RunError> {
        let (stdout, stderr, code) = self.run_raw(&["--version"], None, timeout)?;
        if code != Some(0) {
            return Err(RunError::Exit { code, stderr });
        }
        parse_version(&stdout).ok_or_else(|| RunError::BadJson {
            error: "no version in output".into(),
            stdout_head: head(&stdout),
        })
    }

    /// Start a long-running ndjson stream (`hack logs --json ...`).
    ///
    /// # Errors
    /// `NotFound` or `Spawn`.
    pub fn stream_logs(&self, args: &[&str], path: Option<&Path>) -> Result<LogStream, RunError> {
        let mut child = self.spawn(args, path)?;
        let stdout = child.stdout.take();
        // Bounded: a reader that outruns the UI blocks, which in turn blocks
        // the CLI on its pipe, instead of queueing without limit.
        let (tx, rx) = mpsc::sync_channel(STREAM_QUEUE);
        let reader = thread::spawn(move || {
            let Some(stdout) = stdout else { return };
            let mut r = BufReader::new(stdout);
            while let Some((line, cut)) = read_bounded_line(&mut r, MAX_RAW_LINE) {
                if line.trim().is_empty() {
                    continue;
                }
                // A record cut at MAX_RAW_LINE is no longer valid JSON: show
                // a visible marker instead of dropping it silently.
                let mut event = if cut {
                    oversized_record_event()
                } else {
                    serde_json::from_str::<LogEvent>(&line).unwrap_or_else(|_| LogEvent {
                        kind: "notice".into(),
                        message: Some(line),
                        ..LogEvent::default()
                    })
                };
                // Cap before queueing, so the queue's memory is bounded too.
                cap_event(&mut event);
                if tx.send(event).is_err() {
                    break;
                }
            }
        });
        Ok(LogStream {
            child,
            rx: Some(rx),
            reader: Some(reader),
        })
    }
}

/// Events queued between the reader thread and the UI.
pub const STREAM_QUEUE: usize = 1024;
/// Cap for the top-level `message` of an event (notices, errors).
pub const MAX_NOTICE_BYTES: usize = 4 * 1024;
/// Cap for every other short text field (kind, timestamps, service, ...).
pub const MAX_FIELD_BYTES: usize = 256;
/// Upper bound on the text one queued event retains after `cap_event`:
/// the log message, the notice message and eight short fields.
pub const MAX_EVENT_BYTES: usize =
    crate::logs::MAX_LINE_BYTES + MAX_NOTICE_BYTES + 8 * MAX_FIELD_BYTES;
/// Upper bound on queued text: `STREAM_QUEUE * MAX_EVENT_BYTES` (~70 MiB).
pub const MAX_QUEUED_BYTES: usize = STREAM_QUEUE * MAX_EVENT_BYTES;

/// Bound every text field an event retains, so one event never holds more
/// than `MAX_EVENT_BYTES` (cut on a character boundary into a new, small
/// string). A capped log message marks its entry truncated.
fn cap_event(e: &mut LogEvent) {
    fn cap(s: &mut String, max: usize) -> bool {
        if s.len() <= max {
            return false;
        }
        let mut keep = max;
        while !s.is_char_boundary(keep) {
            keep -= 1;
        }
        *s = s[..keep].to_owned();
        true
    }
    fn cap_opt(s: &mut Option<String>, max: usize) {
        if let Some(v) = s.as_mut() {
            cap(v, max);
        }
    }
    cap(&mut e.kind, MAX_FIELD_BYTES);
    cap_opt(&mut e.ts, MAX_FIELD_BYTES);
    cap_opt(&mut e.backend, MAX_FIELD_BYTES);
    cap_opt(&mut e.reason, MAX_FIELD_BYTES);
    cap_opt(&mut e.message, MAX_NOTICE_BYTES);
    if let Some(entry) = e.entry.as_mut() {
        cap_opt(&mut entry.service, MAX_FIELD_BYTES);
        cap_opt(&mut entry.stream, MAX_FIELD_BYTES);
        cap_opt(&mut entry.timestamp, MAX_FIELD_BYTES);
        cap_opt(&mut entry.level, MAX_FIELD_BYTES);
        if cap(&mut entry.message, crate::logs::MAX_LINE_BYTES) {
            entry.truncated = Some(true);
        }
    }
}

/// Text bytes an event retains (for the bound's test).
#[cfg(test)]
fn event_bytes(e: &LogEvent) -> usize {
    let o = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    e.kind.len()
        + o(&e.ts)
        + o(&e.backend)
        + o(&e.reason)
        + o(&e.message)
        + e.entry.as_ref().map_or(0, |x| {
            x.message.len() + o(&x.service) + o(&x.stream) + o(&x.timestamp) + o(&x.level)
        })
}

/// Longest raw ndjson line read; the rest of a longer line is skipped.
pub const MAX_RAW_LINE: usize = 1024 * 1024;

/// Read one `\n`-terminated line, keeping at most `max` bytes of it.
/// `None` at end of input (or on a read error).
fn read_bounded_line<R: BufRead>(r: &mut R, max: usize) -> Option<(String, bool)> {
    let mut buf = Vec::new();
    let mut saw_any = false;
    let mut cut = false;
    loop {
        let chunk = r.fill_buf().ok()?;
        if chunk.is_empty() {
            return saw_any.then(|| (String::from_utf8_lossy(&buf).into_owned(), cut));
        }
        saw_any = true;
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        let room = max.saturating_sub(buf.len());
        cut |= take > room;
        buf.extend_from_slice(&chunk[..take.min(room)]);
        r.consume(if done { take + 1 } else { take });
        if done {
            return Some((String::from_utf8_lossy(&buf).into_owned(), cut));
        }
    }
}

/// Shown in place of a record longer than `MAX_RAW_LINE`.
fn oversized_record_event() -> LogEvent {
    LogEvent {
        kind: "log".into(),
        entry: Some(crate::models::LogEntry {
            service: None,
            message: format!(
                "[a log record over {} KB was dropped by the app; use Copy command to read it in a terminal]",
                MAX_RAW_LINE / 1024
            ),
            stream: None,
            timestamp: None,
            level: Some("warn".into()),
            truncated: Some(true),
        }),
        ..LogEvent::default()
    }
}

/// One poll of a stream: up to `max` events, and the exit code once the
/// process has exited **and** every line it wrote has been delivered.
#[derive(Debug, Default)]
pub struct StreamPoll {
    pub events: Vec<LogEvent>,
    pub exit: Option<Option<i32>>,
}

/// A running log stream. Dropping it kills the process group.
pub struct LogStream {
    child: Child,
    /// `None` only while dropping (see `Drop`).
    rx: Option<mpsc::Receiver<LogEvent>>,
    reader: Option<thread::JoinHandle<()>>,
}

impl LogStream {
    /// Events received so far, without blocking.
    pub fn drain(&self) -> Vec<LogEvent> {
        self.rx
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default()
    }

    /// Wait up to `timeout` for the next event.
    pub fn next_timeout(&self, timeout: Duration) -> Option<LogEvent> {
        self.rx.as_ref()?.recv_timeout(timeout).ok()
    }

    /// Up to `max` queued events. `exit` is set only when the reader has
    /// reached end of output and the queue is empty, so no trailing line is
    /// lost; its inner value is `None` when a signal ended the process.
    pub fn poll(&mut self, max: usize) -> StreamPoll {
        // Checked before draining: once the reader is done, nothing new
        // arrives, so an under-full batch means the queue is exhausted.
        let reader_done = self
            .reader
            .as_ref()
            .is_none_or(thread::JoinHandle::is_finished);
        let events: Vec<LogEvent> = self
            .rx
            .as_ref()
            .map(|rx| rx.try_iter().take(max).collect())
            .unwrap_or_default();
        let exit = if reader_done && events.len() < max {
            self.child.try_wait().ok().flatten().map(|s| s.code())
        } else {
            None
        };
        StreamPoll { events, exit }
    }
}

impl Drop for LogStream {
    fn drop(&mut self) {
        // Disconnect first: a reader blocked on a full queue then gets a
        // send error and exits, so the join below cannot hang.
        drop(self.rx.take());
        kill_group(&mut self.child);
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
    }
}

/// Read a pipe to EOF on a thread; the result arrives on the channel.
fn read_all<R: Read + Send + 'static>(r: Option<R>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
}

/// Used when no absolute `PATH` entry remains: an empty `PATH` would make
/// a shell search its working directory.
pub const FALLBACK_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// `PATH` with empty and relative entries removed; never empty.
#[must_use]
pub fn sanitize_path(path: &std::ffi::OsStr) -> std::ffi::OsString {
    let kept = std::env::join_paths(std::env::split_paths(path).filter(|d| d.is_absolute()))
        .unwrap_or_default();
    if kept.is_empty() {
        std::ffi::OsString::from(FALLBACK_PATH)
    } else {
        kept
    }
}

/// Search absolute `PATH` entries for an executable regular file `name`.
#[must_use]
pub fn resolve_on_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    if name.contains('/') {
        let p = PathBuf::from(name);
        return p.is_absolute().then_some(p);
    }
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| {
            std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Ask the process group to stop (SIGTERM), give the CLI `grace` to retire
/// the subprocesses it owns, then SIGKILL whatever is left of the group and
/// reap. Returns only once the direct child has exited.
fn terminate_group(child: &mut Child, grace: Duration) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: plain syscall on the group we created with process_group(0).
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
    }
    let until = Instant::now() + grace;
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    kill_group(child);
}

fn kill_group(child: &mut Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: plain syscall on the group we created with process_group(0).
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn head(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Unwrap the CLI result envelope, or return a raw object as is.
///
/// # Errors
/// `Cli` for an error envelope, `Exit` for a non-zero exit with no JSON,
/// `BadJson` for unparsable stdout.
pub fn parse_result(stdout: &str, stderr: &str, code: Option<i32>) -> Result<Value, RunError> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(RunError::Exit {
            code,
            stderr: stderr.to_owned(),
        });
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) if code == Some(0) => {
            return Err(RunError::BadJson {
                error: e.to_string(),
                stdout_head: head(stdout),
            });
        }
        Err(_) => {
            return Err(RunError::Exit {
                code,
                stderr: stderr.to_owned(),
            });
        }
    };
    match value.get("ok").and_then(Value::as_bool) {
        Some(false) => {
            let err = value
                .get("error")
                .cloned()
                .and_then(|e| match e {
                    Value::String(message) => Some(CliError {
                        code: "E_UNEXPECTED".into(),
                        message,
                        detail: None,
                    }),
                    other => serde_json::from_value::<CliError>(other).ok(),
                })
                .unwrap_or_else(|| CliError {
                    code: "E_UNEXPECTED".into(),
                    message: head(stdout),
                    detail: None,
                });
            Err(RunError::Cli(err))
        }
        Some(true) if value.get("data").is_some() => Ok(value["data"].clone()),
        // Raw objects. Some commands (doctor, env list) exit 1 on findings
        // but still print a full report, which the app wants.
        _ => Ok(value),
    }
}

/// `hack v5.0.0` / `5.0.0-next.3` → the version string.
#[must_use]
pub fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.'))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `hack` in a fresh temp dir: a shell script with a fixed body.
    struct FakeHack {
        dir: PathBuf,
    }

    impl FakeHack {
        fn new(body: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hack-desktop-runner-{}-{}",
                std::process::id(),
                rand_suffix()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.join("hack");
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            Self { dir }
        }
        fn runner(&self) -> CliRunner {
            CliRunner::new(self.dir.join("hack")).with_env("HACK_HOME", &self.dir.to_string_lossy())
        }
    }

    impl Drop for FakeHack {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    const T: Duration = Duration::from_secs(5);

    #[test]
    fn unwraps_envelope() {
        let f = FakeHack::new(
            r#"echo '{"ok":true,"data":{"action":"up","project":"p","services":{"failed":["api"]}}}'"#,
        );
        let r: crate::models::LifecycleResult =
            f.runner().run_json(&["up", "--json"], None, T).unwrap();
        assert_eq!(r.services.failed, vec!["api"]);
    }

    #[test]
    fn error_envelope_becomes_cli_error() {
        let f = FakeHack::new(
            r#"echo '{"ok":false,"error":{"code":"E_DOCKER_UNAVAILABLE","message":"down"}}'; exit 1"#,
        );
        let r = f.runner().run_json::<Value>(&["up"], None, T);
        assert_eq!(
            r,
            Err(RunError::Cli(CliError {
                code: "E_DOCKER_UNAVAILABLE".into(),
                message: "down".into(),
                detail: None,
            }))
        );
    }

    #[test]
    fn raw_object_with_nonzero_exit_is_kept() {
        let f = FakeHack::new(r#"echo '{"checks":[{"id":"x","status":"error"}]}'; exit 1"#);
        let r: crate::models::DoctorReport = f.runner().run_json(&["doctor"], None, T).unwrap();
        assert_eq!(r.attention_count(), 1);
    }

    #[test]
    fn passes_path_and_no_interactive() {
        let f = FakeHack::new(r#"printf '{"args":"%s","ni":"%s"}' "$*" "$HACK_NO_INTERACTIVE""#);
        let v: Value = f
            .runner()
            .run_json(&["ps", "--json"], Some(Path::new("/work/p")), T)
            .unwrap();
        assert_eq!(v["args"], "ps --json --path /work/p");
        assert_eq!(v["ni"], "1");
    }

    #[test]
    fn timeout_kills_the_process_group() {
        // The child spawns a grandchild that would outlive a plain kill.
        let f = FakeHack::new("sleep 30 & echo $! > \"$HACK_HOME/grandchild\"; wait");
        let started = Instant::now();
        let r = f
            .runner()
            .run_json::<Value>(&["up"], None, Duration::from_millis(300));
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = std::fs::read_to_string(f.dir.join("grandchild"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Give the kernel a moment to deliver SIGKILL and reparent/reap.
        let gone = (0..100).any(|_| {
            thread::sleep(Duration::from_millis(20));
            // SAFETY: signal 0 only checks existence.
            (unsafe { libc::kill(pid, 0) != 0 })
                || std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map(|s| s.contains(") Z "))
                    .unwrap_or(true)
        });
        assert!(gone, "grandchild {pid} survived the timeout");
    }

    #[test]
    fn timeout_covers_a_descendant_holding_the_pipe() {
        // `hack` exits at once, but a background child keeps stdout open.
        let f = FakeHack::new("sleep 30 &\necho '{}'");
        let started = Instant::now();
        let r = f
            .runner()
            .run_json::<Value>(&["x"], None, Duration::from_millis(300));
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn log_stream_reports_exit_only_after_every_line() {
        // Many lines, then exit 3: the exit must not be reported while lines
        // are still queued or unread, even with a small batch size.
        let f = FakeHack::new(
            "i=0; while [ $i -lt 300 ]; do echo \"{\\\"type\\\":\\\"log\\\",\\\"entry\\\":{\\\"message\\\":\\\"l$i\\\"}}\"; i=$((i+1)); done; echo '{\"type\":\"end\",\"reason\":\"eof\"}'; exit 3",
        );
        let mut s = f.runner().stream_logs(&["logs"], None).unwrap();
        let mut got = 0;
        let mut exit = None;
        for _ in 0..500 {
            let p = s.poll(7);
            got += p.events.len();
            if let Some(code) = p.exit {
                exit = Some(code);
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(got, 301, "every line and the end event delivered first");
        assert_eq!(exit, Some(Some(3)));
    }

    #[test]
    fn dropping_a_stream_with_a_full_queue_does_not_hang() {
        // Far more lines than STREAM_QUEUE, never polled: the reader blocks
        // on the full queue. Drop must still return promptly.
        let f = FakeHack::new(
            "i=0; while [ $i -lt 20000 ]; do echo '{\"type\":\"heartbeat\"}'; i=$((i+1)); done; sleep 30",
        );
        let s = f.runner().stream_logs(&["logs"], None).unwrap();
        thread::sleep(Duration::from_millis(500));
        let t = Instant::now();
        drop(s);
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "drop hung for {:?}",
            t.elapsed()
        );
    }

    #[test]
    fn oversized_records_leave_a_visible_marker() {
        let f = FakeHack::new(&format!(
            "printf '{{\"type\":\"log\",\"entry\":{{\"message\":\"'; head -c {} /dev/zero | tr '\\0' x; printf '\"}}}}\\n'; echo '{{\"type\":\"log\",\"entry\":{{\"message\":\"after\"}}}}'",
            MAX_RAW_LINE + 1000
        ));
        let s = f.runner().stream_logs(&["logs"], None).unwrap();
        let a = s.next_timeout(T).expect("marker");
        let b = s.next_timeout(T).expect("next event");
        let marker = a.entry.unwrap();
        assert_eq!(marker.truncated, Some(true));
        assert!(marker.message.contains("dropped by the app"));
        assert_eq!(b.entry.unwrap().message, "after");
    }

    #[test]
    fn queued_events_are_capped_before_send() {
        let big = "x".repeat(crate::logs::MAX_LINE_BYTES * 3);
        let mut e = LogEvent {
            kind: big.clone(),
            ts: Some(big.clone()),
            backend: Some(big.clone()),
            reason: Some(big.clone()),
            message: Some(big.clone()),
            entry: Some(crate::models::LogEntry {
                service: Some(big.clone()),
                message: big.clone(),
                stream: Some(big.clone()),
                timestamp: Some(big.clone()),
                level: Some(big),
                truncated: None,
            }),
        };
        cap_event(&mut e);
        assert!(event_bytes(&e) <= MAX_EVENT_BYTES, "{}", event_bytes(&e));
        let entry = e.entry.as_ref().unwrap();
        assert_eq!(entry.message.len(), crate::logs::MAX_LINE_BYTES);
        assert!(entry.message.capacity() < crate::logs::MAX_LINE_BYTES + 1024);
        assert_eq!(entry.truncated, Some(true));
        assert_eq!(e.message.as_ref().unwrap().len(), MAX_NOTICE_BYTES);
        assert_eq!(entry.timestamp.as_ref().unwrap().len(), MAX_FIELD_BYTES);
        assert_eq!(e.reason.as_ref().unwrap().len(), MAX_FIELD_BYTES);
        const { assert!(MAX_QUEUED_BYTES < 80 * 1024 * 1024) };
    }

    #[test]
    fn bounded_line_reader_skips_the_tail_of_huge_lines() {
        let data = format!("{}\nnext\n", "x".repeat(50));
        let mut r = std::io::BufReader::with_capacity(8, data.as_bytes());
        assert_eq!(
            read_bounded_line(&mut r, 10).unwrap(),
            ("x".repeat(10), true)
        );
        assert_eq!(
            read_bounded_line(&mut r, 10).unwrap(),
            ("next".into(), false)
        );
        assert!(read_bounded_line(&mut r, 10).is_none());
    }

    #[test]
    fn path_lookup_ignores_relative_entries() {
        let f = FakeHack::new("echo '{}'");
        let dir = f.dir.to_string_lossy().into_owned();
        let rel = std::ffi::OsString::from(format!(".:{dir}"));
        assert_eq!(
            resolve_on_path("hack", Some(&rel)),
            Some(f.dir.join("hack"))
        );
        let only_rel = std::ffi::OsString::from(".:relative/bin:");
        assert_eq!(resolve_on_path("hack", Some(&only_rel)), None);
        assert_eq!(resolve_on_path("hack", None), None);
        assert_eq!(
            resolve_on_path("./hack", Some(&rel)),
            None,
            "relative names refused"
        );
    }

    #[test]
    fn child_path_drops_empty_and_relative_entries() {
        let p = std::ffi::OsString::from(".::bin:/usr/bin:./x:/bin");
        assert_eq!(sanitize_path(&p), std::ffi::OsString::from("/usr/bin:/bin"));
        // All relative or empty: a non-empty trusted fallback, never "".
        for bad in [".::relative/bin:", "", ":", "."] {
            assert_eq!(
                sanitize_path(std::ffi::OsStr::new(bad)),
                std::ffi::OsString::from(FALLBACK_PATH),
                "{bad:?}"
            );
        }
        // And the child really receives an all-absolute PATH.
        let f = FakeHack::new(r#"printf '{"p":"%s"}' "$PATH""#);
        let v: Value = f.runner().run_json(&["x"], None, T).unwrap();
        let got = v["p"].as_str().unwrap();
        assert!(
            got.split(':').all(|e| e.starts_with('/')),
            "child PATH {got:?}"
        );
    }

    #[test]
    fn a_runner_that_found_nothing_never_spawns() {
        let mut r = CliRunner::new("hack");
        r.missing = true;
        assert_eq!(
            r.run_json::<Value>(&["x"], None, T),
            Err(RunError::NotFound)
        );
    }

    #[test]
    fn timeout_sends_sigterm_first_so_the_cli_can_retire_its_children() {
        let f = FakeHack::new(
            r#"trap 'echo term > "$HACK_HOME/got"; exit 0' TERM
while :; do sleep 0.05; done"#,
        );
        let started = Instant::now();
        let r = f
            .runner()
            .with_term_grace(Duration::from_secs(3))
            .run_json::<Value>(&["up"], None, Duration::from_millis(300));
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(f.dir.join("got").exists(), "SIGTERM reached the CLI");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "exited on TERM, no full grace"
        );
    }

    #[test]
    fn a_cli_ignoring_sigterm_is_killed_after_the_grace() {
        let f = FakeHack::new("trap '' TERM\nwhile :; do sleep 0.05; done");
        let started = Instant::now();
        let r = f
            .runner()
            .with_term_grace(Duration::from_millis(300))
            .run_json::<Value>(&["up"], None, Duration::from_millis(200));
        assert!(matches!(r, Err(RunError::Timeout { .. })), "{r:?}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn run_to_completion_waits_past_any_short_deadline() {
        // Takes longer than a short timeout would allow, and still succeeds.
        let f = FakeHack::new("sleep 1; echo '{\"ok\":true,\"data\":{\"action\":\"up\"}}'");
        let started = Instant::now();
        let r: Value = f.runner().run_json_to_completion(&["up"], None).unwrap();
        assert_eq!(r["action"], "up");
        assert!(started.elapsed() >= Duration::from_millis(900));
    }

    #[test]
    fn missing_binary_is_not_found() {
        let r = CliRunner::new("/nonexistent/hack").run_json::<Value>(&["x"], None, T);
        assert_eq!(r, Err(RunError::NotFound));
    }

    #[test]
    fn bad_json_is_reported() {
        let f = FakeHack::new("echo 'not json'");
        assert!(matches!(
            f.runner().run_json::<Value>(&["x"], None, T),
            Err(RunError::BadJson { .. })
        ));
    }

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("hack v4.3.0\n").as_deref(), Some("4.3.0"));
        assert_eq!(
            parse_version("5.0.0-next.3").as_deref(),
            Some("5.0.0-next.3")
        );
        assert_eq!(parse_version("hack"), None);
        let f = FakeHack::new("echo 'hack v5.0.0'");
        assert_eq!(f.runner().version(T).unwrap(), "5.0.0");
    }

    #[test]
    fn log_stream_parses_ndjson_and_stops_on_drop() {
        let f = FakeHack::new(
            r#"echo '{"type":"start","backend":"compose"}'
echo '{"type":"log","entry":{"service":"api","message":"hi"}}'
echo 'plain text'
sleep 30"#,
        );
        let mut s = f.runner().stream_logs(&["logs", "--json"], None).unwrap();
        let mut got = Vec::new();
        while got.len() < 3 {
            got.push(s.next_timeout(T).expect("event"));
        }
        assert_eq!(got[0].kind, "start");
        assert_eq!(got[1].entry.as_ref().unwrap().message, "hi");
        assert_eq!(got[2].message.as_deref(), Some("plain text"));
        assert!(s.poll(10).exit.is_none(), "still running");
        let t = Instant::now();
        drop(s);
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
