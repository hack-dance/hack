//! Display state of a project, derived from a project row plus what this app
//! knows about its own in-flight action and the last action result.
//!
//! This derivation exists only until the CLI reports a `state` field itself
//! (design request R2). Rules, in order:
//! 1. An action this app is running wins (`Starting` / `Stopping`).
//! 2. Always-on gave up, the checkout is missing, or the config has an input
//!    diagnostic → `NeedsAttention`.
//! 3. The last `up` reported failed services, or a defined service exited
//!    non-zero and none run → `FailedStart`.
//! 4. Runtime unreadable → `Unknown` (never `Stopped`).
//! 5. Some but not all defined services running, or one unhealthy →
//!    `Degraded`; all running → `Running`; none → `Stopped`.

use crate::models::{NativePs, ProjectRow};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProjectState {
    Stopped,
    Starting,
    /// `exited_ok`: services that exited 0 while the rest run. Their
    /// completion role is unknown until the CLI reports it (design R2).
    Running {
        uptime: Option<String>,
        exited_ok: Vec<String>,
    },
    Degraded {
        down: Vec<String>,
    },
    Stopping,
    FailedStart {
        services: Vec<String>,
    },
    NeedsAttention {
        reason: String,
    },
    Unknown {
        reason: String,
    },
}

impl ProjectState {
    /// Short label for the state pill.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Stopped => "Stopped".into(),
            Self::Starting => "Starting…".into(),
            Self::Running { exited_ok, .. } if !exited_ok.is_empty() => {
                format!("Running · {} exited (0)", exited_ok.join(", "))
            }
            Self::Running {
                uptime: Some(u), ..
            } => format!("Running · {u}"),
            Self::Running { uptime: None, .. } => "Running".into(),
            Self::Degraded { down } => format!("Degraded · {} down", down.join(", ")),
            Self::Stopping => "Stopping…".into(),
            Self::FailedStart { services } => {
                format!("Failed to start: {}", services.join(", "))
            }
            Self::NeedsAttention { .. } => "Needs attention".into(),
            Self::Unknown { .. } => "Status unknown".into(),
        }
    }

    /// Sidebar group: running-like states go under "Running".
    #[must_use]
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Running { .. } | Self::Degraded { .. } | Self::Starting | Self::Stopping
        )
    }

    #[must_use]
    pub fn tone(&self) -> Tone {
        match self {
            Self::Running { .. } => Tone::Ok,
            Self::Degraded { .. } => Tone::Warn,
            Self::Starting | Self::Stopping => Tone::Busy,
            Self::FailedStart { .. } | Self::NeedsAttention { .. } => Tone::Error,
            Self::Stopped | Self::Unknown { .. } => Tone::Idle,
        }
    }

    /// Which actions the header offers in this state.
    #[must_use]
    pub fn actions(&self) -> &'static [Action] {
        match self {
            Self::Stopped | Self::Unknown { .. } => &[Action::Start],
            Self::Starting => &[Action::Stop],
            Self::Running { .. } | Self::Degraded { .. } => {
                &[Action::Open, Action::Restart, Action::Stop]
            }
            Self::Stopping => &[],
            Self::FailedStart { .. } | Self::NeedsAttention { .. } => {
                &[Action::Start, Action::Stop]
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Ok,
    Warn,
    Busy,
    Error,
    Idle,
}

/// v0 project actions. Each maps to exactly one CLI command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Start,
    Stop,
    Restart,
    Open,
}

impl Action {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Start => "Start",
            Self::Stop => "Stop",
            Self::Restart => "Restart",
            Self::Open => "Open",
        }
    }

    /// CLI arguments (after `hack`), run with `--path <repo_root>`.
    #[must_use]
    pub fn cli_args(self) -> &'static [&'static str] {
        match self {
            Self::Start => &["up", "--detach", "--json", "--no-interactive"],
            Self::Stop => &["down", "--json", "--no-interactive"],
            Self::Restart => &["restart", "--json", "--no-interactive"],
            Self::Open => &["open", "--json", "--no-interactive"],
        }
    }
}

/// What the app itself knows beyond the row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalContext {
    pub in_flight: Option<Action>,
    /// Failed services from the last `up`/`restart` this app ran.
    pub last_failed: Vec<String>,
}

