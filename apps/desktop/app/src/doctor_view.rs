//! The Doctor pane (DESIGN.md section 3): findings as cards grouped by area,
//! each with severity, what it affects and exactly one action.
//!
//! Actions only copy a command or open a doc. A safe one-click "Run" waits
//! for the CLI to report fix kinds (design request R7a).

use gpui_kit::component::{
    ActiveTheme, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    tag::Tag,
    v_flex,
};
use gpui_kit::{
    AnyElement, ClipboardItem, Context, FontWeight, IntoElement, ParentElement, SharedString,
    Styled, div, prelude::*, px,
};
use std::time::Instant;

use hack_desktop_core::doctor::{Card, CardAction, DoctorPane, DoctorState, DoctorView, Severity};

use crate::view::HackApp;

/// Which pane the right side shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Pane {
    #[default]
    Project,
    Doctor,
}

pub fn render(pane: &DoctorPane, cx: &mut Context<HackApp>) -> AnyElement {
    let t = cx.theme().clone();
    let loading = pane.is_loading();
    let header = h_flex()
        .px_5()
        .pt_4()
        .pb_3()
        .gap_3()
        .border_b_1()
        .border_color(t.border)
        .child(
            div()
                .text_xl()
                .font_weight(FontWeight::BOLD)
                .child("Doctor"),
        )
        .child(div().flex_1())
        .children(
            pane.age_label(Instant::now())
                .map(|a| div().text_sm().text_color(t.muted_foreground).child(a)),
        )
        .child(
            Button::new("doctor-recheck")
                .label(if loading {
                    "Checking…"
                } else {
                    "Check again"
                })
                .small()
                .outline()
                .loading(loading)
                .on_click(cx.listener(|this, _, _, cx| this.load_doctor(cx))),
        );
    let body: AnyElement = match (&pane.result, loading) {
        (DoctorState::NeverRun, true) => message(
            "Running doctor…",
            "Checks the machine and each project; this takes up to 90 seconds.",
            cx,
        ),
        (DoctorState::NeverRun, false) => message(
            "Doctor has not run yet",
            "Checks the engine, routing, certificates, the daemon and each project.",
            cx,
        ),
        (DoctorState::Error(why), _) => message("Doctor could not run", why, cx),
        (DoctorState::Loaded(v), _) => cards(v, pane, cx),
    };
    v_flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .child(header)
        .children(pane.stale.then(|| {
            div()
                .px_5()
                .py_1()
                .text_xs()
                .bg(t.warning.opacity(0.15))
                .child("Projects changed while checking; this result may be out of date. Checking again.")
        }))
        .child(body)
        .into_any_element()
}

fn message(title: &str, body: &str, cx: &Context<HackApp>) -> AnyElement {
    let t = cx.theme();
    v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_2()
        .child(
            div()
                .text_lg()
                .font_weight(FontWeight::SEMIBOLD)
                .child(title.to_owned()),
        )
        .child(
            div()
                .text_sm()
                .text_color(t.muted_foreground)
                .child(body.to_owned()),
        )
        .into_any_element()
}

fn cards(v: &DoctorView, pane: &DoctorPane, cx: &mut Context<HackApp>) -> AnyElement {
    let t = cx.theme().clone();
    let mut col = v_flex()
        .id("doctor-cards")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px_5()
        .py_3()
        .gap_4();
    if let Some(p) = &pane.filter {
        col = col.child(
            h_flex()
                .gap_2()
                .text_sm()
                .child(format!("Showing findings for {p}"))
                .child(
                    Button::new("doctor-show-all")
                        .label("Show all")
                        .xsmall()
                        .ghost()
                        .on_click(cx.listener(|this, _, _, cx| this.open_doctor(None, cx))),
                ),
        );
    }
    if let Some(line) = v.coverage_line() {
        col = col.child(div().text_sm().text_color(t.warning).child(line));
    }
    let shown = |c: &&Card| {
        pane.filter
            .as_deref()
            .is_none_or(|p| c.affected.includes(p))
    };
    let any_shown = v.cards().any(|c| shown(&c));
    if !any_shown {
        let (dot_color, text) = if v.is_clean() {
            (t.success, "No problems found")
        } else if pane.filter.is_some() {
            (t.muted_foreground, "No findings for this project")
        } else {
            (t.warning, "No problems found in the checks that ran")
        };
        col = col.child(
            h_flex()
                .gap_2()
                .text_sm()
                .child(div().size(px(8.)).rounded_full().bg(dot_color))
                .child(text),
        );
    }
    for (area, list) in &v.groups {
        let visible: Vec<&Card> = list.iter().filter(|c| shown(c)).collect();
        if visible.is_empty() {
            continue;
        }
        let mut group = v_flex().gap_2().child(
            div()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(t.muted_foreground)
                .child(area.label().to_uppercase()),
        );
        for c in visible {
            group = group.child(card(c, cx));
        }
        col = col.child(group);
    }
    for (who, why) in &v.failed_runs {
        col = col.child(
            div()
                .text_sm()
                .text_color(t.danger)
                .child(format!("Could not check {who}: {why}")),
        );
    }
    col = col.child(
        div()
            .text_sm()
            .text_color(t.muted_foreground)
            .child(format!("{} checks passed", v.passed)),
    );
    col.into_any_element()
}

fn card(c: &Card, cx: &mut Context<HackApp>) -> AnyElement {
    let t = cx.theme().clone();
    let tag = match c.severity {
        Severity::Error => Tag::danger().small().rounded_full().child("Error"),
        Severity::Warn => Tag::warning().small().rounded_full().child("Warning"),
        Severity::CouldNotCheck => Tag::secondary()
            .small()
            .rounded_full()
            .child("Could not check"),
    };
    let id = SharedString::from(format!("doctor-action-{}-{}", c.id, c.affected.label()));
    let action = match &c.action {
        CardAction::Copy(cmd) => {
            let cmd = cmd.clone();
            Button::new(id)
                .label("Copy command")
                .small()
                .outline()
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                }))
        }
        CardAction::OpenDoc(url) => {
            let url = url.clone();
            Button::new(id)
                .label("Open doc")
                .small()
                .ghost()
                .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url)))
        }
    };
    let command = match &c.action {
        CardAction::Copy(cmd) => Some(
            div()
                .font_family(t.mono_font_family.clone())
                .text_xs()
                .px_2()
                .py_0p5()
                .rounded_sm()
                .bg(t.muted)
                .child(cmd.clone()),
        ),
        CardAction::OpenDoc(_) => None,
    };
    v_flex()
        .gap_1()
        .p_3()
        .rounded_md()
        .border_1()
        .border_color(t.border)
        .child(
            h_flex()
                .gap_2()
                .child(tag)
                .child(div().font_weight(FontWeight::SEMIBOLD).child(c.id.clone()))
                .child(div().flex_1())
                .child(action),
        )
        .when(!c.detail.is_empty(), |d| {
            d.child(div().text_sm().child(c.detail.clone()))
        })
        .child(
            h_flex()
                .gap_3()
                .text_xs()
                .text_color(t.muted_foreground)
                .child(c.affected.label())
                .children(command)
                .child(div().flex_1())
                .child(format!("One-click fix needs {}", c.needs)),
        )
        .into_any_element()
}
