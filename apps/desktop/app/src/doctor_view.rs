//! Doctor presents one summary and one next action per finding.

use std::time::Instant;

use gpui_kit::{
    AnyElement, Context, IntoElement, ParentElement, Styled, Window, div, prelude::*, px,
};
use hack_desktop_core::{
    doctor::{Affected, Area, Card, CardAction, DoctorState, DoctorView, Severity},
    setup::{Remedy, Status},
    terminal::{CommandAvailability, CommandControl, CommandControlSize},
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, empty_pane, icon, primary_button},
    icons::Glyph,
    tokens::{radius, space, text},
};

use hack_desktop_core::source::DaemonRecovery;

use crate::{
    health_model::{
        CLI_UPDATE_GUIDE, MACHINE_ROWS, Repair, RepairTarget, cli_update_repair, machine_repair,
        matches_authored_copy, project_repair, setup_card,
    },
    view::HackApp,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Pane {
    #[default]
    Project,
    Doctor,
    Resources,
    Configuration,
    /// Setup checks (`setup_view`).
    Setup,
    Hackd,
    Upgrade,
    BannersSheet,
    ErrorsSheet,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Passed,
    Warning,
    Error,
    Unknown,
    Skipped,
    Running,
}

impl Mark {
    pub fn icon(self, ui: &Ui) -> AnyElement {
        let p = ui.p;
        let (glyph, fg) = match self {
            Self::Passed => (Glyph::Check, p.states.running.fg),
            Self::Warning => (Glyph::CircleAlert, p.states.degraded.fg),
            Self::Error => (Glyph::CircleAlert, p.states.failed.fg),
            Self::Unknown => (Glyph::CircleAlert, p.text_muted),
            Self::Skipped => (Glyph::Minus, p.text_muted),
            Self::Running => (Glyph::Loader, p.text_primary),
        };
        icon(glyph, px(15.), fg).into_any_element()
    }
}

pub enum Next {
    Repair(Repair),
    SingleRepair(Repair),
    Command(CommandControl),
    Doc(String),
    Recheck,
    Review,
    ReviewRelease,
    None,
}

pub struct Row {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) summary: String,
    pub(crate) details: Option<String>,
    pub(crate) mark: Mark,
    pub(crate) next: Next,
}

impl Row {
    fn repair(&self) -> Option<&Repair> {
        if let Next::Repair(repair) | Next::SingleRepair(repair) = &self.next {
            Some(repair)
        } else {
            None
        }
    }
}

fn setup_summary(card: &hack_desktop_core::setup::Card) -> String {
    match (card.id.as_str(), card.status) {
        ("routing", Status::Passed) if !card.detail.is_empty() => card.detail.clone(),
        ("routing", Status::NeedsAttention) if !card.detail.starts_with("5 of 8") => {
            "Some local project URLs may not open".into()
        }
        ("daemon", Status::NeedsAttention) if matches!(card.remedy, Remedy::Run(_)) => {
            "The Hack service isn’t running".into()
        }
        ("trust", Status::NeedsAttention) => "Browsers may warn on HTTPS project URLs".into(),
        ("login", Status::NeedsAttention) => "Hack won’t start when you sign in".into(),
        (_, Status::Unknown) => "Couldn’t check".into(),
        _ => card.detail.clone(),
    }
}

