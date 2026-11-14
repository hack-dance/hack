//! Ordered setup cards. All effects require an explicit click.
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
use hack_desktop_core::setup::{Pane, Remedy, Status};

pub fn render(pane: &Pane, cx: &mut Context<HackApp>) -> AnyElement {
    let t = cx.theme().clone();
    let mut body = v_flex()
        .id("setup-cards")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px_5()
        .py_3()
        .gap_3();
    if pane.report.cards.is_empty() {
        body = body.child(div().child("Checking setup… Reads never start services."));
    }
    if let Some(result) = &pane.result {
        body = body.child(
            div()
                .text_sm()
                .p_3()
                .border_1()
                .border_color(t.border)
                .child(result.clone()),
        );
    }
    for (i, card) in pane.report.cards.iter().enumerate() {
        let skipped = pane.skipped.contains(&card.id);
        let label = if skipped {
            "Skipped for this session · unresolved"
        } else {
            match card.status {
                Status::Passed => "Passed",
                Status::NeedsAttention => "Needs attention",
                Status::Unknown => "Unknown",
            }
        };
        let color = if card.status == Status::Passed && !skipped {
            t.success
        } else {
            t.warning
        };
        let mut actions = h_flex().gap_2().flex_wrap().child(
            Button::new(("setup-recheck", i))
                .label("Check again")
                .small()
                .outline()
                .disabled(pane.loading || pane.action_busy)
                .on_click(cx.listener(|this, _, _, cx| this.load_setup(cx))),
        );
        // Passed cards need no fix. CLI cannot be skipped and gates departure.
        if card.status != Status::Passed {
            match &card.remedy {
                Remedy::Copy(command) => {
                    let command = command.clone();
                    actions = actions.child(
                        Button::new(("setup-copy", i))
                            .label("Copy command")
                            .small()
                            .ghost()
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(command.clone()))
                            }),
                    );
                }
                Remedy::Doc(url) => {
                    let url = url.clone();
                    actions = actions.child(
                        Button::new(("setup-doc", i))
                            .label("Open documentation")
                            .small()
                            .ghost()
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
                Remedy::Run(action) => {
                    let action = *action;
                    actions = actions.child(
                        Button::new(("setup-run", i))
                            .label("Run")
                            .small()
                            .outline()
                            .disabled(pane.loading || pane.action_busy || !pane.report.cli_ready())
                            .on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.run_setup_action(action, cx)
                                }),
                            ),
                    );
                }
                Remedy::Admin(args) => {
                    let args = args.clone();
                    let command = std::iter::once("hack".to_owned())
                        .chain(args.clone())
                        .collect::<Vec<_>>()
                        .join(" ");
                    actions = actions.child(
                        Button::new(("setup-copy", i))
                            .label("Copy command")
                            .small()
                            .ghost()
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(command.clone()))
                            }),
                    );
                    actions = actions.child(
                        Button::new(("setup-terminal", i))
                            .label("Open Terminal")
                            .small()
                            .outline()
                            .disabled(pane.action_busy || pane.loading || !pane.report.cli_ready())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_setup_terminal(args.clone(), cx)
                            })),
                    );
                }
            }
            if card.id != "cli" {
                let id = card.id.clone();
                actions = actions.child(
                    Button::new(("setup-skip", i))
                        .label("Skip for now")
                        .small()
                        .ghost()
                        .disabled(pane.loading || pane.action_busy)
                        .on_click(cx.listener(move |this, _, _, cx| this.skip_setup(&id, cx))),
                );
            }
        }
        body = body.child(
            v_flex()
                .p_3()
                .gap_2()
                .border_1()
                .border_color(t.border)
                .rounded_lg()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                            "{}. {}",
                            i + 1,
                            card.title
                        )))
                        .child(div().flex_1())
                        .child(div().text_xs().text_color(color).child(label)),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(t.muted_foreground)
                        .child(card.detail.clone()),
                )
                .child(actions),
        );
    }
    v_flex().flex_1().h_full().min_w_0().child(h_flex().px_5().py_3().gap_3().border_b_1().border_color(t.border).child(div().text_xl().font_weight(FontWeight::BOLD).child("Set up Hack")).child(div().flex_1()).child(Button::new("setup-continue").label("Continue").small().outline().disabled(!pane.report.cli_ready() || pane.loading || pane.action_busy).on_click(cx.listener(|this,_,_,cx|this.finish_setup(cx))))).child(div().px_5().pt_2().text_sm().text_color(t.muted_foreground).child("Checks observe only. Skipped and unknown steps stay unresolved; admin commands run in your terminal after Enter.")).child(body).into_any_element()
}