/// One service row for the Services table.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ServiceView {
    pub name: String,
    pub running: bool,
    pub status: String,
    pub exit_code: Option<i32>,
    /// Exited 0 and not running: never "down", but its completion role is
    /// unknown until the CLI reports it (shown as "exited (0)").
    pub completed: bool,
    /// A container (or native observation) exists for it. A defined service
    /// with none may simply be in an inactive Compose profile.
    pub created: bool,
    pub route: Option<String>,
}

impl ServiceView {
    /// A service with evidence of being down: it has a container that is
    /// not running and did not exit 0. A defined service that was never
    /// created is not counted: it may sit in an inactive profile, and which
    /// services are expected is only known once the CLI reports it (R2).
    #[must_use]
    pub fn is_down(&self) -> bool {
        self.created && !self.running && !self.completed
    }
}

#[must_use]
pub fn services(row: &ProjectRow) -> Vec<ServiceView> {
    if let Some(ps) = row.native.as_ref().filter(|_| row.is_native()) {
        let mut out: Vec<ServiceView> = ps
            .items
            .iter()
            .map(|i| {
                let running = i.state == "running";
                let status = match &i.health {
                    Some(h) => format!("{} ({h})", i.state),
                    None => i.state.clone(),
                };
                ServiceView {
                    created: true,
                    name: i.service.clone(),
                    running,
                    status,
                    exit_code: i.exit_code,
                    completed: !running && i.exit_code == Some(0),
                    route: row
                        .service_hosts
                        .get(&i.service)
                        .and_then(|h| h.first().cloned()),
                }
            })
            .collect();
        out.sort_by(|a, b| b.is_down().cmp(&a.is_down()).then(a.name.cmp(&b.name)));
        return out;
    }
    let mut names: Vec<String> = row.defined_services.clone();
    if let Some(rt) = &row.runtime {
        for s in &rt.services {
            if !names.contains(&s.service) {
                names.push(s.service.clone());
            }
        }
    }
    let mut out: Vec<ServiceView> = names
        .into_iter()
        .map(|name| {
            let containers = row
                .runtime
                .as_ref()
                .and_then(|rt| rt.services.iter().find(|s| s.service == name))
                .map(|s| s.containers.as_slice())
                .unwrap_or_default();
            let running = containers.iter().any(|c| c.is_running());
            let first = containers.first();
            let exit_code = first.and_then(|c| c.exit_code());
            ServiceView {
                created: first.is_some(),
                completed: !running
                    && first.is_some_and(|c| c.state.eq_ignore_ascii_case("exited"))
                    && exit_code == Some(0),
                route: row
                    .service_hosts
                    .get(&name)
                    .and_then(|h| h.first().cloned()),
                running,
                status: first.map_or_else(|| "not created".into(), |c| c.status.clone()),
                exit_code,
                name,
            }
        })
        .collect();
    // Down services first, then by name.
    out.sort_by(|a, b| b.is_down().cmp(&a.is_down()).then(a.name.cmp(&b.name)));
    out
}

