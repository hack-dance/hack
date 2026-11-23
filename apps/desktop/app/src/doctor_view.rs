//! The Doctor pane (DESIGN.md section 3), in design v1: findings as cards
//! grouped by area, each with severity, what it affects and exactly one
//! action.
//!
//! Actions only copy a command or open a doc. A safe one-click "Run" waits
//! for the CLI to report fix kinds (design request R7a).

use gpui_kit::{
    AnyElement, ClipboardItem, Context, IntoElement, ParentElement, SharedString, Styled, div,
    prelude::*, px,
};
use std::time::Instant;

use hack_desktop_core::doctor::{Card, CardAction, DoctorPane, DoctorState, DoctorView, Severity};
use hack_desktop_ui::components::{
    BannerTone, StyledExt as _, Ui, action_button, banner, dot, empty_pane, pill,
};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::status::Status;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::view::HackApp;

/// Which pane the right side shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Pane {
    #[default]
    Project,
    Doctor,
    Resources,
    Configuration,
    /// Setup checks (`setup_view`).
    Setup,
    /// hackd and always-on (`machine_view`).
    Hackd,
    /// The upgrade review flow (`upgrade_view`).
    Upgrade,
}

pub fn render(pane: &DoctorPane, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let loading = pane.is_loading();
    let mut recheck = action_button(
        "doctor-recheck",
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
        recheck = recheck.on_click(cx.listener(|this, _, _, cx| this.load_doctor(cx)));
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
                .child("Doctor"),
        )
        .child(div().flex_1())
        .child(
            action_button(
                "doctor-setup",
                Glyph::Stethoscope,
                "Run setup again",
                true,
                ui,
            )
            .on_click(cx.listener(|this, _, _, cx| this.open_setup(cx))),
        )
        .children(pane.age_label(Instant::now()).map(|a| {
            div()
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(a)
        }))
        .child(recheck);
    let body: AnyElement = match (&pane.result, loading) {
        (DoctorState::NeverRun, true) => empty_pane(
            Glyph::Loader,
            "Running doctor…",
            "Checks the machine and each project; this takes up to 90 seconds.",
            None,
            ui,
        )
        .into_any_element(),
        (DoctorState::NeverRun, false) => empty_pane(
            Glyph::Stethoscope,
            "Doctor has not run yet",
            "Checks the engine, routing, certificates, the daemon and each project.",
            None,
            ui,
        )
        .into_any_element(),
        (DoctorState::Error(why), _) => empty_pane(
            Glyph::CircleAlert,
            "Doctor could not run",
            why.clone(),
            None,
            ui,
        )
        .into_any_element(),
        (DoctorState::Loaded(v), _) => cards(v, pane, ui, cx),
    };
    div()
        .flex_1()
        .min_w_0()
        .h_full()
        .flex()
        .flex_col()
        .child(header)
        .children(pane.stale.then(|| {
            banner(
                BannerTone::Warn,
                "Projects changed while checking; this result may be out of date. Checking again.",
                None,
                ui,
            )
        }))
        .child(body)
        .into_any_element()
}

pub(crate) fn native_pool_card(
    report: hack_desktop_core::models::NativePoolReport,
    ui: &Ui,
) -> gpui_kit::Div {
    use hack_desktop_core::models::NativePoolState;
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

fn cards(v: &DoctorView, pane: &DoctorPane, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let mut col = div()
        .id("doctor-cards")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .px(space::S8)
        .py(space::S6)
        .gap(space::S7);
    if let Some(project) = &pane.filter {
        col = col.child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::BODY)
                .text_color(p.text_secondary)
                .child(format!("Showing findings for {project}"))
                .child(
                    action_button("doctor-show-all", Glyph::Stethoscope, "Show all", true, ui)
                        .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx))),
                ),
        );
    }
    if let Some(line) = v.coverage_line() {
        col = col.child(
            div()
                .type_step(text::BODY)
                .text_color(p.states.degraded.fg)
                .child(line),
        );
    }
    if let Some(report) = v.native_pool.filter(|_| pane.filter.is_none()) {
        col = col.child(native_pool_card(report, ui));
    }
    let shown = |c: &&Card| {
        pane.filter
            .as_deref()
            .is_none_or(|f| c.affected.includes(f))
    };
    if !v.cards().any(|c| shown(&c)) {
        let (status, label) = if pane.stale {
            (Status::Degraded, "Results are out of date; check again")
        } else if v.is_clean() {
            (Status::Running, "No problems found")
        } else if pane.filter.is_some() {
            (Status::Stopped, "No findings for this project")
        } else {
            (Status::Degraded, "No problems found in the checks that ran")
        };
        col = col.child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::BODY)
                .text_color(p.text_primary)
                .child(dot(status, ui))
                .child(label),
        );
    }
    for (area, list) in &v.groups {
        let visible: Vec<&Card> = list.iter().filter(|c| shown(c)).collect();
        if visible.is_empty() {
            continue;
        }
        let mut group = div().flex().flex_col().gap(space::S4).child(
            div()
                .type_step(text::SMALL_STRONG)
                .text_color(p.text_muted)
                .child(area.label().to_owned()),
        );
        for c in visible {
            group = group.child(card(c, ui, cx));
        }
        col = col.child(group);
    }
    for (who, why) in &v.failed_runs {
        col = col.child(
            div()
                .type_step(text::BODY)
                .text_color(p.states.failed.fg)
                .child(format!("Could not check {who}: {why}")),
        );
    }
    col = col.child(
        div()
            .type_step(text::SMALL)
            .text_color(p.text_muted)
            .child(format!("{} checks passed", v.passed)),
    );
    col.into_any_element()
}

fn card(c: &Card, ui: &Ui, cx: &mut Context<HackApp>) -> AnyElement {
    let p = ui.p;
    let (severity, colors) = match c.severity {
        Severity::Error => ("Error", p.states.failed),
        Severity::Warn => ("Warning", p.states.degraded),
        Severity::CouldNotCheck => ("Could not check", p.states.unknown),
    };
    let id = SharedString::from(format!("doctor-action-{}-{}", c.id, c.affected.label()));
    let action = match &c.action {
        CardAction::Copy(cmd) => {
            let cmd = cmd.clone();
            action_button(id, Glyph::Copy, "Copy command", true, ui).on_click(cx.listener(
                move |_, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                },
            ))
        }
        CardAction::OpenDoc(url) => {
            let url = url.clone();
            action_button(id, Glyph::ExternalLink, "Open doc", true, ui)
                .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url)))
        }
    };
    let command = match &c.action {
        CardAction::Copy(cmd) => Some(
            div()
                .px(space::S4)
                .py(px(1.))
                .rounded(radius::PILL)
                .bg(p.surface_1)
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .text_color(p.text_primary)
                .child(cmd.clone()),
        ),
        CardAction::OpenDoc(_) => None,
    };
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
                .child(pill(severity, colors.bg, colors.fg))
                .child(
                    div()
                        .type_step(text::BODY_STRONG)
                        .text_color(p.text_primary)
                        .child(c.id.clone()),
                )
                .child(div().flex_1())
                .child(action),
        )
        .when(!c.detail.is_empty(), |d| {
            d.child(
                div()
                    .type_step(text::BODY)
                    .text_color(p.text_secondary)
                    .child(c.detail.clone()),
            )
        })
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S4)
                .type_step(text::SMALL)
                .text_color(p.text_muted)
                .child(c.affected.label())
                .children(command),
        )
        .into_any_element()
}
