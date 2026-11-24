//! Typed views of what `hack ... --json` and `hackd` return.
//!
//! Every struct is lenient (`#[serde(default)]`): the CLI adds fields over
//! time and the app must keep working on older and newer payloads. Unknown
//! fields are ignored; missing ones take their default. Values that the app
//! cannot interpret stay as strings, so "unknown" is never turned into
//! "stopped".

use serde::{Deserialize, Deserializer, Serialize};

/// Treat an explicit JSON `null` like a missing field. The CLI emits `null`
/// for collections of projects it could not read (missing Compose file,
/// input diagnostic); one such row must not fail the whole payload.
fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// `GET /v1/projects` and `hack projects --json` (same shape).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct ProjectsPayload {
    pub generated_at: Option<String>,
    pub detail_level: Option<String>,
    /// `false` when the container runtime could not be read.
    pub runtime_ok: Option<bool>,
    pub runtime_error: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub projects: Vec<ProjectRow>,
    /// Machine-wide always-on state (docs/always-on-projects.md, "JSON
    /// contract"). `None` when the payload does not carry it.
    pub autostart_global: Option<AutostartGlobal>,
}

impl ProjectsPayload {
    /// Parse a payload that must carry a `projects` array. `{}` or a
    /// payload without it is malformed, not an empty registry.
    ///
    /// # Errors
    /// A message naming what is wrong.
    pub fn from_value(v: serde_json::Value) -> Result<Self, String> {
        if !v.get("projects").is_some_and(serde_json::Value::is_array) {
            return Err("projects payload has no projects array".into());
        }
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    /// The engine is known to be unavailable (not merely unreported).
    #[must_use]
    pub fn engine_down(&self) -> bool {
        self.runtime_ok == Some(false)
    }
}

/// One project row. Holds the union of the summary and full row fields.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct ProjectRow {
    pub project_id: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub name: String,
    pub dev_host: Option<String>,
    pub repo_root: Option<String>,
    /// `running | stopped | missing | unregistered | unavailable | unknown`.
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    /// Adds `not_configured` to the `status` values.
    pub runtime_status: Option<String>,
    pub kind: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub defined_services: Vec<String>,
    #[serde(deserialize_with = "null_default")]
    pub service_hosts: std::collections::BTreeMap<String, Vec<String>>,
    pub input_diagnostic: Option<InputDiagnostic>,
    pub runtime: Option<ProjectRuntime>,
    // Summary-only counters.
    pub defined_service_count: Option<u32>,
    pub container_count: Option<u32>,
    pub running_container_count: Option<u32>,
    /// Not in the CLI yet (design request R12): always-on state.
    pub autostart: Option<Autostart>,
    /// Not in the CLI yet (design request R2): `compose` or `native`.
    pub backend: Option<String>,
    /// Native observation from `hack ps --json` (filled by the source).
    #[serde(skip)]
    pub native: Option<NativePs>,
    /// This read has not asked `hack ps` for this native project yet
    /// ([`crate::source::Source::listing`]); the app reads it next, on its
    /// own. Meanwhile [`Self::native`] is the previous read's observation,
    /// kept for display, or `None`. A pending row is never evidence: it does
    /// not clear a failed start or report shells.
    #[serde(skip)]
    pub native_pending: bool,
    /// Running branch instances (`hack up --branch <name>`), Compose only.
    /// Native branch instances are not reported here (design request R19).
    #[serde(deserialize_with = "null_default")]
    pub branch_runtime: Vec<BranchRuntime>,
    /// Linked worktrees registered for this project (paths only are used).
    #[serde(deserialize_with = "null_default")]
    pub worktrees: Vec<Worktree>,
    /// Set on a row derived by [`ProjectRow::instance`]: the branch this
    /// row describes. `None` for the project's base instance.
    #[serde(skip)]
    pub branch: Option<String>,
}

/// One registered linked worktree in a `/v1/projects` row.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Worktree {
    pub path: Option<String>,
    pub branch: Option<String>,
}