pub fn rows(app: &HackApp, view: &DoctorView) -> (Vec<Row>, Vec<Row>) {
    let report = app.health_report();
    let mut machine = Vec::new();
    let mut projects = Vec::new();
    if app.doctor.filter.is_none() {
        for (id, title) in MACHINE_ROWS {
            let Some(card) = setup_card(report, id) else {
                continue;
            };
            let skipped = app.setup.skipped.contains(id) && card.status != Status::Passed;
            let (mark, next) = if card.status == Status::Passed {
                (Mark::Passed, Next::None)
            } else if card.status == Status::Unknown {
                (Mark::Unknown, Next::Recheck)
            } else if card.status == Status::NeedsAttention {
                let mark = if skipped {
                    Mark::Skipped
                } else {
                    Mark::Warning
                };
                (mark, machine_action(app, card))
            } else {
                (Mark::Unknown, Next::None)
            };
            let summary = if skipped {
                "Skipped during setup".into()
            } else {
                setup_summary(card)
            };
            machine.push(Row {
                id: id.into(),
                title: title.into(),
                details: (summary != card.detail && !card.detail.is_empty())
                    .then(|| card.detail.clone()),
                summary,
                mark,
                next,
            });
        }
        machine.insert(
            machine
                .iter()
                .position(|row| row.id == "login")
                .unwrap_or(machine.len()),
            Row {
                id: "upgrade".into(),
                title: "Upgrade".into(),
                summary: app.health.signals.update.as_ref().map_or_else(
                    || "Review upgrade readiness".into(),
                    |release| format!("Hack {} is available", release.latest),
                ),
                details: None,
                mark: Mark::Unknown,
                next: if app.health.signals.update.is_some() {
                    Next::ReviewRelease
                } else {
                    Next::Review
                },
            },
        );
    }
    for card in view.cards() {
        match &card.affected {
            Affected::Machine if app.doctor.filter.is_none() && !covered(card, report) => {
                machine.push(finding(app, card, None));
            }
            Affected::Projects(affected) => {
                for project in affected.iter().filter(|project| {
                    app.doctor
                        .filter
                        .as_ref()
                        .is_none_or(|filter| filter == &project.name)
                }) {
                    projects.push(finding(app, card, Some(project)));
                }
            }
            Affected::Machine => {}
        }
    }
    // Keep confirmed project rows visible above the collapsed passed list.
    for target in &app.health.confirmed {
        if let RepairTarget::Project(project) = target
            && app
                .doctor
                .filter
                .as_ref()
                .is_none_or(|filter| filter == &project.name)
            && target.confirmed(report, &app.health.runs)
        {
            projects.push(Row {
                id: format!("fixed-{}", project.name),
                title: project.name.clone(),
                summary: "Project ignore rules are current · fixed just now".into(),
                details: None,
                mark: Mark::Passed,
                next: Next::None,
            });
        }
    }
    (machine, projects)
}

fn machine_action(app: &HackApp, card: &hack_desktop_core::setup::Card) -> Next {
    let report = app.health_report();
    if let Some(mut repair) = machine_repair(card, report) {
        if repair.control.label == "hack daemon restart"
            && app.model.daemon_recovery() != Some(DaemonRecovery::Restart)
        {
            return Next::Recheck;
        }
        if card.id == "routing" && app.health.signals.routing_permission_denied {
            if let CommandAvailability::Ready(spec) = repair.control.availability {
                repair.control.availability = CommandAvailability::CopyOnly(spec);
            }
            return Next::Command(repair.control);
        }
        return Next::Repair(repair);
    }
    match &card.remedy {
        Remedy::Doc(url) => Next::Doc(url.clone()),
        Remedy::Copy(cmd)
            if card.id == "daemon"
                && card.status == Status::NeedsAttention
                && matches_authored_copy(report, cmd, &["update"]) =>
        {
            cli_update_repair(report)
                .map_or_else(|| Next::Doc(CLI_UPDATE_GUIDE.into()), Next::SingleRepair)
        }
        _ => Next::None,
    }
}

/// The setup rows own these checks. Leave unrelated preflight and engine
/// findings individually visible even when the corresponding setup row exists.
fn covered(card: &Card, report: &hack_desktop_core::setup::Report) -> bool {
    let id = card.id.as_str();
    let step = match card.area {
        Area::RoutingDns
            if id == "coredns forwarding"
                || id == "dnsmasq:53"
                || id == "linux dns route"
                || id.starts_with("resolver:")
                || id.starts_with("dnsmasq.conf:") =>
        {
            "routing"
        }
        Area::Certificates if id == "local ca trust" => "trust",
        Area::Daemon if id == "daemon" => "daemon",
        Area::Daemon if matches!(id, "daemon service" | "autostart login service") => "login",
        Area::Engine if id == "docker daemon" => "docker",
        _ => return false,
    };
    setup_card(report, step).is_some()
}

