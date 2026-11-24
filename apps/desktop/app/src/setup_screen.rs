//! One setup step per screen with persistent progress in the sidebar.

use gpui_kit::{
    Animation, AnimationExt, AnyElement, Context, Div, ElementId, IntoElement, ParentElement,
    SharedString, Stateful, Styled, Window, div, prelude::*, px,
};
use hack_desktop_core::setup::{Remedy, Status};
use hack_desktop_ui::components::{StyledExt as _, Ui, icon};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::setup_command;
use crate::setup_flow::{ADVANCE_DELAY, Screen, Step, StepState};
use crate::view::HackApp;

const STAGE_WIDTH: f32 = 560.;
const SIDEBAR_WIDTH: f32 = 232.;
const INSTALL_GUIDE: &str =
    "https://github.com/hack-dance/hack/blob/next/docs/versions/v5/install.md";

pub(crate) fn render(
    app: &HackApp,
    ui: &Ui,
    _window: &mut Window,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let body = match app.setup_flow.screen {
        Screen::Welcome => welcome(ui, cx),
        Screen::Step(step) => screen(app, step, ui, cx),
        Screen::Done => done(app, ui, cx),
    };
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .bg(ui.p.chrome)
        .child(sidebar(app, ui, cx))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .pr(space::S4)
                .pb(space::S4)
                .flex()
                .flex_col()
                .gap(space::S4)
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .flex_col()
                        .rounded(radius::WINDOW)
                        .hairline(ui.p.border)
                        .bg(ui.p.surface)
                        .child(body),
                )
                .map(|pane| {
                    #[cfg(hack_terminal)]
                    let pane = pane.children(app.render_command_drawer(ui, cx));
                    pane
                }),
        )
        .into_any_element()
}

impl StepState {
    fn icon(self, ui: &Ui) -> AnyElement {
        use gpui_kit::component::{Sizable as _, spinner::Spinner};
        let p = ui.p;
        if matches!(self, Self::Checking | Self::Running) {
            return Spinner::new()
                .icon(icon(Glyph::Loader, px(16.), p.text_primary))
                .with_size(px(16.))
                .color(p.text_primary)
                .into_any_element();
        }
        let (glyph, color) = match self {
            Self::Todo => (Glyph::SetupIdle, p.text_muted),
            Self::Checking | Self::Running => (Glyph::Loader, p.text_primary),
            Self::Passed => (Glyph::SetupDone, p.states.running.fg),
            Self::NeedsAction | Self::VersionMismatch => (Glyph::CircleAlert, p.states.degraded.fg),
            Self::Failed => (Glyph::SetupFailed, p.states.failed.fg),
            Self::Skipped => (Glyph::SetupSkipped, p.text_muted),
            Self::Blocked | Self::Password => (Glyph::SetupBlocked, p.text_secondary),
            Self::Unchecked => (Glyph::SetupUnchecked, p.text_muted),
        };
        icon(glyph, px(16.), color).into_any_element()
    }

    fn meta(self, step: Step) -> &'static str {
        match self {
            Self::Skipped => "Skipped",
            Self::Blocked => "Waits on 1",
            Self::VersionMismatch => "Needs Hack 5",
            Self::Failed => "Failed",
            Self::Unchecked => "Couldn’t check",
            Self::Todo | Self::NeedsAction if step == Step::Login => "Optional",
            _ => "",
        }
    }
}