/// A path without a trailing slash ("/" stays "/").
fn trim_path(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        "/".into()
    } else {
        t.to_owned()
    }
}

/// Absolute, with no `.` or `..` component and no NUL.
fn plain_path(p: &str) -> bool {
    p.starts_with('/')
        && !p
            .split('/')
            .any(|part| part == "." || part == ".." || part.contains('\0'))
}

/// The project folder names the CLI creates inside a checkout.
const PROJECT_DIR_NAMES: [&str; 2] = [".hack", ".dev"];

impl ProjectRow {
    /// The checkout that owns a runtime, by the CLI's own ownership rule
    /// (`assertPruneRuntimeOwnership`): its compose working directory is a
    /// registered root (the checkout or a registered linked worktree) or
    /// that root's project folder, and every container agrees. `None` when
    /// it cannot be established: actions must then not run against a guess.
    #[must_use]
    pub fn owning_checkout(&self, runtime: &ProjectRuntime) -> Option<String> {
        self.owner_by(runtime, &|p| trim_path(p))
    }

    /// [`Self::owning_checkout`] comparing the forms `canon` gives (the
    /// live source passes filesystem canonicalization, as the CLI's
    /// `canonicalPath` does). Returns the root as registered.
    fn owner_by(&self, runtime: &ProjectRuntime, canon: &dyn Fn(&str) -> String) -> Option<String> {
        // Every container must carry ownership evidence (as the CLI's
        // `assertSingleRuntimeDirectory` requires): one without a working
        // directory makes the owner unknown, not ignorable.
        let mut dirs: Vec<&String> = runtime.working_dir.iter().collect();
        for c in runtime.services.iter().flat_map(|s| &s.containers) {
            dirs.push(c.working_dir.as_ref()?);
        }
        let first = trim_path(dirs.first()?);
        if dirs.iter().any(|d| trim_path(d) != first) {
            return None;
        }
        if !plain_path(&first) {
            return None;
        }
        let dir = canon(&first);
        let roots = self
            .repo_root
            .iter()
            .chain(self.worktrees.iter().filter_map(|w| w.path.as_ref()))
            .map(|r| trim_path(r))
            .filter(|r| plain_path(r));
        for root in roots {
            let matches = dir == canon(&root)
                || PROJECT_DIR_NAMES
                    .iter()
                    .any(|name| dir == canon(&format!("{root}/{name}")));
            if matches {
                return Some(root);
            }
        }
        None
    }

    /// Resolve each branch instance's owning checkout comparing canonical
    /// paths, so a checkout reached through a link (`/var` and
    /// `/private/var` on macOS, or any symlinked folder) still matches.
    /// Touches the filesystem: call it off the UI thread (the live source
    /// does, while reading the snapshot). A path that cannot be resolved is
    /// compared as written.
    pub fn resolve_branch_owners(&mut self) {
        let canon = |p: &str| {
            std::fs::canonicalize(p)
                .map_or_else(|_| trim_path(p), |c| trim_path(&c.to_string_lossy()))
        };
        let owners: Vec<Option<String>> = self
            .branch_runtime
            .iter()
            .map(|b| self.owner_by(&b.runtime, &canon))
            .collect();
        for (b, owner) in self.branch_runtime.iter_mut().zip(owners) {
            b.owner = Some(owner);
        }
    }
}

/// One branch instance in `/v1/projects` `branch_runtime`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct BranchRuntime {
    /// The Compose project name suffix after `<project>--` (design request
    /// R20: not necessarily the branch name the user typed).
    #[serde(deserialize_with = "null_default")]
    pub branch: String,
    #[serde(deserialize_with = "null_default")]
    pub runtime: ProjectRuntime,
    /// The owning checkout resolved by [`ProjectRow::resolve_branch_owners`]
    /// (`Some(None)`: none). `None` until resolved; then the derived row
    /// falls back to comparing the paths as written.
    #[serde(skip)]
    pub owner: Option<Option<String>>,
}