#[must_use]
pub fn derive(row: &ProjectRow, local: &LocalContext) -> ProjectState {
    match local.in_flight {
        Some(Action::Start | Action::Restart) => return ProjectState::Starting,
        Some(Action::Stop) => return ProjectState::Stopping,
        Some(Action::Open) | None => {}
    }
    if let Some(a) = &row.autostart
        && a.state == "needs_attention"
    {
        return ProjectState::NeedsAttention {
            reason: format!(
                "Always-on stopped trying after {} failures",
                a.failures
                    .count
                    .map_or_else(|| "unknown".into(), |n| n.to_string())
            ),
        };
    }
    if row.status == "missing" {
        return ProjectState::NeedsAttention {
            reason: "The project folder is missing".into(),
        };
    }
    if row.is_native() {
        return native_state(row.native.as_ref());
    }
    if let Some(d) = &row.input_diagnostic {
        return ProjectState::NeedsAttention {
            reason: d.message.clone(),
        };
    }
    match row.status.as_str() {
        "running" | "stopped" => {}
        "unknown" | "unavailable" => {
            return ProjectState::Unknown {
                reason: "The container runtime could not be read".into(),
            };
        }
        // Missing or unfamiliar status: no evidence, so not "stopped".
        "" => {
            return ProjectState::Unknown {
                reason: "The CLI reported no status".into(),
            };
        }
        other => {
            return ProjectState::Unknown {
                reason: format!("Unrecognised status {other:?}"),
            };
        }
    }

    let svcs = services(row);
    let running: Vec<&ServiceView> = svcs.iter().filter(|s| s.running).collect();
    let mut failed_exit: Vec<String> = svcs
        .iter()
        .filter(|s| !s.running && s.exit_code.is_some_and(|c| c != 0))
        .map(|s| s.name.clone())
        .collect();
    // Docker's summary counts only `running`. A crash loop or a dead
    // container is failure evidence even when the summary says stopped.
    let mut uncertain = Vec::new();
    for service in row.runtime.iter().flat_map(|r| &r.services) {
        for c in &service.containers {
            match c.state.to_ascii_lowercase().as_str() {
                "restarting" | "dead" => failed_exit.push(service.service.clone()),
                "running" | "exited" => {}
                _ => uncertain.push(service.service.clone()),
            }
        }
    }
    failed_exit.sort();
    failed_exit.dedup();

    // The CLI named these as failed: trust that, created or not.
    if !local.last_failed.is_empty()
        && local
            .last_failed
            .iter()
            .any(|f| !svcs.iter().any(|s| &s.name == f && s.running))
    {
        return ProjectState::FailedStart {
            services: local.last_failed.clone(),
        };
    }
    if running.is_empty() {
        if !failed_exit.is_empty() {
            return ProjectState::FailedStart {
                services: failed_exit,
            };
        }
        if !uncertain.is_empty() {
            return ProjectState::Unknown {
                reason: format!("Containers are not stopped: {}", uncertain.join(", ")),
            };
        }
        // Summary rows carry counts, not services.
        if row.running_container_count.unwrap_or(0) > 0 || row.status == "running" {
            return ProjectState::Running {
                uptime: None,
                exited_ok: vec![],
            };
        }
        return ProjectState::Stopped;
    }
    let unhealthy = row
        .runtime
        .iter()
        .flat_map(|rt| rt.services.iter())
        .filter(|s| s.containers.iter().any(|c| c.is_unhealthy()))
        .map(|s| s.service.clone());
    let mut down: Vec<String> = svcs
        .iter()
        .filter(|s| s.is_down())
        .map(|s| s.name.clone())
        .chain(unhealthy)
        .chain(failed_exit)
        .chain(uncertain)
        .collect();
    down.sort();
    down.dedup();
    if down.is_empty() {
        let uptime = row
            .runtime
            .iter()
            .flat_map(|rt| rt.services.iter())
            .flat_map(|s| s.containers.iter())
            .find_map(|c| c.uptime().map(str::to_owned));
        let exited_ok = svcs
            .iter()
            .filter(|s| s.completed)
            .map(|s| s.name.clone())
            .collect();
        ProjectState::Running { uptime, exited_ok }
    } else {
        ProjectState::Degraded { down }
    }
}

/// Map native `hack ps --json` `data.status` (and items) to a display state.
#[must_use]
pub fn native_state(ps: Option<&NativePs>) -> ProjectState {
    let Some(ps) = ps else {
        return ProjectState::Unknown {
            reason: "Native status was not read".into(),
        };
    };
    let unknown = |why: &str| ProjectState::Unknown {
        reason: format!("Native runtime: {why}"),
    };
    match ps.status.as_str() {
        "not_started" => ProjectState::Stopped,
        "pending" => ProjectState::Starting,
        "runtime_degraded" => ProjectState::Degraded {
            down: native_down(ps),
        },
        "observed" => {
            let down = native_down(ps);
            if ps.items.is_empty() {
                ProjectState::Stopped
            } else if down.is_empty() {
                let exited_ok = ps
                    .items
                    .iter()
                    .filter(|i| i.state != "running" && i.exit_code == Some(0))
                    .map(|i| i.service.clone())
                    .collect();
                ProjectState::Running {
                    uptime: None,
                    exited_ok,
                }
            } else if down.len() == ps.items.len() {
                ProjectState::FailedStart { services: down }
            } else {
                ProjectState::Degraded { down }
            }
        }
        "provider_pin_changed" => ProjectState::NeedsAttention {
            reason: "The native runtime provider changed; run hack doctor".into(),
        },
        "runtime_not_running" => unknown("not running"),
        "runtime_busy" => unknown("busy"),
        "owner_unconfirmed" => unknown("owner not confirmed"),
        other => unknown(other),
    }
}