fn sidebar(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> Div {
    let p = ui.p;
    let flow = &app.setup_flow;
    let count = Step::ALL
        .iter()
        .filter(|&&step| flow.state(step, &app.setup) == StepState::Passed)
        .count();
    let mut rows = div().flex().flex_col().gap(space::S2);
    for step in Step::ALL {
        let state = app.setup_step_state(step);
        let current = flow.step() == Some(step);
        let meta = progress_meta(app, step, state);
        let enabled = !current
            && !app.setup_command_running()
            && !app.setup.loading
            && flow.can_open(step, &app.setup);
        rows = rows.child(
            div()
                .id(("setup-progress", step.index()))
                .h(px(32.))
                .px(space::S4)
                .flex()
                .items_center()
                .gap(space::S4)
                .rounded(radius::PILL)
                .type_step(if current {
                    text::BODY_STRONG
                } else {
                    text::BODY
                })
                .text_color(if current {
                    p.text_primary
                } else {
                    p.text_secondary
                })
                .when(current, |d| d.bg(p.surface_2))
                .when(enabled, |d| {
                    d.cursor_pointer()
                        .hover(move |d| d.bg(p.surface_1))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.reopen_setup_step(step, cx)),
                        )
                })
                .child(div().flex_none().child(state.icon(ui)))
                .child(div().flex_1().min_w_0().truncate().child(step.name()))
                .child(
                    div()
                        .flex_none()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(meta),
                ),
        );
    }
    div()
        .w(px(SIDEBAR_WIDTH))
        .flex_none()
        .px(space::S4)
        .pb(space::S4)
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(32.))
                .px(space::S4)
                .flex()
                .items_center()
                .type_step(text::SMALL_STRONG)
                .text_color(p.text_secondary)
                .child(format!("Set up Hack · {count} of 6 done")),
        )
        .child(rows)
        .child(div().flex_1())
        .child(
            div()
                .px(space::S4)
                .pb(space::S2)
                .flex()
                .flex_col()
                .gap(space::S2)
                .child(
                    button(
                        "setup-doctor",
                        "Open Doctor",
                        Some(Glyph::Stethoscope),
                        false,
                        ui,
                    )
                    .justify_start()
                    .px(px(0.))
                    .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx))),
                )
                .child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child("Checks only read your setup. Nothing changes until you press Run."),
                ),
        )
}

fn progress_meta(app: &HackApp, step: Step, state: StepState) -> String {
    #[cfg(feature = "screenshots")]
    if app.setup_flow.step() == Some(step)
        && let Some(fixture) = app.setup_flow.fixture.as_ref()
    {
        if let Some(meta) = fixture.meta {
            return meta.into();
        }
        if let Some(count) = fixture.dns
            && state == StepState::NeedsAction
        {
            return format!("{count} of 8");
        }
    }
    let _ = app;
    state.meta(step).into()
}

fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    glyph: Option<Glyph>,
    primary: bool,
    ui: &Ui,
) -> Stateful<Div> {
    let p = ui.p;
    let color = if primary { p.surface } else { p.text_primary };
    div()
        .id(id)
        .h(px(32.))
        .px(space::S7)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(space::S4)
        .rounded(radius::PILL)
        .type_step(text::BODY_STRONG)
        .text_color(color)
        .cursor_pointer()
        .when(primary, |d| d.bg(p.text_primary))
        .hover(move |d| {
            if primary {
                d.opacity(0.88)
            } else {
                d.bg(p.surface_1)
            }
        })
        .children(glyph.map(|glyph| icon(glyph, px(14.), color)))
        .child(label.into())
}

fn stage(top: f32, body: Div, foot: Option<Div>) -> AnyElement {
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .items_center()
        .px(space::S7)
        .child(
            div()
                .id("setup-scroll")
                .flex_1()
                .min_h_0()
                .w_full()
                .max_w(px(STAGE_WIDTH))
                .overflow_y_scroll()
                .pt(px(top))
                .pb(space::S6)
                .child(body),
        )
        .children(foot.map(|footer| {
            div()
                .flex_none()
                .w_full()
                .max_w(px(STAGE_WIDTH))
                .pb(space::S7)
                .child(footer)
        }))
        .into_any_element()
}

fn title(label: &'static str, large: bool) -> Div {
    div()
        .text_size(px(if large { 26. } else { 22. }))
        .line_height(px(if large { 32. } else { 28. }))
        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
        .child(label)
}

