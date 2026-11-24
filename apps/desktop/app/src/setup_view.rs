//! Setup (DESIGN.md section 2), in design v1: ordered cards from fresh
//! checks, shown on a live launch when something needs attention and from
//! Doctor ("Run setup again").
//!
//! Every effect needs an explicit click. Reads never start services. The
//! only actions the app runs are the fixed daemon start and install, each
//! followed by fresh checks. Admin steps (`hack global install`, `hack
//! global trust`) run in the embedded terminal where available. Skips last for
//! this session only and never satisfy a check.

#[cfg(all(test, feature = "screenshots", hack_terminal))]
use gpui_kit::test::TestSupportExt as _;
use gpui_kit::{
    AnyElement, ClipboardItem, Context, IntoElement, ParentElement, SharedString, Styled, div,
    prelude::*, px,
};
use hack_desktop_core::machine_gate::Holder;
use hack_desktop_core::setup::{Card, Remedy, SafeAction, Status};
use hack_desktop_ui::components::{
    StyledExt as _, Ui, action_button, empty_pane, pill, primary_button,
};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::Status as DotStatus;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::doctor_view::Pane;
use crate::view::HackApp;

pub(crate) fn evidence_status(status: Status) -> (DotStatus, &'static str) {
    match status {
        Status::Passed => (DotStatus::Running, "Passed"),
        Status::NeedsAttention => (DotStatus::Degraded, "Needs attention"),
        Status::Unknown => (DotStatus::Unknown, "Unknown"),
    }
}

pub(crate) fn routing_evidence(report: &hack_desktop_core::setup::Report) -> Option<Status> {
    report
        .cards
        .iter()
        .filter(|card| card.id == "routing" || card.id.starts_with("dns:"))
        .map(|card| card.status)
        .max_by_key(|status| match status {
            Status::Passed => 0,
            Status::Unknown => 1,
            Status::NeedsAttention => 2,
        })
}

impl HackApp {
    /// Fixtures and screenshots: show setup with a canned report.
    #[cfg_attr(not(feature = "screenshots"), allow(dead_code))]
    pub(crate) fn show_setup_now(&mut self, report: hack_desktop_core::setup::Report) {
        self.pane = Pane::Setup;
        let generation = self.setup.begin();
        self.setup.finish(generation, report);
    }

    /// Show setup and check again.
    pub(crate) fn open_setup(&mut self, cx: &mut Context<Self>) {
        self.pane = Pane::Setup;
        self.load_setup(cx);
    }

