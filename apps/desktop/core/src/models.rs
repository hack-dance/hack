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
    /// Docker state: `running`, `exited`, `created`, `restarting`, ...
    #[serde(deserialize_with = "null_default")]
    pub state: String,
    /// Docker status text, for example `Up 5 minutes (healthy)`.
    #[serde(deserialize_with = "null_default")]
    pub status: String,
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

/// Always-on state as designed for HACK-2213 (not yet emitted by the CLI).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Autostart {
    pub enabled: Option<bool>,
    pub max_failures: Option<u32>,
    /// `off | on | paused | starting | needs_attention`.
    #[serde(deserialize_with = "null_default")]
    pub state: String,
    pub paused_reason: Option<String>,
    pub failures: AutostartFailures,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct AutostartFailures {
    pub count: Option<u32>,
    pub last_at: Option<String>,
    pub failed_services: Option<Vec<String>>,
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
    pub running: Option<bool>,
    pub api_ok: Option<bool>,
    pub api_compatible: Option<bool>,
    pub stale: Option<bool>,
    pub stale_reason: Option<String>,
    pub issue: Option<String>,
    pub next_step: Option<String>,
    pub pid: Option<u32>,
    pub service: Option<DaemonService>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DaemonService {
    /// `launchd | systemd`.
    pub manager: Option<String>,
    pub available: Option<bool>,
    pub installed: Option<bool>,
    pub enabled: Option<bool>,
    pub active: Option<bool>,
    pub unit_stale: Option<bool>,
    pub unit_stale_reason: Option<String>,
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
    pub detail: String,
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

/// Proposed R12b metadata. Missing fields remain unknown.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct AutostartGlobal {
    pub paused: Option<bool>,
    pub service_ready: Option<bool>,
    pub login_run: Option<LoginRun>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct LoginRun {
    pub in_progress: Option<bool>,
    pub started_at: Option<String>,
    pub pending: Option<Vec<String>>,
    pub started: Option<Vec<String>>,
    pub failed: Option<Vec<String>>,
}

impl DaemonStatus {
    /// Require an explicit observation, not an empty object or an envelope.
    /// Missing service installation metadata stays unknown.
    /// # Errors
    /// A malformed or contradictory observation.
    pub fn from_value(value: serde_json::Value) -> Result<Self, String> {
        let status: Self = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if status.status.is_empty() || status.running.is_none() {
            return Err("daemon status requires status and running".into());
        }
        if (status.status == "running" && status.running != Some(true))
            || (matches!(status.status.as_str(), "stopped" | "stale")
                && status.running != Some(false))
        {
            return Err("contradictory daemon observation".into());
        }
        Ok(status)
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

    #[test]
    fn doctor_attention_count() {
        let r: DoctorReport = serde_json::from_str(
            r#"{"checks":[{"id":"a","status":"ok"},{"id":"b","status":"warn"},{"id":"c","status":"error"}]}"#,
        )
        .unwrap();
        assert_eq!(r.attention_count(), 2);
    }
}
