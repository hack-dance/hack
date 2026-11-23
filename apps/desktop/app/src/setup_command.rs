//! Adapts authored setup remedies to the shared command-control contract.

use gpui_kit::{
    AnyElement, ClipboardItem, Context, IntoElement, ParentElement, Styled, div, prelude::*, px,
};
use hack_desktop_core::setup::{Remedy, Report, SafeAction};
use hack_desktop_core::terminal::{CommandAvailability, CommandControl, CommandControlSize};
use hack_desktop_ui::components::{StyledExt as _, Ui, action_button, primary_button};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::setup_flow::Step;
use crate::view::HackApp;

/// Legacy Copy remedies contain shell text. Reconstruct only the known
/// authored commands and compare their display forms to the offered remedy.
pub(super) fn for_step(step: Step, report: &Report, remedy: &Remedy) -> Option<CommandControl> {
    let (args, copy_only) = match remedy {
        Remedy::Run(action) => (owned_args(action.args()), false),
        Remedy::Admin(args) => (args.clone(), false),
        Remedy::Copy(copy) => {
            let args = [&["daemon", "restart"][..], &["update"][..]]
                .into_iter()
                .map(owned_args)
                .find(|args| {
                    report
                        .command(args.clone())
                        .and_then(|spec| spec.display())
                        .as_ref()
                        == Ok(copy)
                })?;
            (args, true)
        }
        _ => return None,
    };
    let availability = match report.command(args.clone()) {
        Ok(spec) if copy_only => CommandAvailability::CopyOnly(spec),
        Ok(spec) => CommandAvailability::Ready(spec),
        Err(why) => CommandAvailability::Blocked(why),
    };
    Some(CommandControl {
        id: format!("setup-{}", step.id()),
        label: format!("hack {}", args.join(" ")),
        title: "Terminal".into(),
        availability,
        size: CommandControlSize::Standard,
        cwd: None,
        expects_password: matches!(remedy, Remedy::Admin(_)),
    })
}

fn owned_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// Compatibility adapter while the drawer implementation is in flight. The
/// fixed safe action and external-terminal hand-off keep their existing entry points.
pub(super) fn render(
    control: CommandControl,
    remedy: &Remedy,
    busy: bool,
    running: bool,
    retry: bool,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> AnyElement {
    let p = ui.p;
    let copy = match &control.availability {
        CommandAvailability::Ready(spec) | CommandAvailability::CopyOnly(spec) => {
            spec.display().ok()
        }
        _ => None,
    };
    let can_run = !busy && matches!(control.availability, CommandAvailability::Ready(_));
    let label = if running {
        "Running"
    } else if retry {
        "Try again"
    } else {
        "Run"
    };
    let glyph = if running {
        Glyph::Loader
    } else if retry {
        Glyph::Restart
    } else {
        Glyph::Play
    };
    let run = if can_run {
        primary_button("setup-run", glyph, label, ui)
    } else {
        action_button("setup-run", glyph, label, false, ui)
    }
    .px(space::S2)
    .w(px(88.))
    .h(px(28.))
    .justify_center()
    .when(can_run, |button| match remedy.clone() {
        Remedy::Run(action @ (SafeAction::StartDaemon | SafeAction::InstallDaemon)) => {
            button.on_click(cx.listener(move |this, _, _, cx| this.run_setup_action(action, cx)))
        }
        Remedy::Admin(args) => button.on_click(
            cx.listener(move |this, _, _, cx| this.open_setup_terminal(args.clone(), cx)),
        ),
        _ => button,
    });
    div()
        .h(px(44.))
        .px(space::S4)
        .flex()
        .items_center()
        .gap(space::S4)
        .rounded(radius::PANEL)
        .hairline(p.border)
        .when(running, |d| d.bg(p.surface_1))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(ui.mono.clone())
                .type_step(text::MONO)
                .child(format!("$ {}", control.label)),
        )
        .child(run)
        .child(
            action_button("setup-copy", Glyph::Copy, "Copy", copy.is_some(), ui)
                .w(px(88.))
                .h(px(28.))
                .justify_center()
                .when_some(copy, |button, text| {
                    button.on_click(move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()))
                    })
                }),
        )
        .into_any_element()
}
