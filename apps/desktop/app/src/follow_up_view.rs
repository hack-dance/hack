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
    components::{StyledExt as _, Ui, action_button, icon, icon_button},
    icons::Glyph,
    tokens::{radius, space, text},
};

use crate::{
    doctor_view::Mark,
    health_model::{
        CLI_UPDATE_GUIDE, FollowUpKind as Kind, Repair, RepairTarget, cli_update_repair,
        daemon_repair, machine_repair, setup_card,
    },
    view::HackApp,
};

#[derive(Clone)]
pub enum Action {
    Run(Repair),
    Recover(DaemonRecovery),
    Copy(CommandControl),
    Switch(Option<PathBuf>),
    Setup,
    ReviewRelease,
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
        let action = recovery_action(app, DaemonRecovery::Start);
        notices.push(Notice::new(
            Kind::DaemonDown,
            Mark::Error,
            "Hack service isn’t running",
            "Projects and URLs won’t update.",
            action,
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
                if crate::health_commands::AVAILABLE {
                    Action::Run(repair)
                } else {
                    Action::Copy(repair.control)
                }
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
    if let Some(release) = &app.health.signals.update {
        notices.push(Notice::new(
            Kind::Update,
            Mark::Unknown,
            &format!("Hack {} is available", release.latest),
            "Review the update before applying it.",
            Action::ReviewRelease,
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
    notices.extend(
        list.banners
            .iter()
            .filter_map(|banner| diagnostic(app, list, banner)),
    );
    if let Some(error) = app.recovery_error() {
        notices.push(Notice::new(
            Kind::CouldNotCheck,
            Mark::Error,
            "Couldn’t recover the Hack service",
            error,
            Action::Doctor,
        ));
    }
    notices.sort_by_key(|notice| notice.kind);
    notices
}

fn recovery_action(app: &HackApp, want: DaemonRecovery) -> Action {
    if app.model.daemon_recovery() != Some(want) {
        return Action::Doctor;
    }
    let repair = daemon_repair(want, app.health_report());
    if crate::health_commands::AVAILABLE && repair.runnable() {
        Action::Run(repair)
    } else {
        Action::Recover(want)
    }
}

fn diagnostic(app: &HackApp, list: &ListView, banner: &Banner) -> Option<Notice> {
    match banner {
        Banner::DaemonMismatch {
            daemon,
            cli,
            update,
        } => {
            let (summary, action) = match update {
                UpdateSide::Cli => (
                    format!(
                        "hackd {daemon} is newer than CLI {cli}. Update the CLI using its installation method."
                    ),
                    cli_update_repair(app.health_report())
                        .map_or_else(|| Action::Guide(CLI_UPDATE_GUIDE.into()), Action::Run),
                ),
                UpdateSide::Daemon => (
                    format!("hackd {daemon} and CLI {cli} can’t work together."),
                    recovery_action(app, DaemonRecovery::Restart),
                ),
            };
            Some(Notice::new(
                Kind::DaemonMismatch,
                Mark::Warning,
                "Hack versions don’t match",
                summary,
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
        Banner::DaemonUnreadable => Some(Notice::new(
            Kind::CouldNotCheck,
            Mark::Unknown,
            "Couldn’t check hackd",
            "Check again.",
            Action::None,
        )),
        Banner::DaemonReadFailed { error } | Banner::Stale { error }
            if !list
                .banners
                .iter()
                .any(|banner| matches!(banner, Banner::DaemonOff | Banner::DaemonUnreadable)) =>
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
    }
}

fn current_notices(app: &HackApp, list: &ListView) -> Vec<Notice> {
    app.health
        .fixture
        .as_ref()
        .and_then(|f| f.banner.clone())
        .map_or_else(|| observed(app, list), |notice| vec![notice])
}

pub fn reconcile(app: &mut HackApp, list: &ListView) {
    if app.health.follow_ups.has_dismissals() {
        let notices = current_notices(app, list);
        reconcile_notices(app, &notices);
    }
}

fn reconcile_notices(app: &mut HackApp, notices: &[Notice]) {
    let present: Vec<_> = notices
        .iter()
        .map(|notice| (notice.kind, notice.evidence.clone()))
        .collect();
    app.health.follow_ups.retain(&present);
}

pub fn render(
    app: &mut HackApp,
    list: &ListView,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<AnyElement> {
    let notices = current_notices(app, list);
    reconcile_notices(app, &notices);
    let notice = notices
        .iter()
        .find(|notice| app.health.follow_ups.visible(notice.kind, &notice.evidence))?;
    Some(
        div()
            .pt(space::S6)
            .px(space::S7)
            .child(banner(notice, app.health_repairs_busy(), ui, cx))
            .into_any_element(),
    )
}

pub fn banner(notice: &Notice, busy: bool, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let kind = notice.kind;
    let evidence = notice.evidence.clone();
    let status_icon = match kind {
        Kind::Update => Some(Glyph::Upgrade),
        Kind::Offline => Some(Glyph::WifiOff),
        Kind::Setup => Some(Glyph::Info),
        _ => None,
    };
    div()
        .min_h(px(44.))
        .px(space::S6)
        .py(space::S2)
        .flex()
        .items_center()
        .gap(space::S5)
        .rounded(radius::PANEL)
        .hairline(p.border_strong)
        .child(status_icon.map_or_else(
            || notice.mark.icon(ui),
            |glyph| icon(glyph, px(15.), p.text_muted).into_any_element(),
        ))
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
        .children(match &notice.action {
            Action::Run(repair) if repair.runnable() => {
                let command = repair.control.clone();
                Some(
                    action_button(
                        format!("banner-copy-{kind:?}"),
                        Glyph::Copy,
                        "Copy",
                        true,
                        ui,
                    )
                    .flex_none()
                    .on_click(
                        cx.listener(move |_, _, _, cx| crate::health_commands::copy(&command, cx)),
                    ),
                )
            }
            _ => None,
        })
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
        Action::Run(repair) => (
            Glyph::Play,
            if kind == Kind::Routing {
                "Run fix"
            } else {
                "Run"
            },
            !busy && repair.runnable() && crate::health_commands::AVAILABLE,
        ),
        Action::Recover(action) => (Glyph::Power, action.label(), !busy),
        Action::Copy(_) => (Glyph::Copy, "Copy", true),
        Action::Switch(_) => (Glyph::Restart, "Switch", !busy),
        Action::Setup => (Glyph::Stethoscope, "Finish setup", !busy),
        Action::ReviewRelease => (Glyph::Upgrade, "Review", true),
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
                let current = current_notices(this, &this.model.list());
                if current.iter().any(|notice| {
                    notice.kind == kind && matches!(&notice.action, Action::Run(offered)
                        if offered.target == repair.target && offered.control.availability == repair.control.availability)
                }) {
                    this.start_health_repairs(vec![repair.clone()], false, window, cx);
                }
            }
            Action::Recover(action) if this.model.daemon_recovery() == Some(*action) => {
                this.recover_daemon(*action, cx);
            }
            Action::Recover(_) => {}
            Action::Copy(command) => crate::health_commands::copy(command, cx),
            Action::Switch(Some(path)) => this.use_cli(path, window, cx),
            Action::Switch(None) | Action::Setup => this.open_setup(cx),
            Action::Doctor => {
                this.open_doctor(None, cx);
                this.load_doctor(cx);
            }
            Action::ReviewRelease => this.open_upgrade(cx),
            Action::Show => this.show_health_drawer(window, cx),
            Action::Guide(url) => cx.open_url(url),
            Action::None => {}
        }));
    }
    Some(button.into_any_element())
}

#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use std::sync::Arc;

    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::{fixtures::Fixture, source::FixtureSource};

    use super::*;

    #[test]
    fn a_newer_daemon_offers_an_update_even_when_release_checks_are_offline() {
        use hack_desktop_core::{source::SourceError, viewmodel::Event};

        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..WindowOptions::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        let mut app = HackApp::new(
                            Arc::new(FixtureSource(Fixture::Running)),
                            false,
                            window,
                            cx,
                        );
                        let mut setup = hack_desktop_core::setup_fixtures::load("ready").unwrap();
                        let program = "/opt/hack-dist/bin/hack".to_owned();
                        setup.cli_program = Some(program.clone());
                        app.show_setup_now(setup.clone());
                        app.model.apply(Event::Refreshed(Err(SourceError::DaemonUnavailable {
                            cli: "5.0.0".into(),
                            daemon: Some("5.1.0".into()),
                            message: "hackd is newer than the CLI".into(),
                            compatible: false,
                            shared_with: None,
                        })));
                        app.health.signals.offline = true;
                        assert!(app.health.signals.update.is_none());

                        let list = app.model.list();
                        let notices = observed(&app, &list);
                        let mismatch = notices.iter().find(|notice| notice.kind == Kind::DaemonMismatch).unwrap();
                        assert_eq!(mismatch.command.as_deref(), Some("hack update"));
                        assert!(matches!(
                            &mismatch.action,
                            Action::Run(repair) if matches!(&repair.control.availability,
                                CommandAvailability::Ready(spec) if spec.args.ends_with(&[program, "update".into()]))
                        ));

                        setup.cli_program = None;
                        app.show_setup_now(setup);
                        assert!(observed(&app, &list).iter().any(|notice|
                            notice.kind == Kind::DaemonMismatch
                                && matches!(&notice.action, Action::Guide(url) if url == CLI_UPDATE_GUIDE)
                        ));
                        app
                    })
                },
            )
            .unwrap();
        });
    }

    #[test]
    fn a_new_daemon_failure_takes_priority_and_recovers_with_a_cached_pass() {
        use hack_desktop_core::{source::SourceError, viewmodel::Event};

        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..WindowOptions::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        let mut app = HackApp::new(
                            Arc::new(FixtureSource(Fixture::Running)),
                            false,
                            window,
                            cx,
                        );
                        let mut setup = hack_desktop_core::setup_fixtures::load("ready").unwrap();
                        setup.cli_program = Some("/usr/bin/hack".into());
                        app.show_setup_now(setup);
                        assert_eq!(
                            setup_card(app.health_report(), "daemon").unwrap().status,
                            Status::Passed
                        );
                        app.health.signals.update =
                            Some(hack_desktop_core::upgrade::ReleaseUpdate {
                                latest: "5.1.0".into(),
                                upgrade_command: None,
                            });
                        app.health.signals.offline = true;
                        app.simulate_daemon_unavailable(false);

                        let list = app.model.list();
                        let notices = observed(&app, &list);
                        assert_eq!(notices[0].kind, Kind::DaemonDown);
                        assert!(matches!(
                            notices[0].action,
                            Action::Run(_) | Action::Recover(DaemonRecovery::Start)
                        ));
                        assert_eq!(notices.last().unwrap().kind, Kind::Offline);
                        assert!(notices.iter().any(|notice| notice.kind == Kind::Update
                            && matches!(notice.action, Action::ReviewRelease)));
                        let evidence = notices[0].evidence.clone();
                        app.health
                            .follow_ups
                            .dismiss(Kind::DaemonDown, evidence.clone());
                        app.pane = crate::doctor_view::Pane::Doctor;
                        app.refresh_now();
                        let list = app.model.list();
                        reconcile(&mut app, &list);
                        assert!(app.health.follow_ups.visible(Kind::DaemonDown, &evidence));

                        app.model
                            .apply(Event::Refreshed(Err(SourceError::DaemonUnreadable)));
                        let list = app.model.list();
                        assert!(
                            list.banners
                                .iter()
                                .any(|b| matches!(b, Banner::Stale { .. }))
                        );
                        let notices = observed(&app, &list);
                        let checks: Vec<_> = notices
                            .iter()
                            .filter(|notice| notice.kind == Kind::CouldNotCheck)
                            .collect();
                        assert_eq!(checks.len(), 1);
                        assert_eq!(checks[0].title, "Couldn’t check hackd");
                        assert!(matches!(checks[0].action, Action::None));
                        assert!(notices.iter().all(|notice| notice.kind != Kind::DaemonDown));
                        app
                    })
                },
            )
            .unwrap();
        });
    }
}
