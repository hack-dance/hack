//! The main window composed from design v1 components.
//!
//! [`MainWindow`] renders a [`WindowData`]: the same list and detail view
//! models the current app renders, so the gallery can be judged against the
//! live window without touching it. It runs no action.

use std::collections::HashMap;

use gpui_kit::{
    AnyElement, Context, Div, IntoElement, ParentElement, Render, SharedString, Styled, Window,
    div, prelude::*,
};
use hack_desktop_core::fixtures::{self, Fixture};
use hack_desktop_core::models::LogEntry;
use hack_desktop_core::source::{DaemonRecovery, SourceError};
use hack_desktop_core::state::{Action, ProjectState};
use hack_desktop_core::viewmodel::{AppModel, Banner, DetailView, Event, ListView, Phase, Row};

use crate::components::{
    BannerTone, LogLevel, LogLine, ServiceRow, StyledExt as _, Ui, action_button, always_on_switch,
    banner, caption, count_pill, dot, empty_pane, log_tail, machine_row, neutral_pill, pill_tabs,
    primary_button, project_row, services_table, skeleton, state_pill, status_bar, title_bar,
};
use crate::icons::Glyph;
use crate::status::{Status, project_label, service_label};
use crate::tokens::{Mode, Palette, size, space, text};

/// Per-service CPU and memory, when known. The core does not read usage yet;
/// the gallery passes labelled sample values (see DESIGN-V1.md).
pub type Usage = HashMap<String, (String, String)>;

/// Everything the window shows.
pub struct WindowData {
    pub list: ListView,
    pub detail: Option<DetailView>,
    pub tail: Result<Vec<LogEntry>, String>,
    pub recovery: Option<DaemonRecovery>,
    pub engine_observed: bool,
    pub usage: Usage,
}

impl WindowData {
    /// The window's data for one fixture, built exactly as the app builds it.
    #[must_use]
    pub fn from_fixture(f: Fixture) -> Self {
        let mut model = AppModel::new();
        model.apply(Event::Refreshed(fixtures::snapshot(f)));
        model.apply(Event::Select(fixtures::selected(f).to_owned()));
        let mut tail = Ok(fixtures::log_tail(f));
        if matches!(f, Fixture::DaemonDown | Fixture::DaemonMismatch) {
            let mismatch = f == Fixture::DaemonMismatch;
            model.apply(Event::Refreshed(Err(SourceError::DaemonUnavailable {
                cli: fixtures::CLI_VERSION.into(),
                daemon: mismatch.then(|| "4.3.0".into()),
                message: if mismatch {
                    "hackd v4.3.0, CLI v5.0.0: restart hackd"
                } else {
                    "hackd is off or unreachable: start hackd"
                }
                .into(),
            })));
            tail = Err("Project status could not be read".into());
        }
        if let Some(action) = fixtures::local(f).in_flight
            && let Some(name) = model.detail().map(|d| d.name)
        {
            model.apply(Event::ActionStarted {
                project: name,
                action,
            });
        }
        let detail = model.detail();
        let usage = detail
            .as_ref()
            .map(|d| sample_usage(&d.state, d.services.iter().map(|s| (&s.name, s.running))))
            .unwrap_or_default();
        Self {
            list: model.list(),
            detail,
            tail,
            recovery: model.daemon_recovery(),
            engine_observed: model.engine_observed(),
            usage,
        }
    }
}

/// Sample CPU and memory for running services, so the table can be judged
/// at its intended density. Placeholder values, not measurements.
fn sample_usage<'a>(
    state: &ProjectState,
    services: impl Iterator<Item = (&'a String, bool)>,
) -> Usage {
    const SAMPLES: [(&str, &str); 6] = [
        ("3%", "212 MB"),
        ("1%", "148 MB"),
        ("0%", "96 MB"),
        ("0%", "31 MB"),
        ("2%", "64 MB"),
        ("0%", "18 MB"),
    ];
    if matches!(state, ProjectState::Stopped | ProjectState::Unknown { .. }) {
        return Usage::new();
    }
    services
        .filter(|(_, running)| *running)
        .enumerate()
        .map(|(i, (name, _))| {
            let (cpu, mem) = SAMPLES[i % SAMPLES.len()];
            (name.clone(), (cpu.to_owned(), mem.to_owned()))
        })
        .collect()
}