fn finding(
    app: &HackApp,
    card: &Card,
    project: Option<&hack_desktop_core::doctor::ProjectRef>,
) -> Row {
    let report = app.health_report();
    let id = format!(
        "finding-{}-{}",
        card.id,
        project.map_or("machine", |p| p.name.as_str())
    );
    let repair = project
        .filter(|_| card.id == "hack gitignore")
        .and_then(|project| project_repair(project, report, &app.health.runs));
    let next = match (&card.action, repair) {
        (_, _) if card.severity == Severity::CouldNotCheck => Next::Recheck,
        (_, Some(repair)) => Next::Repair(repair),
        (CardAction::OpenDoc(url), None) => Next::Doc(url.clone()),
        (CardAction::Copy(_), None) => {
            let spec = card.authored_remedy.as_ref().and_then(|recipe| {
                let args: Option<Vec<_>> = recipe
                    .argv()
                    .into_iter()
                    .map(|arg| arg.into_string().ok())
                    .collect();
                report.command(args?).ok()
            });
            if let Some(spec) = spec {
                Next::Command(CommandControl {
                    id: id.clone(),
                    label: card
                        .authored_remedy
                        .as_ref()
                        .map_or_else(String::new, |r| r.standalone_command()),
                    title: "Terminal".into(),
                    availability: CommandAvailability::CopyOnly(spec),
                    size: CommandControlSize::Compact,
                    cwd: None,
                    expects_password: false,
                })
            } else {
                Next::None
            }
        }
    };
    let title = project.map_or_else(|| card.area.label().into(), |p| p.name.clone());
    let summary = match (&card.severity, card.id.as_str()) {
        (Severity::CouldNotCheck, _) => format!("Couldn’t check {}", card.id),
        (_, "hack gitignore") => "Project ignore rules are out of date".into(),
        (_, "generated files") => "Generated files need attention".into(),
        _ => card.id.clone(),
    };
    Row {
        id,
        title,
        summary,
        details: (!card.detail.is_empty()).then(|| card.detail.clone()),
        mark: match card.severity {
            Severity::Warn => Mark::Warning,
            Severity::Error => Mark::Error,
            Severity::CouldNotCheck => Mark::Unknown,
        },
        next,
    }
}

pub fn attention_count(app: &HackApp, view: &DoctorView) -> usize {
    let report = app.health_report();
    let machine = MACHINE_ROWS
        .iter()
        .filter(|(id, _)| {
            setup_card(report, id).is_some_and(|card| card.status == Status::NeedsAttention)
        })
        .count();
    machine
        + view
            .cards()
            .filter(|card| !matches!(card.affected, Affected::Machine) || !covered(card, report))
            .count()
}

pub fn repairs(app: &HackApp) -> Vec<Repair> {
    if app.doctor.stale || app.doctor.is_loading() {
        return Vec::new();
    }
    let DoctorState::Loaded(view) = &app.doctor.result else {
        return Vec::new();
    };
    let (machine, projects) = rows(app, view);
    let mut repairs = Vec::new();
    for row in machine.iter().chain(&projects) {
        if let Next::Repair(repair) = &row.next
            && repair.runnable()
            && !repairs.iter().any(|r: &Repair| r.target == repair.target)
        {
            repairs.push(repair.clone());
        }
    }
    repairs
}

