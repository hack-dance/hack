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
    },
}

impl From<RunError> for SourceError {
    fn from(e: RunError) -> Self {
        match e {
            RunError::NotFound => Self::CliMissing,
            RunError::Cli(c) => Self::Cli {
                code: c.code,
                message: c.message,
            },
            other => Self::Cli {
                code: "E_APP_RUN".into(),
                message: other.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActionOutcome {
    Lifecycle(LifecycleResult),
    Opened(OpenResult),
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
    fn log_tail(&self, repo_root: &Path, native: bool, lines: u32) -> Vec<LogEntry>;
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
                self.runner
                    .run_json(&["projects", "--json", "--no-daemon"], None, Self::READ)?
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

    fn log_tail(&self, repo_root: &Path, native: bool, lines: u32) -> Vec<LogEntry> {
        let tail = lines.to_string();
        // No --compose / --services: native rejects them (DESIGN.md, Logs).
        let Ok((out, _, _)) = self.runner_for(native).run_raw(
            &["logs", "--json", "--no-follow", "--tail", &tail],
            Some(repo_root),
            Self::READ,
        ) else {
            return vec![];
        };
        out.lines()
            .filter_map(|l| serde_json::from_str::<crate::models::LogEvent>(l).ok())
            .filter_map(|e| e.entry)
            .collect()
    }
}

/// Canned data for one designed state.
pub struct FixtureSource(pub Fixture);

impl Source for FixtureSource {
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

    fn log_tail(&self, _repo_root: &Path, _native: bool, _lines: u32) -> Vec<LogEntry> {
        fixtures::log_tail(self.0)
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
