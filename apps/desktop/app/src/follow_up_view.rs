//! One follow-up banner at the top of the current project.

use std::path::PathBuf;

use gpui_kit::{AnyElement, Context, IntoElement, ParentElement, Styled, div, prelude::*, px};
use hack_desktop_core::{
    setup::Status,
    source::{DaemonRecovery, UpdateSide},
    terminal::{CommandAvailability, CommandControl},
    viewmodel::{Banner, ListView},
};
use hack_desktop_ui::{
    components::{StyledExt as _, Ui, action_button, icon_button},
    icons::Glyph,
    tokens::{radius, space, text},
};

use crate::{
    doctor_view::Mark,
    health_model::{FollowUpKind as Kind, Repair, RepairTarget, machine_repair, setup_card},
    view::HackApp,
};

#[derive(Clone)]
pub enum Action {
    Run(Repair),
    Copy(CommandControl),
    Switch(Option<PathBuf>),
    Setup,
    Review,
    Doctor,
    Show,
    Guide(String),
    None,
}

#[derive(Clone)]
pub struct Notice {
    pub(crate) kind: Kind,
    pub(crate) mark: Mark,
    pub(crate) title: String,
    pub(crate) summary: String,
    pub(crate) command: Option<String>,
    pub(crate) action: Action,
    pub(crate) evidence: String,
}

impl Notice {
    pub fn new(
        kind: Kind,
        mark: Mark,
        title: &str,
        summary: impl Into<String>,
        action: Action,
    ) -> Self {
        let summary = summary.into();
        let command = match &action {
            Action::Run(repair) => Some(repair.control.label.clone()),
            Action::Copy(command) => Some(command.label.clone()),
            _ => None,
        };
        let evidence = format!("{title} · {summary}");
        Self {
            kind,
            mark,
            title: title.into(),
            summary,
            command,
            action,
            evidence,
        }
    }
}

fn active_routing_repair(app: &HackApp) -> Option<&Repair> {
    let queue = app.health.queue.as_ref()?;
    matches!(&queue.current().target, RepairTarget::Setup(id) if id == "routing")
        .then(|| queue.current())
}