fn explanation(label: &'static str, ui: &Ui) -> Div {
    div()
        .text_size(px(14.))
        .line_height(px(20.))
        .text_color(ui.p.text_secondary)
        .child(label)
}

fn mark(ui: &Ui) -> Div {
    div()
        .size(px(48.))
        .rounded(radius::WINDOW)
        .bg(ui.p.text_primary)
        .text_color(ui.p.surface)
        .font_family(ui.mono.clone())
        .text_size(px(20.))
        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
        .flex()
        .justify_center()
        .items_center()
        .child("h")
}

pub(super) fn not_connected(ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    div()
        .flex_1()
        .flex()
        .flex_col()
        .justify_center()
        .items_center()
        .gap(space::S4)
        .child(mark(ui))
        .child(div().type_step(text::TITLE).child("Hack isn’t connected"))
        .child(explanation("The app can’t find a Hack 5 CLI.", ui))
        .child(
            button("setup-connect", "Set up Hack", None, true, ui)
                .w(px(160.))
                .on_click(cx.listener(|this, _, _, cx| this.open_setup(cx))),
        )
        .into_any_element()
}

fn welcome(ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let mac = cfg!(target_os = "macos");
    let heading = if mac {
        "Set up Hack on this Mac"
    } else {
        "Set up Hack on this machine"
    };
    stage(96., div().flex().flex_col()
        .child(mark(ui))
        .child(div().mt(space::S9).child(title(heading, true)))
        .child(div().mt(space::S4).child(explanation(
            "Six short steps. Hack checks each one for you and only stops when something needs a fix.", ui)))
        .child(div().mt(space::S9).flex().flex_col().gap(space::S6)
            .children([
                (Glyph::Clock, "About 2 minutes"),
                (Glyph::SetupBlocked, if mac { "Two steps may ask for your Mac password" } else { "Two steps may ask for your administrator password" }),
                (Glyph::Terminal, "Commands run in the terminal, so you can see every one"),
            ].into_iter().map(|(glyph, label)| {
                div().flex().items_center().gap(space::S6).type_step(text::BODY)
                    .text_color(p.text_secondary).child(icon(glyph, px(16.), p.text_secondary)).child(label)
            })))
        .child(div().mt(px(32.)).flex().child(
            button("setup-start", "Start setup", None, true, ui).w(px(160.))
                .on_click(cx.listener(|this, _, _, cx| this.start_setup(cx))),
        )), None)
}

fn done(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let mut summary = div()
        .py(space::S2)
        .rounded(radius::PANEL)
        .hairline(p.border);
    for step in Step::ALL {
        let state = app.setup_step_state(step);
        let fact = match state {
            StepState::Passed => success_copy(step, app),
            StepState::Skipped => "Skipped · set up later in Doctor".into(),
            _ => "Check in Doctor".into(),
        };
        summary = summary.child(
            div()
                .min_h(px(32.))
                .px(space::S6)
                .py(space::S2)
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::BODY)
                .child(div().flex_none().child(state.icon(ui)))
                .child(div().flex_none().child(step.name()))
                .child(div().flex_1())
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(fact),
                ),
        );
    }
    let domains_ready = [Step::Domains, Step::Https]
        .into_iter()
        .all(|step| app.setup_flow.evidence(step, &app.setup) == StepState::Passed);
    let message = if domains_ready {
        "Use your project’s HTTPS URL to open it in the browser. Doctor keeps an eye on this setup."
    } else {
        "Open Hack to see your projects. You can finish skipped steps or check your setup in Doctor."
    };
    stage(
        64.,
        div()
            .flex()
            .flex_col()
            .child(icon(Glyph::SetupDone, px(28.), p.states.running.fg))
            .child(div().mt(space::S7).child(title("Hack is ready", true)))
            .child(div().mt(space::S4).child(explanation(message, ui)))
            .child(div().mt(space::S9).child(summary))
            .child(
                div().mt(space::S9).flex().child(
                    button("setup-done", "Open Hack", None, true, ui)
                        .w(px(160.))
                        .on_click(cx.listener(|this, _, _, cx| this.finish_setup(cx))),
                ),
            ),
        None,
    )
}