    /// Fresh checks, off the UI thread. A launch check opens setup only when
    /// something needs attention and the user has not navigated since
    /// launch; losing the CLI always brings it back.
    pub(crate) fn load_setup(&mut self, cx: &mut Context<Self>) {
        if self.setup.loading {
            self.setup.refresh_again = true;
            return;
        }
        if self.setup.action_busy {
            return;
        }
        let generation = self.setup.begin();
        if !self.live {
            let report = self.source.setup();
            self.setup_checked(generation, report, cx);
            return;
        }
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let report = cx
                .background_executor()
                .spawn(async move { source.setup() })
                .await;
            let _ = this.update(cx, |this, cx| this.setup_checked(generation, report, cx));
        })
        .detach();
        cx.notify();
    }

    /// A setup check finished. The launch check opens setup only if the user
    /// has not gone anywhere since launch (see [`Self::user_navigated`]):
    /// the check can take seconds, and must never pull the window away from
    /// a project, a Doctor run or a terminal tab the user opened meanwhile.
    pub(crate) fn setup_checked(
        &mut self,
        generation: u64,
        report: hack_desktop_core::setup::Report,
        cx: &mut Context<Self>,
    ) {
        // A check the app no longer waits for (a newer one, or a CLI
        // switch) changes nothing: no report, no reopening, no auto-open.
        if !self.setup.is_current(generation) {
            return;
        }
        let needed = report.needed();
        self.setup.finish(generation, report);
        let again = std::mem::take(&mut self.setup.refresh_again);
        if again {
            self.load_setup(cx);
        } else {
            self.setup.pending_fix = false;
            #[cfg(hack_terminal)]
            if let Some((run, id)) = self.setup_command_check.take() {
                let result = self
                    .setup
                    .report
                    .cards
                    .iter()
                    .find(|card| card.id == id)
                    .ok_or_else(|| "Could not confirm setup. Check again.".to_owned())
                    .and_then(|card| {
                        if card.status == Status::Passed {
                            Ok(())
                        } else {
                            Err(card.detail.clone())
                        }
                    });
                self.command_checked(run, result, cx);
            }
        }
        if std::mem::take(&mut self.setup_on_launch) && needed {
            self.pane = Pane::Setup;
        }
        if self.setup.report.force_cli_gate && !self.setup.report.cli_ready() {
            self.pane = Pane::Setup;
        }
        cx.notify();
    }

    /// The user chose where to look (an instance, a detail tab, an env
    /// overlay or scope, Doctor, the new-tab menu):
    /// the launch check no longer opens setup by itself. Losing the CLI
    /// still does.
    pub(crate) fn user_navigated(&mut self) {
        self.setup_on_launch = false;
    }

    fn skip_setup(&mut self, id: &str, cx: &mut Context<Self>) {
        self.setup.skip(id);
        cx.notify();
    }

    fn finish_setup(&mut self, cx: &mut Context<Self>) {
        if self.setup.report.cli_ready() && !self.setup.loading && !self.setup.action_busy {
            self.pane = Pane::Project;
            cx.notify();
        }
    }

    /// One of the fixed daemon actions, only while a card offers it.
    fn run_setup_action(&mut self, action: SafeAction, cx: &mut Context<Self>) {
        let offered = self
            .setup
            .report
            .cards
            .iter()
            .any(|c| c.remedy == Remedy::Run(action) && c.status != Status::Passed);
        if self.setup.action_busy
            || self.machine.busy()
            || self.setup.loading
            || !self.setup.report.cli_ready()
            || !offered
        {
            return;
        }
        if !self.live {
            self.setup.result = Some("Fixture: no action executed".into());
            cx.notify();
            return;
        }
        let Some(ticket) = self.machine.try_begin(Holder::Setup) else {
            return;
        };
        self.setup.result = None;
        self.setup.action_busy = true;
        let epoch = self.setup.source_epoch();
        let source = self.source.clone();
        let checked = self.setup.report.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.setup_action(action, &checked) })
                .await;
            let _ = this.update(cx, |this, cx| {
                // Started under a CLI the app has since switched away from.
                if this.setup.source_epoch() != epoch {
                    return;
                }
                this.machine.finish(ticket);
                this.setup.action_busy = false;
                this.setup.result = Some(result);
                this.setup.pending_fix = true;
                this.load_setup(cx);
            });
        })
        .detach();
        cx.notify();
    }

    /// Hand an admin step to the user's terminal: it shows the command and
    /// waits for Enter. Launching proves nothing; checks run again after.
    #[cfg(any(not(hack_terminal), all(test, feature = "screenshots")))]
    fn open_setup_terminal(&mut self, args: Vec<String>, cx: &mut Context<Self>) {
        use hack_desktop_core::terminal::{Platform, Script, SystemLauncher, linux_adapter};
        let offered = self
            .setup
            .report
            .cards
            .iter()
            .any(|c| c.remedy == Remedy::Admin(args.clone()));
        if self.setup.action_busy
            || self.machine.busy()
            || self.setup.loading
            || !self.setup.report.cli_ready()
            || !offered
        {
            return;
        }
        if !self.live {
            self.setup.result = Some("Fixture: no terminal opened".into());
            cx.notify();
            return;
        }
        let command = self.setup.report.command(args);
        // Not admitted through the machine gate: the app only opens the
        // terminal; the command runs there, under the user's control, for as
        // long as they take, and the app cannot see it finish. It does wait
        // for a machine action the app runs itself (checked above), and
        // checks again when the user comes back.
        self.setup.result = None;
        self.setup.action_busy = true;
        let epoch = self.setup.source_epoch();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let spec = command?;
                    let adapter = linux_adapter();
                    if !cfg!(target_os = "macos") && adapter.is_none() {
                        return Err("No terminal adapter (xdg-terminal-exec); use Copy command".into());
                    }
                    let platform = if cfg!(target_os = "macos") {
                        Platform::Mac
                    } else {
                        Platform::Linux
                    };
                    Script::create(&std::env::temp_dir(), &spec)?.open(
                        platform,
                        adapter.as_deref(),
                        &SystemLauncher,
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.setup.source_epoch() != epoch {
                    return;
                }
                this.setup.action_busy = false;
                this.setup.pending_fix = result.is_ok();
                this.setup.result = Some(match result {
                    Ok(()) => "Opened in your terminal. Press Enter there, then Check again: opening it does not prove setup.".into(),
                    Err(e) => e,
                });
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

/// `machine_busy`: another machine action (Start / Restart hackd from the
/// project pane) holds the shared gate, so this pane's actions wait too.
pub fn render(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let pane = &app.setup;
    let busy = pane.loading || pane.action_busy || app.machine.busy();
    let mut recheck = action_button(
        "setup-recheck",
        Glyph::Restart,
        if pane.loading {
            "Checking…"
        } else {
            "Check again"
        },
        !busy,
        ui,
    );
    if !busy {
        recheck = recheck.on_click(cx.listener(|this, _, _, cx| this.load_setup(cx)));
    }
    let ready = pane.report.cli_ready() && !busy;
    let mut done = if ready {
        primary_button("setup-continue", Glyph::Check, "Continue", ui)
    } else {
        action_button("setup-continue", Glyph::Check, "Continue", false, ui)
    };
    if ready {
        done = done.on_click(cx.listener(|this, _, _, cx| this.finish_setup(cx)));
    }
    let header = div()
        .px(space::S8)
        .pt(space::S7)
        .pb(space::S5)
        .flex()
        .items_center()
        .gap(space::S4)
        .hairline_b(p.border)
        .child(
            div()
                .type_step(text::TITLE)
                .text_color(p.text_primary)
                .child("Set up Hack"),
        )
        .child(div().flex_1())
        .child(recheck)
        .child(done);
    let body: AnyElement = if pane.report.cards.is_empty() {
        empty_pane(
            if pane.loading {
                Glyph::Loader
            } else {
                Glyph::Stethoscope
            },
            if pane.loading {
                "Checking setup…"
            } else {
                "Setup has not been checked"
            },
            "Checks only read; they never start a service.",
            None,
            ui,
        )
        .into_any_element()
    } else {
        let mut col = div()
            .id("setup-cards")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .px(space::S8)
            .py(space::S6)
            .gap(space::S5)
            .child(
                div()
                    .type_step(text::BODY)
                    .text_color(p.text_secondary)
                    .child(if cfg!(hack_terminal) {
                        "Checks only read. Commands run in the terminal when you press Run."
                    } else {
                        "Checks only read. Admin steps open in your terminal and wait for Enter."
                    }),
            );
        if let Some(result) = &pane.result {
            col = col.child(
                div()
                    .p(space::S5)
                    .rounded(radius::PANEL)
                    .hairline(p.border)
                    .bg(p.surface_1)
                    .type_step(text::BODY)
                    .text_color(p.text_primary)
                    .child(result.clone()),
            );
        }
        for (i, c) in pane.report.cards.iter().enumerate() {
            col = col.child(card(i, c, app, busy, ui, cx));
        }
        col.into_any_element()
    };
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(header)
        .child(body)
        .into_any_element()
}

/// The `hack …` part of a bound command, for display: a bound command is
/// `'/usr/bin/env' '-i' 'KEY=value'… '/path/to/hack' 'arg'…` (each argument
/// quoted); the full one is what Copy and the terminal get. Anything else
/// is shown as it is.
fn short_command(bound: &str) -> String {
    let Some(inner) = bound.strip_prefix('\'').and_then(|b| b.strip_suffix('\'')) else {
        return bound.to_owned();
    };
    let tokens: Vec<&str> = inner.split("' '").collect();
    if tokens.first() != Some(&"/usr/bin/env") || tokens.iter().any(|t| t.contains('\'')) {
        return bound.to_owned();
    }
    let program = tokens
        .iter()
        .skip(1)
        .position(|t| *t != "-i" && !t.contains('='))
        .map(|i| i + 1);
    match program {
        Some(i) => std::iter::once("hack")
            .chain(tokens[i + 1..].iter().copied())
            .collect::<Vec<_>>()
            .join(" "),
        None => bound.to_owned(),
    }
}

#[cfg(hack_terminal)]
fn setup_command(
    card: &Card,
    mut args: Vec<String>,
    expects_password: bool,
    busy: bool,
    app: &HackApp,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    use hack_desktop_core::terminal::{
        CommandAvailability, CommandControl, CommandControlSize, CommandExit,
    };
    let id = card.id.clone();
    let label = format!("hack {}", args.join(" "));
    if matches!(card.remedy, Remedy::Run(_)) {
        // Preserve the old safe action's non-interactive CLI mode.
        args.push("--no-interactive".into());
    }
    let props = CommandControl {
        id: format!("setup:{id}"),
        label,
        title: "Terminal".into(),
        availability: match app.setup.report.command(args) {
            Ok(spec) => CommandAvailability::Ready(spec),
            Err(reason) => CommandAvailability::Blocked(reason),
        },
        size: CommandControlSize::Standard,
        cwd: None,
        expects_password,
    };
    crate::command_control::render(props, busy, app, ui, cx, move |app, completion, cx| {
        if completion.exit == CommandExit::Code(0) {
            app.setup_command_check = Some((completion.run, id.clone()));
        }
        app.load_setup(cx);
    })
}

fn card(
    i: usize,
    c: &Card,
    app: &HackApp,
    busy: bool,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let pane = &app.setup;
    let p = ui.p;
    let skipped = pane.skipped.contains(&c.id);
    let (status, label) = if skipped {
        (DotStatus::Unknown, "Skipped for now")
    } else {
        evidence_status(c.status)
    };
    let colors = status.colors(&p);
    let cli = pane.report.cli_ready();
    let mut actions = div().flex().items_center().gap(space::S3);
    let mut command_line: Option<String> = None;
    #[cfg(hack_terminal)]
    if c.status == Status::Passed {
        actions = actions.children(crate::command_control::render_history(
            &format!("setup:{}", c.id),
            app,
            ui,
            cx,
        ));
    }
    if c.status != Status::Passed {
        match &c.remedy {
            Remedy::Copy(cmd) => {
                command_line = Some(short_command(cmd));
                let cmd = cmd.clone();
                actions =
                    actions.child(
                        action_button(("setup-copy", i), Glyph::Copy, "Copy command", cli, ui)
                            .when(cli, |b| {
                                b.on_click(move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                                })
                            }),
                    );
            }
            Remedy::Doc(url) => {
                let url = url.clone();
                actions = actions.child(
                    action_button(("setup-doc", i), Glyph::ExternalLink, "Open doc", true, ui)
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                );
            }
            Remedy::Run(action) => {
                let action = *action;
                #[cfg(hack_terminal)]
                let embedded = (action == SafeAction::StartDaemon).then(|| {
                    let args = action.args().iter().map(|arg| (*arg).into()).collect();
                    setup_command(c, args, false, busy, app, ui, cx)
                });
                #[cfg(not(hack_terminal))]
                let embedded: Option<AnyElement> = None;
                if let Some(control) = embedded {
                    actions = actions.child(div().flex_1().min_w_0().child(control));
                } else {
                    let label = match action {
                        SafeAction::StartDaemon => "Start hackd",
                        SafeAction::InstallDaemon => "Install hackd",
                    };
                    let enabled = cli && !busy;
                    actions = actions.child(
                        action_button(("setup-run", i), Glyph::Play, label, enabled, ui).when(
                            enabled,
                            |b| {
                                b.on_click(cx.listener(move |this, _, _, cx| {
                                    this.run_setup_action(action, cx)
                                }))
                            },
                        ),
                    );
                }
            }
            #[cfg(not(hack_terminal))]
            Remedy::Admin(args) => {
                let bound = pane.report.command(args.clone()).and_then(|c| c.display());
                let available = cli && bound.is_ok();
                // Shown short; Copy and the terminal get the bound command,
                // which pins the checked CLI and its non-secret context.
                command_line = Some(format!("hack {}", args.join(" ")));
                let copy = bound.unwrap_or_default();
                actions = actions.child(
                    action_button(
                        ("setup-copy", i),
                        Glyph::Copy,
                        "Copy command",
                        available,
                        ui,
                    )
                    .when(available, |b| {
                        b.on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                        })
                    }),
                );
                let enabled = available && !busy;
                let args = args.clone();
                actions = actions.child(
                    action_button(
                        ("setup-terminal", i),
                        Glyph::Terminal,
                        "Open in terminal",
                        enabled,
                        ui,
                    )
                    .when(enabled, |b| {
                        b.on_click(cx.listener(move |this, _, _, cx| {
                            this.open_setup_terminal(args.clone(), cx)
                        }))
                    }),
                );
            }
            #[cfg(hack_terminal)]
            Remedy::Admin(args) => {
                actions = actions.child(div().flex_1().min_w_0().child(setup_command(
                    c,
                    args.clone(),
                    true,
                    busy,
                    app,
                    ui,
                    cx,
                )));
            }
        }
        // The CLI cannot be skipped: everything else needs it.
        if c.id != "cli" && !skipped {
            let id = c.id.clone();
            let enabled = !busy;
            actions = actions.child(
                action_button(("setup-skip", i), Glyph::Close, "Skip for now", enabled, ui)
                    .when(enabled, |b| {
                        b.on_click(cx.listener(move |this, _, _, cx| this.skip_setup(&id, cx)))
                    }),
            );
        }
    }
    div()
        .id(SharedString::from(format!("setup-card-{}", c.id)))
        .flex()
        .flex_col()
        .gap(space::S3)
        .p(space::S6)
        .rounded(radius::PANEL)
        .hairline(p.border)
        .bg(p.surface)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .child(
                    div()
                        .type_step(text::SMALL_STRONG)
                        .text_color(p.text_muted)
                        .child(format!("{}", i + 1)),
                )
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .text_color(p.text_primary)
                        .child(c.title.clone()),
                )
                .child(div().flex_1())
                .child(
                    pill(label, colors.bg, colors.fg)
                        .id(("setup-status", i))
                        .role(gpui_kit::Role::Label)
                        .aria_label(label)
                        .map(|pill| {
                            #[cfg(all(test, feature = "screenshots", hack_terminal))]
                            let pill = pill.test_support();
                            pill
                        }),
                ),
        )
        .when(!c.detail.is_empty(), |d| {
            d.child(
                div()
                    .type_step(text::BODY)
                    .text_color(p.text_secondary)
                    .child(c.detail.clone()),
            )
        })
        .children(command_line.map(|cmd| {
            div()
                .px(space::S4)
                .py(px(1.))
                .rounded(radius::PILL)
                .bg(p.surface_1)
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .text_color(p.text_primary)
                .child(cmd)
        }))
        .child(actions)
        .into_any_element()
}

