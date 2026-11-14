//! Ordinary user copy; proposed capability boundaries belong in the docs.
use crate::view::HackApp;
use gpui_kit::component::{
    ActiveTheme, Disableable as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, ClipboardItem, Context, FontWeight, IntoElement, ParentElement, Styled, div,
    prelude::*,
};
use hack_desktop_core::upgrade::{Flow, State, display_step};
pub fn render(flow: &Flow, machine_busy: bool, cx: &mut Context<HackApp>) -> AnyElement {
    let t = cx.theme().clone();
    let busy = machine_busy || flow.busy;
    let mut body = v_flex().id("upgrade-body").flex_1().min_h_0().overflow_y_scroll().p_5().gap_3()
        .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(flow.state.label()))
        .child(div().text_sm().text_color(t.muted_foreground).child(if flow.target.is_none() {
            "Update availability could not be verified. You can review readiness and save files, but Upgrade is unavailable."
        } else { "Review readiness, save a complete file snapshot, then run the upgrade in your terminal. Check again to confirm each result." }));
    if let Some(target) = &flow.target {
        body = body.child(div().child(format!("Target: Hack {}", target.version)));
    }
    body = body.child(
        h_flex()
            .gap_3()
            .flex_wrap()
            .child(div().child(format!(
                "CLI: {}",
                flow.observation.cli.as_deref().unwrap_or("Unknown")
            )))
            .child(div().child(format!(
                "Installed app: {}",
                flow.observation.app.as_deref().unwrap_or("Unknown")
            )))
            .child(div().child(format!(
                "hackd: {}",
                flow.observation.daemon.as_deref().unwrap_or("Unknown")
            ))),
    );
    if let Some(message) = &flow.message {
        body = body.child(
            div()
                .text_sm()
                .p_3()
                .border_1()
                .border_color(t.border)
                .child(message.clone()),
        );
    }
    if let Some(snapshot) = &flow.snapshot {
        body = body.child(div().text_sm().child(if snapshot.manifest().is_some() {
            "Files were saved. Rollback restores files only."
        } else {
            "This snapshot is not a complete recovery point. Upgrade and rollback are unavailable."
        }));
        if let Some(path) = snapshot.manifest() {
            body = body.child(div().text_xs().child(path.to_owned()));
        }
        for gap in snapshot.gaps.iter().flatten() {
            body = body.child(
                div()
                    .text_sm()
                    .child(format!("{}: {}", gap.name, gap.reason)),
            );
        }
    }
    if let Some(report) = &flow.observation.report {
        for finding in report.blockers.iter().chain(&report.incomplete) {
            body = body.child(
                div()
                    .p_3()
                    .border_1()
                    .border_color(t.warning)
                    .child(format!(
                        "{} · {}: {}",
                        finding.scope, finding.id, finding.summary
                    )),
            );
        }
        if report.plan.is_empty() {
            body = body.child(div().child(if report.ready() {
                "No readiness steps remain."
            } else {
                "Readiness could not be fully checked."
            }));
        }
        for (i, step) in report.plan.iter().enumerate() {
            let mut card = v_flex()
                .p_3()
                .gap_2()
                .border_1()
                .border_color(t.border)
                .rounded_lg()
                .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                    "{}. {} · {}",
                    i + 1,
                    step.scope,
                    step.id
                )))
                .child(div().text_sm().child(step.why.clone()));
            if let Some(action) = &step.action {
                card = card.child(div().text_sm().child(action.clone()));
            }
            if let Some(command) = step
                .args
                .as_ref()
                .and_then(|a| display_step(&flow.observation.cli_program, a).ok())
            {
                card = card.child(div().text_xs().child(command.clone())).child(
                    Button::new(("upgrade-copy", i))
                        .label("Copy command")
                        .small()
                        .ghost()
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(command.clone()))
                        }),
                );
            }
            body = body.child(card);
        }
    }
    if let Some(before) = &flow.previous {
        for step in before.plan.iter().filter(|s| s.id != "snapshot") {
            let confirmed = flow
                .observation
                .report
                .as_ref()
                .is_some_and(|r| r.confirms(step, before));
            body = body.child(div().text_sm().child(format!(
                "{} · {}: {}",
                step.scope,
                step.id,
                if confirmed { "Confirmed" } else { "Unknown" }
            )));
        }
    }
    if let Some(result) = &flow.rollback {
        if let Some(message) = &result.message {
            body = body.child(div().text_sm().child(message.clone()));
        }
        for file in &result.results {
            body = body.child(div().text_sm().child(format!(
                    "{}: {}{}{}",
                    file.path,
                    file.status,
                    file.kept_as
                        .as_ref()
                        .map(|p| format!(" · kept as {p}"))
                        .unwrap_or_default(),
                    file.message
                        .as_ref()
                        .map(|m| format!(" · {m}"))
                        .unwrap_or_default()
                )));
        }
    }
    if flow.state == State::Restored {
        body = body.child(
            div().child("Files restored. Versions, containers and services were not changed."),
        );
    }
    let commands = hack_desktop_core::upgrade::homebrew_commands()
        .iter()
        .filter_map(|c| c.display().ok())
        .collect::<Vec<_>>()
        .join(" && ");
    body = body.child(
        div()
            .text_xs()
            .text_color(t.muted_foreground)
            .child(commands),
    );
    let actions = h_flex()
        .gap_2()
        .flex_wrap()
        .child(
            Button::new("upgrade-review")
                .label(if flow.observation.report.is_some() {
                    "Check again"
                } else {
                    "Review readiness"
                })
                .small()
                .outline()
                .disabled(busy)
                .on_click(cx.listener(|this, _, _, cx| this.review_upgrade(cx))),
        )
        .child(
            Button::new("upgrade-save")
                .label("Save file snapshot")
                .small()
                .outline()
                .disabled(busy || !flow.can_snapshot())
                .on_click(cx.listener(|this, _, _, cx| this.save_upgrade_files(cx))),
        )
        .child(
            Button::new("upgrade-run")
                .label("Upgrade in Terminal")
                .small()
                .outline()
                .disabled(busy || !flow.can_upgrade())
                .on_click(cx.listener(|this, _, _, cx| this.run_upgrade_terminal(cx))),
        )
        .child(
            Button::new("upgrade-restart")
                .label("Restart hackd")
                .small()
                .outline()
                .disabled(busy || flow.previous.is_none())
                .on_click(cx.listener(|this, _, _, cx| this.restart_upgrade_daemon(cx))),
        )
        .child(
            Button::new("upgrade-rollback")
                .label("Restore files from snapshot")
                .small()
                .outline()
                .disabled(busy || !flow.can_rollback())
                .on_click(cx.listener(|this, _, _, cx| this.rollback_upgrade_files(cx))),
        )
        .child(
            Button::new("upgrade-docs")
                .label("Upgrade documentation")
                .small()
                .ghost()
                .on_click(|_, _, cx| {
                    cx.open_url(
                        "https://github.com/hack-dance/hack/blob/next/docs/versions/v5/upgrade.md",
                    )
                }),
        );
    v_flex()
        .flex_1()
        .h_full()
        .min_w_0()
        .child(
            div()
                .px_5()
                .py_3()
                .border_b_1()
                .border_color(t.border)
                .text_xl()
                .font_weight(FontWeight::BOLD)
                .child("Upgrade Hack"),
        )
        .child(body)
        .child(
            div()
                .p_3()
                .border_t_1()
                .border_color(t.border)
                .child(actions),
        )
        .into_any_element()
}
