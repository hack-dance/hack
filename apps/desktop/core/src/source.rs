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
    /// Cache-backed reads refresh quickly; unavailable or mismatched
    /// daemon reads retry slowly, without spawning a registry writer.
    #[must_use]
    pub fn poll_interval(snapshot: Option<&Self>) -> Duration {
        if snapshot.is_some_and(|s| {
            s.daemon
                .as_ref()
                .is_some_and(|d| d.version == s.cli_version)
        }) {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(10)
        }
    }
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
    /// Project reads require a matching daemon until observe-only CLI listing exists.
    DaemonUnavailable {
        cli: String,
        daemon: Option<String>,
        message: String,
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
pub const NATIVE_LOGS_NOTE: &str =
    "Native logs are read one service at a time; they arrive with the Logs tab.";

pub trait Source: Send + Sync {
    /// Explicit user recovery only; never called by a poll.
    /// # Errors
    /// Failed or unavailable daemon command.
    fn recover_daemon(&self, _action: DaemonRecovery) -> Result<(), String> {
        Err("Daemon actions are unavailable for this source".into())
    }
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

/// Live data from a matching hackd. CLI listing fallback needs R18:
/// today's `projects` command auto-registers projects and writes the registry.
pub struct LiveSource {
    pub runner: CliRunner,
    pub daemon: Option<DaemonClient>,
}

impl LiveSource {
    /// The live source exactly as the app builds it: `hack` resolved on
    /// absolute PATH entries, and the hackd socket under `HACK_HOME`
    /// (else `~/.hack`). Used by the window and by `hack-desktop-state`.
    #[must_use]
    pub fn from_env() -> Self {
        let socket = crate::daemon::default_socket_path(
            std::env::var("HACK_HOME").ok().as_deref(),
            std::env::var("HOME").ok().as_deref(),
        );
        Self {
            runner: CliRunner::on_path("hack"),
            daemon: socket.map(|s| DaemonClient::new(s, Duration::from_secs(3))),
        }
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
    fn recover_daemon(&self, action: DaemonRecovery) -> Result<(), String> {
        let (_, stderr, code) = self
            .runner
            .run_raw(
                &["daemon", action.command()],
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
            Err(format!(
                "Could not {} hackd: command {exit}. {}",
                action.command(),
                stderr.trim()
            ))
        }
    }
    fn snapshot(&self) -> Result<Snapshot, SourceError> {
        let cli_version = self.runner.version(Duration::from_secs(5))?;
        let daemon = self.daemon.as_ref().and_then(|d| d.status().ok());
        let from_daemon = daemon
            .as_ref()
            .filter(|d| d.version == cli_version)
            .and(self.daemon.as_ref())
            .and_then(|d| d.projects().ok());
        let mut projects = from_daemon.ok_or_else(|| SourceError::DaemonUnavailable {
            cli: cli_version.clone(),
            daemon: daemon.as_ref().map(|d| d.version.clone()),
            message: match &daemon {
                None => "hackd is off or unreachable. Start hackd to read project status.".into(),
                Some(d) if d.version != cli_version => format!(
                    "hackd v{}, CLI v{cli_version}. Restart hackd to read project status.",
                    d.version
                ),
                Some(_) => {
                    "hackd could not provide project status. Check again or restart hackd.".into()
                }
            },
        })?;
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

        let args = action.cli_args();
        let runner = self.runner_for(native);
        Ok(match action {
            Action::Open => {
                ActionOutcome::Opened(runner.run_json(args, Some(repo_root), Self::OPEN)?)
            }
            // No app deadline: busy until the CLI exits (see LIFECYCLE_WARN_AFTER).
            _ => ActionOutcome::Lifecycle(runner.run_json_to_completion(args, Some(repo_root))?),
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

/// Mirror of the CLI's project discovery from `root` (see
/// `discoverProjectInputs` in `src/lib/project-input-selection.ts`): `true`
/// only when discovery starting at `root` selects `root` itself.
/// - `.hack/hack.project.json` (native) or `.hack/docker-compose.yml` at
///   `root` selects it;
/// - `.dev/docker-compose.yml` alone selects it unless an ancestor with
///   `.hack/docker-compose.yml` is reached before an ancestor native marker.
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

    fn fake_daemon(projects: &str) -> (DaemonClient, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
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
        let projects = projects.to_owned();
        let handle = std::thread::spawn(move || {
            for body in [r#"{"status":"ok","version":"5.0.0"}"#.to_owned(), projects] {
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
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
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /v1/"));
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
        (DaemonClient::new(socket, Duration::from_secs(2)), handle)
    }

    /// A trusted fake daemon provides rows; only native ps uses the fake CLI.
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
        let (daemon, server) = fake_daemon(
            r#"{"runtime_ok":true,"projects":[{"name":"svc","status":"running","repo_root":"/work/svc"},{"name":"nat","status":"unavailable","repo_root":"/work/nat","backend":"native"}]}"#,
        );
        let src = LiveSource {
            runner: CliRunner::new(&hack).with_env("HACK_HOME", &dir.to_string_lossy()),
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
        let (daemon, server) = fake_daemon("{}");
        let src = LiveSource {
            runner: CliRunner::new(&hack),
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
    fn lifecycle_actions_run_to_completion_without_an_app_deadline() {
        // A Start slower than any read timeout still completes; Open keeps
        // its bounded limit. (The CLI owns lifecycle timeouts.)
        use std::os::unix::fs::PermissionsExt;
        let b = base("lifecycle");
        let p = b.join("p");
        make_project(&p, ".hack", "docker-compose.yml");
        let hack = b.join("hack");
        std::fs::write(
            &hack,
            "#!/bin/sh\nsleep 1\necho '{\"ok\":true,\"data\":{\"action\":\"up\",\"services\":{\"failed\":[]}}}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = LiveSource {
            runner: CliRunner::new(&hack),
            daemon: None,
        };
        if host_temp_is_trustworthy() {
            let r = src.act(&p, false, Action::Start);
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
