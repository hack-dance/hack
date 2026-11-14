//! Where the app's data comes from: the live CLI and daemon, or fixtures.

use std::path::{Path, PathBuf};
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
        // Actions run checkout-defined lifecycle commands as the user: run
        // only on a validated root, by its canonical path.
        let real = trusted_root(repo_root)?;
        let repo_root = real.as_path();
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
/// - the root itself carries a Hack project marker (`hack.project.json`,
///   `.hack/`, or `.dev/` with a project file), so the CLI's ancestor
///   discovery cannot select some other project;
/// - each project config entry (and each file directly in `.hack/` or
///   `.dev/`, following symlinks) is owned by this user and not
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
    let private = |p: &Path| -> Result<(), SourceError> {
        let m = std::fs::metadata(p) // follows symlinks: checks the target
            .map_err(|_| refuse(format!("{} could not be read", p.display())))?;
        if m.uid() != uid || m.mode() & 0o022 != 0 {
            return Err(refuse(format!(
                "{} is not yours alone (owner or write permissions)",
                p.display()
            )));
        }
        Ok(())
    };
    let legacy_files = ["docker-compose.yml", "hack.config.json", "hack.toml"];
    let native = real.join("hack.project.json");
    let hack_dir = real.join(".hack");
    let dev_dir = real.join(".dev");
    let has_marker = native.is_file()
        || hack_dir.is_dir()
        || (dev_dir.is_dir() && legacy_files.iter().any(|f| dev_dir.join(f).is_file()));
    if !has_marker {
        return Err(refuse(
            "the project folder has no Hack project files".into(),
        ));
    }
    if native.exists() {
        private(&native)?;
    }
    for d in [&hack_dir, &dev_dir] {
        if !d.exists() {
            continue;
        }
        private(d)?;
        let entries = std::fs::read_dir(d)
            .map_err(|_| refuse(format!("{} could not be read", d.display())))?;
        for e in entries {
            let e = e.map_err(|_| refuse(format!("{} could not be read", d.display())))?;
            private(&e.path())?;
        }
    }
    Ok(real)
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

    /// A fresh private base under the temp dir, or `None` when the temp
    /// dir's own ancestors are not trustworthy on this host (then the
    /// positive cases cannot be asserted and are skipped).
    fn private_base(tag: &str) -> Option<PathBuf> {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "hack-desktop-trust-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join(".hack")).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(dir.join(".hack"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        std::fs::write(dir.join(".hack/hack.config.json"), "{}").unwrap();
        std::fs::set_permissions(
            dir.join(".hack/hack.config.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        if trusted_root(&dir).is_ok() {
            Some(dir)
        } else {
            let _ = std::fs::remove_dir_all(&dir);
            None
        }
    }

    #[test]
    fn trusted_root_accepts_a_private_project_and_returns_its_real_path() {
        let Some(dir) = private_base("ok") else {
            eprintln!("skipped: temp dir ancestors are not private on this host");
            return;
        };
        let link = dir.with_extension("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let real = trusted_root(&link).unwrap();
        assert_eq!(
            real,
            std::fs::canonicalize(&dir).unwrap(),
            "runs the real path"
        );
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trusted_root_refuses_writable_or_unmarked_or_foreign() {
        use std::os::unix::fs::PermissionsExt;
        let set = |p: &Path, m: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap()
        };
        let untrusted = |r: Result<PathBuf, SourceError>| matches!(r, Err(SourceError::Cli { ref code, .. }) if code == "E_APP_UNTRUSTED_ROOT");
        assert!(untrusted(trusted_root(Path::new("relative/dir"))));
        let Some(dir) = private_base("bad") else {
            eprintln!("skipped: temp dir ancestors are not private on this host");
            return;
        };
        // World-writable root.
        set(&dir, 0o777);
        assert!(untrusted(trusted_root(&dir)), "0777 root");
        set(&dir, 0o700);
        // Group-writable config file.
        set(&dir.join(".hack/hack.config.json"), 0o664);
        assert!(untrusted(trusted_root(&dir)), "writable config");
        set(&dir.join(".hack/hack.config.json"), 0o600);
        // A config entry that is a symlink to a foreign-owned file.
        if Path::new("/etc/hostname").exists() && unsafe { libc::getuid() } != 0 {
            std::os::unix::fs::symlink("/etc/hostname", dir.join(".hack/docker-compose.yml"))
                .unwrap();
            assert!(untrusted(trusted_root(&dir)), "symlink to a foreign file");
            std::fs::remove_file(dir.join(".hack/docker-compose.yml")).unwrap();
        }
        // No project marker: the CLI could pick another project above it.
        let bare = dir.join("sub");
        std::fs::create_dir(&bare).unwrap();
        set(&bare, 0o700);
        assert!(untrusted(trusted_root(&bare)), "no marker");
        // A child whose parent is group-writable.
        let open = dir.join("open");
        std::fs::create_dir_all(open.join("proj/.hack")).unwrap();
        set(&open, 0o775);
        set(&open.join("proj"), 0o700);
        set(&open.join("proj/.hack"), 0o700);
        assert!(
            untrusted(trusted_root(&open.join("proj"))),
            "writable ancestor"
        );
        assert!(trusted_root(&dir).is_ok(), "restored base is trusted again");
        let _ = std::fs::remove_dir_all(&dir);
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