fn screen(app: &HackApp, step: Step, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let state = app.setup_step_state(step);
    let (summary, note) = status_copy(step, state, app);
    let mut body = div()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .child(
                    div()
                        .font_family(ui.mono.clone())
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(format!("Step {} of 6", step.index() + 1)),
                )
                .when(step == Step::Login, |d| {
                    d.child(
                        div()
                            .px(space::S4)
                            .rounded(radius::PILL)
                            .hairline(p.border)
                            .type_step(text::MICRO)
                            .text_color(p.text_secondary)
                            .child("Optional"),
                    )
                }),
        )
        .child(div().mt(space::S4).child(title(step.title(), false)))
        .child(div().mt(space::S4).child(explanation(step.why(), ui)))
        .child(
            div()
                .mt(space::S9)
                .flex()
                .items_start()
                .gap(space::S4)
                .child(div().pt(space::S1).flex_none().child(state.icon(ui)))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(space::S2)
                        .child(div().text_size(px(14.)).line_height(px(20.)).child(summary))
                        .children(note.map(|text| {
                            div()
                                .type_step(text::BODY)
                                .text_color(p.text_secondary)
                                .child(text)
                        })),
                ),
        );

    match state {
        StepState::Checking | StepState::Blocked => {}
        StepState::Passed => {
            #[cfg(hack_terminal)]
            if let Some(history) = crate::command_control::render_history(
                &setup_command::control_id(step),
                app,
                ui,
                cx,
            ) {
                body = body.child(div().mt(space::S7).child(history));
            }
            if app.setup_flow.advance_at.is_some() {
                let key: SharedString = format!("setup-advance-{}", step.id()).into();
                body = body.child(
                    div()
                        .mt(space::S9)
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .type_step(text::SMALL)
                        .text_color(p.text_secondary)
                        .child(
                            div()
                                .w(px(160.))
                                .h(px(4.))
                                .rounded_full()
                                .overflow_hidden()
                                .bg(p.surface_2)
                                .child(
                                    div()
                                        .h_full()
                                        .rounded_full()
                                        .bg(p.text_primary)
                                        .with_animation(
                                            key,
                                            Animation::new(ADVANCE_DELAY),
                                            |bar, progress| bar.w(px(160. * progress)),
                                        ),
                                ),
                        )
                        .child(format!(
                            "Next: {}",
                            match app.setup_flow.next_screen(step, &app.setup) {
                                Screen::Step(next) => next.title(),
                                _ => "All done",
                            }
                        )),
                );
            }
        }
        _ => {
            body = body
                .children(
                    remedy(app, step, state, ui, cx)
                        .map(|action| div().mt(space::S7).child(action)),
                )
                .children(app.setup_flow.terminal_notice.as_ref().map(|notice| {
                    div()
                        .mt(space::S4)
                        .type_step(text::BODY)
                        .text_color(p.text_secondary)
                        .child(notice.clone())
                }))
                .child(div().mt(space::S7).child(details(app, step, ui, cx)));
        }
    }
    stage(64., body, footer(app, step, state, ui, cx))
}

fn remedy(
    app: &HackApp,
    step: Step,
    state: StepState,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<AnyElement> {
    if step == Step::Cli
        && let Some((other, label)) = setup_alternate_cli(app)
    {
        return Some(
            div()
                .flex()
                .child(button("setup-switch-cli", label, None, true, ui).on_click(
                    cx.listener(move |this, _, window, cx| this.use_cli(&other.path, window, cx)),
                ))
                .into_any_element(),
        );
    }
    if inline_daemon_recheck(step, state) {
        return Some(
            div()
                .flex()
                .child(
                    button(
                        "setup-recheck",
                        "Check again",
                        Some(Glyph::Restart),
                        true,
                        ui,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.retry_setup_check(cx))),
                )
                .into_any_element(),
        );
    }
    let card = step.remedy_card(&app.setup.report)?;
    let remedy = &card.remedy;
    if let Some(command) = setup_command::render(app, step, remedy, state, ui, cx) {
        return Some(command);
    }
    let Remedy::Doc(url) = remedy else {
        return None;
    };
    let (label, url) = setup_guide(card, url, cfg!(target_os = "macos"));
    Some(
        div()
            .flex()
            .child(
                button("setup-guide", label, Some(Glyph::ExternalLink), true, ui)
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            )
            .into_any_element(),
    )
}