#[cfg(test)]
mod display_tests {
    use super::short_command;

    #[test]
    fn a_bound_command_is_shown_as_its_hack_part() {
        let bound = "'/usr/bin/env' '-i' 'HOME=/h' 'PATH=/usr/bin:/bin' 'HACK_MCP_COMMAND=/opt/x/hack' '/opt/x/hack' 'daemon' 'restart'";
        assert_eq!(short_command(bound), "hack daemon restart");
        assert_eq!(short_command("hack update"), "hack update");
        // An argument with a quote in it is shown in full, never guessed at.
        let odd = "'/usr/bin/env' '-i' 'HOME=/h' '/opt/x/hack' 'it'\\''s'";
        assert_eq!(short_command(odd), odd);
    }
}

// A headless app needs GPUI's test support (the `screenshots` feature).
#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use std::sync::Arc;

    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;

    use super::*;

    fn app() -> (HeadlessAppContext, gpui_kit::Entity<HackApp>) {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let options = WindowOptions {
            focus: false,
            show: false,
            ..WindowOptions::default()
        };
        let (_, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| {
                        HackApp::new(Arc::new(FixtureSource(Fixture::Running)), false, window, cx)
                    })
                })
            })
            .expect("open a headless window");
        (cx, app)
    }

    #[test]
    fn run_setup_again_shows_fresh_cards_and_continue_returns_to_projects() {
        let (mut cx, app) = app();
        cx.update(|cx| app.update(cx, |a, cx| a.open_setup(cx)));
        let (pane, cards, ready) = cx.update(|cx| {
            let a = app.read(cx);
            (
                a.pane,
                a.setup.report.cards.len(),
                a.setup.report.cli_ready(),
            )
        });
        assert_eq!(pane, Pane::Setup);
        assert!(cards > 0, "the checks produced cards");
        assert!(ready, "the fixture has a CLI");
        cx.update(|cx| app.update(cx, |a, cx| a.finish_setup(cx)));
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Project);
    }

    /// A launch check that finishes after the user opened something (the
    /// drive's select, Logs, host shell) leaves the window where it is.
    #[test]
    fn a_late_launch_check_never_replaces_what_the_user_opened() {
        let (mut cx, app) = app();
        let partial = hack_desktop_core::setup_fixtures::load("partial").expect("fixture");
        assert!(partial.needed(), "the fixture has something to do");
        // Launch: the check is in flight and nobody has moved yet.
        let generation = cx.update(|cx| {
            app.update(cx, |a, _| {
                a.setup_on_launch = true;
                a.setup.begin()
            })
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| a.select_project("storefront".into(), cx));
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| a.setup_checked(generation, partial.clone(), cx));
        });
        assert_eq!(
            cx.update(|cx| app.read(cx).pane),
            Pane::Project,
            "the project the user selected stays on screen"
        );
        // A detail tab the user clicks counts as well.
        let (mut cx, app) = super::tests::app();
        let generation = cx.update(|cx| {
            app.update(cx, |a, _| {
                a.setup_on_launch = true;
                a.setup.begin()
            })
        });
        cx.update(|cx| app.update(cx, |a, cx| a.set_tab(2, cx)));
        cx.update(|cx| {
            app.update(cx, |a, cx| a.setup_checked(generation, partial.clone(), cx));
        });
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Project);
        // Without any navigation, the launch check still opens setup.
        let (mut cx, app) = super::tests::app();
        let generation = cx.update(|cx| {
            app.update(cx, |a, _| {
                a.setup_on_launch = true;
                a.setup.begin()
            })
        });
        cx.update(|cx| app.update(cx, |a, cx| a.setup_checked(generation, partial, cx)));
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Setup);
    }

    /// The minute tick checks a shown Setup pane again once its result is
    /// ten minutes old, and leaves a fresh one alone.
    #[test]
    fn a_setup_pane_left_open_is_checked_again_after_ten_minutes() {
        let (mut cx, app) = app();
        cx.update(|cx| app.update(cx, |a, cx| a.open_setup(cx)));
        let first = cx
            .update(|cx| app.read(cx).setup.checked_at)
            .expect("checked");
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.window_visible = true;
                a.minute_tick(cx);
            });
        });
        assert_eq!(
            cx.update(|cx| app.read(cx).setup.checked_at),
            Some(first),
            "fresh: not checked again"
        );
        let old = first
            .checked_sub(hack_desktop_core::setup::RECHECK_EVERY)
            .expect("clock");
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.setup.checked_at = Some(old);
                a.minute_tick(cx);
            });
        });
        cx.run_until_parked();
        let after = cx
            .update(|cx| app.read(cx).setup.checked_at)
            .expect("checked");
        assert!(after > old, "checked again");
        // Not when another pane is shown.
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.finish_setup(cx);
                a.setup.checked_at = Some(old);
                a.minute_tick(cx);
            });
        });
        assert_eq!(cx.update(|cx| app.read(cx).setup.checked_at), Some(old));
    }

    #[test]
    fn setup_is_checked_again_when_the_window_regains_focus() {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let options = WindowOptions {
            focus: false,
            show: false,
            ..WindowOptions::default()
        };
        let (window, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| {
                        let mut a = HackApp::new(
                            Arc::new(FixtureSource(Fixture::Running)),
                            false,
                            window,
                            cx,
                        );
                        a.watch_window(window, cx);
                        a.show_setup_now(
                            hack_desktop_core::setup_fixtures::load("partial").expect("fixture"),
                        );
                        a
                    })
                })
            })
            .expect("open a headless window");
        let before = cx.update(|cx| app.read(cx).setup.checked_at);
        cx.update_window(window, |_, w, _| w.activate_window())
            .expect("activate");
        cx.run_until_parked();
        let after = cx.update(|cx| app.read(cx).setup.checked_at);
        assert_ne!(before, after, "focus coming back checks setup again");
    }

    #[test]
    fn a_skip_lasts_for_the_session_and_the_cli_cannot_be_skipped() {
        let (mut cx, app) = app();
        cx.update(|cx| app.update(cx, |a, cx| a.open_setup(cx)));
        let other = cx.update(|cx| {
            app.read(cx)
                .setup
                .report
                .cards
                .iter()
                .find(|c| c.id != "cli")
                .map(|c| c.id.clone())
                .expect("a card besides the CLI")
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.skip_setup("cli", cx);
                a.skip_setup(&other, cx);
            })
        });
        let skipped = cx.update(|cx| app.read(cx).setup.skipped.clone());
        assert!(!skipped.contains("cli"));
        assert!(skipped.contains(&other));
        // Checking again keeps the skip; it never satisfies the check.
        cx.update(|cx| app.update(cx, |a, cx| a.load_setup(cx)));
        assert!(cx.update(|cx| app.read(cx).setup.skipped.contains(&other)));
    }

    #[test]
    fn fixtures_never_run_an_action_or_open_a_terminal() {
        let (mut cx, app) = app();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.show_setup_now(
                    hack_desktop_core::setup_fixtures::load("partial").expect("fixture"),
                );
                a.run_setup_action(SafeAction::StartDaemon, cx);
            })
        });
        assert_eq!(
            cx.update(|cx| app.read(cx).setup.result.clone()).as_deref(),
            Some("Fixture: no action executed")
        );
        let admin = cx.update(|cx| {
            app.read(cx)
                .setup
                .report
                .cards
                .iter()
                .find_map(|c| match &c.remedy {
                    Remedy::Admin(args) => Some(args.clone()),
                    _ => None,
                })
        });
        if let Some(args) = admin {
            cx.update(|cx| app.update(cx, |a, cx| a.open_setup_terminal(args, cx)));
            assert_eq!(
                cx.update(|cx| app.read(cx).setup.result.clone()).as_deref(),
                Some("Fixture: no terminal opened")
            );
        }
    }
}

