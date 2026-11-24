//! Where the app's data comes from: the live CLI and daemon, or fixtures.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::daemon::DaemonClient;
use crate::doctor::DoctorRun;
use crate::fixtures::{self, Fixture};
use crate::models::{
    DaemonApiStatus, DoctorReport, LifecycleResult, LogEntry, OpenResult, ProjectsPayload,
    StoppedContainerExecution,
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
    /// Whether the CLI can use this hackd: `Some(true)` when the versions
    /// are equal or the CLI's `hack daemon status --json` reported
    /// `api_compatible: true`; `Some(false)` otherwise; `None` when no
    /// daemon was read (then [`Self::daemon_matches`] falls back to
    /// comparing the version strings).
    pub daemon_compatible: Option<bool>,
}

impl Snapshot {
    /// Cache-backed reads refresh quickly; unavailable or mismatched
    /// daemon reads retry slowly, without spawning a registry writer.
    #[must_use]
    pub fn poll_interval(snapshot: Option<&Self>) -> Duration {
        if snapshot.is_some_and(Self::daemon_matches) {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(10)
        }
    }

    /// hackd is reachable and the CLI can use it.
    #[must_use]
    pub fn daemon_matches(&self) -> bool {
        match (&self.daemon, self.daemon_compatible) {
            (None, _) => false,
            (Some(_), Some(compatible)) => compatible,
            (Some(d), None) => d.version == self.cli_version,
        }
    }

    /// hackd runs, but the CLI cannot use it: its version.
    #[must_use]
    pub fn daemon_mismatch(&self) -> Option<&str> {
        self.daemon
            .as_ref()
            .filter(|_| !self.daemon_matches())
            .map(|d| d.version.as_str())
    }
}

/// Which side to update when hackd and the CLI do not match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSide {
    /// hackd is older (or not comparable): restart it from this CLI.
    Daemon,
    /// hackd is newer than this CLI: update the CLI (`hack update`).
    /// Restarting hackd from an older CLI would downgrade it.
    Cli,
}

impl UpdateSide {
    /// The side to update for a daemon at `daemon` and a CLI at `cli`.
    /// Versions that do not parse as semver fall back to restarting hackd.
    #[must_use]
    pub fn for_versions(daemon: &str, cli: &str) -> Self {
        if compare_versions(daemon, cli) == Some(std::cmp::Ordering::Greater) {
            Self::Cli
        } else {
            Self::Daemon
        }
    }
}

/// One sentence naming the mismatch and its remedy.
#[must_use]
pub fn mismatch_text(daemon: &str, cli: &str) -> String {
    match compare_versions(daemon, cli) {
        Some(std::cmp::Ordering::Greater) => {
            format!(
                "hackd {daemon} is newer than this CLI ({cli}): update the CLI with hack update"
            )
        }
        Some(std::cmp::Ordering::Less) => {
            format!("hackd {daemon} is older than this CLI ({cli}): restart hackd")
        }
        _ => format!("hackd {daemon} does not match this CLI ({cli}): restart hackd"),
    }
}

/// Compare two semantic versions, with pre-release ordering
/// (`5.0.0-next.2 < 5.0.0-next.10 < 5.0.0`). A leading `v` and build
/// metadata are ignored. `None` when either does not parse.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn parse(v: &str) -> Option<([u64; 3], Vec<&str>)> {
        let v = v.trim();
        let v = v.strip_prefix('v').unwrap_or(v);
        let v = v.split('+').next()?;
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (v, None),
        };
        let mut nums = [0u64; 3];
        let mut parts = core.split('.');
        for n in &mut nums {
            let p = parts.next()?;
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            *n = p.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        let pre: Vec<&str> = match pre {
            Some(p) => {
                let ids: Vec<&str> = p.split('.').collect();
                if ids.iter().any(|i| i.is_empty()) {
                    return None;
                }
                ids
            }
            None => vec![],
        };
        Some((nums, pre))
    }
    let (an, ap) = parse(a)?;
    let (bn, bp) = parse(b)?;
    let core = an.cmp(&bn);
    if core != Ordering::Equal {
        return Some(core);
    }
    Some(match (ap.is_empty(), bp.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in ap.iter().zip(&bp) {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return Some(ord);
                }
            }
            ap.len().cmp(&bp.len())
        }
    })
}

/// Longest branch name the app passes to `--branch`.
pub const MAX_BRANCH_LEN: usize = 128;

/// Check a branch name before it becomes a CLI argument: non-empty, at most
/// [`MAX_BRANCH_LEN`] bytes, no leading `-` (it would read as an option),
/// no whitespace or control characters.
///
/// # Errors
/// `E_APP_INVALID_BRANCH` naming the problem.
pub fn validate_branch(branch: &str) -> Result<&str, SourceError> {
    let refuse = |why: &str| SourceError::Cli {
        code: "E_APP_INVALID_BRANCH".into(),
        message: format!("Not running this command: the branch name {why}."),
        failed: vec![],
    };
    if branch.is_empty() {
        return Err(refuse("is empty"));
    }
    if branch.len() > MAX_BRANCH_LEN {
        return Err(refuse("is too long"));
    }
    if branch.starts_with('-') {
        return Err(refuse("starts with '-'"));
    }
    if branch.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(refuse("contains whitespace or control characters"));
    }
    Ok(branch)
}

/// `args` with `--branch <branch>` inserted after the subcommand.
fn with_branch<'a>(args: &[&'a str], branch: Option<&'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = args.to_vec();
    if let Some(b) = branch {
        let at = out.len().min(1);
        out.splice(at..at, ["--branch", b]);
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    /// No answer yet (fixtures use it for the loading state).
    Pending,
    CliMissing,
    /// Project reads require a matching daemon until observe-only CLI listing exists.
    DaemonUnavailable {
        cli: String,
        /// The daemon's version, `None` when hackd is off or unreachable.
        daemon: Option<String>,
        /// The CLI can use this hackd (equal versions or `api_compatible`):
        /// the failure was the project read itself, not a mismatch.
        compatible: bool,
        message: String,
        /// Another Hack install whose CLI reports the same hackd (same
        /// home), as "hack 4.2.1 (stable)". The app then never starts or
        /// restarts that hackd: the other install would replace it again.
        shared_with: Option<String>,
    },
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

/// A service action can fail after Docker confirms a subset of its stops.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceActionError {
    pub source: Box<SourceError>,
    pub(crate) stopped: Option<ServiceStopReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceStopReceipt {
    pub stopped_containers: Vec<StoppedContainerExecution>,
    pub stopped_at: String,
}

impl From<SourceError> for ServiceActionError {
    fn from(source: SourceError) -> Self {
        Self {
            source: Box::new(source),
            stopped: None,
        }
    }
}

impl From<RunError> for ServiceActionError {
    fn from(error: RunError) -> Self {
        let stopped = match &error {
            RunError::Cli(error) if error.code == "E_COMPOSE_FAILED" => error
                .detail
                .as_ref()
                .and_then(|detail| ServiceStopReceipt::deserialize(detail).ok()),
            _ => None,
        };
        Self {
            source: Box::new(error.into()),
            stopped,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonRecovery {
    Start,
    Restart,
}

impl DaemonRecovery {
    #[must_use]
    pub fn command(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Restart => "restart",
        }
    }
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "Start hackd",
            Self::Restart => "Restart hackd",
        }
    }
}

/// Native finite logs are a single-service snapshot (not ndjson), so the
/// combined tail is not available for native projects in v0.
pub const NATIVE_LOGS_NOTE: &str = "Native logs are read one service at a time and are not shown in this preview yet. In a terminal: HACK_RUNTIME_BACKEND=native hack logs <service> --no-follow --tail 200";

/// A running log stream: live `hack logs --json`, or canned events.
pub trait LogFeed: Send {
    /// Up to `max` events without blocking, overflow count, and exit after
    /// retained events are delivered (see [`crate::runner::LogStream::poll`]).
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
            skipped: 0,
        }
    }
}

/// Names and observed state from `hack ps --copies --json`.
#[derive(Debug, serde::Deserialize)]
pub struct CopiesReport {
    pub copies: Vec<ProjectCopy>,
    pub observation: CopiesObservation,
}