/// The design v1 main window.
pub struct MainWindow {
    pub data: WindowData,
    pub mode: Mode,
    /// Draw stand-in traffic lights (offscreen macOS-style renders).
    pub traffic_lights: bool,
    pub tab: usize,
}

impl MainWindow {
    fn ui(&self, cx: &gpui_kit::App) -> Ui {
        use gpui_kit::component::ActiveTheme as _;
        let t = cx.theme();
        Ui {
            p: Palette::for_mode(self.mode),
            font: t.font_family.clone(),
            mono: t.mono_font_family.clone(),
        }
    }

    fn sidebar(&self, ui: &Ui) -> Div {
        let p = ui.p;
        let list = &self.data.list;
        let mut projects = div()
            .id("projects")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .px(space::S3)
            .pb(space::S4);
        match &list.phase {
            Phase::Loading => {
                projects = projects.child(caption("Projects", ui));
                for w in [120., 96., 132.] {
                    projects = projects.child(
                        div()
                            .h(size::ROW)
                            .px(space::S5)
                            .flex()
                            .items_center()
                            .gap(space::S4)
                            .child(div().size(size::DOT).rounded_full().bg(p.surface_1))
                            .child(skeleton(w, ui)),
                    );
                }
            }
            Phase::Ready => {
                let group = |name: &'static str, rows: &[Row], mut col: gpui_kit::Stateful<Div>| {
                    if rows.is_empty() {
                        return col;
                    }
                    col = col.child(caption(name, ui));
                    for r in rows {
                        col = col.child(project_row(
                            SharedString::from(format!("project-{}", r.name)),
                            r.name.clone(),
                            Status::of(&r.state),
                            r.always_on,
                            r.selected,
                            ui,
                        ));
                    }
                    col
                };
                let all_unknown = !list.stopped.is_empty()
                    && list
                        .stopped
                        .iter()
                        .all(|r| matches!(r.state, ProjectState::Unknown { .. }));
                projects = group("Running", &list.running, projects);
                projects = group(
                    if all_unknown {
                        "Not observed"
                    } else {
                        "Stopped"
                    },
                    &list.stopped,
                    projects,
                );
            }
            Phase::Empty | Phase::CliMissing | Phase::Error { .. } => {}
        }
        let doctor_trailing: AnyElement = match (list.doctor_known, list.doctor_count) {
            (true, n) if n > 0 => count_pill(n, ui).into_any_element(),
            (true, _) => dot(Status::Running, ui).into_any_element(),
            (false, _) => dot(Status::Unknown, ui).into_any_element(),
        };
        let machine = div()
            .flex_none()
            .flex()
            .flex_col()
            .px(space::S3)
            .pb(space::S4)
            .child(caption("Machine", ui))
            // Routing status is not read yet: shown as unknown (ring).
            .child(machine_row(
                "routing",
                Glyph::Globe,
                "Routing and DNS",
                dot(Status::Unknown, ui),
                ui,
            ))
            .child(machine_row(
                "doctor",
                Glyph::Stethoscope,
                "Doctor",
                doctor_trailing,
                ui,
            ));
        div()
            .w(size::SIDEBAR)
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .bg(p.chrome)
            .hairline_r(p.border)
            .child(projects)
            .child(machine)
    }

    fn banners(&self, ui: &Ui) -> Div {
        let mut col = div().flex().flex_col();
        let mut recovery_shown = false;
        for b in &self.data.list.banners {
            let (tone, msg, action) = match b {
                Banner::DaemonOff => (
                    BannerTone::Warn,
                    "hackd is not running. Project states are not observed.".to_owned(),
                    Some((Glyph::Power, "Start hackd")),
                ),
                Banner::DaemonMismatch { daemon, cli } => (
                    BannerTone::Warn,
                    format!("hackd {daemon} is running; this CLI is {cli}."),
                    Some((Glyph::Restart, "Restart hackd")),
                ),
                Banner::EngineDown { error } => (
                    BannerTone::Error,
                    format!("Docker is not reachable: {error}"),
                    None,
                ),
                Banner::DaemonReadFailed { error } => (BannerTone::Warn, error.clone(), None),
                // The stale banner repeats the daemon banner's cause; the
                // sidebar's "Not observed" caption already says it.
                Banner::Stale { .. } => continue,
            };
            let action = if action.is_some() && self.data.recovery.is_some() && !recovery_shown {
                recovery_shown = true;
                action
            } else {
                None
            };
            col = col.child(banner(tone, msg, action, ui));
        }
        col
    }

    fn header(&self, d: &DetailView, ui: &Ui) -> Div {
        let p = ui.p;
        let status = Status::of(&d.state);
        let mut actions = div().flex().items_center().gap(space::S3);
        for a in [Action::Open, Action::Restart, Action::Stop, Action::Start] {
            if !d.actions.contains(&a) {
                continue;
            }
            let enabled = !d.busy;
            let (glyph, id) = match a {
                Action::Open => (Glyph::ExternalLink, "open"),
                Action::Restart => (Glyph::Restart, "restart"),
                Action::Stop => (Glyph::Stop, "stop"),
                Action::Start => (Glyph::Play, "start"),
            };
            actions = actions.child(if a == Action::Start && enabled {
                primary_button(id, glyph, a.label(), ui)
            } else {
                action_button(id, glyph, a.label(), enabled, ui)
            });
        }
        let reason = match (&d.state, &d.last_error) {
            (_, Some(e)) => Some(format!("Last action failed: {e}")),
            (ProjectState::NeedsAttention { reason }, None) => Some(reason.clone()),
            // A daemon banner already explains an unobserved project.
            (ProjectState::Unknown { reason }, None) if !self.daemon_banner() => {
                Some(reason.clone())
            }
            _ => None,
        };
        div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .child(
                        div()
                            .type_step(text::TITLE)
                            .text_color(p.text_primary)
                            .child(d.name.clone()),
                    )
                    .child(state_pill(status, project_label(&d.state), ui))
                    .child(neutral_pill(d.backend.clone(), ui))
                    .child(div().flex_1())
                    .child(actions),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S5)
                    .type_step(text::BODY)
                    .text_color(p.text_secondary)
                    .children(d.url.clone().map(|u| {
                        div()
                            .font_family(ui.mono.clone())
                            .type_step(text::MONO)
                            .text_color(p.text_secondary)
                            .child(u)
                    }))
                    .child(div().flex_1())
                    .child(always_on_switch(d.always_on, false, ui)),
            )
            .children(reason.map(|r| {
                let c = if matches!(status, Status::Failed) {
                    p.states.failed.fg
                } else {
                    p.text_secondary
                };
                div().type_step(text::BODY).text_color(c).child(r)
            }))
            .children(d.note.clone().map(|n| {
                div()
                    .type_step(text::SMALL)
                    .text_color(p.text_muted)
                    .child(n)
            }))
    }

    fn detail(&self, d: &DetailView, ui: &Ui) -> Div {
        let rows: Vec<ServiceRow> = d
            .services
            .iter()
            .map(|s| {
                let usage = self.data.usage.get(&s.name);
                ServiceRow {
                    name: s.name.clone(),
                    status: Status::of_service(s),
                    state: service_label(s),
                    cpu: usage.map(|u| u.0.clone()),
                    memory: usage.map(|u| u.1.clone()),
                    route: s.route.clone().ok_or_else(|| "internal".to_owned()),
                }
            })
            .collect();
        let lines: Vec<LogLine> = match &self.data.tail {
            Ok(entries) => entries
                .iter()
                .map(|e| LogLine {
                    time: e.timestamp.clone(),
                    service: e.service.clone(),
                    message: e.message.clone(),
                    level: match e.level.as_deref() {
                        Some("error" | "fatal") => LogLevel::Error,
                        Some("warn" | "warning") => LogLevel::Warn,
                        _ => LogLevel::Info,
                    },
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        let empty = self.data.tail.as_ref().err().map(String::as_str);
        div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .px(space::S8)
                    .pt(space::S7)
                    .pb(space::S5)
                    .child(self.header(d, ui)),
            )
            .child(div().px(space::S7).pb(space::S3).child(pill_tabs(
                &["Services", "Logs", "Env", "Activity"],
                self.tab,
                ui,
            )))
            .child(
                div()
                    .id("detail-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(space::S8)
                    .pb(space::S7)
                    .flex()
                    .flex_col()
                    .gap(space::S6)
                    .child(services_table(&rows, ui))
                    .child(log_tail("Recent logs", &lines, empty, ui)),
            )
    }

    fn daemon_banner(&self) -> bool {
        self.data
            .list
            .banners
            .iter()
            .any(|b| matches!(b, Banner::DaemonOff | Banner::DaemonMismatch { .. }))
    }

    fn status_items(&self) -> Vec<(Option<Status>, String)> {
        let list = &self.data.list;
        if list.cli_version.is_none() {
            return vec![(None, "not connected".into())];
        }
        let c = list.counts;
        let always_on = list
            .running
            .iter()
            .chain(&list.stopped)
            .filter(|r| r.always_on)
            .count();
        let mut items = vec![];
        if c.unknown > 0 && c.running == 0 {
            items.push((None, format!("{} not observed", c.unknown)));
        } else {
            items.push((None, format!("{} running", c.running)));
        }
        items.push((None, format!("{always_on} always on")));
        let banners = &list.banners;
        let engine = if !self.data.engine_observed {
            (Status::Unknown, "engine unknown")
        } else if banners
            .iter()
            .any(|b| matches!(b, Banner::EngineDown { .. }))
        {
            (Status::Failed, "engine down")
        } else {
            (Status::Running, "engine ok")
        };
        items.push((Some(engine.0), engine.1.into()));
        let daemon = if banners.iter().any(|b| matches!(b, Banner::DaemonOff)) {
            Some((Status::Stopped, "hackd off"))
        } else if banners
            .iter()
            .any(|b| matches!(b, Banner::DaemonMismatch { .. }))
        {
            Some((Status::Degraded, "hackd mismatch"))
        } else {
            None
        };
        if let Some((s, l)) = daemon {
            items.push((Some(s), l.into()));
        }
        items
    }
}

impl Render for MainWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = self.ui(cx);
        let p = ui.p;
        let list = &self.data.list;
        let main: AnyElement = match &list.phase {
            Phase::CliMissing => empty_pane(
                Glyph::CircleAlert,
                "Hack CLI not found",
                "The app runs the hack command for everything. Install it, then reopen the app.",
                Some("brew install hack-dance/tap/hack"),
                &ui,
            )
            .into_any_element(),
            Phase::Error { code, message } => empty_pane(
                Glyph::CircleAlert,
                "Could not read projects",
                format!("{message} ({code})"),
                Some("hack projects --json"),
                &ui,
            )
            .into_any_element(),
            Phase::Empty => empty_pane(
                Glyph::Folder,
                "No projects yet",
                "Set up a repository with Hack and it shows up here.",
                Some("hack init"),
                &ui,
            )
            .into_any_element(),
            Phase::Loading => {
                empty_pane(Glyph::Loader, "Loading projects…", "", None, &ui).into_any_element()
            }
            Phase::Ready => match &self.data.detail {
                Some(d) => self.detail(d, &ui).into_any_element(),
                None => {
                    empty_pane(Glyph::Folder, "Select a project", "", None, &ui).into_any_element()
                }
            },
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(p.surface)
            .text_color(p.text_primary)
            .font_family(ui.font.clone())
            .child(title_bar(self.traffic_lights, &ui))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(self.sidebar(&ui))
                    .child(
                        div()
                            .flex_1()
                            .h_full()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(self.banners(&ui))
                            .child(main),
                    ),
            )
            .child(status_bar(
                self.status_items(),
                list.cli_version.clone().map(|v| format!("hack {v}")),
                &ui,
            ))
    }
}
