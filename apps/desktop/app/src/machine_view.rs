//! The hackd pane (HACK-2288 item 6): the observed hackd card and the
//! read-only always-on summary, opened from the sidebar's Machine group.
//! What it shows comes from `hack_desktop_core::machine`; the only action is
//! the card's one (Start or Restart hackd through the shared machine gate, or
//! Setup for the login service). No `hack autostart` command runs here.

use gpui_kit::{AnyElement, Context, IntoElement, ParentElement, Styled, div, prelude::*};

use hack_desktop_core::machine::{self, CardAction, Tone};
use hack_desktop_core::machine_gate::Holder;
use hack_desktop_core::source::DaemonRecovery;
use hack_desktop_ui::components::{StyledExt as _, Ui, action_button, dot, empty_pane};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::Status;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::view::HackApp;

/// The dot for a tone, as the rest of the window draws states.
#[must_use]
pub fn status_of(tone: Tone) -> Status {
    match tone {
        Tone::Ok => Status::Running,
        Tone::Attention => Status::Degraded,
        Tone::Problem => Status::Failed,
        Tone::Unknown => Status::Unknown,
    }
}

impl HackApp {
    /// Before the pane has read hackd's status: what the project reads
    /// already say (a matching hackd answered, or it is off or mismatched).
    pub(crate) fn hackd_tone_from_snapshot(&self) -> Option<Tone> {
        match self.model.daemon_recovery() {
            Some(DaemonRecovery::Start) => return Some(Tone::Problem),
            Some(DaemonRecovery::Restart) => return Some(Tone::Attention),
            None => {}
        }
        self.model
            .project_list_readable()
            .then(|| self.model.snapshot())
            .flatten()
            .filter(|s| s.daemon_matches())
            .map(|_| Tone::Ok)
    }

    /// What the hackd pane says, as text: the card's title and login-service
    /// line, then each always-on summary line (the drive's `expect-hackd`).
    #[cfg(hack_terminal)]
    pub(crate) fn hackd_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(c) = self.hackd_card() {
            lines.push(c.title);
            lines.push(c.login_service.1);
        }
        if let Some(s) = self
            .model
            .snapshot()
            .filter(|_| self.model.project_list_readable())
        {
            let summary = machine::always_on_summary(&s.projects);
            lines.extend(summary.login_run);
            lines.extend(
                summary
                    .rows
                    .into_iter()
                    .map(|(name, _, line)| format!("{name} {line}")),
            );
        }
        lines
    }

    /// The hackd card from the last status read and the last snapshot.
    pub(crate) fn hackd_card(&self) -> Option<machine::HackdCard> {
        if !self.hackd_read {
            return None;
        }
        let snapshot = self.model.snapshot();
        Some(machine::hackd_card(
            self.hackd_status.as_ref(),
            snapshot.and_then(|s| s.daemon.as_ref()),
            snapshot.map(|s| s.cli_version.as_str()),
        ))
    }
}

pub fn render(app: &HackApp, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let loading = app.hackd_loading;
    let mut recheck = action_button(
        "hackd-recheck",
        Glyph::Restart,
        if loading {
            "Checking…"
        } else {
            "Check again"
        },
        !loading,
        ui,
    );
    if !loading {
        recheck = recheck.on_click(cx.listener(|this, _, _, cx| this.load_hackd(cx)));
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
                .child("hackd"),
        )
        .child(div().flex_1())
        .child(recheck);
    let card: AnyElement = match app.hackd_card() {
        None => empty_pane(
            Glyph::Loader,
            "Reading hackd…",
            "Asks the selected CLI for hackd's status; this starts nothing.",
            None,
            ui,
        )
        .into_any_element(),
        Some(c) => hackd_card(app, &c, ui, cx),
    };
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(header)
        .child(
            div()
                .id("hackd-pane")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .px(space::S8)
                .py(space::S6)
                .gap(space::S7)
                .child(card)
                .child(always_on(app, ui)),
        )
        .into_any_element()
}

fn hackd_card(
    app: &HackApp,
    c: &machine::HackdCard,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let p = ui.p;
    let busy = app.machine.busy();
    let action = c.action.map(|a| {
        let (glyph, label) = match a {
            CardAction::Start => (Glyph::Power, "Start hackd"),
            CardAction::Restart => (Glyph::Restart, "Restart hackd"),
            CardAction::OpenSetup => (Glyph::Stethoscope, "Open Setup"),
        };
        let working = app.machine.held_by(Holder::Recovery) && a != CardAction::OpenSetup;
        let enabled = a == CardAction::OpenSetup || !busy;
        let mut button = action_button(
            "hackd-action",
            glyph,
            if working { "Working…" } else { label },
            enabled,
            ui,
        );
        if enabled {
            button = button.on_click(cx.listener(move |this, _, _, cx| match a {
                CardAction::Start => this.recover_daemon(DaemonRecovery::Start, cx),
                CardAction::Restart => this.recover_daemon(DaemonRecovery::Restart, cx),
                CardAction::OpenSetup => this.open_setup(cx),
            }));
        }
        button
    });
    div()
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
                .child(dot(status_of(c.tone), ui))
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .text_color(p.text_primary)
                        .child(c.title.clone()),
                )
                .child(div().flex_1())
                .children(action),
        )
        .children(c.details.iter().map(|d| {
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(d.clone())
        }))
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(dot(status_of(c.login_service.0), ui))
                .child(c.login_service.1.clone()),
        )
        .children(app.recovery_error().map(|e| {
            div()
                .type_step(text::BODY)
                .text_color(p.states.failed.fg)
                .child(e.to_owned())
        }))
        .into_any_element()
}