/// Project views refuse canonical native projects with this code.
pub const NATIVE_PROJECT_CODE: &str = "E_NATIVE_PROJECT_UNSUPPORTED";

impl ProjectRow {
    /// A native-backend project: reported by `backend`, or recognised by the
    /// input diagnostic legacy project views return for it.
    #[must_use]
    pub fn is_native(&self) -> bool {
        self.backend.as_deref() == Some("native")
            || self
                .input_diagnostic
                .as_ref()
                .is_some_and(|d| d.code == NATIVE_PROJECT_CODE)
    }

    /// A row for one branch instance of this project, derived from
    /// `branch_runtime`; `None` when no such branch instance is reported.
    ///
    /// The derived row keeps the project's identity (name, checkout, kind,
    /// backend, defined services) and takes everything observed from the
    /// branch runtime: `status` is `running` when any container runs, else
    /// `stopped`; `service_hosts` come from each container's `caddy` label
    /// (already rewritten for the branch); `dev_host` is
    /// `<branch>.<base dev_host>`, the host `hack open --branch` opens, never
    /// a service route; `repo_root` is the checkout that started the
    /// instance ([`ProjectRow::owning_checkout`]). Summary counters and
    /// always-on do not apply.
    #[must_use]
    pub fn instance(&self, branch: &str) -> Option<ProjectRow> {
        let br = self.branch_runtime.iter().find(|b| b.branch == branch)?;
        let mut service_hosts: std::collections::BTreeMap<String, Vec<String>> =
            std::collections::BTreeMap::new();
        for svc in &br.runtime.services {
            for c in &svc.containers {
                let Some(label) = c.labels.get("caddy") else {
                    continue;
                };
                for host in label.split(',').map(str::trim).filter(|h| !h.is_empty()) {
                    let hosts = service_hosts.entry(svc.service.clone()).or_default();
                    if !hosts.iter().any(|h| h == host) {
                        hosts.push(host.to_owned());
                    }
                }
            }
        }
        // The instance's own host, by the rule `hack open --branch <b>` uses
        // with no target: the branch label on the project's dev host. Never a
        // service route from the labels (those belong in the services table).
        // The OAuth alias preference is not in this read (DESIGN.md R20).
        let dev_host = self.dev_host.as_ref().map(|d| format!("{branch}.{d}"));
        let running = br
            .runtime
            .services
            .iter()
            .any(|s| s.containers.iter().any(Container::is_running));
        let status = if running { "running" } else { "stopped" };
        Some(ProjectRow {
            project_id: self.project_id.clone(),
            name: self.name.clone(),
            dev_host,
            // The checkout that started this instance, which may be a
            // linked worktree, never a guess: `None` disables its actions.
            repo_root: br
                .owner
                .clone()
                .unwrap_or_else(|| self.owning_checkout(&br.runtime)),
            status: status.into(),
            runtime_status: Some(status.into()),
            kind: self.kind.clone(),
            defined_services: self.defined_services.clone(),
            service_hosts,
            runtime: Some(br.runtime.clone()),
            backend: self.backend.clone(),
            branch: Some(branch.to_owned()),
            ..ProjectRow::default()
        })
    }
}

