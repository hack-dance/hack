//! Where the app's data comes from: the live CLI and daemon, or fixtures.

use std::path::Path;
use std::time::Duration;

use crate::daemon::DaemonClient;
use crate::doctor::DoctorRun;
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
pub const NATIVE_LOGS_NOTE: &str =
    "Native logs are read one service at a time; they arrive with the Logs tab.";

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

    /// Doctor runs: one outside any project, then one per project
    /// (DESIGN.md section 3). Each run fails on its own.
    fn doctor_runs(&self, projects: &[DoctorTarget]) -> Vec<DoctorRun>;
}

/// A project to run doctor for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorTarget {
    pub name: String,
    pub repo_root: std::path::PathBuf,
    pub native: bool,
}

/// Identity of each target (name, checkout, backend) for the stale guard.
#[must_use]
pub fn target_keys(targets: &[DoctorTarget]) -> Vec<crate::doctor::TargetKey> {
    targets
        .iter()
        .map(|t| (t.name.clone(), t.repo_root.clone(), t.native))
        .collect()
}

impl DoctorTarget {
    fn run(&self, result: Result<crate::models::DoctorReport, String>) -> DoctorRun {
        DoctorRun {
            project: Some(self.name.clone()),
            root: Some(self.repo_root.clone()),
            native: self.native,
            result,
        }
    }

    /// Doctor targets for every project row with a checkout.
    #[must_use]
    pub fn from_projects(p: &ProjectsPayload) -> Vec<Self> {
        p.projects
            .iter()
            .filter_map(|r| {
                Some(Self {
                    name: r.name.clone(),
                    repo_root: r.repo_root.clone()?.into(),
                    native: r.is_native(),
                })
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
fn read_doctor(
    runner: &CliRunner,
    root: Option<&Path>,
    timeout: Duration,
) -> Result<crate::models::DoctorReport, String> {
    let v: serde_json::Value = runner
        .run_json(&["doctor", "--json"], root, timeout)
        .map_err(|e| e.to_string())?;
    if !v.get("checks").is_some_and(serde_json::Value::is_array) {
        return Err("doctor printed no checks list".into());
    }
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Live data: hackd when its version matches the CLI, else the CLI.
pub struct LiveSource {
    pub runner: CliRunner,
    pub daemon: Option<DaemonClient>,
}

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
        let deadline = std::time::Instant::now() + budget;
        let left = || deadline.saturating_duration_since(std::time::Instant::now());
        let read = |runner: &CliRunner, root: Option<&Path>, timeout: Duration| {
            read_doctor(runner, root, timeout)
        };
        // The machine run must happen outside every checkout, or doctor
        // would report that checkout's project checks as machine checks.
        // Prefer a user-private directory; the shared temp dir is a last
        // resort (children get an all-absolute PATH either way).
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from)
            && crate::doctor::is_private_dir(&run)
        {
            candidates.push(run);
        }
        candidates.extend([std::env::temp_dir(), std::path::PathBuf::from("/")]);
        let machine = match crate::doctor::neutral_dir(&candidates) {
            Some(dir) => read(
                &self.runner.clone().with_cwd(dir),
                None,
                per_call.min(left()),
            ),
            None => Err("machine checks could not run outside a project".into()),
        };
        let mut runs = vec![DoctorRun::machine(machine)];
        for chunk in projects.chunks(DOCTOR_PARALLEL) {
            let chunk_runs: Vec<DoctorRun> = std::thread::scope(|s| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|t| {
                        let runner = self.runner_for(t.native);
                        let timeout = per_call.min(left());
                        s.spawn(move || {
                            let result = if timeout.is_zero() {
                                Err(NOT_CHECKED_BUDGET.to_owned())
                            } else {
                                read(&runner, Some(&t.repo_root), timeout)
                            };
                            t.run(result)
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
        runs
    }

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

    fn doctor_runs(&self, projects: &[DoctorTarget]) -> Vec<DoctorRun> {
        self.doctor_runs_within(projects, DOCTOR_BUDGET, DOCTOR_TIMEOUT)
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
    fn snapshot(&self) -> Result<Snapshot, SourceError> {
        fixtures::snapshot(self.0)
    }

    fn doctor_runs(&self, _projects: &[DoctorTarget]) -> Vec<DoctorRun> {
        fixtures::doctor_runs(self.0)
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
        std::fs::write(&hack, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        hack
    }

    fn targets(n: usize) -> Vec<DoctorTarget> {
        (0..n)
            .map(|i| DoctorTarget {
                name: format!("p{i}"),
                repo_root: format!("/work/p{i}").into(),
                native: false,
            })
            .collect()
    }

    #[test]
    fn doctor_payload_without_checks_is_not_a_report() {
        let hack = fake_hack("doctor-empty", r#"echo '{"ok":true,"data":{}}'"#);
        let src = LiveSource {
            runner: CliRunner::new(&hack),
            daemon: None,
        };
        let runs = src.doctor_runs(&targets(1));
        let _ = std::fs::remove_dir_all(hack.parent().unwrap());
        assert!(runs.iter().all(|r| r.result.is_err()), "{runs:?}");
        assert!(matches!(
            crate::doctor::DoctorState::from_runs(&runs),
            crate::doctor::DoctorState::Error(_)
        ));
    }

    #[test]
    fn doctor_budget_marks_late_projects_not_checked() {
        let hack = fake_hack("doctor-slow", "sleep 5");
        let src = LiveSource {
            runner: CliRunner::new(&hack),
            daemon: None,
        };
        let started = std::time::Instant::now();
        let runs = src.doctor_runs_within(
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
  *--path*) echo '{"ok":true,"data":{"checks":[{"id":"env key","status":"error","detail":"key missing"}],"summary":[],"counts":{"ok":0,"warn":0,"error":1}}}'; exit 1 ;;
  *) echo '{"ok":true,"data":{"checks":[{"id":"docker daemon","status":"ok","detail":""}],"summary":[],"counts":{"ok":1,"warn":0,"error":0}}}' ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = LiveSource {
            runner: CliRunner::new(&hack).with_env("HACK_HOME", &dir.to_string_lossy()),
            daemon: None,
        };
        let runs = src.doctor_runs(&[DoctorTarget {
            name: "alpha".into(),
            repo_root: "/work/alpha".into(),
            native: false,
        }]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(runs.len(), 2);
        assert!(runs[0].project.is_none());
        let alpha = runs[1].result.as_ref().expect("exit 1 keeps the report");
        assert_eq!(alpha.checks[0].id, "env key");
        let v = crate::doctor::aggregate(&runs);
        assert_eq!(v.attention_count(), 1);
        assert_eq!(v.passed, 1);
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
