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
}

impl CliRunner {
    /// Run `program` (normally `hack`, resolved through PATH).
    #[must_use]
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            env: vec![("HACK_NO_INTERACTIVE".into(), "1".into())],
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
        let mut child = self.spawn(args, path)?;
        let out = read_all(child.stdout.take());
        let err = read_all(child.stderr.take());
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if Instant::now() >= deadline => {
                    kill_group(&mut child);
                    return Err(RunError::Timeout { after: timeout });
                }
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(e) => return Err(RunError::Spawn(e.to_string())),
            }
        };
        // The deadline also covers draining: a descendant that keeps a pipe
        // open after `hack` exits must not hold the caller past the timeout.
        let drain = |rx: &mpsc::Receiver<String>, child: &mut Child| {
            let left = deadline.saturating_duration_since(Instant::now());
            rx.recv_timeout(left).map_err(|_| {
                kill_group(child);
                RunError::Timeout { after: timeout }
            })
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
            while let Some(line) = read_bounded_line(&mut r, MAX_RAW_LINE) {
                if line.trim().is_empty() {
                    continue;
                }
                let event = serde_json::from_str::<LogEvent>(&line).unwrap_or_else(|_| LogEvent {
                    kind: "notice".into(),
                    message: Some(line),
                    ..LogEvent::default()
                });
                if tx.send(event).is_err() {
                    break;
                }
            }
        });
        Ok(LogStream {
            child,
            rx,
            reader: Some(reader),
        })
    }
}

/// Events queued between the reader thread and the UI.
pub const STREAM_QUEUE: usize = 4096;
/// Longest raw ndjson line read; the rest of a longer line is skipped.
pub const MAX_RAW_LINE: usize = 1024 * 1024;

/// Read one `\n`-terminated line, keeping at most `max` bytes of it.
/// `None` at end of input (or on a read error).
fn read_bounded_line<R: BufRead>(r: &mut R, max: usize) -> Option<String> {
    let mut buf = Vec::new();
    let mut saw_any = false;
    loop {
        let chunk = r.fill_buf().ok()?;
        if chunk.is_empty() {
            return saw_any.then(|| String::from_utf8_lossy(&buf).into_owned());
        }
        saw_any = true;
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        let room = max.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..take.min(room)]);
        r.consume(if done { take + 1 } else { take });
        if done {
            return Some(String::from_utf8_lossy(&buf).into_owned());
        }
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
    rx: mpsc::Receiver<LogEvent>,
    reader: Option<thread::JoinHandle<()>>,
}

impl LogStream {
    /// Events received so far, without blocking.
    pub fn drain(&self) -> Vec<LogEvent> {
        self.rx.try_iter().collect()
    }

    /// Wait up to `timeout` for the next event.
    pub fn next_timeout(&self, timeout: Duration) -> Option<LogEvent> {
        self.rx.recv_timeout(timeout).ok()
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
        let events: Vec<LogEvent> = self.rx.try_iter().take(max).collect();
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
    fn bounded_line_reader_skips_the_tail_of_huge_lines() {
        let data = format!("{}\nnext\n", "x".repeat(50));
        let mut r = std::io::BufReader::with_capacity(8, data.as_bytes());
        assert_eq!(read_bounded_line(&mut r, 10).unwrap(), "x".repeat(10));
        assert_eq!(read_bounded_line(&mut r, 10).unwrap(), "next");
        assert!(read_bounded_line(&mut r, 10).is_none());
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
