//! Where the app's data comes from: the live CLI and daemon, or fixtures.

use std::path::Path;
use std::time::Duration;

use crate::daemon::DaemonClient;
use crate::fixtures::{self, Fixture};
use crate::models::{
    DaemonApiStatus, DoctorReport, LifecycleResult, LogEntry, OpenResult, ProjectsPayload,
};
use crate::runner::{CliRunner, RunError};
use crate::state::Action;

/// Everything the list and detail panes need for one refresh.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub cli_version: String,
    pub projects: ProjectsPayload,
    /// `None` when hackd is not reachable.
    pub daemon: Option<DaemonApiStatus>,
    /// `None` when doctor was not run in this refresh.
    pub doctor: Option<DoctorReport>,
}

impl Snapshot {
    /// hackd runs, but at another version than the CLI.
    #[must_use]
    pub fn daemon_mismatch(&self) -> Option<&str> {
        self.daemon
            .as_ref()
            .filter(|d| d.version != self.cli_version)
            .map(|d| d.version.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    /// No answer yet (fixtures use it for the loading state).
    Pending,
    CliMissing,
    Cli {
        code: String,
        message: String,
        /// Services the CLI reported as failed to start (`detail.failed`).
        failed: Vec<String>,
    },
}

impl From<RunError> for SourceError {
    fn from(e: RunError) -> Self {
        match e {
            RunError::NotFound => Self::CliMissing,
            RunError::Cli(c) => Self::Cli {
                failed: c.failed_services(),
                code: c.code,
                message: c.message,
            },
            other => Self::Cli {
                code: "E_APP_RUN".into(),
                message: other.to_string(),
                failed: vec![],
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActionOutcome {
    Lifecycle(LifecycleResult),
    Opened(OpenResult),
}

/// Native finite logs are a single-service snapshot (not ndjson), so the
/// combined tail is not available for native projects in v0.
pub const NATIVE_LOGS_NOTE: &str = "Native logs are read one service at a time and are not shown in this preview yet. In a terminal: HACK_RUNTIME_BACKEND=native hack logs <service> --no-follow --tail 200";

/// A running log stream: live `hack logs --json`, or canned events.
pub trait LogFeed: Send {
    /// Up to `max` events without blocking, and the exit once every event
    /// has been delivered (see [`crate::runner::LogStream::poll`]).
    fn poll(&mut self, max: usize) -> crate::runner::StreamPoll;
}

impl LogFeed for crate::runner::LogStream {
    fn poll(&mut self, max: usize) -> crate::runner::StreamPoll {
        crate::runner::LogStream::poll(self, max)
    }
}

/// Canned events delivered in batches; then it keeps "following" silently.
pub struct FixtureFeed(pub Vec<crate::models::LogEvent>);

impl LogFeed for FixtureFeed {
    fn poll(&mut self, max: usize) -> crate::runner::StreamPoll {
        let n = max.min(self.0.len());
        crate::runner::StreamPoll {
            events: self.0.drain(..n).collect(),
            exit: None,
        }
    }
}

pub trait Source: Send + Sync {
    /// # Errors
    /// A [`SourceError`] when no usable snapshot could be read.
    fn snapshot(&self) -> Result<Snapshot, SourceError>;

    /// Run one action for a project root. `native` selects the native
    /// backend (`HACK_RUNTIME_BACKEND=native`), which every native command needs.
    ///
    /// # Errors
    /// A [`SourceError`] from the CLI.
    fn act(
        &self,
        repo_root: &Path,
        native: bool,
        action: Action,
    ) -> Result<ActionOutcome, SourceError>;

    /// Last log lines for a project (no follow).
    ///
    /// # Errors
    /// Why no tail could be read; shown in place of the tail.
    fn log_tail(&self, repo_root: &Path, native: bool, lines: u32)
    -> Result<Vec<LogEntry>, String>;

    /// Start a log stream for the Logs tab (`args` from `LogsModel::cli_args`).
    /// Dropping the feed stops the stream.
    ///
    /// # Errors
    /// Why no stream can be opened (native projects in v0, spawn failure).
    fn open_logs(
        &self,
        repo_root: &Path,
        native: bool,
        args: &[String],
    ) -> Result<Box<dyn LogFeed>, String>;
}

/// Live data: hackd when its version matches the CLI, else the CLI.
pub struct LiveSource {
    pub runner: CliRunner,
    pub daemon: Option<DaemonClient>,
}

impl LiveSource {
    fn runner_for(&self, native: bool) -> CliRunner {
        if native {
            self.runner
                .clone()
                .with_env("HACK_RUNTIME_BACKEND", "native")
        } else {
            self.runner.clone()
        }
    }

    const READ: Duration = Duration::from_secs(15);
    const UP: Duration = Duration::from_secs(600);
    const OTHER: Duration = Duration::from_secs(120);
}

impl Source for LiveSource {
    fn open_logs(
        &self,
        repo_root: &Path,
        native: bool,
        args: &[String],
    ) -> Result<Box<dyn LogFeed>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.runner
            .stream_logs(&args, Some(repo_root))
            .map(|s| Box::new(s) as Box<dyn LogFeed>)
            .map_err(|e| e.to_string())
    }

    fn snapshot(&self) -> Result<Snapshot, SourceError> {
        let cli_version = self.runner.version(Duration::from_secs(5))?;
        let daemon = self.daemon.as_ref().and_then(|d| d.status().ok());
        let from_daemon = daemon
            .as_ref()
            .filter(|d| d.version == cli_version)
            .and(self.daemon.as_ref())
            .and_then(|d| d.projects().ok());
        let mut projects: ProjectsPayload = match from_daemon {
            Some(p) => p,
            None => {
                let v: serde_json::Value = self.runner.run_json(
                    &["projects", "--json", "--no-daemon"],
                    None,
                    Self::READ,
                )?;
                ProjectsPayload::from_value(v).map_err(|message| SourceError::Cli {
                    code: "E_APP_BAD_OUTPUT".into(),
                    message,
                    failed: vec![],
                })?
            }
        };
        // Project views do not read native projects; ask native ps for each.
        let native = self.runner_for(true);
        for row in projects.projects.iter_mut().filter(|r| r.is_native()) {
            if let Some(root) = row.repo_root.clone() {
                row.native = native
                    .run_json(&["ps", "--json"], Some(Path::new(&root)), Self::READ)
                    .ok();
            }
        }
        Ok(Snapshot {
            cli_version,
            projects,
            daemon,
            doctor: None,
        })
    }

    fn act(
        &self,
        repo_root: &Path,
        native: bool,
        action: Action,
    ) -> Result<ActionOutcome, SourceError> {
        let timeout = if action == Action::Start {
            Self::UP
        } else {
            Self::OTHER
        };
        let args = action.cli_args();
        let runner = self.runner_for(native);
        Ok(match action {
            Action::Open => {
                ActionOutcome::Opened(runner.run_json(args, Some(repo_root), timeout)?)
            }
            _ => ActionOutcome::Lifecycle(runner.run_json(args, Some(repo_root), timeout)?),
        })
    }

    fn log_tail(
        &self,
        repo_root: &Path,
        native: bool,
        lines: u32,
    ) -> Result<Vec<LogEntry>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        let tail = lines.to_string();
        // No --compose / --services: they are backend-specific (DESIGN.md, Logs).
        let (out, err, code) = self
            .runner
            .run_raw(
                &["logs", "--json", "--no-follow", "--tail", &tail],
                Some(repo_root),
                Self::READ,
            )
            .map_err(|e| e.to_string())?;
        parse_log_tail(&out, &err, code)
    }
}

/// Parse a finite `hack logs --json` run. Any non-zero exit, `error` event or
/// unsuccessful `end` reason (for example `exit:1`) is a failed read, even
/// when some entries arrived: a partial tail is never shown as complete.
///
/// # Errors
/// The reason the read failed.
pub fn parse_log_tail(out: &str, err: &str, code: Option<i32>) -> Result<Vec<LogEntry>, String> {
    let events: Vec<crate::models::LogEvent> = out
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if let Some(e) = events.iter().find(|e| e.kind == "error") {
        return Err(e
            .message
            .clone()
            .unwrap_or_else(|| "log read failed".into()));
    }
    let bad_end = events.iter().find(|e| {
        e.kind == "end"
            && e.reason
                .as_deref()
                .is_some_and(|r| r == "error" || (r.starts_with("exit:") && r != "exit:0"))
    });
    if let Some(e) = bad_end {
        return Err(format!(
            "log read ended with {}",
            e.reason.as_deref().unwrap_or("an error")
        ));
    }
    if code != Some(0) {
        return Err(format!("hack logs exited with {code:?}: {}", err.trim()));
    }
    Ok(events.into_iter().filter_map(|e| e.entry).collect())
}

/// Canned data for one designed state.
pub struct FixtureSource(pub Fixture);

impl Source for FixtureSource {
    fn open_logs(
        &self,
        _repo_root: &Path,
        native: bool,
        args: &[String],
    ) -> Result<Box<dyn LogFeed>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        // Replay the "following" fixture, filtered to the chosen service.
        // The service filter is the trailing positional, if any.
        let service = args
            .last()
            .filter(|a| !a.starts_with("--") && a.parse::<u32>().is_err() && a.as_str() != "logs");
        let events = crate::logs::fixtures::events()
            .into_iter()
            .filter(|e| {
                service.is_none()
                    || e.entry
                        .as_ref()
                        .is_none_or(|x| x.service.as_ref() == service)
            })
            .collect();
        Ok(Box::new(FixtureFeed(events)))
    }

    fn snapshot(&self) -> Result<Snapshot, SourceError> {
        fixtures::snapshot(self.0)
    }

    fn act(
        &self,
        _repo_root: &Path,
        _native: bool,
        action: Action,
    ) -> Result<ActionOutcome, SourceError> {
        Ok(match action {
            Action::Open => ActionOutcome::Opened(OpenResult {
                url: "https://storefront.hack".into(),
                hint: None,
            }),
            _ => ActionOutcome::Lifecycle(LifecycleResult::default()),
        })
    }

    fn log_tail(
        &self,
        _repo_root: &Path,
        native: bool,
        _lines: u32,
    ) -> Result<Vec<LogEntry>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        Ok(fixtures::log_tail(self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live source against a fake `hack` (no daemon socket): the CLI
    /// fallback is used, and native rows are read with the native backend.
    #[test]
    fn live_source_reads_native_rows_with_native_backend() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-source-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        std::fs::write(
            &hack,
            r#"#!/bin/sh
case "$1" in
  --version) echo "hack v5.0.0" ;;
  projects) echo '{"runtime_ok":true,"projects":[{"name":"svc","status":"running","repo_root":"/work/svc"},{"name":"nat","status":"unavailable","repo_root":"/work/nat","input_diagnostic":{"code":"E_NATIVE_PROJECT_UNSUPPORTED","message":"m"}}]}' ;;
  ps) if [ "$HACK_RUNTIME_BACKEND" = native ]; then echo '{"ok":true,"data":{"backend":"native","status":"pending","items":[]}}'; else echo '{"ok":false,"error":{"code":"E_NATIVE_PROJECT_UNSUPPORTED","message":"m"}}'; exit 1; fi ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = LiveSource {
            runner: CliRunner::new(&hack).with_env("HACK_HOME", &dir.to_string_lossy()),
            daemon: Some(DaemonClient::new(
                dir.join("none.sock"),
                Duration::from_millis(100),
            )),
        };
        let snap = src.snapshot().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(snap.daemon.is_none());
        let nat = snap
            .projects
            .projects
            .iter()
            .find(|p| p.name == "nat")
            .unwrap();
        assert_eq!(nat.native.as_ref().unwrap().status, "pending");
        assert_eq!(
            crate::state::derive(nat, &crate::state::LocalContext::default()),
            crate::state::ProjectState::Starting
        );
        let svc = snap
            .projects
            .projects
            .iter()
            .find(|p| p.name == "svc")
            .unwrap();
        assert!(svc.native.is_none());
    }

    #[test]
    fn live_source_rejects_a_payload_without_projects() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-source-empty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        std::fs::write(
            &hack,
            "#!/bin/sh\ncase \"$1\" in --version) echo 'hack v5.0.0' ;; projects) echo '{}' ;; esac\n",
        )
        .unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = LiveSource {
            runner: CliRunner::new(&hack),
            daemon: None,
        };
        let r = src.snapshot();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            matches!(&r, Err(SourceError::Cli { code, .. }) if code == "E_APP_BAD_OUTPUT"),
            "{r:?}"
        );
    }