fn always_on(app: &HackApp, ui: &Ui) -> AnyElement {
    let p = ui.p;
    let mut col = div().flex().flex_col().gap(space::S4).child(
        div()
            .type_step(text::SMALL_STRONG)
            .text_color(p.text_muted)
            .child("Always on"),
    );
    let line = |tone: Tone, text_: String| {
        div()
            .flex()
            .items_center()
            .gap(space::S4)
            .type_step(text::BODY)
            .text_color(p.text_primary)
            .child(dot(status_of(tone), ui))
            .child(text_)
    };
    let Some(snapshot) = app
        .model
        .snapshot()
        .filter(|_| app.model.project_list_readable())
    else {
        return col
            .child(
                div()
                    .type_step(text::BODY)
                    .text_color(p.text_secondary)
                    .child("Shown once the project list is read."),
            )
            .into_any_element();
    };
    let s = machine::always_on_summary(&snapshot.projects);
    if s.global_paused == Some(true) {
        col = col.child(line(
            Tone::Attention,
            "Always-on is paused for all projects".into(),
        ));
    }
    if let Some(run) = &s.login_run {
        col = col.child(line(Tone::Unknown, run.clone()));
    }
    if s.marked == 0 {
        col = col.child(
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child("No project is always on."),
        );
    } else {
        let mut counts = vec![format!("{} always on", s.marked)];
        for (n, what) in [
            (s.paused, "paused"),
            (s.starting, "starting"),
            (s.needs_attention, "needing attention"),
        ] {
            if n > 0 {
                counts.push(format!("{n} {what}"));
            }
        }
        col = col.child(
            div()
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(counts.join(" · ")),
        );
        for (name, tone, text_) in &s.rows {
            col = col.child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S4)
                    .type_step(text::BODY)
                    .child(dot(status_of(*tone), ui))
                    .child(div().text_color(p.text_primary).child(name.clone()))
                    .child(div().text_color(p.text_secondary).child(text_.clone())),
            );
        }
    }
    if s.service_ready == Some(false) && s.marked > 0 {
        col = col.child(line(
            Tone::Attention,
            "No login service file: always-on projects will not start at login".into(),
        ));
    }
    col.child(
        div()
            .type_step(text::SMALL)
            .text_color(p.text_muted)
            .child("Read-only: change always-on with hack autostart add, remove, pause or resume."),
    )
    .into_any_element()
}

#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use super::*;
    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;
    use std::sync::Arc;

    fn window(f: Fixture) -> (HeadlessAppContext, gpui_kit::Entity<HackApp>) {
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
                    cx.new(|cx| HackApp::new(Arc::new(FixtureSource(f)), false, window, cx))
                })
            })
            .unwrap();
        (cx, app)
    }

    #[test]
    fn opening_the_hackd_pane_reads_hackd_and_offers_its_one_action() {
        let (mut cx, app) = window(Fixture::HackdOff);
        let card = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.refresh_now();
                assert!(
                    a.hackd_card().is_none(),
                    "nothing read before the pane opens"
                );
                a.open_hackd(cx);
                a.hackd_card()
            })
        });
        let card = card.expect("read on open");
        assert_eq!(card.title, "hackd stopped (login service installed)");
        assert_eq!(card.action, Some(CardAction::Start));
        assert_eq!(card.login_service.0, Tone::Attention);
        // A machine action already running holds the gate: the card's Start
        // waits (the button is disabled; recover_daemon refuses).
        cx.update(|cx| {
            app.update(cx, |a, _| {
                let held = a.machine.try_begin(Holder::Setup).unwrap();
                assert!(a.machine.busy());
                assert!(a.machine.finish(held));
            })
        });
    }

    #[test]
    fn a_running_hackd_has_no_action_and_a_green_sidebar_dot() {
        let (mut cx, app) = window(Fixture::Hackd);
        let (before, card) = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.refresh_now();
                let before = a.hackd_tone_from_snapshot();
                a.open_hackd(cx);
                (before, a.hackd_card().unwrap())
            })
        });
        assert_eq!(before, Some(Tone::Ok), "from the project read alone");
        assert_eq!((card.tone, card.action), (Tone::Ok, None));
        assert_eq!(card.details, vec!["hackd 5.0.0 · pid 4242".to_owned()]);
    }
}