pub fn render(app: &HackApp, ui: &Ui, window: &Window, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let busy = app.health.queue.is_some() || app.machine.busy();
    let checking = app.doctor.is_loading();
    let available = repairs(app);
    let recheck = button(
        "doctor-recheck",
        Glyph::Restart,
        if checking {
            "Checking…"
        } else {
            "Check again"
        },
        !busy && !checking,
        ui,
    )
    .w(px(128.))
    .justify_center();
    let recheck = if !busy && !checking {
        recheck.on_click(cx.listener(|this, _, _, cx| this.load_doctor(cx)))
    } else {
        recheck
    };
    let fix = if let Some(queue) = &app.health.queue {
        if queue.stopping {
            button("doctor-stop", Glyph::Close, "Stopping…", false, ui)
        } else {
            button("doctor-stop", Glyph::Close, "Stop", true, ui)
                .on_click(cx.listener(|this, _, window, cx| this.stop_health_repair(window, cx)))
        }
    } else if crate::health_commands::AVAILABLE && !app.machine.busy() && !available.is_empty() {
        primary_button("doctor-fix-all", Glyph::Play, "Fix all", ui)
            .h(px(28.))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.start_health_repairs(available.clone(), true, window, cx);
            }))
    } else {
        button("doctor-fix-all", Glyph::Play, "Fix all", false, ui)
    }
    .w(px(128.))
    .justify_center();
    let age = app.doctor.age_label(Instant::now());
    let header = div()
        .flex()
        .items_center()
        .gap(space::S4)
        .child(div().type_step(text::TITLE).child("Doctor"))
        .children(age.map(|age| {
            let summary = if let Some(queue) = &app.health.queue {
                format!(
                    "Fixing {} in order · {} done",
                    queue.repairs.len(),
                    queue.index
                )
            } else if let DoctorState::Loaded(view) = &app.doctor.result {
                let (machine, projects) = rows(app, view);
                let issues = machine
                    .iter()
                    .chain(&projects)
                    .filter(|row| matches!(row.mark, Mark::Warning | Mark::Error | Mark::Skipped))
                    .count();
                match issues {
                    0 => age,
                    1 => format!("{age} · 1 thing to fix"),
                    _ => format!("{age} · {issues} things to fix"),
                }
            } else {
                age
            };
            div()
                .min_w_0()
                .truncate()
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(summary)
        }))
        .child(div().flex_1())
        .child(recheck)
        .child(fix);
    let body = match &app.doctor.result {
        DoctorState::NeverRun => empty_pane(
            if checking {
                Glyph::Loader
            } else {
                Glyph::Stethoscope
            },
            if checking {
                "Checking your setup…"
            } else {
                "Doctor has not run yet"
            },
            "Checks the machine and each project.",
            None,
            ui,
        )
        .into_any_element(),
        DoctorState::Error(why) => {
            empty_pane(Glyph::CircleAlert, "Couldn’t check", why.clone(), None, ui)
                .into_any_element()
        }
        DoctorState::Loaded(view) => groups(app, view, ui, window, cx),
    };
    div()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .flex()
        .flex_col()
        .p(space::S7)
        .gap(space::S6)
        .child(header)
        .children(app.health.recent_failure.as_ref().map(|message| {
            div()
                .type_step(text::SMALL)
                .text_color(p.states.failed.fg)
                .child(message.clone())
        }))
        .when(app.doctor.stale, |pane| {
            pane.child(
                div()
                    .type_step(text::SMALL)
                    .text_color(p.states.degraded.fg)
                    .child("Projects changed while checking. Check again for current results."),
            )
        })
        .child(body)
        .into_any_element()
}

pub(crate) fn native_pool_card(
    report: hack_desktop_core::models::NativePoolReport,
    ui: &Ui,
) -> gpui_kit::Div {
    use hack_desktop_core::models::NativePoolState;
    use hack_desktop_ui::{components::dot, status::Status};
    let (status, label) = match report.state {
        NativePoolState::Idle => (Status::Degraded, "Running · idle"),
        NativePoolState::InUse => (Status::Running, "Running · in use"),
        NativePoolState::Stopped => (Status::Stopped, "Stopped"),
        NativePoolState::Unknown => (Status::Unknown, "Status unknown"),
    };
    let p = ui.p;
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .child(div().type_step(text::BODY_STRONG).child("Native VM pool"))
                .child(dot(status, ui))
                .child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(label),
                ),
        )
        .children(report.graph_runs.map(|count| {
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(format!("Recorded project graphs · {count}"))
        }))
        .children(report.memory_bytes.map(|bytes| {
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(format!(
                    "Provider memory · {}",
                    hack_desktop_core::usage::bytes(bytes)
                ))
        }))
        .children(report.guest_memory_mib.map(|mib| {
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(format!("Guest memory · {mib} MiB"))
        }))
}