    #[test]
    fn failed_log_reads_are_failures_even_with_entries() {
        let entry = r#"{"type":"log","entry":{"service":"api","message":"hi"}}"#;
        let ok =
            format!("{{\"type\":\"start\"}}\n{entry}\n{{\"type\":\"end\",\"reason\":\"eof\"}}\n");
        assert_eq!(parse_log_tail(&ok, "", Some(0)).unwrap().len(), 1);
        let bad_end = format!(
            "{{\"type\":\"start\"}}\n{entry}\n{{\"type\":\"end\",\"reason\":\"exit:1\"}}\n"
        );
        assert!(parse_log_tail(&bad_end, "", Some(0)).is_err());
        assert!(parse_log_tail(&ok, "boom", Some(1)).is_err());
        let err_ev = "{\"type\":\"error\",\"message\":\"no engine\"}\n";
        assert_eq!(
            parse_log_tail(err_ev, "", Some(0)).unwrap_err(),
            "no engine"
        );
    }

    #[test]
    fn fixture_logs_honour_the_service_filter_and_native_note() {
        let src = FixtureSource(Fixture::Running);
        let args: Vec<String> = ["logs", "--json", "--tail", "500", "worker"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut feed = src.open_logs(Path::new("/work/x"), false, &args).unwrap();
        let events = feed.poll(1000).events;
        assert!(
            events
                .iter()
                .filter_map(|e| e.entry.as_ref())
                .all(|e| e.service.as_deref() == Some("worker"))
        );
        assert!(feed.poll(1000).events.is_empty(), "delivered once");
        assert!(src.open_logs(Path::new("/work/x"), true, &args).is_err());
    }

    #[test]
    fn mismatch_detection() {
        let s = fixtures::snapshot(Fixture::DaemonMismatch).unwrap();
        assert_eq!(s.daemon_mismatch(), Some("4.3.0"));
        let s = fixtures::snapshot(Fixture::Running).unwrap();
        assert_eq!(s.daemon_mismatch(), None);
    }

    #[test]
    fn run_errors_map_to_source_errors() {
        assert_eq!(
            SourceError::from(RunError::NotFound),
            SourceError::CliMissing
        );
        assert!(matches!(
            SourceError::from(RunError::Timeout {
                after: Duration::from_secs(1)
            }),
            SourceError::Cli { .. }
        ));
    }
}
