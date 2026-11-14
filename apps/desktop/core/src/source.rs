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

    /// Run one action for a project root.
    ///
    /// # Errors
    /// A [`SourceError`] from the CLI.
    fn act(&self, repo_root: &Path, action: Action) -> Result<ActionOutcome, SourceError>;

    /// Last log lines for a project (no follow).
    fn log_tail(&self, repo_root: &Path, lines: u32) -> Vec<LogEntry>;
}

/// Live data: hackd when its version matches the CLI, else the CLI.
pub struct LiveSource {
    pub runner: CliRunner,
    pub daemon: Option<DaemonClient>,
}

impl LiveSource {
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
        let projects = match from_daemon {
            Some(p) => p,
            None => {
                self.runner
                    .run_json(&["projects", "--json", "--no-daemon"], None, Self::READ)?
            }
        };
        Ok(Snapshot {
            cli_version,
            projects,
            daemon,
            doctor: None,
        })
    }

    fn act(&self, repo_root: &Path, action: Action) -> Result<ActionOutcome, SourceError> {
        let timeout = if action == Action::Start {
            Self::UP
        } else {
            Self::OTHER
        };
        let args = action.cli_args();
        Ok(match action {
            Action::Open => {
                ActionOutcome::Opened(self.runner.run_json(args, Some(repo_root), timeout)?)
            }
            _ => ActionOutcome::Lifecycle(self.runner.run_json(args, Some(repo_root), timeout)?),
        })
    }

    fn log_tail(&self, repo_root: &Path, lines: u32) -> Vec<LogEntry> {
        let tail = lines.to_string();
        let Ok((out, _, _)) = self.runner.run_raw(
            &[
                "logs",
                "--json",
                "--no-follow",
                "--compose",
                "--tail",
                &tail,
            ],
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

    fn act(&self, _repo_root: &Path, action: Action) -> Result<ActionOutcome, SourceError> {
        Ok(match action {
            Action::Open => ActionOutcome::Opened(OpenResult {
                url: "https://storefront.hack".into(),
                hint: None,
            }),
            _ => ActionOutcome::Lifecycle(LifecycleResult::default()),
        })
    }

    fn log_tail(&self, _repo_root: &Path, _lines: u32) -> Vec<LogEntry> {
        fixtures::log_tail(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