fn groups(
    app: &HackApp,
    view: &DoctorView,
    ui: &Ui,
    window: &Window,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let (machine, projects) = rows(app, view);
    let p = ui.p;
    let busy = app.health.queue.is_some()
        || app.machine.busy()
        || app.doctor.is_loading()
        || app.doctor.stale;
    let mut body = div()
        .id("doctor-checks")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(space::S6);
    if let Some(project) = &app.doctor.filter {
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::SMALL)
                .child(format!("Showing findings for {project}"))
                .child(
                    button("doctor-show-all", Glyph::Stethoscope, "Show all", true, ui)
                        .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx))),
                ),
        );
    }
    if !busy
        && machine
            .iter()
            .chain(&projects)
            .any(|row| row.repair().is_some_and(Repair::runnable))
    {
        body = body.child(
            div().type_step(text::SMALL).text_color(p.text_muted)
                .child("Fix all runs one repair at a time in the terminal. Some commands may ask for your password."),
        );
    }
    if let Some(coverage) = view.coverage_line() {
        body = body.child(
            div()
                .type_step(text::SMALL)
                .text_color(p.states.degraded.fg)
                .child(coverage),
        );
    }
    if let Some(report) = view.native_pool.filter(|_| app.doctor.filter.is_none()) {
        body = body.child(native_pool_card(report, ui));
    }
    for (title, rows) in [("Machine", &machine), ("Projects", &projects)] {
        if rows.is_empty() {
            continue;
        }
        body =
            body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S3)
                    .child(
                        div()
                            .type_step(text::SMALL_STRONG)
                            .text_color(p.text_muted)
                            .child(title),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .rounded(radius::PANEL)
                            .hairline(p.border)
                            .children(rows.iter().enumerate().map(|(i, row)| {
                                render_row(app, row, i != 0, busy, ui, window, cx)
                            })),
                    ),
            );
    }
    for (who, why) in &view.failed_runs {
        let id = format!("doctor-failed-{who}");
        let open = app.health.details_open.as_ref() == Some(&id);
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(space::S2)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .type_step(text::SMALL)
                        .text_color(p.states.degraded.fg)
                        .child(format!("Couldn’t check {who}"))
                        .child(details(id, false, ui, cx)),
                )
                .children(open.then(|| {
                    div()
                        .type_step(text::SMALL)
                        .text_color(p.text_muted)
                        .child(why.clone())
                })),
        );
    }
    body = body.child(
        div()
            .id("doctor-passed")
            .flex()
            .items_center()
            .gap(space::S2)
            .cursor_pointer()
            .type_step(text::SMALL)
            .text_color(p.text_primary)
            .child(if app.health.passed_open { "⌄" } else { "›" })
            .child(format!("{} checks passed", view.passed))
            .on_click(cx.listener(|this, _, _, cx| {
                this.health.passed_open = !this.health.passed_open;
                cx.notify();
            })),
    );
    if app.health.passed_open {
        body = body.children(
            view.passed_checks
                .iter()
                .filter(|(_, who)| {
                    app.doctor
                        .filter
                        .as_ref()
                        .is_none_or(|name| Some(name) == who.as_ref())
                })
                .map(|(id, who)| {
                    div()
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .pl(space::S4)
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(Mark::Passed.icon(ui))
                        .child(
                            who.as_ref()
                                .map_or_else(|| id.clone(), |name| format!("{name} · {id}")),
                        )
                }),
        );
    }
    body.child(
        button(
            "doctor-setup",
            Glyph::Stethoscope,
            "Run setup again",
            true,
            ui,
        )
        .self_start()
        .on_click(cx.listener(|this, _, _, cx| this.open_setup(cx))),
    )
    .into_any_element()
}