/// `HACK_RUNTIME_BACKEND=native hack ps --json` → `data`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct NativePs {
    /// `not_started | pending | runtime_not_running | runtime_busy |
    /// provider_pin_changed | observed | owner_unconfirmed | runtime_degraded`.
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    #[serde(deserialize_with = "null_default")]
    pub items: Vec<NativePsItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct NativePsItem {
    #[serde(deserialize_with = "null_default")]
    pub service: String,
    #[serde(deserialize_with = "null_default")]
    pub state: String,
    #[serde(rename = "container")]
    pub container_id: Option<String>,
    pub health: Option<String>,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    /// `started | healthy | completed` when the native runtime reports it.
    pub readiness: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct InputDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct ProjectRuntime {
    pub project: Option<String>,
    /// Compose's project working directory: the folder of the checkout that
    /// started this runtime (`<root>/.hack`, or `<root>` itself).
    pub working_dir: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub services: Vec<RuntimeService>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct RuntimeService {
    #[serde(deserialize_with = "null_default")]
    pub service: String,
    #[serde(deserialize_with = "null_default")]
    pub containers: Vec<Container>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Container {
    pub id: Option<String>,
    pub name: Option<String>,
    pub image: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub mounts: Vec<ContainerMount>,
    #[serde(deserialize_with = "null_default")]
    pub networks: Vec<ContainerNetwork>,
    /// Docker state: `running`, `exited`, `created`, `restarting`, ...
    #[serde(deserialize_with = "null_default")]
    pub state: String,
    /// Docker status text, for example `Up 5 minutes (healthy)`.
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    pub image: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub mounts: Vec<ContainerMount>,
    /// Container labels. Branch instances carry their routes in `caddy`.
    #[serde(deserialize_with = "null_default")]
    pub labels: std::collections::BTreeMap<String, String>,
    /// The container's compose working directory.
    pub working_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ContainerMount {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ContainerNetwork {
    pub name: String,
}
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct ContainerMount {
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    #[serde(rename = "type")]
    pub kind: String,
}

impl Container {
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.state.eq_ignore_ascii_case("running")
    }

    #[must_use]
    pub fn is_unhealthy(&self) -> bool {
        self.status.contains("(unhealthy)")
    }

    /// Exit code from Docker's exited or restarting status text.
    #[must_use]
    pub fn exit_code(&self) -> Option<i32> {
        let rest = self
            .status
            .strip_prefix("Exited (")
            .or_else(|| self.status.strip_prefix("Restarting ("))?;
        rest.split(')').next()?.trim().parse().ok()
    }

    /// Uptime text from a status like `Up 2 hours (healthy)`.
    #[must_use]
    pub fn uptime(&self) -> Option<&str> {
        let rest = self.status.strip_prefix("Up ")?;
        Some(rest.split(" (").next().unwrap_or(rest).trim())
    }
}

/// Always-on state of one project (docs/always-on-projects.md, "JSON
/// contract"). The app only reads it: no `hack autostart` command runs.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Autostart {
    pub enabled: bool,
    /// `off | on | paused | starting | needs_attention`.
    #[serde(deserialize_with = "null_default")]
    pub state: String,
    pub paused_reason: Option<String>,
    pub failures: AutostartFailures,
    /// The keep-up retry bound (`3` today).
    pub max_failures: Option<u32>,
    /// `null` for the base instance, else the branch-instance slug.
    pub branch: Option<String>,
    /// The individual marker is paused (separate from a global pause).
    pub paused: bool,
    /// The last automatic start attempt, `None` before any.
    pub last_result: Option<AutostartResult>,
}

/// One recorded automatic start attempt.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct AutostartResult {
    /// `started | already_running | skipped | failed` (an unknown future
    /// status is shown as a generic failure).
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    /// A machine-readable code, `None` on success. Never command output.
    pub reason: Option<String>,
    pub at: Option<String>,
}

/// `autostart_global`: the machine-wide policy and the login run.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct AutostartGlobal {
    pub paused: bool,
    pub login_run: AutostartLoginRun,
    /// A login-service file is installed for this invocation. It does not
    /// prove the service manager runs it.
    pub service_ready: bool,
}

/// Progress of the start pass at login. The arrays hold project ids.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct AutostartLoginRun {
    pub in_progress: bool,
    pub started_at: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub pending: Vec<String>,
    #[serde(deserialize_with = "null_default")]
    pub started: Vec<String>,
    #[serde(deserialize_with = "null_default")]
    pub failed: Vec<String>,
    pub waiting_for_engine: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct AutostartFailures {
    pub count: u32,
    pub last_at: Option<String>,
    pub failed_services: Vec<String>,
    pub last_error_code: Option<String>,
}

/// `GET /v1/status` on the hackd socket.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DaemonApiStatus {
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    pub version: String,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub uptime_ms: Option<u64>,
}