fn setup_alternate_cli(app: &HackApp) -> Option<(hack_desktop_core::cli_choice::Install, String)> {
    #[cfg(feature = "screenshots")]
    if let Some((install, version)) = app
        .setup_flow
        .fixture
        .as_ref()
        .and_then(|overlay| overlay.alternate_cli.as_ref())
    {
        return Some((install.clone(), format!("Use {} {version}", install.name)));
    }
    app.source
        .cli_choice()
        .and_then(|c| c.others().next().cloned())
        .map(|install| {
            let label = format!("Use {}", install.name);
            (install, label)
        })
}

fn inline_daemon_recheck(step: Step, state: StepState) -> bool {
    step == Step::Daemon && state == StepState::Unchecked
}

fn setup_guide(
    card: &hack_desktop_core::setup::Card,
    url: &str,
    macos: bool,
) -> (&'static str, String) {
    match card.id.as_str() {
        "cli" => ("Open install guide", url.into()),
        "docker" if macos => (
            "Get Docker Desktop",
            "https://docs.docker.com/desktop/setup/install/mac-install/".into(),
        ),
        "docker" => ("Open Docker guide", url.into()),
        id if id.starts_with("native:") => ("Open native runtime guide", url.into()),
        _ => ("Open guide", url.into()),
    }
}