#[cfg(all(test, feature = "screenshots"))]
mod gate_tests {
    use super::*;
    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;
    use std::sync::Arc;

    #[test]
    fn a_setup_action_waits_while_hackd_is_being_recovered_from_the_project_pane() {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(gpui_kit::init);
        let options = WindowOptions {
            focus: false,
            show: false,
            ..WindowOptions::default()
        };
        let (_, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| {
                        HackApp::new(Arc::new(FixtureSource(Fixture::Running)), false, window, cx)
                    })
                })
            })
            .unwrap();
        let report = hack_desktop_core::setup_fixtures::NAMES
            .iter()
            .filter_map(|n| hack_desktop_core::setup_fixtures::load(n))
            .find(|r| {
                r.cli_ready()
                    && r.cards
                        .iter()
                        .any(|c| matches!(c.remedy, Remedy::Run(_)) && c.status != Status::Passed)
            })
            .expect("a setup fixture that offers a Run action");
        let action = report
            .cards
            .iter()
            .find_map(|c| match c.remedy {
                Remedy::Run(a) if c.status != Status::Passed => Some(a),
                _ => None,
            })
            .unwrap();
        let result = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.setup.report = report;
                let recovery = a.machine.try_begin(Holder::Recovery).unwrap();
                a.run_setup_action(action, cx);
                let refused = (a.setup.result.clone(), a.setup.action_busy);
                assert!(
                    a.machine.finish(recovery),
                    "Setup did not take or release the gate"
                );
                a.run_setup_action(action, cx);
                (refused, a.setup.result.clone())
            })
        });
        assert_eq!(
            result.0,
            (None, false),
            "refused while recovery holds the gate"
        );
        assert_eq!(
            result.1.as_deref(),
            Some("Fixture: no action executed"),
            "runs once the gate is free"
        );
    }
}
