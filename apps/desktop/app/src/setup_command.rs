//! Adapts authored setup remedies to the shared command-control contract.

use gpui_kit::{
    AnyElement, ClipboardItem, Context, IntoElement, ParentElement, Styled, div, prelude::*, px,
};
use hack_desktop_core::setup::{Remedy, Report, SafeAction};
use hack_desktop_core::terminal::{CommandAvailability, CommandControl, CommandControlSize};
use hack_desktop_ui::components::{StyledExt as _, Ui, action_button, primary_button};
use hack_desktop_ui::icons::Glyph;
use hack_desktop_ui::tokens::{radius, space, text};

use crate::setup_flow::{Step, StepState};
use crate::view::HackApp;

pub(super) const CONTROL_PREFIX: &str = "setup:";

/// Legacy Copy remedies contain shell text. Reconstruct only the known
/// authored commands and compare their display forms to the offered remedy.
fn for_step(step: Step, report: &Report, remedy: &Remedy) -> Option<CommandControl> {
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
    let label = format!("hack {}", args.join(" "));
    let mut bound_args = args;
    if cfg!(hack_terminal) && *remedy == Remedy::Run(SafeAction::StartDaemon) {
        bound_args.push("--no-interactive".into());
    }
    let availability = match report.command(bound_args) {
        Ok(spec) if copy_only => CommandAvailability::CopyOnly(spec),
        Ok(spec) => CommandAvailability::Ready(spec),
        Err(why) => CommandAvailability::Blocked(why),
    };
    Some(CommandControl {
        id: control_id(step),
        label,
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

pub(super) fn control_id(step: Step) -> String {
    format!("{CONTROL_PREFIX}{}", step.id())
}

pub(super) fn render(
    app: &HackApp,
    step: Step,
    remedy: &Remedy,
    state: StepState,
    ui: &Ui,
    cx: &mut Context<HackApp>,
) -> Option<AnyElement> {
    let control = for_step(step, &app.setup.report, remedy)?;
    let running = matches!(state, StepState::Running | StepState::Password);
    let busy = app.machine.busy() || running;
    #[cfg(hack_terminal)]
    if *remedy != Remedy::Run(SafeAction::InstallDaemon) {
        // Login service installation keeps its dedicated runner's fresh
        // service-manager and home ownership preflight.
        let epoch = app.setup.source_epoch();
        return Some(crate::command_control::render(
            control,
            busy,
            app,
            ui,
            cx,
            move |app, completion, cx| {
                app.setup_drawer_finished(epoch, step, completion, cx);
            },
        ));
    }
    let fallback = render_fallback(
        control,
        remedy,
        busy,
        running,
        state == StepState::Failed,
        ui,
        cx,
    );
    if matches!(remedy, Remedy::Admin(_)) && !running {
        let note = match step {
            Step::Domains => "May ask for your password to set up local domains.",
            Step::Https => "May ask for your password to trust Hack’s certificate.",
            _ => return Some(fallback),
        };
        return Some(
            div()
                .flex()
                .flex_col()
                .gap(space::S4)
                .child(fallback)
                .child(
                    div()
                        .type_step(text::SMALL)
                        .text_color(ui.p.text_secondary)
                        .child(note),
                )
                .into_any_element(),
        );
    }
    Some(fallback)
}

fn render_fallback(
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