#[derive(Debug, serde::Deserialize)]
pub struct ProjectCopy {
    pub branch: Option<String>,
    pub checkout: CopyCheckout,
    pub instance: Option<String>,
    pub backend: String,
    pub state: String,
    pub address: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct CopyCheckout {
    pub name: String,
    pub root: String,
    pub kind: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct CopiesObservation {
    pub ok: bool,
    pub code: Option<String>,
}

/// A short reason and next step for a failed copies observation.
#[derive(Debug)]
pub struct CopiesError {
    pub reason: String,
    pub hint: String,
}

impl From<RunError> for CopiesError {
    fn from(error: RunError) -> Self {
        let (reason, hint): (String, String) = match error {
            RunError::Cli(error) => {
                let fallback = match error.code.as_str() {
                    "E_USAGE" => "Select a Hack CLI that supports ps --copies.",
                    "E_PROJECT_NOT_FOUND" => "Check the project checkout and try again.",
                    "E_DOCKER_UNAVAILABLE" => "Start the container engine and check again.",
                    _ => "Run hack ps --copies from the checkout for more detail.",
                };
                let hint = error
                    .detail
                    .as_ref()
                    .and_then(|detail| detail.get("hint"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(fallback)
                    .to_owned();
                (format!("{}: {}", error.code, error.message), hint)
            }
            RunError::NotFound => (
                "Hack CLI unavailable.".into(),
                "Select an installed Hack CLI.".into(),
            ),
            RunError::Timeout { after } => (
                format!("E_TIMEOUT: Hack did not answer within {after:?}."),
                "Check again.".into(),
            ),
            // Don't display unsolicited subprocess output, including stdout from
            // a CLI that doesn't implement the JSON contract.
            _ => (
                "Hack did not return a project copies report.".into(),
                "Run hack ps --copies from the checkout for more detail.".into(),
            ),
        };
        Self { reason, hint }
    }
}

pub trait Source: Send + Sync {
    /// Observe the project family in the selected checkout.
    fn copies(&self, _root: &Path, _native: bool) -> Result<CopiesReport, CopiesError> {
        Err(RunError::NotFound.into())
    }

    /// Read names-only env metadata; diagnostics must never contain CLI output.
    fn env(&self, _root: &Path, _native: bool) -> crate::env::EnvView {
        crate::env::EnvView::Unreadable
    }

    /// `hack env list --json` for one overlay (`--env`) and scope
    /// (`--service`); `None` leaves each to the CLI's default. Names, scopes
    /// and set state only: never values.
    fn env_for(&self, root: &Path, native: bool, _selection: &EnvTarget) -> crate::env::EnvView {
        self.env(root, native)
    }

    /// One value, read when the user asks for it (`hack env get KEY` on a
    /// pipe, never a terminal). The error never contains the value.
    ///
    /// # Errors
    /// Why the value could not be read, with no value in it.
    fn env_value(
        &self,
        _root: &Path,
        _native: bool,
        _selection: &EnvTarget,
        _key: &str,
    ) -> Result<crate::env::Revealed, String> {
        Err("Values are unavailable for this source".into())
    }

    /// Set one value in the overlay and scope named (`hack env add KEY
    /// [--secret] --value-stdin`): the value goes to the CLI on stdin,
    /// never argv or the environment. The error never contains the value.
    ///
    /// # Errors
    /// Why the value was not stored, with no value in it.
    fn env_set(
        &self,
        _root: &Path,
        _native: bool,
        _target: &EnvTarget,
        _key: &str,
        _secret: bool,
        _value: &crate::env::Revealed,
    ) -> Result<(), String> {
        Err("Editing is unavailable for this source".into())
    }

    /// `hack daemon status --json`, for the hackd card: the selected CLI in
    /// its checked context, without starting hackd. `None` when it could not
    /// be read.
    fn daemon_status(&self) -> Option<crate::models::DaemonStatus> {
        None
    }

    /// `hack upgrade check --json`: read-only.
    ///
    /// # Errors
    /// The CLI could not run or printed no report this app reads.
    fn upgrade_check(&self) -> Result<crate::upgrade::CheckReport, String> {
        Err("Upgrade checks are unavailable for this source".into())
    }

    /// `hack upgrade review --json`: read-only.
    ///
    /// # Errors
    /// As [`Self::upgrade_check`].
    fn upgrade_review(&self) -> Result<crate::upgrade::Review, String> {
        Err("Upgrade review is unavailable for this source".into())
    }

    /// `hack upgrade snapshot --json`: keeps a private copy of the files an
    /// upgrade changes, under the CLI's home. A machine action.
    ///
    /// # Errors
    /// As [`Self::upgrade_check`].
    fn upgrade_snapshot(&self) -> Result<crate::upgrade::Snapshot, String> {
        Err("Upgrade snapshots are unavailable for this source".into())
    }

    /// The CLI's snapshots (`hack upgrade rollback --json`, no manifest):
    /// read-only.
    ///
    /// # Errors
    /// As [`Self::upgrade_check`].
    fn upgrade_snapshots(&self) -> Result<crate::upgrade::SnapshotList, String> {
        Err("Upgrade snapshots are unavailable for this source".into())
    }

    /// Put back one listed snapshot's files (`hack upgrade rollback
    /// --rollback-manifest <m> --json`), never with `--overwrite`. A machine
    /// action; only a manifest [`crate::upgrade::SnapshotEntry::manifest`]
    /// accepts is passed.
    ///
    /// # Errors
    /// As [`Self::upgrade_check`], or a manifest the CLI does not keep.
    fn upgrade_restore(
        &self,
        _entry: &crate::upgrade::SnapshotEntry,
    ) -> Result<crate::upgrade::Rollback, String> {
        Err("Upgrade restore is unavailable for this source".into())
    }

    /// Read files in one running Compose service.
    ///
    /// # Errors
    /// The CLI or the selected service could not complete the read.
    fn service_files(
        &self,
        _target: &crate::files::Target,
        _op: crate::files::Read,
        _path: &str,
    ) -> Result<crate::files::Report, String> {
        Err("Files are unavailable for this source.".into())
    }

    /// CPU and memory per service of a Compose project and its branch
    /// instances (`hack usage --json --by-service --path <root>`).
    ///
    /// # Errors
    /// The CLI could not read it (Docker unavailable, say) or printed no
    /// report this app reads.
    fn service_usage(&self, _root: &Path) -> Result<crate::usage::UsageReport, String> {
        Err("Usage is unavailable for this source".into())
    }

    /// One machine-wide, Compose-only sample, with per-container counters.
    ///
    /// # Errors
    /// The CLI could not read usage or its output could not be parsed.
    fn stats_sample(&self) -> Result<crate::stats::StatsReport, String> {
        Err("Usage is unavailable for this source".into())
    }

    /// The services of one instance whose image architecture differs from
    /// the engine's (`hack ps --json --path <root> [--branch <name>]`).
    ///
    /// # Errors
    /// As [`Self::service_usage`].
    fn emulated_services(
        &self,
        _root: &Path,
        _branch: Option<&str>,
    ) -> Result<std::collections::BTreeSet<String>, String> {
        Ok(std::collections::BTreeSet::new())
    }

    /// Explicit user recovery only; never called by a poll.
    /// # Errors
    /// Failed or unavailable daemon command.
    fn recover_daemon(&self, _action: DaemonRecovery) -> Result<(), String> {
        Err("Daemon actions are unavailable for this source".into())
    }
    /// # Errors
    /// A [`SourceError`] when no usable snapshot could be read.
    fn snapshot(&self) -> Result<Snapshot, SourceError>;

    /// The snapshot without reading native projects: each native row with a
    /// checkout has [`ProjectRow::native_pending`] set and no observation,
    /// for the caller to read with [`Self::native_ps`] one at a time. A
    /// native `hack ps` is a CLI start each (seconds), so the window shows
    /// Compose state at once and fills native state in as each returns.
    /// Sources without that cost return the full snapshot.
    ///
    /// # Errors
    /// As [`Self::snapshot`].
    fn listing(&self) -> Result<Snapshot, SourceError> {
        self.snapshot()
    }

    /// One native project's `hack ps --json`, run in `repo_root` with the
    /// native backend. `None` when it could not be read.
    fn native_ps(&self, _repo_root: &Path) -> Option<crate::models::NativePs> {
        None
    }

    /// The `hack` executable this source runs, for sessions the app starts
    /// itself (a terminal tab running `hack exec`, `hack logs` or `hack host
    /// shell`). `None` when there is no CLI (fixtures, CLI missing).
    fn hack_program(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// The Hack CLIs found and the one this source runs, when it chose
    /// among them (`None` for fixtures and fixed test sources).
    fn cli_choice(&self) -> Option<crate::cli_choice::Choice> {
        None
    }

    /// This source bound to the CLI it runs now, for an action accepted
    /// now: a switch afterwards cannot make the action run another CLI.
    /// `None` when the source has no CLI to switch (fixtures).
    fn pinned(&self) -> Option<std::sync::Arc<dyn Source>> {
        None
    }

    /// Run the install at `path` from now on and save that choice.
    ///
    /// # Errors
    /// Why it could not switch, or could not save the choice.
    fn use_cli(&self, path: &Path) -> Result<(), String> {
        Err(format!("cannot switch this source to {}", path.display()))
    }

    /// Run one action for a project root. `native` selects the native
    /// backend (`HACK_RUNTIME_BACKEND=native`), which every native command needs.
    /// `branch` targets that branch instance (`--branch <branch>`); it is
    /// checked with [`validate_branch`] first.
    ///
    /// # Errors
    /// A [`SourceError`] from the CLI, or an invalid branch name.
    fn act(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        action: Action,
    ) -> Result<ActionOutcome, SourceError>;

    /// Run a copy action bound to the Compose identity the app displayed.
    fn act_on_copy(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        _compose_project: Option<&str>,
        action: Action,
    ) -> Result<ActionOutcome, SourceError> {
        self.act(repo_root, native, branch, action)
    }

    /// Run a service-scoped lifecycle action on a Compose instance.
    fn act_on_service(
        &self,
        _repo_root: &Path,
        _branch: Option<&str>,
        _compose_project: Option<&str>,
        _service: &str,
        _action: Action,
    ) -> Result<LifecycleResult, ServiceActionError> {
        Err(SourceError::Cli {
            code: "E_APP_SERVICE_ACTION".into(),
            message: "Service actions are unavailable for this source.".into(),
            failed: vec![],
        }
        .into())
    }

    /// Last log lines for a project or one of its branch instances (no follow).
    ///
    /// # Errors
    /// Why no tail could be read; shown in place of the tail.
    fn log_tail(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        lines: u32,
    ) -> Result<Vec<LogEntry>, String>;

    /// Doctor runs: one outside any project, then one per project
    /// (DESIGN.md section 3). Each run fails on its own.
    fn doctor_runs(&self, projects: &[DoctorTarget]) -> Vec<DoctorRun>;

    /// Fresh setup checks (DESIGN.md section 2). Fixtures stay offline.
    fn setup(&self) -> crate::setup::Report {
        crate::setup::fixture(self.snapshot(), &self.doctor_runs(&[]))
    }

    /// Run one fixed, non-admin setup action against the checked report,
    /// never anything inferred from Doctor text. Fixtures refuse.
    fn setup_action(
        &self,
        _action: crate::setup::SafeAction,
        _checked: &crate::setup::Report,
    ) -> String {
        "Fixture: no action executed".into()
    }

    /// Start a log stream for the Logs tab (`args` from `LogsModel::cli_args`).
    /// `branch` streams that branch instance (`--branch <branch>` is added
    /// after the subcommand). Dropping the feed stops the stream.
    ///
    /// # Errors
    /// Why no stream can be opened (native projects in v0, invalid branch
    /// name, spawn failure).
    fn open_logs(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        args: &[String],
    ) -> Result<Box<dyn LogFeed>, String>;
}

/// A project to run doctor for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorTarget {
    pub missing: bool,
    pub name: String,
    pub repo_root: std::path::PathBuf,
    pub native: bool,
    /// A native project's URL (`https://<dev_host>`), passed as
    /// `--browser-url`: the CLI derives the native hostname, and so its
    /// `native host dns` check, from it alone.
    pub browser_url: Option<String>,
}

/// Identity of each target (name, checkout, backend) for the stale guard.
#[must_use]
pub fn target_keys(targets: &[DoctorTarget]) -> Vec<crate::doctor::TargetKey> {
    targets
        .iter()
        .map(|t| {
            (
                t.name.clone(),
                t.repo_root.clone(),
                t.native,
                t.missing,
                t.browser_url.clone(),
            )
        })
        .collect()
}

impl DoctorTarget {
    fn run(&self, result: Result<crate::models::DoctorReport, String>) -> DoctorRun {
        DoctorRun {
            project: Some(self.name.clone()),
            root: Some(self.repo_root.clone()),
            native: self.native,
            exact_native_root: false,
            probe_started: true,
            result,
        }
    }

    /// Retain missing rows for coverage, but never probe them.
    #[must_use]
    pub fn from_projects(p: &ProjectsPayload) -> Vec<Self> {
        p.projects
            .iter()
            .map(|r| Self {
                missing: r.status == "missing" || r.repo_root.is_none(),
                name: r.name.clone(),
                repo_root: r.repo_root.clone().unwrap_or_default().into(),
                native: r.is_native(),
                browser_url: r
                    .dev_host
                    .as_deref()
                    .filter(|_| r.is_native())
                    .filter(|h| is_plain_host(h))
                    .map(|h| format!("https://{h}")),
            })
            .collect()
    }
}

/// Doctor reads take long (they probe DNS, trust and the engine).
pub const DOCTOR_TIMEOUT: Duration = Duration::from_secs(60);
/// At most this many doctor runs at once.
const DOCTOR_PARALLEL: usize = 4;
/// One refresh never takes longer than this.
pub const DOCTOR_BUDGET: Duration = Duration::from_secs(90);
/// The reason shown for projects the budget did not reach.
pub const NOT_CHECKED_BUDGET: &str = "not checked (time budget)";

/// Read one doctor report. Exit 1 still carries a report; a payload
/// without a `checks` array is not a report.
/// A host name made of letters, digits, dots and hyphens that does not
/// start with a hyphen: safe to put in a URL argument.
fn is_plain_host(h: &str) -> bool {
    !h.is_empty()
        && !h.starts_with(['-', '.'])
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn read_doctor(
    runner: &CliRunner,
    root: Option<&Path>,
    browser_url: Option<&str>,
    timeout: Duration,
) -> Result<crate::models::DoctorReport, String> {
    // Doctor invokes Git read commands. Repository config must never turn
    // those observations into fsmonitor or hook execution.
    let v: serde_json::Value = runner
        .clone()
        .with_env("GIT_CONFIG_PARAMETERS", "")
        .with_env("GIT_CONFIG_COUNT", "2")
        .with_env("GIT_CONFIG_KEY_0", "core.fsmonitor")
        .with_env("GIT_CONFIG_VALUE_0", "false")
        .with_env("GIT_CONFIG_KEY_1", "core.hooksPath")
        .with_env("GIT_CONFIG_VALUE_1", "/dev/null")
        .run_json(
            &match browser_url {
                Some(url) => vec!["doctor", "--json", "--browser-url", url],
                None => vec!["doctor", "--json"],
            },
            root,
            timeout,
        )
        .map_err(|e| e.to_string())?;
    if !v
        .get("checks")
        .is_some_and(|c| c.as_array().is_some_and(|a| !a.is_empty()))
    {
        return Err("doctor printed no checks list".into());
    }
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Owner-write is allowed; group/other-write and foreign ownership are not.
/// A root-owned sticky ancestor (such as /tmp) may contain a private entry.
/// `runner`'s CLI in the checked execution context, for every `hack daemon`
/// command the app runs on its own (status reads and project-pane
/// recovery), as Setup runs its actions:
/// - the executable `runner` resolves to now, pinned and verified, so a
///   later `PATH` lookup cannot pick another install;
/// - a clean environment with only the context's allowlist, and a `PATH` of
///   directories no other user can change;
/// - `HACK_MCP_COMMAND` naming that executable: the CLI starts hackd by
///   invoking itself and would otherwise use the first `hack` on `PATH`,
///   which on a machine with several installs is another one.
///
/// # Errors
/// No CLI selected, or a context that cannot be checked.
pub(crate) fn checked_daemon_runner(runner: &CliRunner) -> Result<CliRunner, String> {
    let (checked, program) = checked_cli_runner(runner)?;
    Ok(checked.with_env("HACK_MCP_COMMAND", &program))
}

/// `runner`'s CLI pinned to the executable it resolves to now, in the
/// checked execution context (a clean environment with only its allowlist
/// and a `PATH` of directories no other user can change), with that
/// executable's path.
///
/// # Errors
/// No CLI selected, or a context that cannot be checked.
pub(crate) fn checked_cli_runner(runner: &CliRunner) -> Result<(CliRunner, String), String> {
    let program = runner
        .program_path()
        .ok_or("No Hack CLI is selected")?
        .into_os_string()
        .into_string()
        .map_err(|_| "The CLI path is not UTF-8".to_owned())?;
    let context = crate::execution::ExecutionContext::capture(runner)?.with_controlled_path()?;
    Ok((context.runner(&program)?, program))
}

/// `hack daemon status --json` as JSON, without starting the daemon. Exit
/// status 1 still carries the report when hackd is not running.
pub(crate) fn read_daemon_status(
    runner: &CliRunner,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (out, _, _) = runner
        .clone()
        .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .run_raw(&["daemon", "status", "--json"], None, timeout)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&out).map_err(|e| format!("hack daemon status: {e}"))
}

pub(crate) fn trusted_tool_path(path: &Path, uid: u32, directory: bool) -> Option<PathBuf> {
    trusted_tool_path_with(path, uid, directory, |_, _| false)
}

fn trusted_tool_path_with(
    path: &Path,
    uid: u32,
    directory: bool,
    writable_dir: fn(&Path, &std::fs::Metadata) -> bool,
) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    if !crate::doctor_plugins::guarded_names_with(path, uid, &mut 64, false, writable_dir) {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    for (index, component) in real.ancestors().enumerate() {
        let meta = std::fs::metadata(component).ok()?;
        let sticky_root = index > 0 && meta.uid() == 0 && meta.mode() & 0o1000 != 0;
        if !crate::doctor_acl::controlled(component)
            || (index > 0 || directory) && !meta.is_dir()
            || (index == 0 && !directory && (!meta.is_file() || meta.mode() & 0o111 == 0))
            || (meta.uid() != uid && meta.uid() != 0)
            || (meta.mode() & 0o022 != 0
                && !sticky_root
                && !(index > 0 && writable_dir(component, &meta)))
        {
            return None;
        }
    }
    Some(real)
}

/// A script's `#!` interpreter runs with the script's authority, so it must
/// pass the same ownership and write rules as the script (recursively, for
/// interpreters that are scripts themselves). `#!/usr/bin/env name` is safe
/// once env is trusted: Doctor children see only the private wrapper PATH.
/// A file this user cannot read is refused: the kernel still follows the `#!`
/// line of an execute-only script, so its interpreter could not be checked.
/// Any other read failure or unparsable line refuses the tool too.
/// `wrapper_path`: the program's children see only Doctor's private wrapper
/// PATH, so `#!/usr/bin/env <name>` resolves to a checked tool. Callers whose
/// children use an ordinary PATH must pass false, which refuses the env form.
pub(crate) fn trusted_interpreter(real: &Path, uid: u32, depth: u8, wrapper_path: bool) -> bool {
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    let mut file = match std::fs::File::open(real) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut head = [0_u8; 512];
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    let Some(line) = head[..read].strip_prefix(b"#!") else {
        return true;
    };
    let Some(end) = line.iter().position(|b| *b == b'\n') else {
        return false;
    };
    let tokens: Vec<&[u8]> = line[..end]
        .split(|b| *b == b' ' || *b == b'\t')
        .filter(|token| !token.is_empty())
        .collect();
    let Some((interpreter, args)) = tokens.split_first() else {
        return false;
    };
    let interpreter = Path::new(std::ffi::OsStr::from_bytes(interpreter));
    if depth == 0 || !interpreter.is_absolute() {
        return false;
    }
    let Some(real_interpreter) = trusted_tool_path(interpreter, uid, false) else {
        return false;
    };
    // Only two forms are accepted; anything else (options, file or path
    // arguments, variables, assignments) fails closed as Unknown:
    // - `#!<trusted interpreter>` with no arguments;
    // - exactly `#!/usr/bin/env <name>` (env identified by real path), whose
    //   name resolves only through Doctor's private wrapper PATH.
    match args {
        [] => trusted_interpreter(&real_interpreter, uid, depth - 1, wrapper_path),
        [name] => {
            wrapper_path
                && real_interpreter == Path::new("/usr/bin/env")
                && !name.starts_with(b"-")
                && name
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
        }
        _ => false,
    }
}

/// A per-read private PATH containing only wrappers for checked executables.
/// Wrappers exec the original absolute path so shims keep their normal $0.
/// No credential/context values are stored. Drop removes only this owned scratch.
#[derive(Debug)]
struct ProbeTools {
    dir: PathBuf,
    coverage: Option<&'static str>,
    unchecked: std::collections::BTreeSet<&'static str>,
}

impl ProbeTools {
    fn path(&self) -> &std::ffi::OsStr {
        self.dir.as_os_str()
    }
}

impl Drop for ProbeTools {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn trusted_probe_path(path: &std::ffi::OsStr) -> Result<ProbeTools, String> {
    trusted_probe_path_with_limits(path, 64, 8192)
}

fn trusted_probe_path_with_limits(
    path: &std::ffi::OsStr,
    max_dirs: usize,
    max_entries: usize,
) -> Result<ProbeTools, String> {
    use std::os::unix::fs::DirBuilderExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    if trusted_tool_path(Path::new("/bin/sh"), uid, false).is_none() {
        return Err("Doctor wrapper interpreter is not trusted".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "hack-desktop-tools-{}-{stamp}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| e.to_string())?;
    let mut tools = ProbeTools {
        dir,
        coverage: None,
        unchecked: std::collections::BTreeSet::new(),
    };
    if trusted_tool_path(&tools.dir, uid, true).is_none() {
        return Err("Doctor tool scratch is not private".into());
    }
    let mut seen_dirs = std::collections::BTreeSet::new();
    let mut names = std::collections::BTreeSet::new();
    let mut entries = 0;
    'directories: for p in std::env::split_paths(path) {
        if !p.is_absolute()
            || !seen_dirs.insert(std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone()))
        {
            continue;
        }
        if seen_dirs.len() > max_dirs {
            tools.coverage = Some(
                "Doctor tool PATH directory scan limit reached; remaining tools were not searched",
            );
            break;
        }
        let Some(real) = trusted_tool_path(&p, uid, true) else {
            for tool in crate::doctor_tools::NAMES {
                if names.contains(std::ffi::OsStr::new(tool)) {
                    continue;
                }
                if !matches!(std::fs::symlink_metadata(p.join(tool)), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
                {
                    tools.unchecked.insert(tool);
                }
            }
            continue;
        };
        let Ok(children) = std::fs::read_dir(real) else {
            tools.coverage =
                Some("Doctor could not enumerate a PATH directory; tools there were not checked");
            continue;
        };
        for entry in children {
            entries += 1;
            if entries > max_entries {
                tools.coverage = Some(
                    "Doctor tool PATH entry scan limit reached; remaining tools were not searched",
                );
                break 'directories;
            }
            let Ok(entry) = entry else {
                tools.coverage =
                    Some("Doctor could not inspect a PATH entry; tool coverage is incomplete");
                continue;
            };
            let name = entry.file_name();
            if names.contains(&name) {
                continue;
            }
            if trusted_tool_path(&entry.path(), uid, false)
                .is_none_or(|real| !trusted_interpreter(&real, uid, 4, true))
            {
                if let Some(tool) = crate::doctor_tools::NAMES
                    .iter()
                    .find(|tool| name == std::ffi::OsStr::new(**tool))
                {
                    tools.unchecked.insert(tool);
                }
                continue;
            }
            write_wrapper(&tools.dir, &name, &entry.path())?;
            names.insert(name);
        }
    }
    // Candidate launchers (hack-v5, hack-next) need dirname before they run
    // the CLI. Offer it from a trusted system location when the scan did not.
    if !names.contains(std::ffi::OsStr::new("dirname"))
        && let Some(found) = ["/usr/bin/dirname", "/bin/dirname"]
            .iter()
            .map(Path::new)
            .find(|p| {
                trusted_tool_path(p, uid, false)
                    .is_some_and(|real| trusted_interpreter(&real, uid, 4, true))
            })
    {
        write_wrapper(&tools.dir, std::ffi::OsStr::new("dirname"), found)?;
        names.insert("dirname".into());
    }
    if tools.coverage.is_some() {
        for tool in crate::doctor_tools::NAMES {
            if !names.contains(std::ffi::OsStr::new(tool)) {
                tools.unchecked.insert(tool);
            }
        }
    }
    Ok(tools)
}

/// A private wrapper that execs `target` by absolute path, so shims keep their
/// normal `$0`. Created new with owner-only permissions.
fn write_wrapper(dir: &Path, name: &std::ffi::OsStr, target: &Path) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
    let mut script = b"#!/bin/sh\nexec '".to_vec();
    for byte in target.as_os_str().as_bytes() {
        if *byte == b'\'' {
            script.extend_from_slice(b"'\\''");
        } else {
            script.push(*byte);
        }
    }
    script.extend_from_slice(b"' \"$@\"\n");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(dir.join(name))
        .map_err(|e| e.to_string())?;
    file.write_all(&script).map_err(|e| e.to_string())
}

fn apply_tool_coverage(runs: &mut Vec<DoctorRun>, tools: &ProbeTools) {
    if tools.unchecked.is_empty() {
        return;
    }
    let names = tools
        .unchecked
        .iter()
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let note = format!(
        "Doctor did not check tools: {names}; install location/target permissions or bounded PATH scan prevented validation"
    );
    for run in runs.iter_mut() {
        if let Ok(report) = &mut run.result {
            for check in &mut report.checks {
                if tools
                    .unchecked
                    .iter()
                    .any(|tool| crate::doctor_tools::affected(tool, &check.id))
                {
                    check.status = "unknown".into();
                    check.detail = "A required tool was filtered or not searched; this check could not be established".into();
                }
            }
        }
    }
    let mut coverage = DoctorRun::machine(Ok(crate::models::DoctorReport {
        checks: vec![crate::models::DoctorCheck {
            native_pool: None,
            id: "desktop tool coverage".into(),
            status: "unknown".into(),
            detail: note,
            fix: None,
        }],
        summary: vec![],
    }));
    coverage.probe_started = false;
    runs.push(coverage);
}

/// Live data from a matching hackd. CLI listing fallback needs R18:
/// today's `projects` command auto-registers projects and writes the registry.
pub struct LiveSource {
    pub runner: CliRunner,
    /// A fixed hackd to read (tests). `None`: ask the CLI where its hackd
    /// is ([`LiveSource::hackd`]).
    pub daemon: Option<DaemonClient>,
    /// What this source has learned from its CLI.
    pub cache: CliCache,
}

/// What a [`LiveSource`] learns from its CLI, so polling does not spawn the
/// CLI every refresh:
/// - `api_compatible` answers from `hack daemon status --json`, per
///   `(cli_version, daemon_version)`; failed or unparsable answers are never
///   cached;
/// - where the CLI's hackd is (`socket_path` from the same command), per
///   CLI executable. A prerelease channel keeps its hackd in its own home.
#[derive(Debug, Default)]
pub struct CliCache {
    compat: std::sync::Mutex<std::collections::HashMap<(String, String), bool>>,
    hackd: std::sync::Mutex<Option<FoundHackd>>,
    /// Bumped on every CLI switch. A read records it when it starts and
    /// writes nothing back if it changed: answers from the previous CLI
    /// never land in the new one's cache.
    generation: std::sync::atomic::AtomicU64,
    /// The Hack CLIs found and the one this source runs ([`LiveSource::from_env`]).
    choice: std::sync::Mutex<Option<crate::cli_choice::Choice>>,
    /// `hack version --json` per executable, for [`CLI_VERSION_TTL`]: every
    /// start of a launcher such as `hack-next` re-verifies its bundle.
    versions: std::sync::Mutex<std::collections::HashMap<PathBuf, (String, std::time::Instant)>>,
    /// The hackd socket each other install's CLI reported, per executable,
    /// and when: a found socket is reused for [`OTHER_SOCKET_TTL`], a failed
    /// lookup retried after [`HACKD_LOOKUP_RETRY`].
    other_sockets:
        std::sync::Mutex<std::collections::HashMap<PathBuf, (Option<PathBuf>, std::time::Instant)>>,
}

/// How long another install's reported hackd socket is reused.
const OTHER_SOCKET_TTL: Duration = Duration::from_secs(60);

/// How long a CLI's reported version is reused before asking again.
const CLI_VERSION_TTL: Duration = Duration::from_secs(30);

/// Where one CLI's hackd is, and when that was asked. Keyed by the CLI
/// executable and the version it reported, so an upgrade asks again.
#[derive(Debug, Clone)]
struct FoundHackd {
    program: PathBuf,
    cli_version: Option<String>,
    client: Option<DaemonClient>,
    asked: std::time::Instant,
}

/// Native `ps` reads (each a CLI start) run this many at a time.
pub const NATIVE_PS_PARALLEL: usize = 8;

/// After a failed lookup (or a socket that stopped answering), how long
/// before asking the CLI again.
const HACKD_LOOKUP_RETRY: Duration = Duration::from_secs(10);

impl CliCache {
    fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::Acquire)
    }
    fn compat_get(&self, key: &(String, String)) -> Option<bool> {
        self.compat.lock().ok()?.get(key).copied()
    }
    fn compat_put(&self, key: (String, String), compatible: bool, generation: u64) {
        if let Ok(mut m) = self.compat.lock()
            && self.generation() == generation
        {
            m.insert(key, compatible);
        }
    }
    /// Forget what was learned from the CLI: the source now runs another.
    fn clear_learned(&self) {
        // Under the locks, so a read that started earlier cannot write back
        // between the bump and the clear.
        let compat = self.compat.lock();
        let hackd = self.hackd.lock();
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        if let Ok(mut m) = compat {
            m.clear();
        }
        if let Ok(mut h) = hackd {
            *h = None;
        }
        if let Ok(mut o) = self.other_sockets.lock() {
            o.clear();
        }
    }
}

/// SIGTERM grace for doctor reads: they only read, so they own no builds
/// to retire, and a short grace keeps a refresh within its budget.
pub const DOCTOR_TERM_GRACE: Duration = Duration::from_secs(2);

impl LiveSource {
    /// Doctor runs under one overall `budget`: each call gets the smaller of
    /// `per_call` and the time left, and projects not started before the
    /// budget runs out are reported as not checked.
    pub fn doctor_runs_within(
        &self,
        projects: &[DoctorTarget],
        budget: Duration,
        per_call: Duration,
    ) -> Vec<DoctorRun> {
        self.doctor_runs_with_discovery(
            projects,
            budget,
            per_call,
            &crate::doctor_plugins::Discovery::from_runner(&self.runner),
        )
    }

    fn doctor_runs_with_discovery(
        &self,
        projects: &[DoctorTarget],
        budget: Duration,
        per_call: Duration,
        discovery: &crate::doctor_plugins::Discovery,
    ) -> Vec<DoctorRun> {
        let deadline = std::time::Instant::now() + budget;
        let native_pin = match crate::doctor_plugins::validate_helpers(&self.runner)
            .and_then(|pin| crate::doctor_plugins::validate(discovery).map(|()| pin))
        {
            Ok(pin) => pin,
            Err(reason) => {
                let why = format!("Could not check Doctor executable discovery: {reason}");
                let report = crate::models::DoctorReport {
                    checks: vec![crate::models::DoctorCheck {
                        native_pool: None,
                        id: "desktop preflight".into(),
                        status: "unknown".into(),
                        detail: why.clone(),
                        fix: None,
                    }],
                    summary: vec![],
                };
                let mut machine = DoctorRun::machine(Ok(report));
                machine.probe_started = false;
                return std::iter::once(machine)
                    .chain(projects.iter().map(|t| t.run(Err(why.clone()))))
                    .collect();
            }
        };
        // Resolve once per refresh, not once per project. The private PATH
        // stays alive until every bounded child has completed.
        let tools = match trusted_probe_path(
            self.runner
                .env_value("PATH")
                .unwrap_or_default()
                .as_os_str(),
        ) {
            Ok(tools) => tools,
            Err(why) => {
                return std::iter::once(DoctorRun::machine(Err(why.clone())))
                    .chain(projects.iter().map(|t| t.run(Err(why.clone()))))
                    .collect();
            }
        };
        let Some(tool_path) = tools.path().to_str() else {
            let why = "Doctor tool PATH is not UTF-8".to_owned();
            return std::iter::once(DoctorRun::machine(Err(why.clone())))
                .chain(projects.iter().map(|t| t.run(Err(why.clone()))))
                .collect();
        };
        // Each call's timeout leaves room for its SIGTERM grace, so stopping
        // a slow check also finishes within the overall budget.
        let left = || {
            deadline
                .saturating_duration_since(std::time::Instant::now())
                .saturating_sub(DOCTOR_TERM_GRACE)
        };
        let read =
            |runner: &CliRunner,
             root: Option<&Path>,
             browser_url: Option<&str>,
             timeout: Duration| { read_doctor(runner, root, browser_url, timeout) };
        // The machine run must happen outside every checkout, or doctor
        // would report that checkout's project checks as machine checks.
        // Prefer a user-private directory, then root. A shared temp cwd
        // would permit another user to plant a project marker after inspection.
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from)
            && crate::doctor::is_private_dir(&run)
        {
            candidates.push(run);
        }
        candidates.push(std::path::PathBuf::from("/"));
        let machine = match crate::doctor::neutral_dir(&candidates) {
            Some(dir) if !left().is_zero() => read(
                &native_pin
                    .apply(self.runner.clone(), &tools.dir)
                    .with_env("PATH", tool_path)
                    .without_interpreter_startup()
                    .with_cwd(dir)
                    .with_term_grace(DOCTOR_TERM_GRACE),
                None,
                None,
                per_call.min(left()),
            ),
            Some(_) => Err(NOT_CHECKED_BUDGET.to_owned()),
            None => Err("machine checks could not run outside a project".into()),
        };
        let mut runs = vec![DoctorRun::machine(machine)];
        for chunk in projects.chunks(DOCTOR_PARALLEL) {
            let chunk_runs: Vec<DoctorRun> = std::thread::scope(|s| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|t| {
                        let runner = native_pin
                            .apply(self.runner_for(t.native), &tools.dir)
                            .with_env("PATH", tool_path)
                            .without_interpreter_startup()
                            .with_term_grace(DOCTOR_TERM_GRACE);
                        let timeout = per_call.min(left());
                        s.spawn(move || {
                            let before = (t.native && !t.missing)
                                .then(|| exact_doctor_root(&t.repo_root))
                                .flatten();
                            let result = if t.missing {
                                Err("not checked (checkout missing)".into())
                            } else if timeout.is_zero() {
                                Err(NOT_CHECKED_BUDGET.to_owned())
                            } else {
                                read(
                                    &runner,
                                    Some(&t.repo_root),
                                    t.browser_url.as_deref(),
                                    timeout,
                                )
                            };
                            let mut run = t.run(result);
                            run.exact_native_root =
                                before.is_some() && before == exact_doctor_root(&t.repo_root);
                            // Adoption is reported as unsupported native input
                            // by legacy project views, but Doctor selects it
                            // through Compose. Accept only exact adopted-root
                            // evidence from this bounded read-only retry.
                            if t.native
                                && run
                                    .result
                                    .as_ref()
                                    .is_ok_and(|r| !crate::doctor::project_evidence(&run, r))
                            {
                                let timeout = per_call.min(left());
                                if !timeout.is_zero() {
                                    let compose = self
                                        .runner_for(false)
                                        .with_env("PATH", tool_path)
                                        .without_interpreter_startup()
                                        .with_term_grace(DOCTOR_TERM_GRACE);
                                    if let Ok(report) =
                                        read(&compose, Some(&t.repo_root), None, timeout)
                                        && crate::doctor::adopted_project_evidence(
                                            &t.repo_root,
                                            &report,
                                        )
                                    {
                                        let mut adopted = t.run(Ok(report));
                                        adopted.native = false;
                                        return adopted;
                                    }
                                }
                            }
                            run
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .zip(chunk)
                    .map(|(h, t)| {
                        h.join()
                            .unwrap_or_else(|_| t.run(Err("doctor read panicked".into())))
                    })
                    .collect()
            });
            runs.extend(chunk_runs);
        }
        apply_tool_coverage(&mut runs, &tools);
        runs
    }

    /// [`Source::snapshot`], with how long each step took (for
    /// `hack-desktop-state`): the CLI version, finding hackd, its status and
    /// projects, and each native project's `ps`.
    pub fn snapshot_timed(&self) -> (Result<Snapshot, SourceError>, Vec<(String, Duration)>) {
        let mut steps: Vec<(String, Duration)> = Vec::new();
        let result = self.read_snapshot(&mut steps);
        (result, steps)
    }

    fn read_snapshot(&self, steps: &mut Vec<(String, Duration)>) -> Result<Snapshot, SourceError> {
        let runner = self.runner.fixed();
        let mut snapshot = self.read_listing(&runner, steps)?;
        // The window shows the list here (`Source::listing`); a full
        // snapshot then asks native ps for each, a few at a time: each is a
        // CLI start.
        let listed: Duration = steps.iter().map(|(_, d)| *d).sum();
        steps.push(("list shown in the window after".into(), listed));
        let native = Self::native_runner(&runner);
        let t = std::time::Instant::now();
        let mut rows: Vec<&mut crate::models::ProjectRow> = snapshot
            .projects
            .projects
            .iter_mut()
            .filter(|r| r.native_pending)
            .collect();
        let count = rows.len();
        for chunk in rows.chunks_mut(NATIVE_PS_PARALLEL) {
            std::thread::scope(|s| {
                for row in chunk.iter_mut() {
                    let native = native.clone();
                    s.spawn(move || {
                        let root = row.repo_root.clone().unwrap_or_default();
                        row.native = Self::read_native_ps(&native, Path::new(&root));
                        row.native_pending = false;
                    });
                }
            });
        }
        steps.push((
            format!("native ps for {count} project(s), {NATIVE_PS_PARALLEL} at a time"),
            t.elapsed(),
        ));
        Ok(snapshot)
    }

    fn native_runner(runner: &CliRunner) -> CliRunner {
        runner.clone().with_env("HACK_RUNTIME_BACKEND", "native")
    }

    fn read_native_ps(native: &CliRunner, root: &Path) -> Option<crate::models::NativePs> {
        native
            .run_json(&["ps", "--json"], Some(root), Self::READ)
            .ok()
    }

    /// Everything but native `ps`: native rows with a checkout come back
    /// with `native_pending` set.
    fn read_listing(
        &self,
        runner: &CliRunner,
        steps: &mut Vec<(String, Duration)>,
    ) -> Result<Snapshot, SourceError> {
        let mut timed = |label: &str, started: std::time::Instant| {
            steps.push((label.to_owned(), started.elapsed()));
        };
        // One CLI for the whole read, even if the user switches meanwhile.
        let generation = self.cache.generation();
        let runner = runner.clone();
        let t = std::time::Instant::now();
        let cli_version = self.cli_version(&runner);
        timed("hack version --json (cached 30 s per CLI)", t);
        let cli_version = cli_version?;
        // hackd is found and checked with the CLI in its checked context; a
        // context that cannot be checked is that error, never "hackd off"
        // (which would offer Start).
        if self.daemon.is_none() {
            checked_daemon_runner(&runner).map_err(|e| SourceError::Cli {
                code: "E_APP_CONTEXT".into(),
                message: format!(
                    "The app could not check the CLI's environment to read hackd: {e}"
                ),
                failed: vec![],
            })?;
        }
        let t = std::time::Instant::now();
        let client = self.hackd_for(&runner, Some(&cli_version), generation);
        timed("find hackd (cached after the first read)", t);
        let t = std::time::Instant::now();
        let daemon = client.as_ref().and_then(|d| d.status().ok());
        timed("hackd status", t);
        if client.is_some() && daemon.is_none() {
            self.forget_hackd(generation);
        }
        let t = std::time::Instant::now();
        let daemon_compatible = daemon
            .as_ref()
            .map(|d| self.daemon_compatible_with(&runner, generation, &cli_version, &d.version));
        timed("version compatibility (cached per pair)", t);
        let t = std::time::Instant::now();
        let from_daemon = client
            .as_ref()
            .filter(|_| daemon_compatible == Some(true))
            .and_then(|d| d.projects().ok());
        timed("hackd projects", t);
        // A mismatch with a hackd that another install's CLI also uses:
        // name it, and never offer to restart it.
        let shared_with = match (&daemon, daemon_compatible, &client) {
            (Some(_), Some(false), Some(c)) => self.install_sharing(&runner, c.socket()),
            _ => None,
        };
        let mut projects = from_daemon.ok_or_else(|| SourceError::DaemonUnavailable {
            shared_with: shared_with.clone(),
            cli: cli_version.clone(),
            daemon: daemon.as_ref().map(|d| d.version.clone()),
            compatible: daemon_compatible == Some(true),
            message: match (&daemon, &shared_with) {
                (Some(d), Some(other)) => format!(
                    "hackd {} here belongs to {other}, which shares this home with the app's CLI ({cli_version}). The app does not restart it: use {other} in the app, or give each install its own home.",
                    d.version
                ),
                (None, _) => "hackd is off or unreachable. Start hackd to read project status.".into(),
                (Some(d), None) if daemon_compatible != Some(true) => {
                    format!(
                        "{} to read project status.",
                        mismatch_text(&d.version, &cli_version)
                    )
                }
                (Some(_), None) => {
                    "hackd could not provide project status. Check again or restart hackd.".into()
                }
            },
        })?;
        // Which checkout owns each branch instance, by canonical paths.
        for row in &mut projects.projects {
            row.resolve_branch_owners();
        }
        // Project views do not read native projects: `hack ps` does, one CLI
        // start each. Marked here, read by the caller.
        for row in &mut projects.projects {
            row.native_pending = row.is_native() && row.repo_root.is_some();
        }
        Ok(Snapshot {
            cli_version,
            projects,
            daemon,
            doctor: None,
            daemon_compatible,
        })
    }

    /// The live source exactly as the app builds it: the CLI the app
    /// selected (`hack` on absolute PATH entries unless a saved choice or a
    /// prerelease install says otherwise; see [`crate::cli_choice`]), and the
    /// hackd that CLI reports. Used by the window and by `hack-desktop-state`.
    #[must_use]
    pub fn from_env() -> Self {
        let choice = crate::cli_choice::Choice::load();
        // No trusted install: run nothing. Falling back to PATH would run
        // the very `hack` the trust check refused (`choice.rejected`).
        let runner = match &choice.selected {
            Some(install) => CliRunner::selectable(install.path.clone()),
            None => CliRunner::unavailable("hack"),
        };
        let source = Self::new(runner, None);
        if let Ok(mut c) = source.cache.choice.lock() {
            *c = Some(choice);
        }
        source
    }

    /// The hackd this source reads now: the fixed one, else the one its
    /// CLI reports ([`Self::hackd_for`]).
    pub fn hackd(&self) -> Option<DaemonClient> {
        let generation = self.cache.generation();
        self.hackd_for(&self.runner.fixed(), None, generation)
    }

    /// The hackd `runner`'s CLI reports (`hack daemon status --json` →
    /// `socket_path`), asked once per CLI executable and version, and again
    /// after [`HACKD_LOOKUP_RETRY`] when the lookup failed or the socket
    /// stopped answering. A CLI whose valid report has no `socket_path`
    /// (older ones) uses the home it inherits (`HACK_HOME`, else `~/.hack`).
    /// A failed lookup never falls back: that could read another CLI's
    /// hackd.
    fn hackd_for(
        &self,
        runner: &CliRunner,
        cli_version: Option<&str>,
        generation: u64,
    ) -> Option<DaemonClient> {
        if let Some(d) = &self.daemon {
            return Some(d.clone());
        }
        let program = runner.program_path()?;
        if let Ok(found) = self.cache.hackd.lock()
            && let Some(f) = found.as_ref()
            && f.program == program
            && (cli_version.is_none() || f.cli_version.as_deref() == cli_version)
            && (f.client.is_some() || f.asked.elapsed() < HACKD_LOOKUP_RETRY)
        {
            return f.client.clone();
        }
        let client = self.ask_cli_for_hackd(runner);
        if let Ok(mut found) = self.cache.hackd.lock()
            && self.cache.generation() == generation
        {
            *found = Some(FoundHackd {
                program,
                cli_version: cli_version.map(str::to_owned),
                client: client.clone(),
                asked: std::time::Instant::now(),
            });
        }
        client
    }

    /// `runner`'s version, reused for [`CLI_VERSION_TTL`] per executable.
    fn cli_version(&self, runner: &CliRunner) -> Result<String, SourceError> {
        let program = runner.program_path();
        if let Some(p) = &program
            && let Ok(v) = self.cache.versions.lock()
            && let Some((version, at)) = v.get(p)
            && at.elapsed() < CLI_VERSION_TTL
        {
            return Ok(version.clone());
        }
        let version = runner.version(Duration::from_secs(5))?;
        if let Some(p) = program
            && let Ok(mut v) = self.cache.versions.lock()
        {
            v.insert(p, (version.clone(), std::time::Instant::now()));
        }
        Ok(version)
    }

    /// Another discovered install whose CLI reports `socket` as its hackd,
    /// as "name version (channel)". Each other CLI is asked once.
    pub(crate) fn install_sharing(&self, runner: &CliRunner, socket: &Path) -> Option<String> {
        let ours = runner.program_path()?;
        let choice = self.cli_choice()?;
        for other in choice.installs.iter().filter(|i| i.path != ours) {
            let other_runner = runner.with_program(&other.path);
            let known = self
                .cache
                .other_sockets
                .lock()
                .ok()
                .and_then(|m| m.get(&other.path).cloned())
                .filter(|(s, at)| {
                    let ttl = if s.is_some() {
                        OTHER_SOCKET_TTL
                    } else {
                        HACKD_LOOKUP_RETRY
                    };
                    at.elapsed() < ttl
                });
            let reported = match known {
                Some((s, _)) => s,
                None => {
                    let s = self
                        .ask_cli_for_hackd(&other_runner)
                        .map(|d| d.socket().to_path_buf());
                    if let Ok(mut m) = self.cache.other_sockets.lock() {
                        m.insert(other.path.clone(), (s.clone(), std::time::Instant::now()));
                    }
                    s
                }
            };
            if reported.as_deref() == Some(socket) {
                let version = self
                    .cli_version(&other_runner)
                    .map(|v| format!(" {v}"))
                    .unwrap_or_default();
                return Some(format!(
                    "{}{version} ({})",
                    other.name,
                    other.channel.label()
                ));
            }
        }
        None
    }

    /// The cached hackd stopped answering: ask the CLI again, after the
    /// retry interval, in case it moved (an upgrade, another home).
    fn forget_hackd(&self, generation: u64) {
        if let Ok(mut found) = self.cache.hackd.lock()
            && self.cache.generation() == generation
            && let Some(f) = found.as_mut()
        {
            f.client = None;
            f.asked = std::time::Instant::now();
        }
    }

    fn ask_cli_for_hackd(&self, runner: &CliRunner) -> Option<DaemonClient> {
        let report = checked_daemon_runner(runner)
            .ok()?
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_raw(&["daemon", "status", "--json"], None, Self::DAEMON_STATUS)
            .ok()
            // Exit 1 still carries the report when hackd is not running.
            .and_then(|(out, _, _)| serde_json::from_str::<serde_json::Value>(&out).ok())
            .filter(serde_json::Value::is_object)?;
        let socket = match report.get("socket_path") {
            Some(v) => PathBuf::from(v.as_str()?),
            // A valid report from a CLI that does not name its socket: the
            // home it inherits from the app.
            None => crate::daemon::default_socket_path(
                runner
                    .env_value("HACK_HOME")
                    .and_then(|h| h.into_string().ok())
                    .as_deref(),
                std::env::var("HOME").ok().as_deref(),
            )?,
        };
        socket
            .is_absolute()
            .then(|| DaemonClient::new(socket, Duration::from_secs(3)))
    }

    #[must_use]
    pub fn new(runner: CliRunner, daemon: Option<DaemonClient>) -> Self {
        Self {
            runner,
            daemon,
            cache: CliCache::default(),
        }
    }

    /// Can the CLI at `cli` use the daemon at `daemon`? Equal versions match
    /// without a call. Otherwise the CLI decides (`hack daemon status
    /// --json` → `api_compatible`), cached per version pair. A failed or
    /// unparsable answer, or one where the API was not reachable, counts as
    /// not matching and is not cached.
    fn daemon_compatible_with(
        &self,
        runner: &CliRunner,
        generation: u64,
        cli: &str,
        daemon: &str,
    ) -> bool {
        if cli == daemon {
            return true;
        }
        let key = (cli.to_owned(), daemon.to_owned());
        if let Some(c) = self.cache.compat_get(&key) {
            return c;
        }
        let answer = checked_daemon_runner(runner)
            .ok()
            .map(|r| r.with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1"))
            .and_then(|r| {
                r.run_raw(&["daemon", "status", "--json"], None, Self::DAEMON_STATUS)
                    .ok()
            })
            // Exit 1 still carries the report when hackd is not "running".
            .and_then(|(out, _, _)| serde_json::from_str::<crate::models::DaemonStatus>(&out).ok())
            .filter(|s| s.api_reachable != Some(false))
            .and_then(|s| s.api_compatible);
        match answer {
            Some(c) => {
                self.cache.compat_put(key, c, generation);
                c
            }
            None => false,
        }
    }

    /// The daemon client to read: the configured one, else the socket
    /// `hack daemon status --json` reports (an absolute path only).
    pub(crate) fn effective_daemon(
        &self,
        status: Option<&serde_json::Value>,
    ) -> Option<DaemonClient> {
        self.daemon.clone().or_else(|| {
            let path = Path::new(status?.get("socket_path")?.as_str()?);
            if !path.is_absolute() {
                return None;
            }
            Some(DaemonClient::new(
                path.to_path_buf(),
                Duration::from_secs(3),
            ))
        })
    }

    fn runner_for(&self, native: bool) -> CliRunner {
        if native {
            self.runner
                .clone()
                .with_env("HACK_RUNTIME_BACKEND", "native")
        } else {
            self.runner
                .clone()
                .with_env("HACK_RUNTIME_BACKEND", "compose")
        }
    }

    const READ: Duration = Duration::from_secs(15);
    /// `hack daemon status --json` when the versions differ.
    const DAEMON_STATUS: Duration = Duration::from_secs(10);
    /// `usage --by-service` takes one `docker stats` sample (about 1–2 s);
    /// `ps` probes image architectures within 3 s.
    const USAGE: Duration = Duration::from_secs(15);
    /// `hack upgrade check` and `review` probe the machine and every
    /// registered project.
    const UPGRADE_READ: Duration = Duration::from_secs(180);
    /// Snapshot, the snapshot listing and restore copy files.
    const UPGRADE_WRITE: Duration = Duration::from_secs(120);

    /// Run `hack upgrade <sub> --json --no-interactive` with the selected CLI
    /// in its checked context, without starting hackd. No `--path`: upgrade
    /// commands are machine-wide and refuse it. Returns stdout whatever the exit code: the CLI reports
    /// refusals and a not-ready check as an envelope with exit 1.
    fn run_upgrade(&self, sub: &[&str], timeout: Duration) -> Result<String, String> {
        let (runner, _) = checked_cli_runner(&self.runner.fixed())?;
        let mut args = vec!["upgrade"];
        args.extend_from_slice(sub);
        args.extend(["--json", "--no-interactive"]);
        let (out, err, code) = runner
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_raw(&args, None, timeout)
            .map_err(|e| e.to_string())?;
        if out.trim().is_empty() {
            let exit = code.map_or_else(|| "was killed".into(), |n| format!("exited {n}"));
            let detail: String = err.trim().chars().take(300).collect();
            return Err(format!("hack upgrade {} {exit}. {detail}", sub[0]));
        }
        Ok(out)
    }
    /// After this long a lifecycle command is only *reported* as slow
    /// (`LIFECYCLE_WARN_AFTER`); the app never terminates it. The CLI owns
    /// lifecycle timeouts and retires the detached builds it starts; killing
    /// it from outside could orphan them (its detached build path does not
    /// forward SIGTERM today; requested of the lead).
    pub const LIFECYCLE_WARN_AFTER: Duration = Duration::from_secs(6 * 60 * 60);
    /// `open` starts nothing; a short limit is safe.
    const OPEN: Duration = Duration::from_secs(120);
}

impl Source for LiveSource {
    fn open_logs(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        args: &[String],
    ) -> Result<Box<dyn LogFeed>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        let branch = branch
            .map(validate_branch)
            .transpose()
            .map_err(|e| describe_error(&e))?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.runner_for(false)
            .stream_logs(&with_branch(&args, branch), Some(repo_root))
            .map(|s| Box::new(s) as Box<dyn LogFeed>)
            .map_err(|e| e.to_string())
    }

    fn env(&self, root: &Path, native: bool) -> crate::env::EnvView {
        self.env_for(root, native, &EnvTarget::default())
    }

    fn env_for(&self, root: &Path, native: bool, selection: &EnvTarget) -> crate::env::EnvView {
        let Some(root) = env_root(root) else {
            return crate::env::EnvView::Unreadable;
        };
        let Ok(extra) = selection.args() else {
            return crate::env::EnvView::Unreadable;
        };
        let mut args = vec!["env", "list", "--json"];
        args.extend(extra.iter().map(String::as_str));
        match self
            .runner_for(native)
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_raw(&args, Some(&root), Duration::from_secs(10))
        {
            Ok((out, _, code)) if cli_selects_exactly(&root) => {
                crate::env::EnvView::parse(&out, code)
            }
            Ok(_) => crate::env::EnvView::Unreadable,
            Err(_) => crate::env::EnvView::Unreadable,
        }
    }

    fn env_value(
        &self,
        root: &Path,
        native: bool,
        selection: &EnvTarget,
        key: &str,
    ) -> Result<crate::env::Revealed, String> {
        let root = env_root(root).ok_or("This checkout's env cannot be read")?;
        if !valid_env_name(key) {
            return Err("Not a variable name the app reads".into());
        }
        let extra = selection.args()?;
        let mut args = vec!["env", "get", key];
        args.extend(extra.iter().map(String::as_str));
        // stdout is the value; nothing from it reaches an error message.
        match self
            .runner_for(native)
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_raw(&args, Some(&root), Duration::from_secs(10))
        {
            Ok((out, _, Some(0))) if cli_selects_exactly(&root) => {
                Ok(crate::env::Revealed::new(out))
            }
            Ok((_, _, Some(0))) => Err("The checkout changed while reading; try again".into()),
            Ok((_, _, code)) => Err(format!(
                "hack env get {key} {}",
                code.map_or_else(|| "was stopped".into(), |c| format!("exited with code {c}"))
            )),
            // Only these carry no command output; anything else is named, not quoted.
            Err(e @ (RunError::NotFound | RunError::Spawn(_) | RunError::Timeout { .. })) => {
                Err(format!("hack env get {key}: {e}"))
            }
            Err(_) => Err(format!("hack env get {key} failed")),
        }
    }

    fn env_set(
        &self,
        root: &Path,
        native: bool,
        target: &EnvTarget,
        key: &str,
        secret: bool,
        value: &crate::env::Revealed,
    ) -> Result<(), String> {
        let root = env_root(root).ok_or("This checkout's env cannot be changed")?;
        let args = env_set_args(target, key, secret)?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        // `--value-stdin` strips one trailing `\r\n`, else one `\n`.
        // Ending the input with `\r\n` makes the CLI strip exactly that,
        // so a value ending in a newline or `\r` is stored as typed.
        let mut input = value.expose().as_bytes().to_vec();
        input.extend_from_slice(b"\r\n");
        match self
            .runner_for(native)
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_raw_with_input(&args, Some(&root), Duration::from_secs(20), &input)
        {
            Ok((_, _, Some(0))) => Ok(()),
            // No command output in the error: an echoed value can be
            // trimmed, escaped or cut, so no check on it is safe.
            Ok((_, _, code)) => Err(format!(
                "hack env add {key} {}. Run the command shown in a terminal to see why.",
                code.map_or_else(|| "was stopped".into(), |c| format!("exited with code {c}"))
            )),
            Err(e @ (RunError::NotFound | RunError::Spawn(_) | RunError::Timeout { .. })) => {
                Err(format!("hack env add {key}: {e}"))
            }
            Err(_) => Err(format!("hack env add {key} failed")),
        }
    }

    fn daemon_status(&self) -> Option<crate::models::DaemonStatus> {
        // Exit 1 still carries the report when hackd is not running.
        let (out, _, _) = checked_daemon_runner(&self.runner.fixed())
            .ok()?
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_raw(&["daemon", "status", "--json"], None, Self::DAEMON_STATUS)
            .ok()?;
        serde_json::from_str(&out).ok()
    }

    fn service_files(
        &self,
        target: &crate::files::Target,
        op: crate::files::Read,
        path: &str,
    ) -> Result<crate::files::Report, String> {
        crate::files::read(&self.runner_for(false).fixed(), target, op, path)
    }

    fn service_usage(&self, root: &Path) -> Result<crate::usage::UsageReport, String> {
        // Compose only: an inherited HACK_RUNTIME_BACKEND=native must not
        // change these reads.
        let v: serde_json::Value = self
            .runner_for(false)
            .fixed()
            .run_json(
                &["usage", "--json", "--by-service"],
                Some(root),
                Self::USAGE,
            )
            .map_err(|e| e.to_string())?;
        crate::usage::UsageReport::from_value(v)
    }

    fn stats_sample(&self) -> Result<crate::stats::StatsReport, String> {
        let value: serde_json::Value = self
            .runner_for(false)
            .fixed()
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .run_json(
                &["usage", "--json", "--details", "--no-host"],
                None,
                Self::USAGE,
            )
            .map_err(|e| e.to_string())?;
        if value.get("runtime_ok").and_then(serde_json::Value::as_bool) != Some(true)
            || value.get("error").is_some()
        {
            return Err("Container usage is unavailable".into());
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    fn emulated_services(
        &self,
        root: &Path,
        branch: Option<&str>,
    ) -> Result<std::collections::BTreeSet<String>, String> {
        let mut args = vec!["ps", "--json"];
        if let Some(b) = branch {
            validate_branch(b).map_err(|_| format!("{b:?} is not a branch name the app runs"))?;
            args.extend(["--branch", b]);
        }
        let v: serde_json::Value = self
            .runner_for(false)
            .fixed()
            .run_json(&args, Some(root), Self::USAGE)
            .map_err(|e| e.to_string())?;
        Ok(crate::usage::emulated_services(&v))
    }

    fn upgrade_check(&self) -> Result<crate::upgrade::CheckReport, String> {
        crate::upgrade::CheckReport::parse(&self.run_upgrade(&["check"], Self::UPGRADE_READ)?)
    }

    fn upgrade_review(&self) -> Result<crate::upgrade::Review, String> {
        crate::upgrade::envelope(&self.run_upgrade(&["review"], Self::UPGRADE_READ)?)
    }

    fn upgrade_snapshot(&self) -> Result<crate::upgrade::Snapshot, String> {
        crate::upgrade::envelope(&self.run_upgrade(&["snapshot"], Self::UPGRADE_WRITE)?)
    }

    fn upgrade_snapshots(&self) -> Result<crate::upgrade::SnapshotList, String> {
        crate::upgrade::envelope(&self.run_upgrade(&["rollback"], Self::UPGRADE_WRITE)?)
    }

    fn upgrade_restore(
        &self,
        entry: &crate::upgrade::SnapshotEntry,
    ) -> Result<crate::upgrade::Rollback, String> {
        let manifest = entry
            .manifest()
            .and_then(|p| p.to_str())
            .ok_or("That snapshot's manifest is not one the CLI keeps")?;
        // Never --overwrite: a file changed since the snapshot stays as it is.
        crate::upgrade::envelope(&self.run_upgrade(
            &["rollback", "--rollback-manifest", manifest],
            Self::UPGRADE_WRITE,
        )?)
    }

    fn recover_daemon(&self, action: DaemonRecovery) -> Result<(), String> {
        // The selected CLI in its checked context, so hackd is started or
        // restarted by this install and no other.
        let runner = checked_daemon_runner(&self.runner.fixed())
            .map_err(|e| format!("Could not {} hackd: {e}", action.command()))?;
        let (stdout, stderr, code) = runner
            .run_raw(
                &["daemon", action.command(), "--no-interactive"],
                None,
                Duration::from_secs(120),
            )
            .map_err(|e| e.to_string())?;
        if code == Some(0) {
            Ok(())
        } else {
            let exit = code.map_or_else(
                || "was killed by a signal".into(),
                |n| format!("exited with code {n}"),
            );
            // The CLI writes some diagnostics to stdout: keep both, bounded.
            let detail = [stderr.trim(), stdout.trim()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(2048).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n");
            Err(format!(
                "Could not {} hackd: command {exit}. {detail}",
                action.command(),
            ))
        }
    }
    fn setup(&self) -> crate::setup::Report {
        self.read_setup()
    }

    fn setup_action(
        &self,
        action: crate::setup::SafeAction,
        checked: &crate::setup::Report,
    ) -> String {
        crate::setup_io::run_safe(action, checked)
    }

    fn cli_choice(&self) -> Option<crate::cli_choice::Choice> {
        self.cache.choice.lock().ok()?.clone()
    }

    fn pinned(&self) -> Option<std::sync::Arc<dyn Source>> {
        Some(std::sync::Arc::new(LiveSource::new(
            self.runner.fixed(),
            self.daemon.clone(),
        )))
    }

    /// Switch every read and action to `path` (one of the installs found),
    /// save the choice, and drop what was learned from the previous CLI.
    fn use_cli(&self, path: &Path) -> Result<(), String> {
        let saved = {
            let mut guard = self.cache.choice.lock().map_err(|_| "choice unavailable")?;
            let choice = guard.as_mut().ok_or("this source has no CLI choice")?;
            choice.select(path)
        };
        let selected = self
            .cli_choice()
            .and_then(|c| c.selected)
            .filter(|i| i.path == path)
            .ok_or("not one of the installs found")?;
        self.runner.select(&selected.path);
        self.cache.clear_learned();
        saved
    }

    fn hack_program(&self) -> Option<std::path::PathBuf> {
        self.runner.program_path()
    }

    fn snapshot(&self) -> Result<Snapshot, SourceError> {
        self.snapshot_timed().0
    }

    fn listing(&self) -> Result<Snapshot, SourceError> {
        self.read_listing(&self.runner.fixed(), &mut Vec::new())
    }

    fn native_ps(&self, repo_root: &Path) -> Option<crate::models::NativePs> {
        Self::read_native_ps(&Self::native_runner(&self.runner.fixed()), repo_root)
    }

    fn copies(&self, root: &Path, native: bool) -> Result<CopiesReport, CopiesError> {
        let root = trusted_root(root).map_err(|error| CopiesError {
            reason: describe_error(&error),
            hint: "Check the project checkout and try again.".into(),
        })?;
        // The CLI gives its parallel observation jobs 45 s. Leave time for
        // project discovery and address resolution before the runner retires it.
        Ok(self.runner_for(native).run_json(
            &["ps", "--copies", "--json"],
            Some(&root),
            Duration::from_secs(60),
        )?)
    }

    fn act(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        action: Action,
    ) -> Result<ActionOutcome, SourceError> {
        self.act_on_copy(repo_root, native, branch, None, action)
    }

    fn act_on_copy(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        compose_project: Option<&str>,
        action: Action,
    ) -> Result<ActionOutcome, SourceError> {
        let branch = branch.map(validate_branch).transpose()?;
        // Actions run checkout-defined lifecycle commands as the user: run
        // only on a validated root, by its canonical path.
        let real = trusted_root(repo_root)?;
        let repo_root = real.as_path();

        let mut args = with_branch(action.cli_args(), branch);
        let expected = compose_project
            .filter(|_| !native && action != Action::Open)
            .map(|name| format!("--expect-compose-project={name}"));
        if let Some(expected) = &expected {
            args.extend(["--target", "local", expected.as_str()]);
        }
        let runner = self.runner_for(native);
        Ok(match action {
            Action::Open => {
                ActionOutcome::Opened(runner.run_json(&args, Some(repo_root), Self::OPEN)?)
            }
            // No app deadline: busy until the CLI exits (see LIFECYCLE_WARN_AFTER).
            _ => ActionOutcome::Lifecycle(runner.run_json_to_completion(&args, Some(repo_root))?),
        })
    }

    fn act_on_service(
        &self,
        repo_root: &Path,
        branch: Option<&str>,
        compose_project: Option<&str>,
        service: &str,
        action: Action,
    ) -> Result<LifecycleResult, ServiceActionError> {
        let branch = branch.map(validate_branch).transpose()?;
        let root = trusted_root(repo_root)?;
        // `--service=<name>` always stays the value of the service selector.
        let stop_option = format!("--service={service}");
        let mut args = match action {
            Action::Stop => vec![
                "down",
                "--json",
                "--no-interactive",
                "--target",
                "local",
                &stop_option,
            ],
            Action::Restart if !service.is_empty() && !service.starts_with('-') => {
                vec![
                    "restart",
                    "--json",
                    "--no-interactive",
                    "--target",
                    "local",
                    service,
                ]
            }
            _ => {
                return Err(SourceError::Cli {
                    code: "E_APP_SERVICE_ACTION".into(),
                    message: "Invalid service action or service name.".into(),
                    failed: vec![],
                }
                .into());
            }
        };
        let expected = compose_project.map(|name| format!("--expect-compose-project={name}"));
        if let Some(expected) = &expected {
            args.push(expected);
        }
        let runner = self.runner_for(false);
        Ok(runner.run_json_to_completion(&with_branch(&args, branch), Some(&root))?)
    }

    fn doctor_runs(&self, projects: &[DoctorTarget]) -> Vec<DoctorRun> {
        self.doctor_runs_within(projects, DOCTOR_BUDGET, DOCTOR_TIMEOUT)
    }

    fn log_tail(
        &self,
        repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        lines: u32,
    ) -> Result<Vec<LogEntry>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        let branch = branch
            .map(validate_branch)
            .transpose()
            .map_err(|e| describe_error(&e))?;
        let tail = lines.to_string();
        // No --compose / --services: they are backend-specific (DESIGN.md, Logs).
        let (out, err, code) = self
            .runner
            .run_raw(
                &with_branch(&["logs", "--json", "--no-follow", "--tail", &tail], branch),
                Some(repo_root),
                Self::READ,
            )
            .map_err(|e| e.to_string())?;
        parse_log_tail(&out, &err, code)
    }
}

/// A [`SourceError`] as one line for string-error APIs (logs).
fn describe_error(e: &SourceError) -> String {
    match e {
        SourceError::Cli { message, .. } | SourceError::DaemonUnavailable { message, .. } => {
            message.clone()
        }
        SourceError::CliMissing => "hack was not found on PATH".into(),
        SourceError::Pending => "still loading".into(),
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

/// Validate a registry-supplied project root before running an action that
/// executes checkout-defined lifecycle commands, and return the canonical
/// path to pass to the CLI.
///
/// The projects registry is not ownership-checked by the CLI today, so the
/// app refuses a root unless:
/// - it is absolute and canonicalises to an existing directory (the returned
///   canonical path is what runs, so a symlink cannot be swapped between
///   this check and the call);
/// - every ancestor is owned by this user or root and not writable by group
///   or others, except a root-owned sticky directory such as `/tmp`, where
///   other users cannot rename entries;
/// - the root itself is owned by this user and not group/other writable;
/// - the CLI's own discovery, started at the root, selects exactly the root
///   (mirrored by `cli_selects_exactly`), so no other project is chosen;
/// - `.hack/`, `.dev/` and every entry directly in them are plain files or
///   directories (symlinks are refused), owned by this user and not
///   group/other writable.
///
/// What remains is CLI work: the CLI should verify the registry itself and
/// bind each action to the registered identity (requested of the lead).
///
/// # Errors
/// `E_APP_UNTRUSTED_ROOT` with the reason.
pub fn trusted_root(root: &Path) -> Result<PathBuf, SourceError> {
    use std::os::unix::fs::MetadataExt;
    let refuse = |why: String| SourceError::Cli {
        code: "E_APP_UNTRUSTED_ROOT".into(),
        message: format!("Not running this action: {why}."),
        failed: vec![],
    };
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    if !root.is_absolute() {
        return Err(refuse("the project folder is not an absolute path".into()));
    }
    let real = std::fs::canonicalize(root)
        .map_err(|_| refuse("the project folder could not be read".into()))?;
    let meta = std::fs::metadata(&real)
        .map_err(|_| refuse("the project folder could not be read".into()))?;
    if !meta.is_dir() {
        return Err(refuse("the project folder is not a directory".into()));
    }
    if meta.uid() != uid || meta.mode() & 0o022 != 0 {
        return Err(refuse(
            "the project folder is not yours alone (owner or write permissions)".into(),
        ));
    }
    for dir in real.ancestors().skip(1) {
        let m = std::fs::metadata(dir)
            .map_err(|_| refuse(format!("{} could not be read", dir.display())))?;
        let owner_ok = m.uid() == uid || m.uid() == 0;
        let sticky_root = m.uid() == 0 && m.mode() & 0o1000 != 0;
        if !owner_ok || (m.mode() & 0o022 != 0 && !sticky_root) {
            return Err(refuse(format!(
                "{} can be changed by another user",
                dir.display()
            )));
        }
    }
    // Config entries must be plain files and directories (no symlinks: a
    // link target's own path chain could be writable by others), owned by
    // this user and closed to group and others.
    let private = |p: &Path| -> Result<(), SourceError> {
        let m = std::fs::symlink_metadata(p)
            .map_err(|_| refuse(format!("{} could not be read", p.display())))?;
        if m.file_type().is_symlink() {
            return Err(refuse(format!("{} is a symbolic link", p.display())));
        }
        if m.uid() != uid || m.mode() & 0o022 != 0 {
            return Err(refuse(format!(
                "{} is not yours alone (owner or write permissions)",
                p.display()
            )));
        }
        Ok(())
    };
    // The CLI must select exactly this root (see `discoverProjectInputs`).
    if !cli_selects_exactly(&real) {
        return Err(refuse(
            "the project folder is not the project the CLI would select from it".into(),
        ));
    }
    for d in [real.join(".hack"), real.join(".dev")] {
        if std::fs::symlink_metadata(&d).is_err() {
            continue;
        }
        private(&d)?;
        let entries = std::fs::read_dir(&d)
            .map_err(|_| refuse(format!("{} could not be read", d.display())))?;
        for e in entries {
            let e = e.map_err(|_| refuse(format!("{} could not be read", d.display())))?;
            private(&e.path())?;
        }
    }
    Ok(real)
}

#[derive(PartialEq, Eq)]
struct DoctorRootWitness(PathBuf, PathBuf, u64, u64, i64, i64);

/// Read-only witness of exact discovery, not a lock against same-user edits.
fn exact_doctor_root(root: &Path) -> Option<DoctorRootWitness> {
    use std::os::unix::fs::MetadataExt;
    if !root.is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(root).ok()?;
    if !cli_selects_exactly(&real) {
        return None;
    }
    let marker = [
        ".hack/hack.project.json",
        ".hack/docker-compose.yml",
        ".dev/docker-compose.yml",
    ]
    .into_iter()
    .map(|p| real.join(p))
    .find(|p| p.is_file())?;
    let meta = std::fs::metadata(&marker).ok()?;
    Some(DoctorRootWitness(
        real,
        marker,
        meta.dev(),
        meta.ino(),
        meta.mtime(),
        meta.mtime_nsec(),
    ))
}

/// Mirror of `discoverProjectInputs`: native or .hack Compose at this root
/// wins; .dev Compose may lose to an ancestor .hack before a native boundary.
fn cli_selects_exactly(root: &Path) -> bool {
    let native = |d: &Path| d.join(".hack/hack.project.json").exists();
    let hack_compose = |d: &Path| d.join(".hack/docker-compose.yml").is_file();
    let dev_compose = |d: &Path| d.join(".dev/docker-compose.yml").is_file();
    if native(root) || hack_compose(root) {
        return true;
    }
    if !dev_compose(root) {
        return false;
    }
    for a in root.ancestors().skip(1) {
        if native(a) {
            return true;
        }
        if hack_compose(a) {
            return false;
        }
    }
    true
}

/// Canned data for one designed state.
pub struct FixtureSource(pub Fixture);

impl Source for FixtureSource {
    fn open_logs(
        &self,
        _repo_root: &Path,
        native: bool,
        branch: Option<&str>,
        args: &[String],
    ) -> Result<Box<dyn LogFeed>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        if let Some(b) = branch {
            validate_branch(b).map_err(|e| describe_error(&e))?;
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

    fn env(&self, _root: &Path, _native: bool) -> crate::env::EnvView {
        crate::env::fixture(self.0.name())
    }

    fn env_value(
        &self,
        _root: &Path,
        _native: bool,
        _target: &EnvTarget,
        key: &str,
    ) -> Result<crate::env::Revealed, String> {
        // Obviously fake values only; a name the listing does not have fails.
        match crate::env::fixture(self.0.name()) {
            crate::env::EnvView::Report(r) if r.vars.iter().any(|v| v.key == key && !v.missing) => {
                Ok(crate::env::Revealed::new(crate::env::fixture_value(key)))
            }
            _ => Err(format!("hack env get {key} exited with code 1")),
        }
    }

    fn env_set(
        &self,
        _root: &Path,
        _native: bool,
        target: &EnvTarget,
        key: &str,
        secret: bool,
        _value: &crate::env::Revealed,
    ) -> Result<(), String> {
        // Fixtures store nothing; they check the command as the CLI would get it.
        env_set_args(target, key, secret).map(|_| ())
    }

    fn snapshot(&self) -> Result<Snapshot, SourceError> {
        fixtures::snapshot(self.0)
    }

    fn daemon_status(&self) -> Option<crate::models::DaemonStatus> {
        fixtures::daemon_status(self.0)
    }

    fn upgrade_check(&self) -> Result<crate::upgrade::CheckReport, String> {
        fixtures::upgrade_check(self.0)
    }

    fn service_usage(&self, _root: &Path) -> Result<crate::usage::UsageReport, String> {
        fixtures::service_usage(self.0)
    }

    fn emulated_services(
        &self,
        _root: &Path,
        _branch: Option<&str>,
    ) -> Result<std::collections::BTreeSet<String>, String> {
        Ok(fixtures::emulated_services(self.0))
    }

    fn upgrade_review(&self) -> Result<crate::upgrade::Review, String> {
        Ok(fixtures::upgrade_review())
    }

    fn upgrade_snapshot(&self) -> Result<crate::upgrade::Snapshot, String> {
        Ok(fixtures::upgrade_snapshot())
    }

    fn upgrade_snapshots(&self) -> Result<crate::upgrade::SnapshotList, String> {
        Ok(fixtures::upgrade_snapshots())
    }

    fn upgrade_restore(
        &self,
        entry: &crate::upgrade::SnapshotEntry,
    ) -> Result<crate::upgrade::Rollback, String> {
        entry
            .manifest()
            .ok_or("That snapshot's manifest is not one the CLI keeps")?;
        Ok(fixtures::upgrade_restore())
    }

    fn doctor_runs(&self, _projects: &[DoctorTarget]) -> Vec<DoctorRun> {
        fixtures::doctor_runs(self.0)
    }

    fn act(
        &self,
        _repo_root: &Path,
        _native: bool,
        branch: Option<&str>,
        action: Action,
    ) -> Result<ActionOutcome, SourceError> {
        let branch = branch.map(validate_branch).transpose()?;
        Ok(match action {
            Action::Open => ActionOutcome::Opened(OpenResult {
                url: branch.map_or_else(
                    || "https://storefront.hack".into(),
                    |b| format!("https://{b}.storefront.hack"),
                ),
                hint: None,
            }),
            _ => ActionOutcome::Lifecycle(LifecycleResult::default()),
        })
    }

    fn log_tail(
        &self,
        _repo_root: &Path,
        native: bool,
        _branch: Option<&str>,
        _lines: u32,
    ) -> Result<Vec<LogEntry>, String> {
        if native {
            return Err(NATIVE_LOGS_NOTE.into());
        }
        Ok(fixtures::log_tail(self.0))
    }
}

/// Which overlay and scope an env read is for. `None` leaves it to the CLI.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvTarget {
    /// `--env` (`default` is the CLI's name for the base layers).
    pub env: Option<String>,
    /// `--service` (`global` or a service name).
    pub scope: Option<String>,
    /// Writes only: `--local`, the worktree-local layer
    /// (`hack.env[.<overlay>].local.yaml`) instead of the shared file.
    pub local: bool,
}

impl EnvTarget {
    /// The CLI arguments, refusing anything that is not a plain name.
    ///
    /// # Errors
    /// An overlay or scope name the app does not pass to the CLI.
    pub fn args(&self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        if let Some(env) = &self.env {
            if !valid_selector(env) {
                return Err("Not an overlay name the app passes to the CLI".into());
            }
            out.extend(["--env".into(), env.clone()]);
        }
        if let Some(scope) = &self.scope {
            if !valid_selector(scope) {
                return Err("Not a scope name the app passes to the CLI".into());
            }
            out.extend(["--service".into(), scope.clone()]);
        }
        Ok(out)
    }
}

/// The argv for setting `key` in `target` (`hack env add KEY [--secret]
/// --value-stdin [--env X] [--service S]`), names checked. The value is
/// never part of it.
///
/// # Errors
/// A name the app does not pass to the CLI.
pub fn env_set_args(target: &EnvTarget, key: &str, secret: bool) -> Result<Vec<String>, String> {
    if !valid_env_name(key) {
        return Err("Not a variable name the app writes".into());
    }
    let mut args = vec!["env".to_owned(), "add".into(), key.into()];
    if secret {
        args.push("--secret".into());
    }
    args.push("--value-stdin".into());
    if target.local {
        args.push("--local".into());
    }
    args.extend(target.args()?);
    Ok(args)
}

/// The command shown before a write runs, exactly as run but without the
/// checkout path, and never the value: `hack env add API_TOKEN --secret
/// --value-stdin --env staging --service api`.
///
/// # Errors
/// As [`env_set_args`].
pub fn env_set_command(target: &EnvTarget, key: &str, secret: bool) -> Result<String, String> {
    Ok(format!(
        "hack {}",
        env_set_args(target, key, secret)?.join(" ")
    ))
}

/// Overlay and scope names: letters, digits, `.`, `_` and `-`, not starting
/// with `-` (never read as an option), at most 128 bytes.
fn valid_selector(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Variable names as the CLI lists them: a letter or `_`, then letters,
/// digits and `_`, at most 256 bytes.
fn valid_env_name(s: &str) -> bool {
    s.len() <= 256
        && s.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The checkout an env command runs in. `hack env` walks ancestors, so a
/// missing or shadowed project marker is refused instead of reading an
/// ancestor's env as this project's.
fn env_root(root: &Path) -> Option<std::path::PathBuf> {
    if !root.is_absolute() {
        return None;
    }
    let root = std::fs::canonicalize(root).ok()?;
    (root.is_dir() && cli_selects_exactly(&root)).then_some(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_socket_requires_explicit_absolute_cli_evidence() {
        let source = LiveSource {
            cache: Default::default(),
            runner: CliRunner::new("/missing/hack-next"),
            daemon: None,
        };
        for status in [
            serde_json::json!({}),
            serde_json::json!({"socket_path":"relative/hackd.sock"}),
            serde_json::json!({"socket_path":false}),
        ] {
            assert!(source.effective_daemon(Some(&status)).is_none());
        }
        assert!(source.effective_daemon(None).is_none());
        assert!(
            source
                .effective_daemon(Some(
                    &serde_json::json!({"socket_path":"/private/candidate/daemon/hackd.sock"})
                ))
                .is_some()
        );
    }

    fn fixture_runner(hack: &Path) -> CliRunner {
        let root = hack.parent().unwrap().to_str().unwrap();
        let bin = hack.parent().unwrap().join("fixture-tools");
        std::fs::create_dir_all(&bin).unwrap();
        for name in ["sleep", "cat", "pwd", "git"] {
            let tool = bin.join(name);
            if !tool.exists() {
                let installed = if name == "git" {
                    Path::new("/usr/bin")
                } else {
                    Path::new("/bin")
                };
                std::os::unix::fs::symlink(installed.join(name), tool).unwrap();
            }
        }
        CliRunner::new(hack)
            .with_env("HOME", root)
            .with_env("HACK_HOME", root)
            .with_env("HACK_MUTAGEN_PATH", "")
            .with_env("PATH", bin.to_str().unwrap())
    }

    impl LiveSource {
        // Fake CLIs must not inspect the runner's actual Docker configuration
        // or installed plugin directories. The production gate is exercised
        // with explicit owned inputs in the dedicated discovery tests below.
        fn fixture_doctor_runs(&self, projects: &[DoctorTarget]) -> Vec<DoctorRun> {
            self.fixture_doctor_runs_within(projects, DOCTOR_BUDGET, DOCTOR_TIMEOUT)
        }

        fn fixture_doctor_runs_within(
            &self,
            projects: &[DoctorTarget],
            budget: Duration,
            timeout: Duration,
        ) -> Vec<DoctorRun> {
            // Only a private directory for the discovery inputs: no
            // executable to write or launch, so nothing here is timed by a
            // budget test except the Doctor run itself.
            let root = &private_temp_dir("plugin-inputs");
            let discovery = crate::doctor_plugins::Discovery {
                config_dir: Some(root.join("client")),
                unsupported_extra_selector: false,
                docker_host: None,
                context: None,
                system_dirs: vec![root.join("system-plugins")],
            };
            let runs = self.doctor_runs_with_discovery(projects, budget, timeout, &discovery);
            let _ = std::fs::remove_dir_all(root);
            runs
        }
    }

    fn fake_daemon(projects: &str) -> (DaemonClient, std::thread::JoinHandle<()>) {
        fake_daemon_bodies(vec![
            r#"{"status":"ok","version":"5.0.0"}"#.to_owned(),
            projects.to_owned(),
        ])
    }

    /// A fake hackd answering one request per body, in order.
    fn fake_daemon_bodies(bodies: Vec<String>) -> (DaemonClient, std::thread::JoinHandle<()>) {
        use std::io::Write;
        use std::os::unix::{fs::DirBuilderExt, net::UnixListener};
        let dir = PathBuf::from(format!(
            "/tmp/hds-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = dir.join("s");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + crate::test_support::DAEMON_BUDGET;
            for body in bodies {
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(pair) => break pair,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("fake daemon accept failed or timed out: {e}"),
                    }
                };
                crate::test_support::read_request(&mut stream, deadline);
                stream
                    .set_write_timeout(Some(crate::test_support::remaining(deadline)))
                    .unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
            std::fs::remove_dir_all(dir).unwrap();
        });
        (
            DaemonClient::new(socket, crate::test_support::DAEMON_BUDGET),
            handle,
        )
    }

    #[test]
    fn fake_daemon_waits_for_delayed_and_partial_request_headers() {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        use std::os::unix::{
            fs::DirBuilderExt,
            net::{UnixListener, UnixStream},
        };
        let dir = PathBuf::from(format!(
            "/tmp/hdr-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = dir.join("s");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (ready, waiting) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + crate::test_support::DAEMON_BUDGET;
            let mut server = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("regression fixture accept: {error}"),
                }
            };
            // Force Darwin's inherited-mode case on Linux as well.
            server.set_nonblocking(true).unwrap();
            ready.send(()).unwrap();
            crate::test_support::read_request(&mut server, deadline);
            // SAFETY: the accepted stream remains live; inspect its flags.
            let flags = unsafe { libc::fcntl(server.as_raw_fd(), libc::F_GETFL) };
            assert!(flags >= 0);
            assert_eq!(
                flags & libc::O_NONBLOCK,
                0,
                "accepted stream must be blocking"
            );
        });
        let mut client = UnixStream::connect(&socket).unwrap();
        waiting
            .recv_timeout(crate::test_support::DAEMON_BUDGET)
            .unwrap();
        // Exceed the former two-second timeout, then split the header.
        std::thread::sleep(Duration::from_millis(2500));
        client.write_all(b"GET /v1/status HTTP/1.1\r\n").unwrap();
        std::thread::sleep(Duration::from_millis(10));
        client.write_all(b"Host: fixture\r\n\r\n").unwrap();
        worker.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A trusted fake daemon provides rows; only native ps uses the fake CLI.
    #[test]
    fn a_listing_runs_no_native_ps_and_each_native_read_runs_one() {
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-listing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        let log = dir.join("ps.log");
        crate::test_support::script(
            &hack,
            format!(
                r#"#!/bin/sh
case "$1" in
  version) echo '{{"ok":true,"data":{{"schema":"hack.version.v1","version":"5.0.0"}}}}' ;;
  ps) echo "$HACK_RUNTIME_BACKEND" >> '{log}'; echo '{{"ok":true,"data":{{"backend":"native","status":"not_started","items":[]}}}}' ;;
esac
"#,
                log = log.display()
            ),
        );
        let runner = || {
            fixture_runner(&hack)
                .with_env("HOME", &dir.to_string_lossy())
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        };
        runner().version(Duration::from_secs(60)).unwrap();
        let (daemon, server) = fake_daemon(
            r#"{"runtime_ok":true,"projects":[{"name":"svc","status":"running","repo_root":"/work/svc"},{"name":"nat","status":"unavailable","repo_root":"/work/nat","backend":"native"},{"name":"gone","status":"missing","backend":"native"}]}"#,
        );
        let src = LiveSource {
            cache: Default::default(),
            runner: runner(),
            daemon: Some(daemon),
        };
        let listing = src.listing().unwrap();
        server.join().unwrap();
        assert!(!log.exists(), "the listing ran no hack ps");
        let row = |name: &str| {
            listing
                .projects
                .projects
                .iter()
                .find(|p| p.name == name)
                .unwrap()
                .clone()
        };
        assert!(row("nat").native_pending && row("nat").native.is_none());
        assert!(!row("svc").native_pending, "Compose rows are complete");
        assert!(!row("gone").native_pending, "no checkout, nothing to read");
        let ps = src.native_ps(Path::new("/work/nat")).unwrap();
        let backends = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(ps.status, "not_started");
        assert_eq!(backends, "native\n", "one ps, with the native backend");
    }

    #[test]
    fn automatic_daemon_status_reads_run_the_selected_cli_in_its_checked_context() {
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-status-ctx-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        let env_log = dir.join("status-env");
        crate::test_support::script(
            &hack,
            format!(
                r#"#!/bin/sh
if [ "$1 $2" = "daemon status" ]; then
  {{ echo "stray=${{STRAY_SETTING:-unset}}"; echo "autostart=$HACK_DAEMON_AUTOSTART_DISABLE"; echo "mcp=$HACK_MCP_COMMAND"; }} > '{log}'
  echo '{{"status":"stopped","running":false,"socket_path":"{dir}/hackd.sock"}}'; exit 1
fi
"#,
                log = env_log.display(),
                dir = dir.display()
            ),
        );
        let src = LiveSource::new(
            fixture_runner(&hack)
                .with_env("HOME", &dir.to_string_lossy())
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("STRAY_SETTING", "from the app's environment"),
            None,
        );
        let found = src.hackd();
        let env = std::fs::read_to_string(&env_log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            found.map(|d| d.socket().to_path_buf()),
            Some(dir.join("hackd.sock"))
        );
        assert!(
            env.contains("stray=unset\n"),
            "only the checked allowlist: {env}"
        );
        assert!(env.contains("autostart=1\n"), "{env}");
        assert!(
            env.contains(&format!("mcp={}\n", hack.display())),
            "pinned to the selected CLI: {env}"
        );
    }

    #[test]
    fn a_context_that_cannot_be_checked_is_an_error_never_hackd_off() {
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-ctx-err-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        let called = dir.join("status-called");
        crate::test_support::script(
            &hack,
            format!(
                r#"#!/bin/sh
case "$1" in
  version) echo '{{"ok":true,"data":{{"schema":"hack.version.v1","version":"5.0.0"}}}}' ;;
  daemon) : > '{called}'; exit 1 ;;
esac
"#,
                called = called.display()
            ),
        );
        let src = LiveSource::new(
            fixture_runner(&hack)
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("HOME", "relative/home"),
            None,
        );
        let result = src.snapshot();
        let status_ran = called.exists();
        let _ = std::fs::remove_dir_all(&dir);
        let Err(e @ SourceError::Cli { .. }) = result else {
            panic!("expected the context error, got {result:?}");
        };
        let mut model = crate::viewmodel::AppModel::new();
        model.apply(crate::viewmodel::Event::Refreshed(Err(e)));
        assert_eq!(
            model.daemon_recovery(),
            None,
            "no Start for an unchecked context"
        );
        assert!(
            !status_ran,
            "no daemon command ran outside the checked context"
        );
    }

    #[test]
    fn upgrade_commands_run_the_checked_cli_and_restore_never_overwrites() {
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-upgrade-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        let log = dir.join("calls");
        let check = include_str!("../tests/fixtures/upgrade/check-v2.json").replace('\'', "");
        crate::test_support::script(
            &hack,
            format!(
                r#"#!/bin/sh
echo "$* | stray=${{STRAY_SETTING:-unset}}" >> '{log}'
case "$2" in
  check) printf '%s' '{check}'; exit 1 ;;
  rollback) echo '{{"ok":true,"data":{{"status":"restored","results":[{{"path":"/a","label":"a","status":"restored"}}]}}}}' ;;
esac
"#,
                log = log.display(),
                check = check.replace('\n', " ")
            ),
        );
        let src = LiveSource::new(
            fixture_runner(&hack)
                .with_env("HOME", &dir.to_string_lossy())
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("STRAY_SETTING", "from the app's environment"),
            None,
        );
        let report = src
            .upgrade_check()
            .expect("exit 1 still carries the report");
        assert!(report.ready);
        let manifest = format!("{}/upgrade/snapshots/s1/manifest.json", dir.display());
        let listed = crate::upgrade::SnapshotEntry {
            id: "s1".into(),
            manifest_path: manifest.clone(),
            ..crate::upgrade::SnapshotEntry::default()
        };
        assert_eq!(src.upgrade_restore(&listed).unwrap().status, "restored");
        let unlisted = crate::upgrade::SnapshotEntry {
            id: "s1".into(),
            manifest_path: "/tmp/elsewhere/manifest.json".into(),
            ..crate::upgrade::SnapshotEntry::default()
        };
        assert!(src.upgrade_restore(&unlisted).is_err(), "never run");
        let calls = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        let lines: Vec<&str> = calls.lines().collect();
        assert_eq!(
            lines,
            vec![
                "upgrade check --json --no-interactive | stray=unset".to_owned(),
                format!(
                    "upgrade rollback --rollback-manifest {manifest} --json --no-interactive | stray=unset"
                ),
            ]
        );
        assert!(!calls.contains("--overwrite") && !calls.contains("--path"));
    }

    #[test]
    fn live_source_reads_native_rows_with_native_backend() {
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
        crate::test_support::script(
            &hack,
            r#"#!/bin/sh
case "$1" in
  version) echo '{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}'  ;;
  projects) echo '{"runtime_ok":true,"projects":[{"name":"svc","status":"running","repo_root":"/work/svc"},{"name":"nat","status":"unavailable","repo_root":"/work/nat","input_diagnostic":{"code":"E_NATIVE_PROJECT_UNSUPPORTED","message":"m"}}]}' ;;
  ps) if [ "$HACK_RUNTIME_BACKEND" = native ]; then echo '{"ok":true,"data":{"backend":"native","status":"pending","items":[]}}'; else echo '{"ok":false,"error":{"code":"E_NATIVE_PROJECT_UNSUPPORTED","message":"m"}}'; exit 1; fi ;;
esac
"#,
        );
        // Complete macOS first-launch scanning before the fake daemon's
        // bounded accept window starts. version --json has no fixture effects.
        fixture_runner(&hack)
            .with_env("HOME", &dir.to_string_lossy())
            .with_env("HACK_HOME", &dir.to_string_lossy())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .version(Duration::from_secs(60))
            .unwrap();
        let (daemon, server) = fake_daemon(
            r#"{"runtime_ok":true,"projects":[{"name":"svc","status":"running","repo_root":"/work/svc"},{"name":"nat","status":"unavailable","repo_root":"/work/nat","backend":"native"}]}"#,
        );
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack)
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("HOME", &dir.to_string_lossy())
                .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1"),
            daemon: Some(daemon),
        };
        let snap = src.snapshot().unwrap();
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(snap.daemon.is_some());
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
        crate::test_support::script(
            &hack,
            "#!/bin/sh\ncase \"$1\" in version) echo '{\"ok\":true,\"data\":{\"schema\":\"hack.version.v1\",\"version\":\"5.0.0\"}}' ;; projects) echo '{}' ;; esac\n",
        );
        fixture_runner(&hack)
            .with_env("HOME", &dir.to_string_lossy())
            .with_env("HACK_HOME", &dir.to_string_lossy())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .version(Duration::from_secs(60))
            .unwrap();
        let (daemon, server) = fake_daemon("{}");
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack)
                .with_env("HOME", &dir.to_string_lossy())
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1"),
            daemon: Some(daemon),
        };
        let r = src.snapshot();
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            matches!(&r, Err(SourceError::DaemonUnavailable { .. })),
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

    /// Docker's metadata directory name for a context: hex sha256 of the name.
    fn context_dir(name: &str) -> String {
        <sha2::Sha256 as sha2::Digest>::digest(name.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// A new owner-only directory under the temp dir, for fixture inputs.
    fn private_temp_dir(tag: &str) -> std::path::PathBuf {
        use std::os::unix::fs::DirBuilderExt;
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir
    }

    fn fake_hack(tag: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-{tag}-{}-{}",
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
            format!("#!/bin/sh\nif [ \"$1\" = __warmup ]; then echo '{{}}'; exit 0; fi\n{body}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Match the core fixture warmup: macOS first-launch scanning must
        // finish before Doctor's short budget tests start their clocks.
        fixture_runner(&hack)
            .run_json::<serde_json::Value>(&["__warmup"], None, Duration::from_secs(60))
            .expect("Doctor fake CLI warmup");
        hack
    }

    fn targets(n: usize) -> Vec<DoctorTarget> {
        (0..n)
            .map(|i| DoctorTarget {
                missing: false,
                name: format!("p{i}"),
                repo_root: format!("/work/p{i}").into(),
                native: false,
                browser_url: None,
            })
            .collect()
    }

    #[test]
    fn doctor_probes_only_read_and_select_each_backend() {
        let hack = fake_hack(
            "doctor-contract",
            r#"[ "$HACK_NO_INTERACTIVE" = 1 ] || exit 2
case "$*" in
  'doctor --json')
    detail=machine ;;
  'doctor --json --path /work/p0')
    [ "$HACK_RUNTIME_BACKEND" = native ] || exit 3
    detail=native ;;
  'doctor --json --path /work/p1')
    [ "$HACK_RUNTIME_BACKEND" = compose ] || exit 4
    detail=compose ;;
  *) exit 5 ;;
esac
printf '{"ok":true,"data":{"checks":[{"id":"probe","status":"ok","detail":"%s"}]}}' "$detail"
"#,
        );
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack).with_env("HACK_RUNTIME_BACKEND", "native"),
            daemon: None,
        };
        let mut projects = targets(2);
        projects[0].native = true;
        let runs = src.fixture_doctor_runs(&projects);
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        let details: Vec<_> = runs
            .iter()
            .map(|run| run.result.as_ref().unwrap().checks[0].detail.as_str())
            .collect();
        assert_eq!(details, ["machine", "native", "compose"]);
    }

    #[test]
    fn adopted_target_inferred_native_is_checked_with_compose() {
        let hack = fake_hack(
            "doctor-adopted",
            r#"if [ "$HACK_RUNTIME_BACKEND" = compose ]; then
echo "{\"ok\":true,\"data\":{\"checks\":[{\"id\":\"project\",\"status\":\"warn\",\"detail\":\"Adopted Compose project at /work/p0/.hack has a pending or interrupted adoption operation. Use explicit adoption recovery before other project commands; values omitted.\"}]}}"
else
echo '{"ok":true,"data":{"checks":[{"id":"native root trust","status":"ok","detail":"trusted"}]}}'
fi"#,
        );
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack),
            daemon: None,
        };
        let mut targets = targets(1);
        targets[0].native = true;
        let runs = source.fixture_doctor_runs(&targets);
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        assert!(!runs[1].native);
        let view = crate::doctor::aggregate(&runs);
        assert_eq!(view.projects_checked, 1);
        assert!(!view.is_clean());
    }

    #[test]
    fn doctor_git_reads_disable_repository_fsmonitor() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack(
            "doctor-git",
            r#"git -C "$HACK_HOME/repo" ls-files >/dev/null || exit 2
echo '{"ok":true,"data":{"checks":[{"id":"docker","status":"ok","detail":""}]}}'"#,
        );
        let dir = hack.parent().unwrap();
        let repo = dir.join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("/usr/bin/git")
                .env("HOME", dir)
                .env("PATH", "/usr/bin:/bin")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HACK_HOME", dir)
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q"]).status.success());
        std::fs::write(repo.join("tracked"), "fixture").unwrap();
        assert!(git(&["add", "tracked"]).status.success());
        let hook = dir.join("fsmonitor");
        std::fs::write(
            &hook,
            "#!/bin/sh\nprintf called > \"$HACK_HOME/executed\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            git(&["config", "core.fsmonitor", hook.to_str().unwrap()])
                .status
                .success()
        );
        assert!(git(&["ls-files"]).status.success());
        assert!(
            dir.join("executed").exists(),
            "negative control must run the harmless hook"
        );
        std::fs::remove_file(dir.join("executed")).unwrap();
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack).with_env("HACK_HOME", &dir.to_string_lossy()),
            daemon: None,
        };
        let runs = source.fixture_doctor_runs(&[]);
        assert!(runs[0].result.is_ok());
        assert!(!dir.join("executed").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn doctor_nested_tools_cannot_use_writable_absolute_path_entries() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack(
            "doctor-path",
            "git --version >/dev/null || exit 2\necho '{}'",
        );
        let dir = hack.parent().unwrap();
        let hostile = dir.join("writable");
        std::fs::create_dir(&hostile).unwrap();
        std::fs::set_permissions(&hostile, std::fs::Permissions::from_mode(0o777)).unwrap();
        let git = hostile.join("git");
        std::fs::write(&git, "#!/bin/sh\nprintf called > \"$HACK_HOME/executed\"\n").unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        let inherited = format!("{}:/usr/bin:/bin", hostile.display());
        let runner = fixture_runner(&hack).with_env("HACK_HOME", &dir.to_string_lossy());
        runner
            .clone()
            .with_env("PATH", &inherited)
            .run_json::<serde_json::Value>(&[], None, Duration::from_secs(60))
            .unwrap();
        assert!(
            dir.join("executed").exists(),
            "negative control must execute the harmless nested tool"
        );
        std::fs::remove_file(dir.join("executed")).unwrap();
        let trusted = trusted_probe_path(std::ffi::OsStr::new(&inherited)).unwrap();
        assert_ne!(Path::new(trusted.path()), hostile);
        runner
            .with_env("PATH", &trusted.path().to_string_lossy())
            .run_json::<serde_json::Value>(&[], None, Duration::from_secs(60))
            .unwrap();
        assert!(!dir.join("executed").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn doctor_nested_tools_reject_writable_files_and_symlink_targets() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let hack = fake_hack(
            "doctor-tool-file",
            "git --version >/dev/null || exit 2\necho '{}'",
        );
        let dir = hack.parent().unwrap();
        let bin = dir.join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let target = dir.join("writable-tool");
        let body = "#!/bin/sh\nprintf called > \"$HACK_HOME/executed\"\n";
        std::fs::write(&target, body).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o777)).unwrap();
        let git = bin.join("git");
        let inherited = format!("{}:/usr/bin:/bin", bin.display());
        let runner = fixture_runner(&hack).with_env("HACK_HOME", &dir.to_string_lossy());
        for linked in [false, true] {
            if linked {
                symlink(&target, &git).unwrap();
            } else {
                std::fs::write(&git, body).unwrap();
                std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o777)).unwrap();
            }
            runner
                .clone()
                .with_env("PATH", &inherited)
                .run_json::<serde_json::Value>(&[], None, Duration::from_secs(60))
                .unwrap();
            assert!(dir.join("executed").exists(), "negative control {linked}");
            std::fs::remove_file(dir.join("executed")).unwrap();
            let trusted = trusted_probe_path(std::ffi::OsStr::new(&inherited)).unwrap();
            assert_ne!(Path::new(trusted.path()), bin);
            runner
                .clone()
                .with_env("PATH", &trusted.path().to_string_lossy())
                .run_json::<serde_json::Value>(&[], None, Duration::from_secs(60))
                .unwrap();
            assert!(!dir.join("executed").exists());
            std::fs::remove_file(&git).unwrap();
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn docker_context_metadata_rejects_acl_write_grants() {
        let hack = fake_hack("doctor-context-acl", "echo '{}'");
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let client = root.join("client");
        let meta = client.join("contexts/meta").join(context_dir("selected"));
        std::fs::create_dir_all(&meta).unwrap();
        let file = meta.join("meta.json");
        std::fs::write(
            &file,
            r#"{"Name":"selected","Endpoints":{"docker":{"Host":"unix:///example/docker.sock"}}}"#,
        )
        .unwrap();
        let discovery = crate::doctor_plugins::Discovery {
            config_dir: Some(client.clone()),
            unsupported_extra_selector: false,
            system_dirs: vec![],
            docker_host: None,
            context: Some("selected".into()),
        };
        assert!(
            crate::doctor_plugins::validate(&discovery).is_ok(),
            "positive control"
        );
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone allow write"])
                .arg(&file)
                .status()
                .unwrap()
                .success()
        );
        assert!(crate::doctor_plugins::validate(&discovery).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tools_and_plugins_reject_acl_mutation_grants() {
        let hack = fake_hack("doctor-tool-acl", "echo '{}'");
        let dir = hack.parent().unwrap();
        let uid = unsafe { libc::getuid() };
        assert!(
            std::process::Command::new("/bin/chmod")
                .arg("-N")
                .arg(&hack)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            crate::doctor_acl::controlled(&hack),
            "no ACL is not an unknown ACL"
        );
        assert!(
            !crate::doctor_acl::controlled(&dir.join("missing")),
            "missing is not no-ACL"
        );
        use std::os::unix::fs::PermissionsExt;
        for mode in [0o711, 0o111] {
            std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(
                trusted_tool_path(&hack, uid, false).is_some(),
                "owned execute-only tools must not need read access for ACL inspection"
            );
        }
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        for rule in ["everyone deny delete", "everyone allow read"] {
            assert!(
                std::process::Command::new("/bin/chmod")
                    .args(["+a", rule])
                    .arg(&hack)
                    .status()
                    .unwrap()
                    .success()
            );
            assert!(trusted_tool_path(&hack, uid, false).is_some());
            assert!(
                std::process::Command::new("/bin/chmod")
                    .arg("-N")
                    .arg(&hack)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        for path in [&hack, dir] {
            assert!(
                std::process::Command::new("/bin/chmod")
                    .args(["+a", "everyone allow write,delete"])
                    .arg(path)
                    .status()
                    .unwrap()
                    .success()
            );
            assert!(trusted_tool_path(&hack, uid, false).is_none());
            assert!(!crate::doctor_plugins::guarded_names(
                &hack, uid, &mut 64, false
            ));
            assert!(
                std::process::Command::new("/bin/chmod")
                    .arg("-N")
                    .arg(path)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn plugins_and_native_runtime_require_a_trusted_interpreter() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-plugin-native-interp", "echo '{}'");
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let shared = root.join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::copy("/bin/sh", shared.join("interp")).unwrap();
        let client = root.join("client");
        std::fs::create_dir_all(client.join("cli-plugins")).unwrap();
        let script = |path: &Path, shebang: &str| {
            std::fs::write(path, format!("#!{shebang}\n")).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let plugin = client.join("cli-plugins/docker-compose");
        let discovery = crate::doctor_plugins::Discovery {
            config_dir: Some(client.clone()),
            unsupported_extra_selector: false,
            docker_host: None,
            context: None,
            system_dirs: vec![],
        };
        script(&plugin, "/bin/sh");
        assert!(crate::doctor_plugins::validate(&discovery).is_ok());
        script(&plugin, shared.join("interp").to_str().unwrap());
        assert!(crate::doctor_plugins::validate(&discovery).is_err());
        // A native candidate runtime is spawned directly, without the
        // wrapper PATH: an unsafe interpreter and the env form are refused.
        let native = root.join("native-runtime");
        let runner = fixture_runner(&hack)
            .with_env("HACK_HOME", root.to_str().unwrap())
            .with_env("HACK_NATIVE_BINARY", native.to_str().unwrap());
        for (shebang, ok) in [
            ("/bin/sh", true),
            (shared.join("interp").to_str().unwrap(), false),
            ("/usr/bin/env sh", false),
        ] {
            script(&native, shebang);
            assert_eq!(
                crate::doctor_plugins::validate_helpers(&runner).is_ok(),
                ok,
                "{shebang}"
            );
        }
        assert!(
            crate::doctor_plugins::validate_helpers(
                &runner.with_env("HACK_NATIVE_BINARY", "relative-runtime")
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// With `HACK_NATIVE_BINARY` unset the CLI would run `hack-native` from
    /// beside its own executable, so Doctor checks that fallback and pins the
    /// result; a `#!` launcher's fallback is unknowable and pinned absent.
    #[test]
    fn doctor_checks_and_pins_the_adjacent_native_fallback() {
        use crate::doctor_plugins::{NativePin, validate_helpers};
        use std::os::unix::fs::PermissionsExt;
        let launcher = fake_hack("doctor-native-fallback", "echo '{}'");
        let root = std::fs::canonicalize(launcher.parent().unwrap()).unwrap();
        let private = root.join("private-tools");
        let pinned = |runner: CliRunner| {
            NativePin::apply(&validate_helpers(&runner).unwrap(), runner, &private)
                .env_value("HACK_NATIVE_BINARY")
        };
        let base = |hack: &Path| fixture_runner(hack).with_env("HACK_HOME", root.to_str().unwrap());
        // A #! launcher: its eventual executable is unknown.
        assert_eq!(
            validate_helpers(&base(&launcher)),
            Ok(NativePin::Unavailable)
        );
        assert_eq!(
            pinned(base(&launcher)),
            Some(private.join("native-unavailable/hack-native").into())
        );
        // A trusted PATH tool named like the pin's first component is wrapped
        // as a file, so the pinned path still cannot exist.
        let tools_dir = root.join("collide");
        std::fs::create_dir(&tools_dir).unwrap();
        std::fs::set_permissions(&tools_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["native-unavailable", "hack-native", "sh"] {
            let tool = tools_dir.join(name);
            std::fs::write(&tool, b"\x7fELF fixture").unwrap();
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let tools = trusted_probe_path(tools_dir.as_os_str()).unwrap();
        let wrappers = Path::new(tools.path());
        assert!(wrappers.join("native-unavailable").is_file());
        let pin = NativePin::Unavailable
            .apply(base(&launcher), wrappers)
            .env_value("HACK_NATIVE_BINARY")
            .unwrap();
        assert_eq!(
            Path::new(&pin),
            wrappers.join(crate::doctor_plugins::UNAVAILABLE_NATIVE)
        );
        assert!(std::fs::symlink_metadata(&pin).is_err());
        drop(tools);
        // A compiled CLI (no #!): its own directory is the fallback.
        let compiled = root.join("compiled");
        std::fs::create_dir(&compiled).unwrap();
        std::fs::set_permissions(&compiled, std::fs::Permissions::from_mode(0o700)).unwrap();
        let hack = compiled.join("hack");
        std::fs::write(&hack, b"\x7fELF fixture").unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(validate_helpers(&base(&hack)), Ok(NativePin::Absent));
        assert_eq!(pinned(base(&hack)), None);
        let native = compiled.join("hack-native");
        std::fs::write(&native, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            validate_helpers(&base(&hack)),
            Ok(NativePin::Adjacent(native.clone()))
        );
        assert_eq!(pinned(base(&hack)), Some(native.clone().into()));
        // Writable by others, or an untrusted interpreter: Doctor refuses.
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o722)).unwrap();
        assert!(validate_helpers(&base(&hack)).is_err());
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&native, "#!/usr/bin/env sh\n").unwrap();
        assert!(validate_helpers(&base(&hack)).is_err());
        // The lifecycle supervisor beside a compiled CLI is checked too; a
        // compiled CLI ignores any selector for it.
        std::fs::remove_file(&native).unwrap();
        let supervisor = compiled.join("hack-lifecycle-supervisor");
        std::fs::write(&supervisor, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&supervisor, std::fs::Permissions::from_mode(0o722)).unwrap();
        assert!(validate_helpers(&base(&hack)).is_err());
        std::fs::set_permissions(&supervisor, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(validate_helpers(&base(&hack)), Ok(NativePin::Absent));
        std::fs::write(&supervisor, "#!/usr/bin/env sh\n").unwrap();
        assert!(validate_helpers(&base(&hack)).is_err());
        std::fs::remove_file(&supervisor).unwrap();
        // An explicit selection is checked and left as the CLI's choice.
        let selected = base(&hack).with_env("HACK_NATIVE_BINARY", "/example/absent/hack-native");
        assert_eq!(validate_helpers(&selected), Ok(NativePin::Selected));
        assert_eq!(pinned(selected), Some("/example/absent/hack-native".into()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn doctor_refuses_remote_or_unknown_docker_endpoints() {
        let hack = fake_hack("doctor-docker-endpoint", "echo '{}'");
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let client = root.join("client");
        let meta = client.join("contexts/meta").join(context_dir("selected"));
        // A decoy elsewhere that claims the same name with a local endpoint.
        let decoy = client.join("contexts/meta/decoy");
        std::fs::create_dir_all(&decoy).unwrap();
        std::fs::write(
            decoy.join("meta.json"),
            r#"{"Name":"selected","Endpoints":{"docker":{"Host":"unix:///example/decoy.sock"}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(&meta).unwrap();
        let discovery =
            |host: Option<&str>, context: Option<&str>| crate::doctor_plugins::Discovery {
                config_dir: Some(client.clone()),
                unsupported_extra_selector: false,
                system_dirs: vec![],
                docker_host: host.map(str::to_owned),
                context: context.map(str::to_owned),
            };
        let write = |host: &str| {
            std::fs::write(
                meta.join("meta.json"),
                format!(r#"{{"Name":"selected","Endpoints":{{"docker":{{"Host":"{host}"}}}}}}"#),
            )
            .unwrap();
        };
        write("unix:///example/docker.sock");
        assert!(crate::doctor_plugins::validate(&discovery(None, None)).is_ok());
        assert!(crate::doctor_plugins::validate(&discovery(None, Some("default"))).is_ok());
        assert!(crate::doctor_plugins::validate(&discovery(None, Some("selected"))).is_ok());
        assert!(
            crate::doctor_plugins::validate(&discovery(Some("unix:///example/docker.sock"), None))
                .is_ok()
        );
        assert!(
            crate::doctor_plugins::validate(&discovery(Some("tcp://example:2375"), None)).is_err()
        );
        assert!(crate::doctor_plugins::validate(&discovery(None, Some("missing"))).is_err());
        write("ssh://user@example");
        assert!(crate::doctor_plugins::validate(&discovery(None, Some("selected"))).is_err());
        // A FIFO at the exact path is refused without blocking.
        std::fs::remove_file(meta.join("meta.json")).unwrap();
        let fifo = std::ffi::CString::new(meta.join("meta.json").to_str().unwrap()).unwrap();
        // SAFETY: fifo is a valid NUL-terminated path for this call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(crate::doctor_plugins::validate(&discovery(None, Some("selected"))).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn absolute_mutagen_helpers_require_trusted_paths() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-mutagen-helper", "echo '{}'");
        let dir = hack.parent().unwrap();
        let managed = dir.join("bin/mutagen");
        std::fs::create_dir(dir.join("bin")).unwrap();
        std::fs::copy(&hack, &managed).unwrap();
        let runner = fixture_runner(&hack)
            .with_env("HACK_HOME", dir.to_str().unwrap())
            .with_env("HACK_MUTAGEN_PATH", "");
        // A trusted helper script whose #! interpreter another user can replace.
        let shared = dir.join("shared");
        std::fs::create_dir(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::copy("/bin/sh", shared.join("interp")).unwrap();
        let scripted = dir.join("bin/scripted-mutagen");
        std::fs::write(
            &scripted,
            format!("#!{}\n", shared.join("interp").display()),
        )
        .unwrap();
        std::fs::set_permissions(&scripted, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            crate::doctor_plugins::validate_helpers(
                &runner
                    .clone()
                    .with_env("HACK_MUTAGEN_PATH", scripted.to_str().unwrap())
            )
            .is_err(),
            "absolute helpers need a trusted interpreter too"
        );
        for explicit in [false, true] {
            let runner = if explicit {
                runner
                    .clone()
                    .with_env("HACK_MUTAGEN_PATH", managed.to_str().unwrap())
            } else {
                runner.clone()
            };
            std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(crate::doctor_plugins::validate_helpers(&runner).is_ok());
            std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o777)).unwrap();
            assert!(crate::doctor_plugins::validate_helpers(&runner).is_err());
        }
        assert!(
            crate::doctor_plugins::validate_helpers(
                &runner.with_env("HACK_MUTAGEN_PATH", "relative-helper")
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn filtered_docker_preserves_file_only_compose_and_native_warnings() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-file-only-coverage", "echo '{}'");
        let root = hack.parent().unwrap();
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::copy(&hack, bin.join("docker")).unwrap();
        std::fs::set_permissions(bin.join("docker"), std::fs::Permissions::from_mode(0o775))
            .unwrap();
        let tools = trusted_probe_path(bin.as_os_str()).unwrap();
        assert!(tools.unchecked.contains("docker"));
        for native in [false, true] {
            let checks = vec![
                crate::models::DoctorCheck { native_pool: None, id: "project".into(), status: "ok".into(), detail: format!("Found .hack/ (or legacy .dev/) at {}", root.join(".hack").display()), fix: None },
                crate::models::DoctorCheck { native_pool: None, id: "compose networks".into(), status: "warn".into(), detail: "Internal services attached to hack-dev without Caddy labels: worker".into(), fix: None },
                crate::models::DoctorCheck { native_pool: None, id: "compose backend features".into(), status: "warn".into(), detail: "External network blocks native up; select the Compose backend or documented isolatedNetworks adaptation.".into(), fix: None },
            ];
            let mut run = DoctorRun::project(
                "fixture",
                root.to_str().unwrap(),
                Ok(crate::models::DoctorReport {
                    checks,
                    summary: vec![],
                }),
            );
            run.native = native;
            run.exact_native_root = native;
            let mut runs = vec![run];
            let before = crate::doctor::aggregate(&runs);
            assert_eq!(before.cards().count(), 2);
            apply_tool_coverage(&mut runs, &tools);
            let after = crate::doctor::aggregate(&runs);
            for original in before.cards() {
                let preserved = after.cards().find(|c| c.id == original.id).unwrap();
                assert_eq!(
                    preserved, original,
                    "warn, ingress/native guidance and any authored recipe must survive filtered Docker"
                );
                assert_eq!(preserved.severity, crate::doctor::Severity::Warn);
            }
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejected_later_path_directory_cannot_invalidate_selected_tool() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-path-priority", "echo '{}'");
        let root = hack.parent().unwrap();
        let trusted = root.join("trusted");
        let shared = root.join("shared");
        for dir in [&trusted, &shared] {
            std::fs::create_dir(dir).unwrap();
            std::fs::copy(&hack, dir.join("docker")).unwrap();
        }
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o775)).unwrap();
        let path = std::env::join_paths([&trusted, &shared]).unwrap();
        let tools = trusted_probe_path(&path).unwrap();
        assert!(Path::new(tools.path()).join("docker").exists());
        assert!(!tools.unchecked.contains("docker"));
        let mut runs = vec![DoctorRun::machine(Ok(crate::models::DoctorReport {
            checks: vec![crate::models::DoctorCheck {
                native_pool: None,
                id: "docker daemon".into(),
                status: "error".into(),
                detail: "validated Docker reported an engine error".into(),
                fix: None,
            }],
            summary: vec![],
        }))];
        let before = crate::doctor::aggregate(&runs);
        apply_tool_coverage(&mut runs, &tools);
        assert_eq!(
            crate::doctor::aggregate(&runs),
            before,
            "later rejected shadows preserve findings and remedies"
        );
        let reverse = std::env::join_paths([&shared, &trusted]).unwrap();
        assert!(
            trusted_probe_path(&reverse)
                .unwrap()
                .unchecked
                .contains("docker"),
            "a rejected earlier selection still has incomplete coverage"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unsafe_optional_mkcert_preserves_certificate_errors_and_remedies() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-mkcert-independent", "echo '{}'");
        let root = hack.parent().unwrap();
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        for name in ["mkcert", "openssl"] {
            let tool = bin.join(name);
            std::fs::copy(&hack, &tool).unwrap();
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o775)).unwrap();
        }
        let tools = trusted_probe_path(bin.as_os_str()).unwrap();
        assert_eq!(
            tools.unchecked.iter().copied().collect::<Vec<_>>(),
            vec!["mkcert"]
        );
        let checks = [
            ("caddy local ca", "stale CA"),
            ("host tls trust", "missing host trust bundle"),
        ]
        .map(|(id, detail)| crate::models::DoctorCheck {
            native_pool: None,
            id: id.into(),
            status: "error".into(),
            detail: detail.into(),
            fix: None,
        })
        .to_vec();
        let mut runs = vec![DoctorRun::machine(Ok(crate::models::DoctorReport {
            checks,
            summary: vec![],
        }))];
        let before = crate::doctor::aggregate(&runs);
        apply_tool_coverage(&mut runs, &tools);
        let after = crate::doctor::aggregate(&runs);
        for original in before.cards() {
            let preserved = after.cards().find(|card| card.id == original.id).unwrap();
            assert_eq!(
                preserved, original,
                "independent error, detail and authored remedy must remain unchanged"
            );
            assert_eq!(preserved.severity, crate::doctor::Severity::Error);
            assert!(matches!(
                preserved.action,
                crate::doctor::CardAction::Copy(_)
            ));
        }
        assert!(!after.is_clean());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn private_path_always_offers_dirname_for_candidate_launchers() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-dirname", "echo '{}'");
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let tools = trusted_probe_path(bin.as_os_str()).unwrap();
        let system = ["/usr/bin/dirname", "/bin/dirname"]
            .iter()
            .any(|p| Path::new(p).exists());
        assert_eq!(tools.dir.join("dirname").exists(), system);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn script_tools_require_a_trusted_interpreter_chain() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-shebang", "echo '{}'");
        let root = hack.parent().unwrap();
        let bin = root.join("bin");
        let shared = root.join("shared");
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&shared).unwrap();
        // Another account could replace anything in this directory.
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        let unsafe_interpreter = shared.join("interp");
        std::fs::copy("/bin/sh", &unsafe_interpreter).unwrap();
        // An owned interpreter that is itself a script pointing at it.
        let nested = bin.join("nested-interp");
        let docker = bin.join("docker");
        let write = |path: &Path, shebang: &Path| {
            std::fs::write(path, format!("#!{}\necho '{{}}'\n", shebang.display())).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        write(&nested, &unsafe_interpreter);
        let unsafe_env = format!("/usr/bin/env {}", unsafe_interpreter.display());
        let env_path = format!("/usr/bin/env PATH={} sh", shared.display());
        let env_split_absolute = format!("/usr/bin/env -S {}", unsafe_interpreter.display());
        // An owned copy of env under another name gets no env options.
        let env_copy = bin.join("env-copy");
        std::fs::copy("/usr/bin/env", &env_copy).unwrap();
        std::fs::set_permissions(&env_copy, std::fs::Permissions::from_mode(0o755)).unwrap();
        let renamed_env = format!("{} -S -P bin sh", env_copy.display());
        for (shebang, trusted) in [
            ("/bin/sh", true),
            ("/usr/bin/env sh", true),
            (unsafe_interpreter.to_str().unwrap(), false),
            (nested.to_str().unwrap(), false),
            (unsafe_env.as_str(), false),
            (env_path.as_str(), false),
            ("/usr/bin/env -S sh", false),
            ("/usr/bin/env -S ${TOOL_INTERPRETER}", false),
            (env_split_absolute.as_str(), false),
            ("/usr/bin/env -P bin sh", false),
            ("/usr/bin/env -- sh", false),
            (renamed_env.as_str(), false),
            ("/bin/sh -eu", false),
            // A plain argument can be a script file the shell would run.
            ("/bin/sh payload", false),
            ("/usr/bin/env sh extra", false),
        ] {
            write(&docker, Path::new(shebang));
            let tools = trusted_probe_path(bin.as_os_str()).unwrap();
            assert_eq!(tools.dir.join("docker").exists(), trusted, "{shebang}");
            assert_eq!(tools.unchecked.contains("docker"), !trusted);
        }
        // An execute-only script cannot be read here, yet the kernel would
        // still follow its #! line: it is refused, never assumed a binary.
        // SAFETY: getuid has no preconditions and cannot fail.
        if unsafe { libc::getuid() } != 0 {
            write(&docker, Path::new("/bin/sh"));
            std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o111)).unwrap();
            let tools = trusted_probe_path(bin.as_os_str()).unwrap();
            assert!(!tools.dir.join("docker").exists());
            assert!(tools.unchecked.contains("docker"));
            std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn filtered_doctor_tools_only_downgrade_dependent_checks() {
        use std::os::unix::fs::PermissionsExt;
        let hack = fake_hack("doctor-scoped-coverage", "echo '{}'");
        let root = hack.parent().unwrap();
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let unrelated = bin.join("unrelated-execute-only");
        std::fs::write(&unrelated, "fixture").unwrap();
        std::fs::set_permissions(&unrelated, std::fs::Permissions::from_mode(0o777)).unwrap();
        let tools = trusted_probe_path(bin.as_os_str()).unwrap();
        assert!(
            tools.unchecked.is_empty(),
            "unrelated unsafe tools do not affect Doctor coverage"
        );
        let docker = bin.join("docker");
        std::fs::copy(&hack, &docker).unwrap();
        for directory in [false, true] {
            std::fs::set_permissions(
                &bin,
                std::fs::Permissions::from_mode(if directory { 0o775 } else { 0o755 }),
            )
            .unwrap();
            std::fs::set_permissions(
                &docker,
                std::fs::Permissions::from_mode(if directory { 0o755 } else { 0o777 }),
            )
            .unwrap();
            let tools = trusted_probe_path(bin.as_os_str()).unwrap();
            assert_eq!(
                tools.unchecked.iter().copied().collect::<Vec<_>>(),
                vec!["docker"]
            );
            let checks = [
                "docker",
                "docker daemon",
                "resolver:hack",
                "host tls trust",
                "env mode",
                "project",
            ]
            .map(|id| crate::models::DoctorCheck {
                native_pool: None,
                id: id.into(),
                status: "ok".into(),
                detail: "independently observed".into(),
                fix: None,
            })
            .to_vec();
            let mut runs = vec![DoctorRun::machine(Ok(crate::models::DoctorReport {
                checks,
                summary: vec![],
            }))];
            apply_tool_coverage(&mut runs, &tools);
            let report = runs[0].result.as_ref().unwrap();
            assert!(report.checks[..2].iter().all(|c| c.status == "unknown"));
            assert!(
                report.checks[2..]
                    .iter()
                    .all(|c| c.status == "ok" && c.detail == "independently observed")
            );
            let view = crate::doctor::aggregate(&runs);
            assert!(!view.is_clean());
            assert_eq!(
                view.cards()
                    .filter(|c| c.id == "desktop tool coverage")
                    .count(),
                1
            );
            assert!(
                view.cards()
                    .any(|c| c.id == "desktop tool coverage" && c.detail.contains("docker"))
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn path_caps_keep_checked_tools_and_report_unsearched_coverage() {
        use std::os::unix::fs::PermissionsExt;
        let hack = std::fs::canonicalize(fake_hack("doctor-path-bounds", "echo '{}'")).unwrap();
        // Keep every input in this owned tree and use its canonical spelling
        // (macOS temp roots may have /var-style aliases). This test qualifies
        // PATH coverage, not absent-helper/plugin discovery on a host image.
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let root = root.as_path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        for dir in [&first, &second] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::os::unix::fs::symlink(&hack, first.join("git")).unwrap();
        std::os::unix::fs::symlink(&hack, second.join("docker")).unwrap();
        let repeated = std::env::join_paths(std::iter::repeat_n(&first, 69)).unwrap();
        let tools = trusted_probe_path_with_limits(&repeated, 1, 1).unwrap();
        assert!(tools.coverage.is_none());
        assert!(Path::new(tools.path()).join("git").exists());
        let path = std::env::join_paths([&first, &second]).unwrap();
        for (dirs, entries) in [(1, 10), (10, 1)] {
            let tools = trusted_probe_path_with_limits(&path, dirs, entries).unwrap();
            assert!(tools.coverage.is_some());
            assert!(Path::new(tools.path()).join("git").exists());
            assert!(!Path::new(tools.path()).join("docker").exists());
        }
        let mut dirs = vec![first.clone()];
        for index in 1..65 {
            let dir = root.join(format!("path-{index}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            dirs.push(dir);
        }
        let ordinary =
            std::env::join_paths(dirs[..64].iter().chain(std::iter::repeat_n(&first, 5))).unwrap();
        let tools = trusted_probe_path(&ordinary).unwrap();
        assert!(
            tools.coverage.is_none(),
            "69 raw / 64 unique must be supported"
        );
        let over = std::env::join_paths(&dirs).unwrap();
        std::fs::write(
            &hack,
            r#"#!/bin/sh
echo '{"checks":[{"id":"docker","status":"ok","detail":"healthy"}]}'
"#,
        )
        .unwrap();
        let client = root.join("client");
        let system_plugins = root.join("system-plugins");
        std::fs::create_dir_all(client.join("cli-plugins")).unwrap();
        std::fs::create_dir(&system_plugins).unwrap();
        std::fs::write(client.join("config.json"), "{}").unwrap();
        for dir in [&client, &client.join("cli-plugins"), &system_plugins] {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let discovery = crate::doctor_plugins::Discovery {
            config_dir: Some(client),
            unsupported_extra_selector: false,
            docker_host: None,
            context: None,
            system_dirs: vec![system_plugins],
        };
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack)
                .with_env("HOME", root.to_str().unwrap())
                .with_env("HACK_HOME", root.to_str().unwrap())
                .with_env("HACK_MUTAGEN_PATH", hack.to_str().unwrap())
                .with_env("PATH", over.to_str().unwrap()),
            daemon: None,
        };
        assert_eq!(
            crate::doctor_plugins::validate_helpers(&source.runner).map(|_| ()),
            Ok(()),
            "stage=helper-preflight"
        );
        assert_eq!(
            crate::doctor_plugins::validate(&discovery),
            Ok(()),
            "stage=plugin-preflight"
        );
        let runs =
            source.doctor_runs_with_discovery(&[], DOCTOR_BUDGET, DOCTOR_TIMEOUT, &discovery);
        // A synthetic preflight card is also Ok/Unknown, but proves nothing
        // about the bounded scan. Fail at the actual stage with static reasons.
        assert!(
            runs[0].probe_started,
            "stage=preflight-refused reason={}",
            runs[0].result.as_ref().unwrap().checks[0].detail
        );
        let report = runs[0]
            .result
            .as_ref()
            .expect("bounded scan still runs Doctor");
        assert_eq!(report.checks.len(), 1, "stage=fake-report-count");
        assert_eq!(report.checks[0].id, "docker", "stage=fake-cli-not-run");
        assert!(
            report.checks.iter().all(|c| c.status == "unknown"),
            "stage=coverage-not-applied"
        );
        let view = crate::doctor::aggregate(&runs);
        assert!(!view.is_clean());
        assert!(
            view.cards()
                .any(|card| card.detail.contains("bounded PATH scan")),
            "stage=coverage-card-missing"
        );
        assert_eq!(
            view.cards()
                .filter(|card| card.id == "desktop tool coverage")
                .count(),
            1,
            "stage=coverage-card-count"
        );
        let refused = crate::doctor_plugins::Discovery {
            unsupported_extra_selector: true,
            docker_host: None,
            context: None,
            ..discovery
        };
        let refused_runs =
            source.doctor_runs_with_discovery(&[], DOCTOR_BUDGET, DOCTOR_TIMEOUT, &refused);
        assert!(
            !refused_runs[0].probe_started,
            "stage=negative-preflight-control"
        );
        let refused_view = crate::doctor::aggregate(&refused_runs);
        assert!(!refused_view.machine_checked);
        assert!(
            !refused_view
                .cards()
                .any(|card| card.id == "desktop tool coverage"),
            "stage=preflight-must-not-masquerade-as-scan"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tool_links_reject_writable_intermediate_alias() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let hack = fake_hack("doctor-tool-hop", "echo '{}'");
        let dir = hack.parent().unwrap();
        let bin = dir.join("bin");
        let shared = dir.join("shared");
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&shared).unwrap();
        let hop = shared.join("current");
        symlink(&hack, &hop).unwrap();
        let tool = bin.join("git");
        symlink(&hop, &tool).unwrap();
        let uid = unsafe { libc::getuid() };
        assert!(trusted_tool_path(&tool, uid, false).is_some());
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(trusted_tool_path(&tool, uid, false).is_none());
        let tools = trusted_probe_path(bin.as_os_str()).unwrap();
        assert!(!Path::new(tools.path()).join("git").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn homebrew_owned_paths_keep_nested_tools_and_shims_despite_unrelated_unsafe_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let hack = fake_hack(
            "doctor-homebrew",
            "docker --version >/dev/null || exit 2\ngit --version >/dev/null || exit 3\ntmux -V >/dev/null || exit 4\nmise --version >/dev/null || exit 5\necho '{}'",
        );
        // macOS temp paths can be aliases (/var -> /private/var). Reproduce
        // that using only an owned fixture symlink, on every platform.
        let fixture_root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let alias = fixture_root.join("fixture-root-alias");
        symlink(&fixture_root, &alias).unwrap();
        let dir = alias.as_path();
        let brew = dir.join("opt/homebrew");
        let bin = brew.join("bin");
        let cellar = brew.join("Cellar/tools/1.0/bin");
        let shims = brew.join("var/mise/shims' owned");
        for p in [&bin, &cellar, &shims] {
            std::fs::create_dir_all(p).unwrap();
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        for (name, body) in [
            ("mise", "printf 'mise fixture\\n'"),
            (
                "docker",
                "git --version >/dev/null || exit 8\nprintf 'docker fixture\\n'",
            ),
            (
                "tmux",
                "mise --version >/dev/null || exit 9\nprintf 'tmux fixture\\n'",
            ),
        ] {
            let target = cellar.join(name);
            std::fs::write(&target, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
            symlink(&target, bin.join(name)).unwrap();
        }
        let git = shims.join("git");
        std::fs::write(&git, "#!/bin/sh\n[ \"$0\" = \"$HACK_HOME/opt/homebrew/var/mise/shims' owned/git\" ] || exit 10\nmise --version >/dev/null || exit 11\nprintf 'git fixture\\n'\n").unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A hosted image can have one unsafe tool beside a trusted Git.
        // Reject that tool, never discard every safe sibling in the directory.
        let unsafe_tool = bin.join("unsafe-unrelated");
        std::fs::write(
            &unsafe_tool,
            "#!/bin/sh\nprintf bad > \"$HACK_HOME/executed\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&unsafe_tool, std::fs::Permissions::from_mode(0o777)).unwrap();
        let inherited = std::env::join_paths([&bin, &shims]).unwrap();
        let tools = trusted_probe_path(&inherited).unwrap();
        assert!(!Path::new(tools.path()).join("unsafe-unrelated").exists());
        for name in ["docker", "git", "tmux", "mise"] {
            assert!(Path::new(tools.path()).join(name).is_file());
        }
        let runner = fixture_runner(&hack).with_env("PATH", &tools.path().to_string_lossy());
        // Reproduce the reported Mac Exit(2) without depending on /var or
        // any runner Homebrew path: spelling an aliased root as $0 fails.
        let aliased = runner
            .clone()
            .with_env("HACK_HOME", &dir.to_string_lossy())
            .run_json::<serde_json::Value>(&[], None, Duration::from_secs(60));
        assert!(matches!(aliased, Err(RunError::Exit { code: Some(2), .. })));
        runner
            // Tool wrappers use canonical directory paths; compare $0 with
            // this fixture's canonical root, never an actual Homebrew prefix.
            .with_env("HACK_HOME", &fixture_root.to_string_lossy())
            .run_json::<serde_json::Value>(&[], None, Duration::from_secs(60))
            .unwrap();
        assert!(!dir.join("executed").exists());
        let private = PathBuf::from(tools.path());
        drop(tools);
        assert!(!private.exists());
        let _ = std::fs::remove_dir_all(&fixture_root);
    }

    #[test]
    fn doctor_payload_without_checks_is_not_a_report() {
        let hack = fake_hack("doctor-empty", r#"echo '{"ok":true,"data":{}}'"#);
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack),
            daemon: None,
        };
        let runs = src.fixture_doctor_runs(&targets(1));
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        assert!(runs.iter().all(|r| r.result.is_err()), "{runs:?}");
        assert!(matches!(
            crate::doctor::DoctorState::from_runs(&runs),
            crate::doctor::DoctorState::Error(_)
        ));
    }

    #[test]
    fn docker_plugin_preflight_preserves_context_and_blocks_untrusted_or_unknown_discovery() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let hack = fake_hack(
            "plugin-context",
            "printf called > \"$HACK_HOME/hack-ran\"\ndocker compose ps >/dev/null || exit 7\necho '{\"ok\":true,\"data\":{\"checks\":[{\"id\":\"docker daemon\",\"status\":\"ok\",\"detail\":\"fixture\"}]}}'",
        );
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let client = root.join("client");
        let plugins = client.join("cli-plugins");
        let bin = root.join("bin");
        let extra = root.join("plugins extra");
        let extra_link = root.join("extra-link");
        let home = root.join("home");
        for p in [&plugins, &bin, &extra, &home] {
            std::fs::create_dir_all(p).unwrap();
        }
        symlink(&extra, &extra_link).unwrap();
        let target = root.join("owned-compose");
        let mutable_alias = root.join("mutable-alias");
        std::fs::create_dir(&mutable_alias).unwrap();
        std::fs::write(
            &target,
            "#!/bin/sh\nprintf called > \"$HACK_HOME/plugin-ran\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&target, plugins.join("docker-compose")).unwrap();
        symlink(&target, mutable_alias.join("plugin-hop")).unwrap();
        let docker = bin.join("docker");
        std::fs::write(&docker, "#!/bin/sh\n[ \"$DOCKER_CONFIG\" = \"$HACK_HOME/client\" ] || exit 91\n[ \"$HOME\" = \"$HACK_HOME/home\" ] || exit 92\n[ \"$DOCKER_CONTEXT\" = fixture-context ] || exit 93\nexec \"$DOCKER_CONFIG/cli-plugins/docker-compose\" \"$@\"\n").unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = serde_json::json!({"currentContext":"fixture-context", "cliPluginsExtraDirs":[extra_link], "auths":{"example.invalid":{"auth":"NOT_A_REAL_CREDENTIAL"}}});
        std::fs::write(
            client.join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        // The selected context must resolve to a local Unix socket.
        let meta = client
            .join("contexts/meta")
            .join(context_dir("fixture-context"));
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("meta.json"),
            r#"{"Name":"fixture-context","Endpoints":{"docker":{"Host":"unix:///example/docker.sock"}}}"#,
        )
        .unwrap();
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack)
                .with_env("PATH", &bin.to_string_lossy())
                .with_env("HACK_HOME", &root.to_string_lossy())
                .with_env("HOME", &home.to_string_lossy())
                .with_env("DOCKER_CONFIG", &client.to_string_lossy())
                .with_env("DOCKER_CONTEXT", "fixture-context")
                .with_env("DOCKER_CLI_PLUGIN_EXTRA_DIRS", ""),
            daemon: None,
        };
        let mut discovery = crate::doctor_plugins::Discovery::from_runner(&source.runner);
        discovery.system_dirs = vec![root.join("system-plugins")];
        let runs =
            source.doctor_runs_with_discovery(&[], DOCTOR_BUDGET, DOCTOR_TIMEOUT, &discovery);
        assert!(runs[0].result.is_ok(), "{runs:?}");
        assert!(root.join("hack-ran").exists() && root.join("plugin-ran").exists());
        assert_eq!(
            std::fs::read(client.join("config.json")).unwrap(),
            serde_json::to_vec(&config).unwrap(),
            "context/config bytes are never rewritten or copied"
        );
        for (case, reason) in [
            ("file", "untrusted"),
            ("symlink-hop", "untrusted"),
            ("extra-dir", "owner-controlled"),
            ("config-dir", "owner-controlled"),
            ("opaque-extra", "unsupported"),
            ("relative-extra", "unsupported"),
            ("invalid-config", "invalid or unsupported"),
        ] {
            std::fs::remove_file(root.join("hack-ran")).ok();
            std::fs::remove_file(root.join("plugin-ran")).ok();
            for p in [&target, &extra, &client, &mutable_alias] {
                std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            std::fs::write(
                client.join("config.json"),
                serde_json::to_vec(&config).unwrap(),
            )
            .unwrap();
            discovery.unsupported_extra_selector = case == "opaque-extra";
            std::fs::remove_file(plugins.join("docker-compose")).unwrap();
            symlink(&target, plugins.join("docker-compose")).unwrap();
            match case {
                "symlink-hop" => {
                    std::fs::remove_file(plugins.join("docker-compose")).unwrap();
                    symlink(
                        mutable_alias.join("plugin-hop"),
                        plugins.join("docker-compose"),
                    )
                    .unwrap();
                    std::fs::set_permissions(
                        &mutable_alias,
                        std::fs::Permissions::from_mode(0o777),
                    )
                    .unwrap();
                }
                "file" => std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o777))
                    .unwrap(),
                "extra-dir" => {
                    std::fs::set_permissions(&extra, std::fs::Permissions::from_mode(0o775))
                        .unwrap()
                }
                "config-dir" => {
                    std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o775))
                        .unwrap()
                }
                "relative-extra" => std::fs::write(
                    client.join("config.json"),
                    r#"{"cliPluginsExtraDirs":["relative"]}"#,
                )
                .unwrap(),
                "invalid-config" => {
                    std::fs::write(client.join("config.json"), "{invalid NOT_A_REAL_CREDENTIAL")
                        .unwrap()
                }
                _ => {}
            }
            let runs =
                source.doctor_runs_with_discovery(&[], DOCTOR_BUDGET, DOCTOR_TIMEOUT, &discovery);
            let view = crate::doctor::aggregate(&runs);
            assert!(!view.is_clean());
            assert!(!view.machine_checked, "preflight did not invoke the CLI");
            let card = view.cards().next().unwrap();
            assert_eq!(card.severity, crate::doctor::Severity::CouldNotCheck);
            assert!(card.detail.contains(reason), "{case}: {}", card.detail);
            assert!(!card.detail.contains("NOT_A_REAL_CREDENTIAL"));
            assert!(card.authored_remedy.is_none());
            assert!(!root.join("hack-ran").exists() && !root.join("plugin-ran").exists());
        }
        assert_eq!(
            source.runner.env_value("DOCKER_CONTEXT").unwrap(),
            "fixture-context"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_checkout_evidence_does_not_accept_ancestor_checks_when_marker_is_missing_or_changes()
    {
        let hack = fake_hack(
            "native-root",
            r#"case "$*" in
*--path*)
  if [ "$DROP_MARKER" = 1 ] && [ -f "$HACK_HOME/parent/child/.hack/hack.project.json" ]; then /bin/rm "$HACK_HOME/parent/child/.hack/hack.project.json"; fi
  echo '{"ok":true,"data":{"checks":[{"id":"env key","status":"error","detail":"could be ancestor"},{"id":"native settings","status":"ok","detail":"could be ancestor"},{"id":"native root trust","status":"warn","detail":"machine diagnostic"}]}}' ;;
*) echo '{"ok":true,"data":{"checks":[{"id":"docker","status":"ok","detail":"fixture"}]}}' ;;
esac"#,
        );
        let root = std::fs::canonicalize(hack.parent().unwrap()).unwrap();
        let parent = root.join("parent");
        let child = parent.join("child");
        std::fs::create_dir_all(parent.join(".hack")).unwrap();
        std::fs::create_dir_all(child.join(".hack")).unwrap();
        std::fs::write(parent.join(".hack/docker-compose.yml"), "services: {}\n").unwrap();
        let marker = child.join(".hack/hack.project.json");
        std::fs::write(&marker, "{}").unwrap();
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack).with_env("HACK_HOME", &root.to_string_lossy()),
            daemon: None,
        };
        let target = DoctorTarget {
            name: "child".into(),
            repo_root: child,
            native: true,
            browser_url: None,
            missing: false,
        };
        let exact = source.fixture_doctor_runs(std::slice::from_ref(&target));
        assert!(exact[1].exact_native_root);
        assert_eq!(crate::doctor::aggregate(&exact).projects_checked, 1);
        let changed = LiveSource {
            cache: Default::default(),
            runner: source.runner.clone().with_env("DROP_MARKER", "1"),
            daemon: None,
        }
        .fixture_doctor_runs(std::slice::from_ref(&target));
        assert!(!changed[1].exact_native_root);
        let missing = source.fixture_doctor_runs(&[target]);
        for runs in [&changed, &missing] {
            let view = crate::doctor::aggregate(runs);
            assert_eq!(view.projects_checked, 0);
            assert!(!view.is_clean());
            assert!(view.cards().any(|c| c.id == "native root trust"));
            assert!(!view.cards().any(|c| c.id == "env key"));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_registry_targets_are_not_probed_but_remain_unchecked() {
        let hack = fake_hack(
            "doctor-missing",
            r#"[ "$*" = 'doctor --json' ] || exit 9
echo '{"ok":true,"data":{"checks":[{"id":"docker","status":"ok","detail":""}]}}'"#,
        );
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack),
            daemon: None,
        };
        let payload: ProjectsPayload = serde_json::from_str(r#"{"projects":[{"name":"gone","status":"missing","repo_root":"/work/gone"},{"name":"no-root","status":"missing"}]}"#).unwrap();
        let runs = source.fixture_doctor_runs(&DoctorTarget::from_projects(&payload));
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        assert_eq!(runs.len(), 3);
        assert!(
            runs[1..]
                .iter()
                .all(|r| r.result.as_ref().unwrap_err() == "not checked (checkout missing)")
        );
        let view = crate::doctor::aggregate(&runs);
        assert_eq!((view.projects_total, view.projects_checked), (2, 0));
        assert!(!view.is_clean());
    }

    #[test]
    fn doctor_budget_holds_even_when_checks_ignore_sigterm() {
        // Every call ignores SIGTERM, so each stop costs the full grace.
        let hack = fake_hack(
            "doctor-stubborn",
            "trap '' TERM\nwhile :; do sleep 0.05; done",
        );
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack),
            daemon: None,
        };
        let budget = Duration::from_secs(4);
        let started = std::time::Instant::now();
        let runs = src.fixture_doctor_runs_within(&targets(6), budget, Duration::from_secs(60));
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        assert!(
            started.elapsed() < budget + Duration::from_millis(800),
            "took {:?} for a {budget:?} budget",
            started.elapsed()
        );
        assert!(runs.iter().all(|r| r.result.is_err()));
    }

    #[test]
    fn doctor_budget_marks_late_projects_not_checked() {
        let hack = fake_hack("doctor-slow", "sleep 5");
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack),
            daemon: None,
        };
        let started = std::time::Instant::now();
        let runs = src.fixture_doctor_runs_within(
            &targets(6),
            Duration::from_millis(400),
            Duration::from_secs(5),
        );
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "budget not honoured"
        );
        assert_eq!(runs.len(), 7);
        let not_checked = runs
            .iter()
            .filter(|r| r.result.as_ref().err().map(String::as_str) == Some(NOT_CHECKED_BUDGET))
            .count();
        assert!(not_checked >= 2, "{runs:?}");
        assert!(runs.iter().all(|r| r.result.is_err()));
    }

    /// Doctor exits 1 when a check errors but still prints the report.
    #[test]
    fn doctor_runs_keep_reports_from_exit_1() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-doctor-{}-{}",
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
case "$*" in
  *--path*) echo '{"ok":true,"data":{"checks":[{"id":"env key","status":"error","detail":"key missing"},{"id":"project","status":"ok","detail":"Found .hack/ (or legacy .dev/) at /work/alpha/.hack"}],"summary":[],"counts":{"ok":0,"warn":0,"error":1}}}'; exit 1 ;;
  *) echo '{"ok":true,"data":{"checks":[{"id":"docker daemon","status":"ok","detail":""}],"summary":[],"counts":{"ok":1,"warn":0,"error":0}}}' ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack).with_env("HACK_HOME", &dir.to_string_lossy()),
            daemon: None,
        };
        let runs = src.fixture_doctor_runs(&[DoctorTarget {
            missing: false,
            name: "alpha".into(),
            repo_root: "/work/alpha".into(),
            native: false,
            browser_url: None,
        }]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(runs.len(), 2);
        assert!(runs[0].project.is_none());
        let alpha = runs[1].result.as_ref().expect("exit 1 keeps the report");
        assert_eq!(alpha.checks[0].id, "env key");
        let v = crate::doctor::aggregate(&runs);
        assert_eq!(v.attention_count(), 1);
        assert_eq!(v.passed, 2);
    }

    /// Whether the temp dir's own ancestors are private enough for the
    /// positive cases. Decided independently of `trusted_root`, so an
    /// unexpected rejection fails the test instead of skipping it.
    fn host_temp_is_trustworthy() -> bool {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        let Ok(t) = std::fs::canonicalize(std::env::temp_dir()) else {
            return false;
        };
        t.ancestors().all(|a| {
            std::fs::metadata(a).is_ok_and(|m| {
                let sticky_root = m.uid() == 0 && m.mode() & 0o1000 != 0;
                (m.uid() == uid || m.uid() == 0) && (m.mode() & 0o022 == 0 || sticky_root)
            })
        })
    }

    /// A private base dir under the temp dir.
    fn base(tag: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-trust-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    /// A real legacy project: `<dir>/<marker_dir>/docker-compose.yml`.
    fn make_project(dir: &Path, marker_dir: &str, file: &str) {
        use std::os::unix::fs::PermissionsExt;
        let d = dir.join(marker_dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(d.join(file), "services: {}\n").unwrap();
        std::fs::set_permissions(d.join(file), std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn untrusted(r: Result<PathBuf, SourceError>) -> bool {
        matches!(r, Err(SourceError::Cli { ref code, .. }) if code == "E_APP_UNTRUSTED_ROOT")
    }

    #[test]
    fn copies_error_keeps_the_cli_hint_and_ignores_unstructured_output() {
        let error = CopiesError::from(RunError::Cli(crate::models::CliError {
            code: "E_NATIVE_SETUP_REQUIRED".into(),
            message: "Native runtime unavailable.".into(),
            detail: Some(serde_json::json!({"hint": "Run hack native setup."})),
        }));
        assert_eq!(
            error.reason,
            "E_NATIVE_SETUP_REQUIRED: Native runtime unavailable."
        );
        assert_eq!(error.hint, "Run hack native setup.");

        let error = CopiesError::from(RunError::Exit {
            code: Some(1),
            stderr: "fixture output".into(),
        });
        assert!(!error.reason.contains("fixture output"));
    }

    #[test]
    fn copies_reads_the_selected_checkout_and_keeps_partial_observations() {
        let dir = base("copies");
        let root = dir.join("worktree");
        make_project(&root, ".hack", "docker-compose.yml");
        let binary = dir.join("hack");
        crate::test_support::script(
            &binary,
            r#"#!/bin/sh
[ "$#" -eq 5 ] && [ "$1 $2 $3 $4" = 'ps --copies --json --path' ] || exit 2
[ "${5##*/}" = worktree ] || exit 3
[ "$HACK_RUNTIME_BACKEND" = native ] || exit 4
echo '{"ok":true,"data":{"copies":[{"checkout":{"name":"shop","root":"/work/shop","kind":"worktree"},"branch":"feature/search","instance":"feature-search","backend":"native","state":"unknown","address":null}],"observation":{"ok":false,"code":"E_TIMEOUT"}}}'
"#,
        );
        let source = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&binary),
            daemon: None,
        };
        let report = source.copies(&root, true);
        std::fs::remove_dir_all(&dir).unwrap();
        let report = report.expect("partial report");
        assert!(!report.observation.ok);
        assert_eq!(report.observation.code.as_deref(), Some("E_TIMEOUT"));
        assert_eq!(report.copies[0].instance.as_deref(), Some("feature-search"));
        assert_eq!(report.copies[0].checkout.kind, "worktree");
        assert_eq!(report.copies[0].state, "unknown");
    }

    #[test]
    fn trusted_root_accepts_real_projects_and_returns_the_real_path() {
        if !host_temp_is_trustworthy() {
            eprintln!("skipped: temp dir ancestors are not private on this host");
            return;
        }
        let b = base("ok");
        let compose = b.join("compose");
        make_project(&compose, ".hack", "docker-compose.yml");
        let native = b.join("native");
        make_project(&native, ".hack", "hack.project.json");
        let dev = b.join("dev");
        make_project(&dev, ".dev", "docker-compose.yml");
        for p in [&compose, &native] {
            assert_eq!(
                trusted_root(p).unwrap(),
                std::fs::canonicalize(p).unwrap(),
                "{}",
                p.display()
            );
        }
        // A `.dev`-only project is selected by the CLI unless an ancestor
        // `.hack` Compose project comes first; this host may have one above
        // its temp dir, in which case the right answer is a refusal.
        let real_dev = std::fs::canonicalize(&dev).unwrap();
        let ancestor_hack = real_dev
            .ancestors()
            .skip(1)
            .take_while(|a| !a.join(".hack/hack.project.json").exists())
            .any(|a| a.join(".hack/docker-compose.yml").is_file());
        if ancestor_hack {
            assert!(untrusted(trusted_root(&dev)), "CLI would pick the ancestor");
        } else {
            assert_eq!(trusted_root(&dev).unwrap(), real_dev);
        }
        let link = b.join("link");
        std::os::unix::fs::symlink(&compose, &link).unwrap();
        assert_eq!(
            trusted_root(&link).unwrap(),
            std::fs::canonicalize(&compose).unwrap()
        );
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn trusted_root_refuses_unsafe_or_ambiguous_roots() {
        use std::os::unix::fs::PermissionsExt;
        let set = |p: &Path, m: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        };
        assert!(untrusted(trusted_root(Path::new("relative/dir"))));
        if !host_temp_is_trustworthy() {
            eprintln!("skipped: temp dir ancestors are not private on this host");
            return;
        }
        let b = base("bad");
        let p = b.join("p");
        make_project(&p, ".hack", "docker-compose.yml");
        assert!(trusted_root(&p).is_ok());
        // World-writable root.
        set(&p, 0o777);
        assert!(untrusted(trusted_root(&p)), "0777 root");
        set(&p, 0o700);
        // Group-writable config file.
        set(&p.join(".hack/docker-compose.yml"), 0o664);
        assert!(untrusted(trusted_root(&p)), "writable config");
        set(&p.join(".hack/docker-compose.yml"), 0o600);
        // A config symlink, even to a private file under a writable parent.
        let open = b.join("open");
        std::fs::create_dir(&open).unwrap();
        set(&open, 0o777);
        std::fs::write(open.join("target.yml"), "x").unwrap();
        set(&open.join("target.yml"), 0o600);
        std::os::unix::fs::symlink(open.join("target.yml"), p.join(".hack/hack.config.json"))
            .unwrap();
        assert!(untrusted(trusted_root(&p)), "config symlink");
        std::fs::remove_file(p.join(".hack/hack.config.json")).unwrap();
        // An empty .hack is not a project for the CLI.
        let empty = b.join("empty");
        std::fs::create_dir_all(empty.join(".hack")).unwrap();
        set(&empty, 0o700);
        set(&empty.join(".hack"), 0o700);
        assert!(untrusted(trusted_root(&empty)), "empty .hack");
        // A .dev project below an ancestor .hack project: the CLI picks the
        // ancestor, so the nested root is refused.
        let outer = b.join("outer");
        make_project(&outer, ".hack", "docker-compose.yml");
        let inner = outer.join("inner");
        make_project(&inner, ".dev", "docker-compose.yml");
        assert!(untrusted(trusted_root(&inner)), "ancestor .hack wins");
        // A child whose parent is group-writable.
        let g = b.join("g");
        std::fs::create_dir(&g).unwrap();
        let proj = g.join("proj");
        make_project(&proj, ".hack", "docker-compose.yml");
        set(&g, 0o775);
        assert!(untrusted(trusted_root(&proj)), "writable ancestor");
        set(&open, 0o700);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn fixture_logs_honour_the_service_filter_and_native_note() {
        let src = FixtureSource(Fixture::Running);
        let args: Vec<String> = ["logs", "--json", "--tail", "500", "worker"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut feed = src
            .open_logs(Path::new("/work/x"), false, None, &args)
            .unwrap();
        let events = feed.poll(1000).events;
        assert!(
            events
                .iter()
                .filter_map(|e| e.entry.as_ref())
                .all(|e| e.service.as_deref() == Some("worker"))
        );
        assert!(feed.poll(1000).events.is_empty(), "delivered once");
        assert!(
            src.open_logs(Path::new("/work/x"), true, None, &args)
                .is_err()
        );
    }

    #[test]
    fn lifecycle_actions_run_to_completion_without_an_app_deadline() {
        // A Start slower than any read timeout still completes; Open keeps
        // its bounded limit. (The CLI owns lifecycle timeouts.)
        let b = base("lifecycle");
        let p = b.join("p");
        make_project(&p, ".hack", "docker-compose.yml");
        let hack = b.join("hack");
        crate::test_support::script(
            &hack,
            "#!/bin/sh\nsleep 1\necho '{\"ok\":true,\"data\":{\"action\":\"up\",\"services\":{\"failed\":[]}}}'\n",
        );
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack),
            daemon: None,
        };
        if host_temp_is_trustworthy() {
            let r = src.act(&p, false, None, Action::Start);
            assert!(matches!(r, Ok(ActionOutcome::Lifecycle(_))), "{r:?}");
        } else {
            eprintln!("skipped: temp dir ancestors are not private on this host");
        }
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn mismatch_detection() {
        let s = fixtures::snapshot(Fixture::DaemonMismatch).unwrap();
        assert_eq!(s.daemon_mismatch(), Some("4.3.0"));
        assert_eq!(Snapshot::poll_interval(Some(&s)), Duration::from_secs(10));
        let mut s = fixtures::snapshot(Fixture::Running).unwrap();
        assert_eq!(s.daemon_mismatch(), None);
        assert_eq!(Snapshot::poll_interval(Some(&s)), Duration::from_secs(2));
        // The CLI's own answer decides when the strings differ.
        s.daemon.as_mut().unwrap().version = "4.3.0".into();
        s.daemon_compatible = Some(true);
        assert_eq!(s.daemon_mismatch(), None);
        assert_eq!(Snapshot::poll_interval(Some(&s)), Duration::from_secs(2));
        s.daemon_compatible = None;
        assert_eq!(s.daemon_mismatch(), Some("4.3.0"));
    }

    #[test]
    fn versions_compare_as_semver_with_prerelease_ordering() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        let cases = [
            ("5.0.0-next.18", "4.3.0", Greater),
            ("5.0.0-next.2", "5.0.0-next.10", Less),
            ("5.0.0-next.18", "5.0.0", Less),
            ("5.0.0", "5.0.0", Equal),
            ("v5.1.0", "5.0.9", Greater),
            ("5.0.0-alpha", "5.0.0-alpha.1", Less),
            ("5.0.0-1", "5.0.0-alpha", Less),
            ("5.0.0+build.7", "5.0.0", Equal),
        ];
        for (a, b, want) in cases {
            assert_eq!(compare_versions(a, b), Some(want), "{a} vs {b}");
            assert_eq!(compare_versions(b, a), Some(want.reverse()), "{b} vs {a}");
        }
        for bad in ["", "5", "5.0", "5.0.0.0", "five", "5.0.x", "5.0.0-"] {
            assert_eq!(compare_versions(bad, "5.0.0"), None, "{bad:?}");
        }
        assert_eq!(
            UpdateSide::for_versions("4.3.0", "5.0.0-next.18"),
            UpdateSide::Daemon
        );
        assert_eq!(UpdateSide::for_versions("5.1.0", "5.0.0"), UpdateSide::Cli);
        assert_eq!(UpdateSide::for_versions("dev", "5.0.0"), UpdateSide::Daemon);
        assert!(mismatch_text("dev", "5.0.0").contains("restart hackd"));
    }

    /// A fake CLI at `cli_version` whose `daemon status --json` runs
    /// `daemon_reply` (and counts calls), plus a fake hackd answering
    /// `bodies`. The CLI is warmed up before the daemon's clock starts.
    fn compat_source(
        tag: &str,
        cli_version: &str,
        daemon_reply: &str,
        bodies: Vec<String>,
    ) -> (LiveSource, std::thread::JoinHandle<()>, PathBuf) {
        let dir = private_temp_dir(tag);
        let hack = dir.join("hack");
        crate::test_support::script(
            &hack,
            format!(
                "#!/bin/sh\ncase \"$1\" in\n  version) echo '{{\"ok\":true,\"data\":{{\"schema\":\"hack.version.v1\",\"version\":\"{cli_version}\"}}}}' ;;\n  daemon) echo \"$*\" >> \"$HACK_HOME/daemon-calls\"; {daemon_reply} ;;\n  *) echo \"$*\" >> \"$HACK_HOME/unexpected\"; exit 2 ;;\nesac\n"
            ),
        );
        let runner = fixture_runner(&hack).with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1");
        runner.version(Duration::from_secs(60)).unwrap();
        let (daemon, server) = fake_daemon_bodies(bodies);
        (LiveSource::new(runner, Some(daemon)), server, dir)
    }

    fn daemon_calls(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("daemon-calls"))
            .map(|s| s.lines().map(str::to_owned).collect())
            .unwrap_or_default()
    }

    fn status_body(version: &str) -> String {
        format!(r#"{{"status":"ok","version":"{version}"}}"#)
    }

    const PROJECTS_BODY: &str = r#"{"runtime_ok":true,"projects":[{"name":"svc","status":"running","repo_root":"/work/svc"}]}"#;

    /// A fixture CLI at version 5.0.0 whose `daemon status --json` reports
    /// `socket` (a hackd outside the default home, as a prerelease channel
    /// keeps it).
    fn cli_reporting_socket(tag: &str, socket: &Path) -> (CliRunner, PathBuf) {
        let dir = private_temp_dir(tag);
        let hack = dir.join("hack-next");
        crate::test_support::script(
            &hack,
            format!(
                "#!/bin/sh\ncase \"$1\" in\n  version) echo '{{\"ok\":true,\"data\":{{\"schema\":\"hack.version.v1\",\"version\":\"5.0.0\"}}}}' ;;\n  daemon) echo '{{\"running\":true,\"socket_path\":\"{}\"}}' ;;\n  *) exit 2 ;;\nesac\n",
                socket.display()
            ),
        );
        let runner = fixture_runner(&hack).with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1");
        runner.version(Duration::from_secs(60)).unwrap();
        (runner, dir)
    }

    #[test]
    fn the_hackd_read_is_the_one_the_cli_reports_not_the_default_home() {
        let (daemon, server) = fake_daemon(PROJECTS_BODY);
        let (runner, dir) = cli_reporting_socket("hackd-from-cli", daemon.socket());
        // No fixed daemon: the source asks its CLI, whose HACK_HOME (the
        // fixture's dir) has no socket at all.
        let src = LiveSource::new(runner, None);
        let snap = src
            .snapshot()
            .expect("projects from the hackd the CLI reported");
        assert_eq!(snap.projects.projects[0].name, "svc");
        assert_eq!(
            src.hackd().map(|d| d.socket().to_path_buf()),
            Some(daemon.socket().to_path_buf())
        );
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_trusted_cli_runs_nothing() {
        let src = LiveSource::new(CliRunner::unavailable("hack"), None);
        assert!(src.hackd().is_none());
        assert!(
            matches!(src.snapshot(), Err(SourceError::CliMissing)),
            "no CLI is run"
        );
    }

    #[test]
    fn a_failed_lookup_never_falls_back_but_a_report_without_a_socket_uses_the_clis_home() {
        let dir = private_temp_dir("hackd-lookup");
        let failing = dir.join("failing");
        crate::test_support::script(&failing, "#!/bin/sh\nexit 2\n");
        let src = LiveSource::new(
            fixture_runner(&failing).with_env("HACK_HOME", dir.to_str().unwrap()),
            None,
        );
        assert!(src.hackd().is_none(), "a failed lookup reads no hackd");
        let legacy = dir.join("legacy");
        crate::test_support::script(&legacy, "#!/bin/sh\necho '{\"running\":false}'\nexit 1\n");
        let src = LiveSource::new(
            fixture_runner(&legacy).with_env("HACK_HOME", dir.to_str().unwrap()),
            None,
        );
        assert_eq!(
            src.hackd().map(|d| d.socket().to_path_buf()),
            Some(dir.join("daemon").join("hackd.sock")),
            "a valid report without socket_path uses the home the CLI inherits"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn answers_from_a_read_that_started_before_a_switch_are_dropped() {
        let cache = CliCache::default();
        let before = cache.generation();
        cache.clear_learned();
        cache.compat_put(("5.0.0".into(), "5.1.0".into()), true, before);
        assert_eq!(cache.compat_get(&("5.0.0".into(), "5.1.0".into())), None);
        cache.compat_put(("5.0.0".into(), "5.1.0".into()), true, cache.generation());
        assert_eq!(
            cache.compat_get(&("5.0.0".into(), "5.1.0".into())),
            Some(true)
        );
    }

    #[test]
    fn a_pinned_source_keeps_its_cli_after_a_switch() {
        let src = LiveSource::new(CliRunner::selectable("/opt/one/hack"), None);
        let pinned = src.pinned().expect("a live source pins");
        src.runner.select(Path::new("/opt/two/hack-next"));
        assert_eq!(
            pinned.hack_program().as_deref(),
            Some(Path::new("/opt/one/hack"))
        );
        assert_eq!(
            src.hack_program().as_deref(),
            Some(Path::new("/opt/two/hack-next"))
        );
    }

    /// A fixture CLI at `version` whose `daemon status` reports `socket`,
    /// recording each `version` call in `<dir>/version-calls`.
    fn cli_at(tag: &str, name: &str, version: &str, socket: &Path) -> (PathBuf, PathBuf) {
        let dir = private_temp_dir(tag);
        let hack = dir.join(name);
        crate::test_support::script(
            &hack,
            format!(
                "#!/bin/sh\ncase \"$1\" in\n  version) echo x >> \"{dir}/version-calls\"; echo '{{\"ok\":true,\"data\":{{\"schema\":\"hack.version.v1\",\"version\":\"{version}\"}}}}' ;;\n  daemon) echo '{{\"running\":true,\"socket_path\":\"{sock}\"}}' ;;\n  *) exit 2 ;;\nesac\n",
                dir = dir.display(),
                sock = socket.display()
            ),
        );
        fixture_runner(&hack)
            .version(Duration::from_secs(60))
            .unwrap();
        let _ = std::fs::remove_file(dir.join("version-calls"));
        (hack, dir)
    }

    #[test]
    fn a_hackd_shared_with_another_install_is_named_and_never_restarted() {
        let (daemon, server) = fake_daemon_bodies(vec![status_body("4.2.1")]);
        let (next, next_dir) = cli_at("shared-next", "hack-next", "5.0.0", daemon.socket());
        let (stable, stable_dir) = cli_at("shared-stable", "hack", "4.2.1", daemon.socket());
        let src = LiveSource::new(
            fixture_runner(&next).with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1"),
            None,
        );
        let install = |name: &str, channel, path: &Path| crate::cli_choice::Install {
            name: name.into(),
            channel,
            path: path.to_path_buf(),
        };
        *src.cache.choice.lock().unwrap() = Some(crate::cli_choice::Choice::pick(
            vec![
                install("hack", crate::cli_choice::Channel::Stable, &stable),
                install("hack-next", crate::cli_choice::Channel::Prerelease, &next),
            ],
            Some(&next),
        ));
        let err = src.snapshot().expect_err("a mismatched hackd");
        let SourceError::DaemonUnavailable {
            shared_with,
            message,
            ..
        } = &err
        else {
            panic!("{err:?}")
        };
        assert_eq!(shared_with.as_deref(), Some("hack 4.2.1 (stable)"));
        assert!(
            message.contains("hack 4.2.1 (stable)") && message.contains("5.0.0"),
            "{message}"
        );
        let mut m = crate::viewmodel::AppModel::new();
        m.apply(crate::viewmodel::Event::Refreshed(Err(err)));
        assert_eq!(
            m.daemon_recovery(),
            None,
            "no start or restart of another install's hackd"
        );
        server.join().unwrap();
        for d in [next_dir, stable_dir] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn the_cli_version_is_asked_once_per_cli_not_on_every_read() {
        let (daemon, server) = fake_daemon_bodies(vec![
            status_body("5.0.0"),
            PROJECTS_BODY.into(),
            status_body("5.0.0"),
            PROJECTS_BODY.into(),
        ]);
        let (hack, dir) = cli_at("version-cache", "hack", "5.0.0", daemon.socket());
        let src = LiveSource::new(fixture_runner(&hack), None);
        src.snapshot().unwrap();
        src.snapshot().unwrap();
        let calls = std::fs::read_to_string(dir.join("version-calls")).unwrap_or_default();
        assert_eq!(
            calls.lines().count(),
            1,
            "one version read for two snapshots"
        );
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn switching_cli_reads_the_new_clis_hackd() {
        let (first, first_server) = fake_daemon(PROJECTS_BODY);
        let (second, second_server) = fake_daemon(
            r#"{"runtime_ok":true,"projects":[{"name":"other","status":"stopped","repo_root":"/work/other"}]}"#,
        );
        let (one, dir_one) = cli_reporting_socket("hackd-switch-one", first.socket());
        let (two, dir_two) = cli_reporting_socket("hackd-switch-two", second.socket());
        let program_two = two.program_path().unwrap();
        let runner = CliRunner::selectable(one.program_path().unwrap())
            .with_env("HACK_HOME", dir_one.to_str().unwrap())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1");
        let src = LiveSource::new(runner, None);
        assert_eq!(src.snapshot().unwrap().projects.projects[0].name, "svc");
        src.runner.select(&program_two);
        src.cache.clear_learned();
        assert_eq!(src.snapshot().unwrap().projects.projects[0].name, "other");
        first_server.join().unwrap();
        second_server.join().unwrap();
        std::fs::remove_dir_all(dir_one).unwrap();
        std::fs::remove_dir_all(dir_two).unwrap();
    }

    #[test]
    fn a_native_projects_doctor_read_names_its_url() {
        let payload: ProjectsPayload = serde_json::from_str(
            r#"{"projects":[
                {"name":"nat","status":"stopped","repo_root":"/work/nat","backend":"native","dev_host":"nat.hack"},
                {"name":"svc","status":"stopped","repo_root":"/work/svc","dev_host":"svc.hack"},
                {"name":"odd","status":"stopped","repo_root":"/work/odd","backend":"native","dev_host":"-x.hack"}
            ]}"#,
        )
        .unwrap();
        let targets = DoctorTarget::from_projects(&payload);
        let url = |n: &str| {
            targets
                .iter()
                .find(|t| t.name == n)
                .unwrap()
                .browser_url
                .clone()
        };
        assert_eq!(url("nat").as_deref(), Some("https://nat.hack"));
        assert_eq!(url("svc"), None, "Compose projects need no URL");
        assert_eq!(
            url("odd"),
            None,
            "a host that looks like an option is never passed"
        );

        let dir = private_temp_dir("doctor-browser-url");
        let hack = dir.join("hack");
        crate::test_support::script(
            &hack,
            "#!/bin/sh\necho \"$*\" > \"$HACK_HOME/args\"\necho '{\"checks\":[{\"id\":\"x\",\"status\":\"ok\"}]}'\n",
        );
        let runner = fixture_runner(&hack);
        read_doctor(
            &runner,
            None,
            Some("https://nat.hack"),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("args")).unwrap().trim(),
            "doctor --json --browser-url https://nat.hack"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn equal_versions_match_without_asking_the_cli() {
        let (src, server, dir) = compat_source(
            "compat-equal",
            "5.0.0",
            "exit 9",
            vec![status_body("5.0.0"), PROJECTS_BODY.into()],
        );
        let snap = src.snapshot().unwrap();
        server.join().unwrap();
        assert_eq!(snap.daemon_compatible, Some(true));
        assert_eq!(snap.daemon_mismatch(), None);
        assert!(daemon_calls(&dir).is_empty());
        assert!(!dir.join("unexpected").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn differing_versions_use_api_compatible_and_cache_it() {
        let (src, server, dir) = compat_source(
            "compat-true",
            "5.0.0-next.18",
            r#"echo '{"status":"running","api_reachable":true,"api_compatible":true}'"#,
            vec![
                status_body("4.3.0"),
                PROJECTS_BODY.into(),
                status_body("4.3.0"),
                PROJECTS_BODY.into(),
            ],
        );
        let first = src.snapshot().unwrap();
        let second = src.snapshot().unwrap();
        server.join().unwrap();
        for snap in [&first, &second] {
            assert_eq!(snap.daemon_compatible, Some(true));
            assert_eq!(snap.daemon_mismatch(), None);
            assert_eq!(Snapshot::poll_interval(Some(snap)), Duration::from_secs(2));
        }
        assert_eq!(daemon_calls(&dir), ["daemon status --json"], "asked once");
        let mut m = crate::viewmodel::AppModel::new();
        m.apply(crate::viewmodel::Event::Refreshed(Ok(second)));
        assert!(m.list().banners.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn incompatible_daemon_names_the_side_to_update() {
        use crate::viewmodel::{AppModel, Banner, Event};
        for (cli, daemon, side, recovery) in [
            (
                "5.0.0",
                "4.3.0",
                UpdateSide::Daemon,
                Some(DaemonRecovery::Restart),
            ),
            ("5.0.0", "5.1.0", UpdateSide::Cli, None),
        ] {
            let (src, server, dir) = compat_source(
                "compat-false",
                cli,
                r#"echo '{"status":"incompatible","api_reachable":true,"api_compatible":false}'; exit 1"#,
                vec![status_body(daemon)],
            );
            let r = src.snapshot();
            server.join().unwrap();
            assert!(
                matches!(&r, Err(SourceError::DaemonUnavailable { compatible: false, daemon: Some(d), .. }) if d == daemon),
                "{r:?}"
            );
            let mut m = AppModel::new();
            m.apply(Event::Refreshed(r));
            let banners = m.list().banners;
            assert_eq!(banners, [Banner::mismatch(daemon, cli)]);
            assert!(
                matches!(&banners[0], Banner::DaemonMismatch { update, .. } if *update == side)
            );
            assert_eq!(m.daemon_recovery(), recovery);
            let text = banners[0].text();
            match side {
                UpdateSide::Daemon => assert!(
                    text.contains("older") && text.contains("restart hackd"),
                    "{text}"
                ),
                UpdateSide::Cli => assert!(
                    text.contains("newer") && text.contains("hack update"),
                    "{text}"
                ),
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn failed_compatibility_answers_mismatch_and_are_not_cached() {
        for reply in [
            "exit 3",
            "echo not-json",
            r#"echo '{"api_reachable":false,"api_compatible":true}'"#,
        ] {
            let (src, server, dir) = compat_source(
                "compat-fail",
                "5.0.0-next.18",
                reply,
                vec![status_body("4.3.0"), status_body("4.3.0")],
            );
            for _ in 0..2 {
                let r = src.snapshot();
                assert!(
                    matches!(
                        &r,
                        Err(SourceError::DaemonUnavailable {
                            compatible: false,
                            shared_with: None,
                            ..
                        })
                    ),
                    "{reply}: {r:?}"
                );
            }
            server.join().unwrap();
            assert_eq!(daemon_calls(&dir).len(), 2, "{reply}: asked every time");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn branch_names_are_validated() {
        for ok in [
            "feature-search",
            "fix/login",
            "a",
            &"b".repeat(MAX_BRANCH_LEN),
        ] {
            assert_eq!(validate_branch(ok).unwrap(), ok);
        }
        let long = "b".repeat(MAX_BRANCH_LEN + 1);
        for bad in [
            "",
            "-x",
            "--help",
            "a b",
            "a\tb",
            "a\nb",
            "a\u{7}b",
            long.as_str(),
        ] {
            assert!(
                matches!(validate_branch(bad), Err(SourceError::Cli { ref code, .. }) if code == "E_APP_INVALID_BRANCH"),
                "{bad:?}"
            );
        }
        assert_eq!(
            with_branch(&["logs", "--json", "api"], Some("b")),
            ["logs", "--branch", "b", "--json", "api"]
        );
        assert_eq!(with_branch(&["logs", "--json"], None), ["logs", "--json"]);
    }

    /// A fake CLI that records its argv and answers with a lifecycle/open
    /// envelope (or a finite log stream for `logs`).
    fn argv_hack(dir: &Path) -> PathBuf {
        let hack = dir.join("hack");
        crate::test_support::script(
            &hack,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$HACK_HOME/argv\"\nif [ \"$1\" = logs ]; then echo '{\"type\":\"start\"}'; echo '{\"type\":\"end\",\"reason\":\"eof\"}'; exit 0; fi\necho '{\"ok\":true,\"data\":{\"action\":\"up\",\"url\":\"https://fix-login.storefront.hack\",\"services\":{\"failed\":[]}}}'\n",
        );
        hack
    }

    fn argv(dir: &Path) -> Vec<String> {
        let a = std::fs::read_to_string(dir.join("argv")).unwrap_or_default();
        let lines: Vec<String> = a.lines().map(str::to_owned).collect();
        let _ = std::fs::remove_file(dir.join("argv"));
        lines
    }

    #[test]
    fn branch_is_passed_to_logs_and_actions() {
        // Canonical once: on macOS the temp directory is reached through a
        // link (/var -> /private/var) and the runner passes canonical roots.
        let b = std::fs::canonicalize(base("branch-argv")).expect("canonical test root");
        let hack = argv_hack(&b);
        let src = LiveSource::new(fixture_runner(&hack), None);
        src.log_tail(&b, false, Some("feature-search"), 50).unwrap();
        let got = argv(&b);
        assert_eq!(
            got[..7],
            [
                "logs",
                "--branch",
                "feature-search",
                "--json",
                "--no-follow",
                "--tail",
                "50"
            ]
        );
        assert_eq!(got[7], "--path", "the runner appends the root");
        src.log_tail(&b, false, None, 50).unwrap();
        assert!(!argv(&b).iter().any(|a| a == "--branch"));
        if host_temp_is_trustworthy() {
            let p = b.join("p");
            make_project(&p, ".hack", "docker-compose.yml");
            for (action, cmd) in [
                (Action::Start, "up"),
                (Action::Stop, "down"),
                (Action::Restart, "restart"),
                (Action::Open, "open"),
            ] {
                let r = src.act(&p, false, Some("fix-login"), action);
                assert!(r.is_ok(), "{action:?}: {r:?}");
                let got = argv(&b);
                assert_eq!(got[..3], [cmd, "--branch", "fix-login"], "{action:?}");
                // Open has no positional target: `hack open --branch b` opens
                // the instance's own host, never a service route.
                if action == Action::Open {
                    let root = p.to_string_lossy().into_owned();
                    assert_eq!(
                        got,
                        [
                            "open",
                            "--branch",
                            "fix-login",
                            "--json",
                            "--no-interactive",
                            "--path",
                            root.as_str()
                        ],
                    );
                }
                assert!(got.iter().any(|a| a == "--json"));
            }
            src.act(&p, false, None, Action::Start).unwrap();
            assert!(!argv(&b).iter().any(|a| a == "--branch"));
        } else {
            eprintln!("skipped actions: temp dir ancestors are not private on this host");
        }
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn invalid_branch_names_never_run_the_cli() {
        let b = base("branch-invalid");
        let hack = argv_hack(&b);
        let src = LiveSource::new(fixture_runner(&hack), None);
        for bad in ["", "-rf", "a b", "a\u{1b}b"] {
            let r = src.act(&b, false, Some(bad), Action::Start);
            assert!(
                matches!(&r, Err(SourceError::Cli { code, .. }) if code == "E_APP_INVALID_BRANCH"),
                "{bad:?}: {r:?}"
            );
            assert!(src.log_tail(&b, false, Some(bad), 10).is_err());
            assert!(
                src.open_logs(&b, false, Some(bad), &["logs".into(), "--json".into()])
                    .is_err()
            );
            assert!(
                FixtureSource(Fixture::Running)
                    .act(&b, false, Some(bad), Action::Open)
                    .is_err()
            );
        }
        assert!(!b.join("argv").exists(), "the CLI was run");
        let _ = std::fs::remove_dir_all(&b);
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

    /// The usage view's two reads, exactly as the CLI receives them.
    #[test]
    fn usage_reads_by_service_and_ps_for_the_shown_instance() {
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-usage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let hack = dir.join("hack");
        crate::test_support::script(
            &hack,
            r#"#!/bin/sh
printf '%s %s\n' "$HACK_RUNTIME_BACKEND" "$*" >> "$HACK_HOME/calls"
case "$1" in
  usage)
    if [ "$3" = "--details" ]; then
      echo '{"runtime_ok":true,"containers":[{"containerId":"aaaaaaaaaaaa","project":"shop","service":"api","netInputBytes":1000,"configuredMemoryLimitBytes":67108864}]}'
    else
      echo '{"ok":true,"data":{"schema":"hack.usage.by-service.v1","project":"shop","services":[{"composeProject":"shop","service":"api","containers":1,"cpuPercent":1.5,"memUsedBytes":1048576,"memLimitBytes":null}]}}'
    fi
    ;;
  ps) echo '{"ok":true,"data":{"items":[{"Service":"api","emulated":true},{"Service":"db"}]}}' ;;
esac
"#,
        );
        let src = LiveSource {
            cache: Default::default(),
            runner: fixture_runner(&hack)
                .with_env("HACK_HOME", &dir.to_string_lossy())
                .with_env("HOME", &dir.to_string_lossy())
                .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
                // Inherited from the app's environment: must not leak in.
                .with_env("HACK_RUNTIME_BACKEND", "native"),
            daemon: None,
        };
        let root = Path::new("/work/shop");
        let report = src.service_usage(root).unwrap();
        assert_eq!(report.for_instance("shop")["api"].cpu_percent, Some(1.5));
        let stats = src.stats_sample().unwrap();
        assert_eq!(stats.containers[0].net_input_bytes, Some(1000));
        assert_eq!(
            stats.containers[0].configured_memory_limit_bytes,
            Some(67_108_864)
        );
        let base = src.emulated_services(root, None).unwrap();
        assert_eq!(base, std::collections::BTreeSet::from(["api".to_owned()]));
        src.emulated_services(root, Some("preview")).unwrap();
        assert!(
            src.emulated_services(root, Some("--all")).is_err(),
            "not a branch name"
        );
        let calls = std::fs::read_to_string(dir.join("calls")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            vec![
                "compose usage --json --by-service --path /work/shop",
                "compose usage --json --details --no-host",
                "compose ps --json --path /work/shop",
                "compose ps --json --branch preview --path /work/shop",
            ]
        );
    }
}
