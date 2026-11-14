//! Typed views of what `hack ... --json` and `hackd` return.
//!
//! Every struct is lenient (`#[serde(default)]`): the CLI adds fields over
//! time and the app must keep working on older and newer payloads. Unknown
//! fields are ignored; missing ones take their default. Values that the app
//! cannot interpret stay as strings, so "unknown" is never turned into
//! "stopped".

use serde::{Deserialize, Serialize};

/// `GET /v1/projects` and `hack projects --json` (same shape).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct ProjectsPayload {
    pub generated_at: Option<String>,
    pub detail_level: Option<String>,
    /// `false` when the container runtime could not be read.
    pub runtime_ok: Option<bool>,
    pub runtime_error: Option<String>,
    pub projects: Vec<ProjectRow>,
}

impl ProjectsPayload {
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
    pub name: String,
    pub dev_host: Option<String>,
    pub repo_root: Option<String>,
    /// `running | stopped | missing | unregistered | unavailable | unknown`.
    pub status: String,
    /// Adds `not_configured` to the `status` values.
    pub runtime_status: Option<String>,
    pub kind: Option<String>,
    pub defined_services: Vec<String>,
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
    pub services: Vec<RuntimeService>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct RuntimeService {
    pub service: String,
    pub containers: Vec<Container>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Container {
    pub id: Option<String>,
    pub name: Option<String>,
    /// Docker state: `running`, `exited`, `created`, `restarting`, ...
    pub state: String,
    /// Docker status text, for example `Up 5 minutes (healthy)`.
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

    /// Exit code from a status like `Exited (1) 3 minutes ago`.
    #[must_use]
    pub fn exit_code(&self) -> Option<i32> {
        let rest = self.status.strip_prefix("Exited (")?;
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
    pub enabled: bool,
    /// `off | on | paused | starting | needs_attention`.
    pub state: String,
    pub paused_reason: Option<String>,
    pub failures: AutostartFailures,
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
    pub status: String,
    pub running: bool,
    pub api_ok: bool,
    pub api_compatible: Option<bool>,
    pub stale: bool,
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
    pub available: bool,
    pub installed: bool,
    pub enabled: bool,
    pub active: bool,
    pub summary: Option<String>,
    pub next_step: Option<String>,
}

/// `hack doctor --json` → `data`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub summary: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct DoctorCheck {
    pub id: String,
    /// `ok | warn | error`.
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct CliError {
    pub code: String,
    pub message: String,
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
    fn doctor_attention_count() {
        let r: DoctorReport = serde_json::from_str(
            r#"{"checks":[{"id":"a","status":"ok"},{"id":"b","status":"warn"},{"id":"c","status":"error"}]}"#,
        )
        .unwrap();
        assert_eq!(r.attention_count(), 2);
    }
}