/// `hack daemon status --json` (raw object, no envelope).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DaemonStatus {
    /// `running | starting | incompatible | stale | stopped`.
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    #[serde(deserialize_with = "null_default")]
    pub running: bool,
    #[serde(deserialize_with = "null_default")]
    pub api_ok: bool,
    pub api_reachable: Option<bool>,
    pub api_compatible: Option<bool>,
    #[serde(deserialize_with = "null_default")]
    pub stale: bool,
    pub stale_reason: Option<String>,
    pub issue: Option<String>,
    pub next_step: Option<String>,
    pub pid: Option<u32>,
    pub service: Option<DaemonService>,
    /// The version hackd's API reported in this same read, `None` when it
    /// did not answer.
    pub version: Option<String>,
    /// The version of the CLI that answered.
    pub cli_version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DaemonService {
    /// `launchd | systemd`. launchd reports `enabled: null` (not a launchd
    /// notion): every flag here reads `null` as false rather than failing
    /// the whole report.
    pub manager: Option<String>,
    #[serde(deserialize_with = "null_default")]
    pub available: bool,
    #[serde(deserialize_with = "null_default")]
    pub installed: bool,
    #[serde(deserialize_with = "null_default")]
    pub enabled: bool,
    #[serde(deserialize_with = "null_default")]
    pub active: bool,
    pub summary: Option<String>,
    pub next_step: Option<String>,
}

/// `hack doctor --json` → `data`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DoctorReport {
    #[serde(deserialize_with = "null_default")]
    pub checks: Vec<DoctorCheck>,
    #[serde(deserialize_with = "null_default")]
    pub summary: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DoctorCheck {
    pub id: String,
    /// `ok | warn | error`.
    #[serde(deserialize_with = "null_default")]
    pub status: String,
    #[serde(rename = "nativePool", skip_serializing_if = "Option::is_none")]
    pub native_pool: Option<NativePoolReport>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<DoctorCheckFix>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct DoctorCheckFix {
    pub kind: String,
    pub args: Vec<String>,
}

/// The machine Doctor check for this CLI's selected native home.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePoolReport {
    pub state: NativePoolState,
    pub graph_runs: Option<u64>,
    pub memory_bytes: Option<u64>,
    pub guest_memory_mib: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativePoolState {
    Idle,
    InUse,
    Stopped,
    #[serde(other)]
    Unknown,
}

impl DoctorReport {
    /// Findings that need the user (warn + error), shown as the sidebar badge.
    #[must_use]
    pub fn attention_count(&self) -> usize {
        self.checks.iter().filter(|c| c.status != "ok").count()
    }
}

/// `hack up|down|restart --json` → `data`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct LifecycleResult {
    pub action: String,
    pub project: String,
    pub services: LifecycleServices,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct LifecycleServices {
    pub started: Vec<String>,
    pub completed: Vec<String>,
    pub stopped: Vec<String>,
    pub failed: Vec<String>,
}

/// `hack open --json`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct OpenResult {
    pub url: String,
    pub hint: Option<String>,
}

/// One line of `hack logs --json` (ndjson).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct LogEvent {
    /// `start | log | notice | heartbeat | error | end`.
    #[serde(rename = "type")]
    pub kind: String,
    pub ts: Option<String>,
    pub backend: Option<String>,
    pub entry: Option<LogEntry>,
    pub message: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct LogEntry {
    pub service: Option<String>,
    pub message: String,
    pub stream: Option<String>,
    pub timestamp: Option<String>,
    pub level: Option<String>,
    pub truncated: Option<bool>,
}

/// The `{ok:false,error}` half of the CLI result envelope.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct CliError {
    pub code: String,
    pub message: String,
    /// Structured detail, for example `E_STARTUP_INCOMPLETE`'s
    /// `{running, completed, failed}` service lists.
    pub detail: Option<serde_json::Value>,
}