pub fn observed(app: &HackApp, list: &ListView) -> Vec<Notice> {
    let report = app.health_report();
    let mut notices = Vec::new();
    if list.banners.contains(&Banner::DaemonOff) {
        let repair = setup_card(report, "daemon")
            .and_then(|card| machine_repair(card, report))
            .filter(|repair| repair.control.label == "hack daemon start" && repair.runnable());
        notices.push(Notice::new(
            Kind::DaemonDown,
            Mark::Error,
            "Hack service isn’t running",
            "Projects and URLs won’t update.",
            repair.map_or(Action::Doctor, Action::Run),
        ));
    }
    if let Some(versions) = &app.health.signals.wrong_cli {
        let mut notice = Notice::new(
            Kind::WrongCli,
            Mark::Warning,
            "Switch to Hack 5",
            format!(
                "Hack {} is selected. {} is installed.",
                versions.current, versions.replacement
            ),
            Action::Switch(versions.path.clone()),
        );
        notice.evidence = format!(
            "{} · {} · {:?}",
            versions.current, versions.replacement, versions.path
        );
        notices.push(notice);
    }
    if let Some(card) = setup_card(report, "routing")
        && let Some(repair) = machine_repair(card, report)
    {
        let mut notice = if let Some(active) = active_routing_repair(app) {
            let mut notice = Notice::new(
                Kind::Routing,
                Mark::Running,
                "Fixing local domains",
                "Running in the terminal below.",
                Action::Show,
            );
            notice.command = Some(active.control.label.clone());
            notice
        } else if app.health.signals.routing_permission_denied {
            let mut command = repair.control;
            if let CommandAvailability::Ready(spec) = command.availability {
                command.availability = CommandAvailability::CopyOnly(spec);
            }
            Notice::new(
                Kind::Permission,
                Mark::Warning,
                "Local domains need an admin",
                "This account can’t run sudo.",
                Action::Copy(command),
            )
        } else {
            let action = if repair.runnable() {
                Action::Run(repair)
            } else {
                Action::Doctor
            };
            Notice::new(
                Kind::Routing,
                Mark::Warning,
                "Local domains partly working",
                "Some project URLs may not open.",
                action,
            )
        };
        notice.evidence = if notice.mark == Mark::Running {
            format!("Running · {}", card.detail)
        } else {
            card.detail.clone()
        };
        notices.push(notice);
    }
    if app.setup.checked_at.is_some()
        && report.cli_ready()
        && report.cards.iter().any(|card| {
            card.status == Status::NeedsAttention && app.setup.skipped.contains(&card.id)
        })
    {
        let mut notice = Notice::new(
            Kind::Setup,
            Mark::Unknown,
            "Setup isn’t finished",
            "Some checks were skipped during setup.",
            Action::Setup,
        );
        notice.evidence = report
            .cards
            .iter()
            .filter(|card| {
                card.status == Status::NeedsAttention && app.setup.skipped.contains(&card.id)
            })
            .map(|card| card.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        notices.push(notice);
    }
    if let Some(version) = &app.health.signals.update {
        notices.push(Notice::new(
            Kind::Update,
            Mark::Unknown,
            &format!("Hack {version} is available"),
            "Review the update before applying it.",
            Action::Review,
        ));
    }
    if app.health.signals.offline {
        notices.push(Notice::new(
            Kind::Offline,
            Mark::Unknown,
            "Update checks are offline",
            "Local projects still work. Update checks resume when the service is reachable.",
            Action::None,
        ));
    }
    if let Some(notice) = diagnostic(app, list) {
        notices.push(notice);
    }
    notices.sort_by_key(|notice| notice.kind);
    notices
}

fn diagnostic(app: &HackApp, list: &ListView) -> Option<Notice> {
    if let Some(error) = app.recovery_error() {
        return Some(Notice::new(
            Kind::CouldNotCheck,
            Mark::Error,
            "Couldn’t recover the Hack service",
            error,
            Action::Doctor,
        ));
    }
    list.banners.iter().find_map(|banner| match banner {
        Banner::DaemonMismatch {
            daemon,
            cli,
            update,
        } => {
            let report = app.health_report();
            let action = match update {
                UpdateSide::Cli => Action::Review,
                UpdateSide::Daemon
                    if app.model.daemon_recovery() == Some(DaemonRecovery::Restart) =>
                {
                    setup_card(report, "daemon")
                        .and_then(|card| machine_repair(card, report))
                        .filter(|repair| {
                            repair.runnable() && repair.control.label == "hack daemon restart"
                        })
                        .map_or(Action::Doctor, Action::Run)
                }
                _ => Action::Doctor,
            };
            Some(Notice::new(
                Kind::DaemonMismatch,
                Mark::Warning,
                "Hack versions don’t match",
                format!("hackd {daemon} and CLI {cli} can’t work together."),
                action,
            ))
        }
        Banner::SharedHome { message } => Some(Notice::new(
            Kind::DaemonMismatch,
            Mark::Warning,
            "Another install owns the Hack service",
            message,
            Action::Guide(hack_desktop_core::setup::SHARED_HOME_DOC.into()),
        )),
        Banner::EngineDown { error } => {
            let mut notice = Notice::new(
                Kind::Docker,
                Mark::Warning,
                "Couldn’t connect to Docker",
                "Compose projects need Docker to be running.",
                Action::Doctor,
            );
            notice.evidence = error.clone();
            Some(notice)
        }
        Banner::DaemonReadFailed { error } | Banner::Stale { error }
            if !list.banners.contains(&Banner::DaemonOff) =>
        {
            let mut notice = Notice::new(
                Kind::CouldNotCheck,
                Mark::Unknown,
                "Couldn’t check projects",
                "Check again for the latest project status.",
                Action::Doctor,
            );
            notice.evidence = error.clone();
            Some(notice)
        }
        _ => None,
    })
}

pub fn render(
    app: &mut HackApp,
    list: &ListView,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<AnyElement> {
    let notices = app
        .health
        .fixture
        .as_ref()
        .and_then(|f| f.banner.clone())
        .map_or_else(|| observed(app, list), |notice| vec![notice]);
    let present: Vec<_> = notices
        .iter()
        .map(|notice| (notice.kind, notice.evidence.clone()))
        .collect();
    app.health.follow_ups.retain(&present);
    let notice = notices
        .iter()
        .find(|notice| app.health.follow_ups.visible(notice.kind, &notice.evidence))?;
    Some(
        div()
            .pt(space::S6)
            .px(space::S7)
            .child(banner(
                notice,
                app.machine.busy() || app.health.queue.is_some(),
                ui,
                cx,
            ))
            .into_any_element(),
    )
}

pub fn banner(notice: &Notice, busy: bool, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let kind = notice.kind;
    let evidence = notice.evidence.clone();
    div()
        .min_h(px(44.))
        .px(space::S6)
        .py(space::S2)
        .flex()
        .items_center()
        .gap(space::S5)
        .rounded(radius::PANEL)
        .hairline(p.border_strong)
        .child(notice.mark.icon(ui))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(space::S4)
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .child(notice.title.clone()),
                )
                .child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(notice.summary.clone()),
                )
                .children(notice.command.as_ref().map(|cmd| {
                    div()
                        .font_family(ui.mono.clone())
                        .type_step(text::MONO)
                        .text_color(p.text_secondary)
                        .child(cmd.clone())
                })),
        )
        .children(button(kind, &notice.action, busy, ui, cx))
        .child(
            icon_button(format!("dismiss-banner-{kind:?}"), Glyph::Close, ui)
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new("Dismiss banner").build(window, cx)
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.health.follow_ups.dismiss(kind, evidence.clone());
                    cx.notify();
                })),
        )
        .into_any_element()
}