fn render_row(
    app: &HackApp,
    row: &Row,
    border: bool,
    busy: bool,
    ui: &Ui,
    window: &Window,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let p = ui.p;
    let progress = app.health.queue.as_ref().and_then(|queue| {
        let index = queue.repairs.iter().position(|repair| {
            row.repair().is_some_and(|r| r.target == repair.target)
                || matches!(&repair.target, RepairTarget::Setup(id) if id == &row.id)
        })?;
        Some(if index < queue.index {
            (Mark::Passed, String::from("Fixed just now"))
        } else if index == queue.index {
            let verb = if queue.checking {
                "Checking"
            } else {
                "Running"
            };
            (
                Mark::Running,
                format!("{verb} · {} of {}", index + 1, queue.repairs.len()),
            )
        } else {
            (
                Mark::Unknown,
                format!("Queued · {} of {}", index + 1, queue.repairs.len()),
            )
        })
    });
    let mark = progress.as_ref().map_or(row.mark, |(mark, _)| *mark);
    let recently_confirmed = row.mark == Mark::Passed
        && app
            .health
            .confirmed
            .iter()
            .any(|target| matches!(target, RepairTarget::Setup(id) if id == &row.id));
    let summary = if recently_confirmed || matches!(progress, Some((Mark::Passed, _))) {
        format!("{} · fixed just now", row.summary)
    } else if row
        .repair()
        .is_some_and(|repair| app.health_waiting_for_password(&repair.control.id))
    {
        if cfg!(target_os = "macos") {
            "Type your Mac password in the terminal".into()
        } else {
            "Type your password in the terminal".into()
        }
    } else {
        row.summary.clone()
    };
    let action = match progress {
        Some((Mark::Passed, _)) => div().into_any_element(),
        Some((_, label)) => div()
            .flex_none()
            .type_step(text::SMALL)
            .text_color(p.text_muted)
            .child(label)
            .into_any_element(),
        None => row_action(app, row, busy, ui, window, cx),
    };
    div()
        .flex()
        .flex_col()
        .when(border, |d| d.hairline_t(p.border))
        .child(
            div()
                .min_h(px(46.))
                .px(space::S5)
                .py(space::S2)
                .flex()
                .items_center()
                .gap(space::S5)
                .child(mark.icon(ui))
                .child(
                    div()
                        .w(px(165.))
                        .min_w_0()
                        .truncate()
                        .type_step(text::BODY_STRONG)
                        .child(row.title.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(summary),
                )
                .child(action),
        )
        .children(
            row.details
                .as_ref()
                .filter(|_| app.health.details_open.as_ref() == Some(&row.id))
                .map(|detail| {
                    div()
                        .px(space::S6)
                        .pb(space::S4)
                        .type_step(text::SMALL)
                        .text_color(p.text_muted)
                        .child(detail.clone())
                }),
        )
        .into_any_element()
}

fn row_action(
    app: &HackApp,
    row: &Row,
    busy: bool,
    ui: &Ui,
    window: &Window,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let id = row.id.clone();
    let action = match &row.next {
        Next::Repair(repair) | Next::SingleRepair(repair) => crate::health_commands::render(
            app,
            repair.control.clone(),
            Some(repair.clone()),
            busy,
            ui,
            window,
            cx,
        ),
        Next::Command(command) => {
            crate::health_commands::render(app, command.clone(), None, busy, ui, window, cx)
        }
        Next::Doc(url) => {
            let url = url.clone();
            button(
                format!("doctor-doc-{id}"),
                Glyph::ExternalLink,
                "Open guide",
                true,
                ui,
            )
            .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url)))
            .into_any_element()
        }
        Next::Recheck if !busy => button(
            format!("doctor-check-{id}"),
            Glyph::Restart,
            "Check again",
            true,
            ui,
        )
        .on_click(cx.listener(|this, _, _, cx| this.load_doctor(cx)))
        .into_any_element(),
        Next::Review | Next::ReviewRelease => {
            let review_findings = matches!(&row.next, Next::Review);
            button(
                format!("doctor-review-{id}"),
                Glyph::Upgrade,
                "Review",
                true,
                ui,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open_upgrade(cx);
                if review_findings {
                    this.review_upgrade(cx);
                }
            }))
            .into_any_element()
        }
        Next::Recheck | Next::None => div().into_any_element(),
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(space::S2)
        .children(
            row.details
                .as_ref()
                .map(|_| details(id, row.repair().is_some(), ui, cx)),
        )
        .child(action)
        .into_any_element()
}

fn details(id: String, alongside_repair: bool, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let details = button(
        format!("doctor-details-{id}"),
        Glyph::ChevronDown,
        "Details",
        true,
        ui,
    );
    let details = if alongside_repair {
        details
            .w(px(64.))
            .h(px(24.))
            .px(px(2.))
            .gap(px(3.))
            .justify_center()
    } else {
        details
    };
    details
        .on_click(cx.listener(move |this, _, _, cx| {
            this.health.details_open = if this.health.details_open.as_ref() == Some(&id) {
                None
            } else {
                Some(id.clone())
            };
            cx.notify();
        }))
        .into_any_element()
}

fn button(
    id: impl Into<gpui_kit::ElementId>,
    glyph: Glyph,
    label: &'static str,
    enabled: bool,
    ui: &Ui,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    action_button(id, glyph, label, enabled, ui)
        .h(px(28.))
        .flex_none()
}
