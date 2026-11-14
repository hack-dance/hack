//! View-model state machines for the project list and the detail pane.
//!
//! Pure: no I/O, no clock. The app feeds events in and renders `view()`.
//!
//! List rules (DESIGN.md, "Project list"):
//! - A failed refresh keeps the last good snapshot and marks it stale; with
//!   no snapshot yet it shows the error state.
//! - Banners stack: daemon off, daemon version mismatch, engine down, stale.
//! - One action per project at a time; the row's state shows it.

use std::collections::HashMap;

use crate::models::ProjectRow;
use crate::source::{ActionOutcome, Snapshot, SourceError};
use crate::state::{self, Action, LocalContext, ProjectState, ServiceView};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "banner", rename_all = "snake_case")]
pub enum Banner {
    DaemonOff,
    DaemonMismatch { daemon: String, cli: String },
    EngineDown { error: String },
    Stale { error: String },
}

impl Banner {
    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Self::DaemonOff => "hackd is off: status refreshes slowly".into(),
            Self::DaemonMismatch { daemon, cli } => {
                format!("hackd v{daemon} is running, CLI is v{cli}: restart hackd")
            }
            Self::EngineDown { error } => format!("Docker not reachable: {error}"),
            Self::Stale { error } => format!("Showing last known state: {error}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Phase {
    Loading,
    CliMissing,
    Error { code: String, message: String },
    Empty,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Row {
    pub name: String,
    pub state: ProjectState,
    pub always_on: bool,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ListView {
    pub phase: Phase,
    pub banners: Vec<Banner>,
    pub running: Vec<Row>,
    pub stopped: Vec<Row>,
    pub doctor_count: usize,
    /// Doctor results exist in this snapshot. Until then the Doctor row is
    /// unknown (grey), never "no findings" (green).
    pub doctor_known: bool,
    pub cli_version: Option<String>,
    /// Counts by state for the status bar; unknown is never "stopped".
    pub counts: Counts,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Counts {
    pub running: usize,
    pub stopped: usize,
    pub unknown: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DetailView {
    pub name: String,
    pub state: ProjectState,
    pub backend: String,
    pub url: Option<String>,
    pub always_on: bool,
    pub actions: Vec<Action>,
    pub busy: bool,
    pub services: Vec<ServiceView>,
    pub last_error: Option<String>,
    /// Why actions are limited (native projects in v0).
    pub note: Option<String>,
}

/// v0 scope: native projects are view-only. Native `restart` (and authored
/// `down`/`restart`) stay in the foreground and refuse `--json`; native
/// `up --json` is detached, but the app waits for one contract (design R2b).
pub const NATIVE_ACTIONS_NOTE: &str = "Native projects are view-only in this preview: start, stop or restart them in a terminal with HACK_RUNTIME_BACKEND=native hack up / down / restart.";

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Refreshed(Result<Snapshot, SourceError>),
    Select(String),
    ActionStarted {
        project: String,
        action: Action,
    },
    ActionFinished {
        project: String,
        action: Action,
        result: Result<ActionOutcome, SourceError>,
    },
}

#[derive(Debug, Default)]
pub struct AppModel {
    snapshot: Option<Snapshot>,
    last_error: Option<SourceError>,
    selected: Option<String>,
    local: HashMap<String, LocalContext>,
    action_errors: HashMap<String, String>,
    loaded_once: bool,
}

impl AppModel {
    #[must_use]
    pub fn always_on_global(&self) -> Option<&crate::models::AutostartGlobal> {
        self.snapshot.as_ref()?.projects.autostart_global.as_ref()
    }

    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply one event. Returns `true` when the app should refresh now.
    pub fn apply(&mut self, event: Event) -> bool {
        match event {
            Event::Refreshed(Ok(s)) => {
                self.loaded_once = true;
                self.clear_recovered_failures(&s);
                self.last_error = None;
                if self.selected.is_none()
                    || !s
                        .projects
                        .projects
                        .iter()
                        .any(|p| Some(&p.name) == self.selected.as_ref())
                {
                    self.selected = first_by_group(&s, &self.local);
                }
                self.snapshot = Some(s);
                false
            }
            Event::Refreshed(Err(SourceError::Pending)) => false,
            Event::Refreshed(Err(e)) => {
                self.loaded_once = true;
                self.last_error = Some(e);
                false
            }
            Event::Select(name) => {
                self.selected = Some(name);
                false
            }
            Event::ActionStarted { project, action } => {
                let ctx = self.local.entry(project.clone()).or_default();
                if ctx.in_flight.is_some() {
                    return false;
                }
                ctx.in_flight = Some(action);
                self.action_errors.remove(&project);
                false
            }
            Event::ActionFinished {
                project,
                action,
                result,
            } => {
                let ctx = self.local.entry(project.clone()).or_default();
                if ctx.in_flight == Some(action) {
                    ctx.in_flight = None;
                }
                match result {
                    Ok(ActionOutcome::Lifecycle(r)) => {
                        ctx.last_failed = if matches!(action, Action::Start | Action::Restart) {
                            r.services.failed
                        } else {
                            vec![]
                        };
                    }
                    Ok(ActionOutcome::Opened(_)) => {}
                    Err(e) => {
                        if let SourceError::Cli { failed, .. } = &e
                            && matches!(action, Action::Start | Action::Restart)
                        {
                            ctx.last_failed.clone_from(failed);
                        }
                        self.action_errors.insert(project, describe(&e));
                    }
                }
                action != Action::Open
            }
        }
    }

    /// A startup failure is cleared only on evidence that it is over: every
    /// failed service is observed running again. (A successful Stop from
    /// this app clears it too, in `ActionFinished`.) "Nothing runs" is not
    /// evidence: a failed start can leave containers never created.
    fn clear_recovered_failures(&mut self, s: &Snapshot) {
        for p in &s.projects.projects {
            let Some(ctx) = self.local.get_mut(&p.name) else {
                continue;
            };
            if ctx.last_failed.is_empty() || ctx.in_flight.is_some() {
                continue;
            }
            let svcs = state::services(p);
            let recovered = ctx
                .last_failed
                .iter()
                .all(|f| svcs.iter().any(|s| &s.name == f && s.running));
            if recovered {
                ctx.last_failed.clear();
            }
        }
    }

    /// Can `action` start for `project` now?
    #[must_use]
    pub fn can_start(&self, project: &str) -> bool {
        !matches!(self.last_error, Some(SourceError::CliMissing))
            && self
                .local
                .get(project)
                .is_none_or(|c| c.in_flight.is_none())
    }

    #[must_use]
    pub fn selected_row(&self) -> Option<&ProjectRow> {
        let s = self.snapshot.as_ref()?;
        let name = self.selected.as_ref()?;
        s.projects.projects.iter().find(|p| &p.name == name)
    }

    #[must_use]
    pub fn list(&self) -> ListView {
        let mut banners = Vec::new();
        let phase = match (&self.snapshot, &self.last_error) {
            (_, Some(SourceError::CliMissing)) => Phase::CliMissing,
            (None, Some(SourceError::Cli { code, message, .. })) => Phase::Error {
                code: code.clone(),
                message: message.clone(),
            },
            (None, _) => Phase::Loading,
            (Some(s), _) if s.projects.projects.is_empty() => Phase::Empty,
            (Some(_), _) => Phase::Ready,
        };
        let mut running = Vec::new();
        let mut stopped = Vec::new();
        if let Some(s) = &self.snapshot {
            match (&s.daemon, s.daemon_mismatch()) {
                (None, _) => banners.push(Banner::DaemonOff),
                (Some(_), Some(v)) => banners.push(Banner::DaemonMismatch {
                    daemon: v.to_owned(),
                    cli: s.cli_version.clone(),
                }),
                _ => {}
            }
            if s.projects.engine_down() {
                banners.push(Banner::EngineDown {
                    error: s.projects.runtime_error.clone().unwrap_or_default(),
                });
            }
            if let Some(e) = &self.last_error {
                banners.push(Banner::Stale { error: describe(e) });
            }
            for p in &s.projects.projects {
                let row = Row {
                    state: state::derive(
                        p,
                        self.local.get(&p.name).unwrap_or(&LocalContext::default()),
                    ),
                    always_on: p
                        .autostart
                        .as_ref()
                        .is_some_and(|a| a.enabled == Some(true)),
                    selected: Some(&p.name) == self.selected.as_ref(),
                    name: p.name.clone(),
                };
                if row.state.is_active() {
                    running.push(row);
                } else {
                    stopped.push(row);
                }
            }
        }
        running.sort_by(|a, b| a.name.cmp(&b.name));
        stopped.sort_by(|a, b| a.name.cmp(&b.name));
        let unknown = stopped
            .iter()
            .filter(|r| matches!(r.state, ProjectState::Unknown { .. }))
            .count();
        let counts = Counts {
            running: running.len(),
            stopped: stopped.len() - unknown,
            unknown,
        };
        ListView {
            phase,
            banners,
            running,
            stopped,
            doctor_known: self.snapshot.as_ref().is_some_and(|s| s.doctor.is_some()),
            doctor_count: self
                .snapshot
                .as_ref()
                .and_then(|s| s.doctor.as_ref())
                .map_or(0, crate::models::DoctorReport::attention_count),
            cli_version: self.snapshot.as_ref().map(|s| s.cli_version.clone()),
            counts,
        }
    }

    #[must_use]
    pub fn detail(&self) -> Option<DetailView> {
        let row = self.selected_row()?;
        let default = LocalContext::default();
        let local = self.local.get(&row.name).unwrap_or(&default);
        let st = state::derive(row, local);
        Some(DetailView {
            name: row.name.clone(),
            backend: if row.is_native() {
                "native".into()
            } else {
                row.backend.clone().unwrap_or_else(|| "compose".into())
            },
            url: row.dev_host.as_ref().map(|h| format!("https://{h}")),
            always_on: row
                .autostart
                .as_ref()
                .is_some_and(|a| a.enabled == Some(true)),
            actions: if row.is_native() || matches!(self.last_error, Some(SourceError::CliMissing))
            {
                vec![]
            } else {
                st.actions().to_vec()
            },
            note: row.is_native().then(|| NATIVE_ACTIONS_NOTE.to_owned()),
            busy: local.in_flight.is_some(),
            services: state::services(row),
            last_error: self.action_errors.get(&row.name).cloned(),
            state: st,
        })
    }
}

fn first_by_group(s: &Snapshot, local: &HashMap<String, LocalContext>) -> Option<String> {
    let default = LocalContext::default();
    let mut rows: Vec<(bool, &str)> = s
        .projects
        .projects
        .iter()
        .map(|p| {
            let st = state::derive(p, local.get(&p.name).unwrap_or(&default));
            (!st.is_active(), p.name.as_str())
        })
        .collect();
    rows.sort();
    rows.first().map(|(_, n)| (*n).to_owned())
}

fn describe(e: &SourceError) -> String {
    match e {
        SourceError::Pending => "still loading".into(),
        SourceError::CliMissing => "hack was not found on PATH".into(),
        SourceError::Cli { code, message, .. } => format!("{code}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{self, Fixture};
    use crate::models::LifecycleResult;

    fn model(f: Fixture) -> AppModel {
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(fixtures::snapshot(f)));
        m
    }

    #[test]
    fn list_phases_for_every_list_fixture() {
        assert_eq!(model(Fixture::Loading).list().phase, Phase::Loading);
        assert_eq!(model(Fixture::Empty).list().phase, Phase::Empty);
        assert_eq!(model(Fixture::CliMissing).list().phase, Phase::CliMissing);
        assert!(matches!(
            model(Fixture::Error).list().phase,
            Phase::Error { .. }
        ));
        assert_eq!(
            model(Fixture::DaemonDown).list().banners,
            vec![Banner::DaemonOff]
        );
        assert!(matches!(
            model(Fixture::DaemonMismatch).list().banners[..],
            [Banner::DaemonMismatch { .. }]
        ));
        let engine = model(Fixture::EngineDown).list();
        assert!(matches!(engine.banners[..], [Banner::EngineDown { .. }]));
        assert!(engine.running.is_empty(), "unknown is not running");
        assert_eq!(engine.counts.stopped, 0, "unknown is not stopped");
        assert_eq!(engine.counts.unknown, 4);
    }

    #[test]
    fn groups_and_selection() {
        let v = model(Fixture::Running).list();
        let names = |rows: &[Row]| rows.iter().map(|r| r.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&v.running), ["docs-site", "storefront"]);
        assert_eq!(names(&v.stopped), ["billing-api", "notes"]);
        assert!(v.running[0].selected, "first running project selected");
        assert!(v.running[0].always_on);
        assert_eq!(v.doctor_count, 1);
        assert!(v.doctor_known);
    }

    #[test]
    fn doctor_is_unknown_until_it_has_run() {
        let mut snap = fixtures::snapshot(Fixture::Running).unwrap();
        snap.doctor = None; // live snapshots carry no doctor results
        let mut m = AppModel::new();
        m.apply(Event::Refreshed(Ok(snap)));
        let v = m.list();
        assert!(!v.doctor_known);
        assert_eq!(v.doctor_count, 0);
    }

    #[test]
    fn failed_refresh_keeps_last_good_and_marks_stale() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Refreshed(Err(SourceError::Cli {
            code: "E_UNEXPECTED".into(),
            message: "boom".into(),
            failed: vec![],
        })));
        let v = m.list();
        assert_eq!(v.phase, Phase::Ready);
        assert!(matches!(v.banners.last(), Some(Banner::Stale { .. })));
        assert_eq!(v.running.len(), 2);
    }

    #[test]
    fn action_lifecycle_and_single_flight() {
        let mut m = model(Fixture::Stopped);
        m.apply(Event::Select("storefront".into()));
        assert_eq!(m.detail().unwrap().actions, vec![Action::Start]);
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Start,
        });
        let d = m.detail().unwrap();
        assert_eq!(d.state, ProjectState::Starting);
        assert!(d.busy);
        assert!(!m.can_start("storefront"));
        // A second action while one runs is ignored.
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Restart,
        });
        let refresh = m.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Start,
            result: Ok(ActionOutcome::Lifecycle(LifecycleResult {
                services: crate::models::LifecycleServices {
                    failed: vec!["api".into()],
                    ..Default::default()
                },
                ..Default::default()
            })),
        });
        assert!(refresh, "lifecycle actions refresh at once");
        assert_eq!(
            m.detail().unwrap().state,
            ProjectState::FailedStart {
                services: vec!["api".into()]
            }
        );
    }

    #[test]
    fn open_is_single_flight_too() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Open,
        });
        assert!(!m.can_start("storefront"));
        assert!(m.detail().unwrap().busy);
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::Running { .. }
        ));
    }

    #[test]
    fn startup_failure_error_names_failed_services() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Restart,
        });
        m.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Restart,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["worker".into()],
            }),
        });
        // Fixture still shows all running; the failure shows once a service is down.
        assert!(m.detail().unwrap().last_error.is_some());
        let mut d = model(Fixture::Degraded);
        d.apply(Event::Select("storefront".into()));
        d.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Start,
        });
        d.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["worker".into()],
            }),
        });
        assert_eq!(
            d.detail().unwrap().state,
            ProjectState::FailedStart {
                services: vec!["worker".into()]
            }
        );
    }

    #[test]
    fn recovered_failure_does_not_stay_latched() {
        let mut m = model(Fixture::Degraded);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Start,
        });
        m.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["worker".into()],
            }),
        });
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::FailedStart { .. }
        ));
        // Recovered elsewhere: everything runs.
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Running)));
        assert!(matches!(
            m.detail().unwrap().state,
            ProjectState::Running { .. }
        ));
        // Then stopped elsewhere: plain Stopped, not "Failed to start".
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Stopped)));
        assert_eq!(m.detail().unwrap().state, ProjectState::Stopped);
    }

    #[test]
    fn failed_start_with_nothing_created_stays_failed() {
        let mut m = model(Fixture::Stopped);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Start,
        });
        m.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Start,
            result: Err(SourceError::Cli {
                code: "E_STARTUP_INCOMPLETE".into(),
                message: "m".into(),
                failed: vec!["api".into()],
            }),
        });
        let failed = ProjectState::FailedStart {
            services: vec!["api".into()],
        };
        assert_eq!(m.detail().unwrap().state, failed);
        // The same stopped observation is no evidence of recovery.
        m.apply(Event::Refreshed(fixtures::snapshot(Fixture::Stopped)));
        assert_eq!(m.detail().unwrap().state, failed);
        // An explicit successful Stop clears it.
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Stop,
        });
        m.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Stop,
            result: Ok(ActionOutcome::Lifecycle(LifecycleResult::default())),
        });
        assert_eq!(m.detail().unwrap().state, ProjectState::Stopped);
    }

    #[test]
    fn native_projects_offer_no_actions_and_say_why() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("docs-site".into()));
        let d = m.detail().unwrap();
        assert!(d.actions.is_empty());
        assert!(d.note.is_some());
        assert_eq!(d.backend, "native");
    }

    #[test]
    fn action_error_is_shown_on_the_project() {
        let mut m = model(Fixture::Running);
        m.apply(Event::Select("storefront".into()));
        m.apply(Event::ActionStarted {
            project: "storefront".into(),
            action: Action::Stop,
        });
        m.apply(Event::ActionFinished {
            project: "storefront".into(),
            action: Action::Stop,
            result: Err(SourceError::Cli {
                code: "E_DOCKER_UNAVAILABLE".into(),
                message: "down".into(),
                failed: vec![],
            }),
        });
        let d = m.detail().unwrap();
        assert_eq!(d.last_error.as_deref(), Some("E_DOCKER_UNAVAILABLE: down"));
        assert!(!d.busy);
    }

    #[test]
    fn every_detail_fixture_renders_a_detail() {
        for f in [
            Fixture::Stopped,
            Fixture::Starting,
            Fixture::Running,
            Fixture::Degraded,
            Fixture::Stopping,
            Fixture::FailedStart,
            Fixture::NeedsAttention,
        ] {
            let mut m = model(f);
            m.apply(Event::Select(fixtures::selected(f).into()));
            if let Some(a) = fixtures::local(f).in_flight {
                m.apply(Event::ActionStarted {
                    project: fixtures::selected(f).into(),
                    action: a,
                });
            }
            let d = m.detail().unwrap_or_else(|| panic!("{f:?}"));
            assert_eq!(d.name, "storefront");
            assert_eq!(d.url.as_deref(), Some("https://storefront.hack"));
        }
    }
}