fn button(
    kind: Kind,
    action: &Action,
    busy: bool,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<AnyElement> {
    let (glyph, label, enabled) = match action {
        Action::Run(_) => (
            Glyph::Play,
            if kind == Kind::Routing {
                "Run fix"
            } else {
                "Run"
            },
            !busy && crate::health_commands::AVAILABLE,
        ),
        Action::Copy(_) => (Glyph::Copy, "Copy", true),
        Action::Switch(_) => (Glyph::Restart, "Switch", !busy),
        Action::Setup => (Glyph::Stethoscope, "Finish setup", !busy),
        Action::Review => (Glyph::Upgrade, "Review", true),
        Action::Doctor => (Glyph::Stethoscope, "Open Doctor", true),
        Action::Show => (Glyph::Terminal, "Show", true),
        Action::Guide(_) => (Glyph::ExternalLink, "Open guide", true),
        Action::None => return None,
    };
    let action = action.clone();
    let mut button = action_button(format!("banner-action-{kind:?}"), glyph, label, enabled, ui)
        .flex_none()
        .min_w(px(96.))
        .justify_center();
    if enabled {
        button = button.on_click(cx.listener(move |this, _, window, cx| match &action {
            Action::Run(repair) => {
                this.start_health_repairs(vec![repair.clone()], false, window, cx)
            }
            Action::Copy(command) => crate::health_commands::copy(command, cx),
            Action::Switch(Some(path)) => this.use_cli(path, window, cx),
            Action::Switch(None) | Action::Setup => this.open_setup(cx),
            Action::Doctor => this.open_doctor(None, cx),
            Action::Review => {
                this.open_upgrade(cx);
                this.review_upgrade(cx);
            }
            Action::Show => this.show_health_drawer(window, cx),
            Action::Guide(url) => cx.open_url(url),
            Action::None => {}
        }));
    }
    Some(button.into_any_element())
}