fn native_down(ps: &NativePs) -> Vec<String> {
    let mut down: Vec<String> = ps
        .items
        .iter()
        .filter(|i| {
            let completed = i.readiness.as_deref() == Some("completed")
                || (i.exit_code == Some(0) && i.state == "exited");
            (i.state != "running" && !completed) || i.health.as_deref() == Some("unhealthy")
        })
        .map(|i| i.service.clone())
        .collect();
    down.sort();
    down.dedup();
    down
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;

    fn row(name: &str) -> ProjectRow {
        fixtures::project(fixtures::Fixture::Running)
            .projects
            .into_iter()
            .find(|p| p.name == name)
            .unwrap()
    }

    #[test]
    fn running_has_uptime() {
        let s = derive(&row("storefront"), &LocalContext::default());
        assert_eq!(
            s,
            ProjectState::Running {
                uptime: Some("2 hours".into()),
                exited_ok: vec![],
            }
        );
        assert_eq!(s.actions(), &[Action::Open, Action::Restart, Action::Stop]);
    }

    #[test]
    fn in_flight_action_wins() {
        let local = LocalContext {
            in_flight: Some(Action::Stop),
            ..LocalContext::default()
        };
        assert_eq!(derive(&row("storefront"), &local), ProjectState::Stopping);
    }

    #[test]
    fn unfamiliar_or_missing_status_is_unknown() {
        for status in ["", "unregistered", "something_new"] {
            let mut r = row("storefront");
            r.status = status.into();
            assert!(
                matches!(
                    derive(&r, &LocalContext::default()),
                    ProjectState::Unknown { .. }
                ),
                "{status:?}"
            );
        }
    }

    #[test]
    fn unknown_is_not_stopped() {
        let mut r = row("storefront");
        r.status = "unknown".into();
        r.runtime = None;
        assert!(matches!(
            derive(&r, &LocalContext::default()),
            ProjectState::Unknown { .. }
        ));
    }

    #[test]
    fn every_fixture_state_derives_as_designed() {
        use fixtures::Fixture::*;
        let cases = [
            (Stopped, "Stopped"),
            (Running, "Running · 2 hours"),
            (Degraded, "Degraded · worker down"),
            (FailedStart, "Failed to start: api, worker"),
            (NeedsAttention, "Needs attention"),
        ];
        for (fx, label) in cases {
            let p = fixtures::project(fx);
            let sel = fixtures::selected(fx);
            let r = p.projects.iter().find(|r| r.name == sel).unwrap();
            assert_eq!(
                derive(r, &fixtures::local(fx)).label(),
                label,
                "fixture {fx:?}"
            );
        }
        let s = fixtures::project(Starting);
        let r = s
            .projects
            .iter()
            .find(|r| r.name == fixtures::selected(Starting))
            .unwrap();
        assert_eq!(
            derive(r, &fixtures::local(Starting)),
            ProjectState::Starting
        );
    }

    #[test]
    fn completed_one_shot_is_not_down() {
        let mut r = row("storefront");
        let rt = r.runtime.as_mut().unwrap();
        rt.services[1].containers[0].state = "exited".into();
        rt.services[1].containers[0].status = "Exited (0) 2 hours ago".into();
        let st = derive(&r, &LocalContext::default());
        assert_eq!(st.label(), "Running · db exited (0)");
        assert!(matches!(st, ProjectState::Running { .. }));
    }

    #[test]
    fn native_status_mapping() {
        use crate::models::{NativePs, NativePsItem};
        let ps = |status: &str, items: Vec<(&str, &str)>| NativePs {
            status: status.into(),
            items: items
                .into_iter()
                .map(|(s, st)| NativePsItem {
                    service: s.into(),
                    state: st.into(),
                    ..NativePsItem::default()
                })
                .collect(),
        };
        assert_eq!(
            native_state(Some(&ps("not_started", vec![]))),
            ProjectState::Stopped
        );
        assert_eq!(
            native_state(Some(&ps("pending", vec![]))),
            ProjectState::Starting
        );
        assert!(matches!(
            native_state(Some(&ps("observed", vec![("app", "running")]))),
            ProjectState::Running { .. }
        ));
        assert_eq!(
            native_state(Some(&ps(
                "observed",
                vec![("app", "running"), ("job", "exited")]
            ))),
            ProjectState::Degraded {
                down: vec!["job".into()]
            }
        );
        assert!(matches!(
            native_state(Some(&ps("runtime_busy", vec![]))),
            ProjectState::Unknown { .. }
        ));
        assert!(matches!(native_state(None), ProjectState::Unknown { .. }));
        assert!(matches!(
            native_state(Some(&ps("provider_pin_changed", vec![]))),
            ProjectState::NeedsAttention { .. }
        ));
    }

    #[test]
    fn native_rows_show_native_services_and_exited_ok() {
        use crate::models::{InputDiagnostic, NativePs, NativePsItem, ProjectRow};
        let row = ProjectRow {
            name: "n".into(),
            status: "unavailable".into(),
            input_diagnostic: Some(InputDiagnostic {
                code: crate::models::NATIVE_PROJECT_CODE.into(),
                message: "m".into(),
            }),
            native: Some(NativePs {
                status: "observed".into(),
                items: vec![
                    NativePsItem {
                        service: "web".into(),
                        state: "running".into(),
                        health: Some("healthy".into()),
                        ..NativePsItem::default()
                    },
                    NativePsItem {
                        service: "migrate".into(),
                        state: "exited".into(),
                        exit_code: Some(0),
                        ..NativePsItem::default()
                    },
                ],
            }),
            ..ProjectRow::default()
        };
        let svcs = services(&row);
        assert_eq!(svcs.len(), 2);
        assert_eq!(
            svcs.iter().find(|s| s.name == "web").unwrap().status,
            "running (healthy)"
        );
        assert!(svcs.iter().find(|s| s.name == "migrate").unwrap().completed);
        assert_eq!(
            derive(&row, &LocalContext::default()).label(),
            "Running · migrate exited (0)"
        );
    }

    #[test]
    fn inactive_profile_services_are_not_down() {
        // `toolchain` is defined (another profile) but has no container.
        let mut r = row("storefront");
        r.defined_services.push("toolchain".into());
        let st = derive(&r, &LocalContext::default());
        assert!(matches!(st, ProjectState::Running { .. }), "{st:?}");
        let svc = services(&r)
            .into_iter()
            .find(|s| s.name == "toolchain")
            .unwrap();
        assert!(!svc.created && !svc.is_down());
        assert_eq!(svc.status, "not created");
    }

    #[test]
    fn services_sort_down_first() {
        let p = fixtures::project(fixtures::Fixture::Degraded);
        let r = p.projects.iter().find(|r| r.name == "storefront").unwrap();
        let s = services(r);
        assert_eq!(s[0].name, "worker");
        assert!(!s[0].running);
        assert_eq!(s[1].route.as_deref(), Some("api.storefront.hack"));
    }
    #[test]
    fn docker_non_running_states_are_not_stopped() {
        for (state, status, failed) in [
            ("restarting", "Restarting (1) 5 seconds ago", true),
            ("dead", "Dead", true),
            ("created", "Created", false),
            ("paused", "Up 2 minutes (Paused)", false),
        ] {
            let row: ProjectRow = serde_json::from_value(serde_json::json!({
                    "name": "sample", "status": "stopped", "defined_services": ["api"],
                    "runtime": {"services": [{"service":"api", "containers":[{"state":state,"status":status}]}]}
                })).unwrap();
            let observed = derive(&row, &LocalContext::default());
            if failed {
                assert_eq!(
                    observed,
                    ProjectState::FailedStart {
                        services: vec!["api".into()]
                    },
                    "{state}"
                );
            } else {
                assert!(
                    matches!(observed, ProjectState::Unknown { .. }),
                    "{state}: {observed:?}"
                );
            }
            assert!(!services(&row)[0].completed);
        }
    }

    #[test]
    fn unhealthy_replica_is_degraded_even_when_another_replica_runs() {
        let row: ProjectRow = serde_json::from_value(serde_json::json!({
            "name":"sample", "status":"running", "defined_services":["api"],
            "runtime":{"services":[{"service":"api","containers":[
                {"state":"running","status":"Up 2 minutes"},
                {"state":"restarting","status":"Restarting (1) 5 seconds ago"}
            ]}]}
        }))
        .unwrap();
        assert_eq!(
            derive(&row, &LocalContext::default()),
            ProjectState::Degraded {
                down: vec!["api".into()]
            }
        );
    }
}