fn footer(
    app: &HackApp,
    step: Step,
    state: StepState,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<Div> {
    let row = div().flex().gap(space::S4);
    let mut has_action = false;
    let mut row = if state == StepState::Passed {
        if app.setup_flow.advance_at.is_some() {
            has_action = true;
            row.child(
                button("setup-stay", "Stay on this step", None, false, ui)
                    .w(px(160.))
                    .on_click(cx.listener(|this, _, _, cx| this.stay_on_setup_step(cx))),
            )
        } else {
            row
        }
    } else if app.setup_flow.can_skip(step, &app.setup) {
        has_action = true;
        let label = app.setup_flow.skip_label(step, &app.setup);
        row.child(
            button("setup-skip", label, None, false, ui)
                .w(px(160.))
                .on_click(cx.listener(move |this, _, _, cx| this.skip_setup(step, cx))),
        )
    } else {
        row
    };
    if state == StepState::Blocked
        || state == StepState::Checking
        || matches!(state, StepState::Running | StepState::Password)
    {
        return None;
    }
    if inline_daemon_recheck(step, state) {
        return has_action.then_some(row);
    }
    if step == Step::Cli
        && (state == StepState::VersionMismatch
            || (state == StepState::Unchecked && setup_alternate_cli(app).is_some()))
    {
        row = row.child(
            button("setup-other-ways", "Other ways to install", None, false, ui)
                .w(px(160.))
                .on_click(|_, _, cx| cx.open_url(INSTALL_GUIDE)),
        );
    }
    let action = if state == StepState::Passed {
        button("setup-next", "Next", None, false, ui)
            .on_click(cx.listener(|this, _, _, cx| this.advance_setup(cx)))
    } else {
        let primary =
            state == StepState::Unchecked && step.remedy_card(&app.setup.report).is_none();
        button("setup-recheck", "Check again", None, primary, ui)
            .on_click(cx.listener(|this, _, _, cx| this.retry_setup_check(cx)))
    };
    Some(
        row.child(
            action
                .w(px(160.))
                .when(!has_action && state == StepState::Passed, |b| {
                    b.justify_start()
                }),
        ),
    )
}

fn details(app: &HackApp, step: Step, ui: &Ui, cx: &mut Context<HackApp>) -> Div {
    let p = ui.p;
    let opened = app.setup_flow.details_open;
    let mut container = div().flex().flex_col().gap(space::S4).child(
        div().flex().child(
            button(
                "setup-details",
                "Details",
                Some(if opened {
                    Glyph::ChevronDown
                } else {
                    Glyph::ChevronRight
                }),
                false,
                ui,
            )
            .px(px(0.))
            .h(px(28.))
            .on_click(cx.listener(|this, _, _, cx| {
                this.setup_flow.details_open = !this.setup_flow.details_open;
                cx.notify();
            })),
        ),
    );
    if opened {
        #[cfg(feature = "screenshots")]
        if let Some(count) = app
            .setup_flow
            .fixture
            .as_ref()
            .and_then(|fixture| fixture.dns)
            && step == Step::Domains
            && app.setup_flow.state(step, &app.setup) == StepState::NeedsAction
        {
            return container.child(dns_fixture_details(count, ui));
        }
        let mut rows = div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .p(space::S6)
            .rounded(radius::PANEL)
            .hairline(p.border);
        for card in step.cards(&app.setup.report) {
            let native = card.id.contains(':');
            rows = rows.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S2)
                    .when(native, |d| {
                        d.child(div().type_step(text::BODY_STRONG).child(card.title.clone()))
                    })
                    .child(
                        div()
                            .font_family(ui.mono.clone())
                            .type_step(text::MONO)
                            .text_color(p.text_secondary)
                            .child(card.detail.clone()),
                    ),
            );
            if native
                && card.status != Status::Passed
                && let Remedy::Doc(url) = &card.remedy
            {
                let url = url.clone();
                rows = rows.child(
                    div().flex().child(
                        button(
                            SharedString::from(format!("setup-native-guide-{}", card.id)),
                            "Open native setup guide",
                            Some(Glyph::ExternalLink),
                            false,
                            ui,
                        )
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                    ),
                );
            }
        }
        if let Some(result) = &app.setup.result {
            rows = rows.child(
                div()
                    .font_family(ui.mono.clone())
                    .type_step(text::MONO)
                    .text_color(p.text_secondary)
                    .child(result.clone()),
            );
        }
        container = container.child(rows);
    }
    container
}

#[cfg(feature = "screenshots")]
fn dns_fixture_details(count: usize, ui: &Ui) -> Div {
    div()
        .py(space::S2)
        .rounded(radius::PANEL)
        .hairline(ui.p.border)
        .children(
            crate::setup_frames::dns_pieces()
                .enumerate()
                .map(|(index, (name, id))| {
                    let state = if index < count {
                        StepState::Passed
                    } else {
                        StepState::NeedsAction
                    };
                    div()
                        .min_h(px(32.))
                        .px(space::S6)
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .type_step(text::BODY)
                        .child(div().flex_none().child(state.icon(ui)))
                        .child(div().flex_1().child(name))
                        .child(
                            div()
                                .font_family(ui.mono.clone())
                                .type_step(text::SMALL)
                                .text_color(ui.p.text_secondary)
                                .child(id),
                        )
                }),
        )
}

fn success_copy(step: Step, app: &HackApp) -> String {
    let detail = || {
        step.card(&app.setup.report)
            .map(|card| card.detail.as_str())
    };
    match step {
        Step::Cli => detail().unwrap_or("Hack 5 is available.").into(),
        Step::Daemon => {
            let evidence = detail().unwrap_or_default();
            if evidence.starts_with("hackd ") && !evidence.contains(',') {
                format!("{evidence} is running.")
            } else {
                "hackd is running.".into()
            }
        }
        Step::Docker if step.card(&app.setup.report).is_none() => "Native runtime is ready.".into(),
        Step::Docker => "Docker is reachable.".into(),
        Step::Domains => "Local domains are set up.".into(),
        Step::Https => "Hack’s certificates are trusted.".into(),
        Step::Login => "Hack starts at login.".into(),
    }
}