impl CliError {
    /// Services named in `detail.failed` (startup failures).
    #[must_use]
    pub fn failed_services(&self) -> Vec<String> {
        self.detail
            .as_ref()
            .and_then(|d| d.get("failed"))
            .and_then(|f| f.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_status_parsing() {
        let up = Container {
            state: "running".into(),
            status: "Up 2 hours (healthy)".into(),
            ..Container::default()
        };
        assert!(up.is_running());
        assert_eq!(up.uptime(), Some("2 hours"));
        assert_eq!(up.exit_code(), None);

        let exited = Container {
            state: "exited".into(),
            status: "Exited (137) 3 minutes ago".into(),
            ..Container::default()
        };
        assert!(!exited.is_running());
        assert_eq!(exited.exit_code(), Some(137));
        assert_eq!(exited.uptime(), None);
    }

    #[test]
    fn projects_payload_is_lenient() {
        let raw = r#"{"generated_at":"t","runtime_ok":true,"unknown_field":1,
          "projects":[{"name":"alpha","status":"running","extra":{"x":1}}]}"#;
        let p: ProjectsPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(p.projects[0].name, "alpha");
        assert!(p.projects[0].defined_services.is_empty());
        assert!(!p.engine_down());
    }

    #[test]
    fn explicit_nulls_do_not_fail_the_payload() {
        // Shape of an unreadable row from serializeProjectView().
        let raw = r#"{"projects":[{"name":"broken","status":"unavailable",
          "defined_services":null,"service_hosts":null,"runtime":null,
          "input_diagnostic":{"code":"E_CONFIG_INVALID","message":"bad"}},
          {"name":"ok","status":"running","defined_services":["api"]}]}"#;
        let p: ProjectsPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(p.projects.len(), 2);
        assert!(p.projects[0].defined_services.is_empty());
        assert!(p.projects[0].service_hosts.is_empty());
    }

    #[test]
    fn payload_without_projects_is_malformed() {
        assert!(ProjectsPayload::from_value(serde_json::json!({})).is_err());
        assert!(ProjectsPayload::from_value(serde_json::json!({"projects": null})).is_err());
        assert!(ProjectsPayload::from_value(serde_json::json!({"projects": []})).is_ok());
    }

    #[test]
    fn startup_failure_detail_is_kept() {
        let e: CliError = serde_json::from_str(
            r#"{"code":"E_STARTUP_INCOMPLETE","message":"m","detail":{"running":["db"],"completed":[],"failed":["api","worker"]}}"#,
        )
        .unwrap();
        assert_eq!(e.failed_services(), vec!["api", "worker"]);
    }

    /// Shape of a full `/v1/projects` row from `serializeProjectView`.
    const BRANCH_ROW: &str = r#"{"projects":[{
      "name":"storefront","status":"stopped","dev_host":"storefront.hack",
      "repo_root":"/work/storefront","kind":"registered","backend":"compose",
      "defined_services":["api","web"],"autostart":{"enabled":true,"state":"on"},
      "runtime":null,
      "branch_runtime":[
        {"branch":"feature-search","runtime":{"project":"storefront--feature-search",
          "working_dir":"/work/storefront","services":[
          {"service":"api","containers":[{"id":"c1","state":"running","status":"Up 3 minutes","working_dir":"/work/storefront",
            "name":"storefront--feature-search-api-1","ports":[],"image":"img",
            "labels":{"caddy":"api.feature-search.storefront.hack, feature-search.storefront.hack",
              "com.docker.compose.project":"storefront--feature-search"},
            "mounts":[],"networks":[]}]},
          {"service":"web","containers":[{"id":"c2","state":"running","status":"Up 3 minutes","working_dir":"/work/storefront/",
            "labels":{"caddy":"feature-search.storefront.hack,web.feature-search.storefront.hack,"}}]},
          {"service":"db","containers":[{"id":"c3","state":"running","status":"Up 3 minutes","working_dir":"/work/storefront",
            "labels":null}]}]}},
        {"branch":"fix-login","runtime":{"project":"storefront--fix-login","services":[
          {"service":"api","containers":[{"state":"exited","status":"Exited (1) 1 minute ago",
            "labels":{"caddy":"api.fix-login.storefront.hack"}}]}]}}
      ]},
      {"name":"notes","status":"stopped","branch_runtime":null}]}"#;

    fn runtime_in(dirs: &[Option<&str>]) -> ProjectRuntime {
        ProjectRuntime {
            project: Some("storefront--b".into()),
            working_dir: dirs.first().copied().flatten().map(str::to_owned),
            services: dirs
                .iter()
                .skip(1)
                .map(|d| RuntimeService {
                    service: "api".into(),
                    containers: vec![Container {
                        working_dir: d.map(str::to_owned),
                        ..Container::default()
                    }],
                })
                .collect(),
        }
    }

    fn registered() -> ProjectRow {
        ProjectRow {
            name: "storefront".into(),
            repo_root: Some("/work/storefront".into()),
            worktrees: vec![Worktree {
                path: Some("/work/wt/feature/".into()),
                branch: Some("feature".into()),
            }],
            ..ProjectRow::default()
        }
    }

    #[test]
    fn a_branch_instance_runs_actions_in_the_checkout_that_started_it() {
        let p = registered();
        // The primary checkout and a registered linked worktree, as the
        // checkout itself or its project folder.
        for (dir, root) in [
            ("/work/storefront/.hack", "/work/storefront"),
            ("/work/storefront", "/work/storefront"),
            ("/work/wt/feature/.hack", "/work/wt/feature"),
            ("/work/wt/feature/.dev/", "/work/wt/feature"),
        ] {
            assert_eq!(
                p.owning_checkout(&runtime_in(&[Some(dir), Some(dir)]))
                    .as_deref(),
                Some(root),
                "{dir}"
            );
        }
        // Not registered, a sibling, a traversal, a relative path, a
        // disagreeing container, or nothing reported: no checkout.
        for dirs in [
            vec![Some("/work/other/.hack")],
            vec![Some("/work/storefront-copy/.hack")],
            vec![Some("/work/storefront/../other/.hack")],
            vec![Some("work/storefront/.hack")],
            vec![
                Some("/work/storefront/.hack"),
                Some("/work/wt/feature/.hack"),
            ],
            vec![None],
            // A valid aggregate, but a container without ownership evidence.
            vec![
                Some("/work/storefront/.hack"),
                Some("/work/storefront/.hack"),
                None,
            ],
        ] {
            assert_eq!(p.owning_checkout(&runtime_in(&dirs)), None, "{dirs:?}");
        }
    }

    /// A checkout reached through a link (macOS `/var` vs `/private/var`,
    /// or any symlinked folder) still owns its instance, either way round,
    /// once the live source resolves owners by canonical path. Without that
    /// step the paths are compared as written and nothing matches (closed).
    #[cfg(unix)]
    #[test]
    fn a_checkout_reached_through_a_link_still_owns_its_instance() {
        let tmp = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("hack-desktop-owner-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let real = tmp.join("real-checkout");
        std::fs::create_dir_all(real.join(".hack")).unwrap();
        let link = tmp.join("linked-checkout");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (real, link) = (
            real.to_string_lossy().into_owned(),
            link.to_string_lossy().into_owned(),
        );
        // Registered through the link, reported by Compose by its real path,
        // and the reverse.
        for (registered, reported) in [(&link, &real), (&real, &link)] {
            let mut p = ProjectRow {
                name: "storefront".into(),
                repo_root: Some("/work/storefront".into()),
                worktrees: vec![Worktree {
                    path: Some(registered.clone()),
                    branch: Some("b".into()),
                }],
                ..ProjectRow::default()
            };
            let dir = format!("{reported}/.hack");
            p.branch_runtime = vec![BranchRuntime {
                owner: None,
                branch: "b".into(),
                runtime: runtime_in(&[Some(dir.as_str()), Some(dir.as_str())]),
            }];
            assert_eq!(
                p.instance("b").unwrap().repo_root,
                None,
                "as written: closed"
            );
            p.resolve_branch_owners();
            assert_eq!(
                p.instance("b").unwrap().repo_root.as_deref(),
                Some(registered.as_str()),
                "registered {registered}, reported {reported}"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_derived_instance_never_borrows_the_primary_checkout() {
        let mut p = registered();
        p.branch_runtime = vec![
            BranchRuntime {
                owner: None,
                branch: "feature".into(),
                runtime: runtime_in(&[Some("/work/wt/feature/.hack")]),
            },
            BranchRuntime {
                owner: None,
                branch: "orphan".into(),
                runtime: runtime_in(&[Some("/elsewhere/.hack")]),
            },
        ];
        assert_eq!(
            p.instance("feature").unwrap().repo_root.as_deref(),
            Some("/work/wt/feature")
        );
        assert_eq!(p.instance("orphan").unwrap().repo_root, None);
    }

    #[test]
    fn branch_runtime_parses_with_null_labels_and_null_list() {
        let p: ProjectsPayload = serde_json::from_str(BRANCH_ROW).unwrap();
        let row = &p.projects[0];
        assert_eq!(row.branch_runtime.len(), 2);
        assert_eq!(row.branch_runtime[0].branch, "feature-search");
        assert!(
            row.branch_runtime[0].runtime.services[2].containers[0]
                .labels
                .is_empty()
        );
        assert!(p.projects[1].branch_runtime.is_empty());
        assert!(row.branch.is_none());
        assert!(row.instance("nope").is_none());
    }

    #[test]
    fn instance_derives_state_hosts_and_dev_host() {
        let p: ProjectsPayload = serde_json::from_str(BRANCH_ROW).unwrap();
        let base = &p.projects[0];
        let fs = base.instance("feature-search").unwrap();
        assert_eq!(fs.name, "storefront");
        assert_eq!(fs.branch.as_deref(), Some("feature-search"));
        assert_eq!(fs.status, "running");
        assert_eq!(fs.repo_root, base.repo_root);
        assert_eq!(fs.backend.as_deref(), Some("compose"));
        assert_eq!(fs.defined_services, base.defined_services);
        assert!(fs.branch_runtime.is_empty());
        assert!(fs.autostart.is_none());
        assert_eq!(
            fs.service_hosts["api"],
            [
                "api.feature-search.storefront.hack",
                "feature-search.storefront.hack"
            ]
        );
        assert_eq!(
            fs.service_hosts["web"],
            [
                "feature-search.storefront.hack",
                "web.feature-search.storefront.hack"
            ]
        );
        assert!(!fs.service_hosts.contains_key("db"));
        assert_eq!(
            fs.dev_host.as_deref(),
            Some("feature-search.storefront.hack")
        );

        // Every route of this instance is a service subdomain: its URL is
        // still the instance host `hack open --branch` opens, never a route.
        let fl = base.instance("fix-login").unwrap();
        assert_eq!(fl.status, "stopped");
        assert_eq!(fl.service_hosts["api"], ["api.fix-login.storefront.hack"]);
        assert_eq!(fl.dev_host.as_deref(), Some("fix-login.storefront.hack"));

        // No base dev host: no URL, rather than a guess from the labels.
        let mut no_host = base.clone();
        no_host.dev_host = None;
        assert_eq!(no_host.instance("fix-login").unwrap().dev_host, None);
        assert_eq!(no_host.instance("feature-search").unwrap().dev_host, None);
    }

    #[test]
    fn doctor_attention_count() {
        let r: DoctorReport = serde_json::from_str(
            r#"{"checks":[{"id":"a","status":"ok"},{"id":"b","status":"warn"},{"id":"c","status":"error"}]}"#,
        )
        .unwrap();
        assert_eq!(r.attention_count(), 2);
    }
}