fn status_copy(step: Step, state: StepState, app: &HackApp) -> (String, Option<String>) {
    let copy = |text: &str| (text.to_owned(), None);
    let card = step.card(&app.setup.report);
    #[cfg(feature = "screenshots")]
    if let Some((summary, note)) = app
        .setup_flow
        .fixture
        .as_ref()
        .and_then(|fixture| fixture.copy)
    {
        return (summary.into(), note.map(str::to_owned));
    }
    match state {
        StepState::Passed => (success_copy(step, app), None),
        StepState::Checking => {
            let check = match step {
                Step::Daemon => "Checking hackd…",
                Step::Cli => "Checking the Hack CLI…",
                Step::Docker => "Checking Docker…",
                Step::Domains => "Checking local domains…",
                Step::Https => "Checking HTTPS trust…",
                Step::Login => "Checking the login service…",
            };
            copy(check)
        }
        StepState::Running => (
            if step == Step::Daemon {
                "Starting hackd…"
            } else {
                "Running…"
            }
            .into(),
            Some("This step checks again when the command finishes.".into()),
        ),
        StepState::Password => copy("Waiting for your password."),
        StepState::Failed => (
            "Setup stopped before it finished.".into(),
            app.setup_flow
                .outcome
                .as_ref()
                .and_then(|run| run.diagnosis.clone()),
        ),
        StepState::Skipped if step == Step::Https => (
            "Skipped for now.".into(),
            Some("Browsers may warn on HTTPS URLs until this is done.".into()),
        ),
        StepState::Skipped => copy("Skipped for now."),
        StepState::Blocked => copy("Waiting for the Hack CLI."),
        StepState::VersionMismatch => {
            card.map_or_else(|| copy("This app needs Hack 5."), |card| copy(&card.detail))
        }
        StepState::Unchecked if step == Step::Cli && app.setup.report.force_cli_gate => {
            copy("No compatible Hack CLI was found.")
        }
        StepState::Unchecked => (
            format!(
                "Couldn’t check {}.",
                match step {
                    Step::Daemon => "the Hack service",
                    Step::Cli => "the Hack CLI",
                    Step::Docker => "Docker",
                    Step::Domains => "local domains",
                    Step::Https => "HTTPS trust",
                    Step::Login => "the login service",
                }
            ),
            None,
        ),
        StepState::NeedsAction => copy(match step {
            Step::Cli => "Install Hack 5 to continue.",
            Step::Daemon => match step.remedy_card(&app.setup.report).map(|card| &card.remedy) {
                Some(Remedy::Run(_)) => "hackd isn’t running.",
                Some(Remedy::Doc(_)) => "This hackd belongs to another Hack install.",
                _ => "The Hack service and CLI need compatible versions.",
            },
            Step::Docker => "Docker isn’t reachable.",
            Step::Domains => "Local domains need attention.",
            Step::Https => "Browsers may warn until Hack’s certificates are trusted.",
            Step::Login => "Not set up. hackd stops when you log out.",
        }),
        StepState::Todo => copy("Ready to check."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passed_docker_does_not_redirect_a_native_problem_to_docker_desktop() {
        let mut mixed = hack_desktop_core::setup_fixtures::load("ready").unwrap();
        let native = hack_desktop_core::setup_fixtures::load("native-unknown").unwrap();
        mixed.cards.extend(
            native
                .cards
                .into_iter()
                .filter(|card| card.id.starts_with("native:")),
        );
        let card = Step::Docker.remedy_card(&mixed).expect("native remedy");
        let Remedy::Doc(url) = &card.remedy else {
            panic!("expected a native guide");
        };
        let (label, actual_url) = setup_guide(card, url, true);
        assert_eq!(label, "Open native runtime guide");
        assert_eq!(actual_url, hack_desktop_core::setup::NATIVE_DOC);
    }
}
