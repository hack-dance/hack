//! Doctor and follow-up command lifecycle. The shared drawer owns the PTY.

use std::time::{Duration, Instant};

use gpui_kit::{AnyElement, ClipboardItem, Context, Window};
use hack_desktop_core::{
    doctor::{DoctorRun, Finish},
    setup::Report,
    terminal::{CommandAvailability, CommandControl, CommandExit},
};
use hack_desktop_ui::components::Ui;

use crate::{
    health_model::{Repair, RepairQueue, RepairTarget},
    view::HackApp,
};

impl HackApp {
    pub(crate) fn health_report(&self) -> &Report {
        match &self.health.observed_setup {
            Some((at, report)) if self.setup.checked_at.is_none_or(|seen| seen <= *at) => report,
            _ => &self.setup.report,
        }
    }

    pub(crate) fn refresh_update_notice(&mut self, cx: &mut Context<Self>) {
        let interval = if self.health.signals.offline {
            Duration::from_secs(60)
        } else {
            Duration::from_secs(24 * 60 * 60)
        };
        if !self.live
            || !self.window_visible
            || self.health.update_checking
            || self
                .health
                .update_started
                .is_some_and(|at| at.elapsed() < interval)
            || !self.health_report().cli_ready()
        {
            return;
        }
        let checked = self.health_report().clone();
        self.health.update_started = Some(Instant::now());
        self.health.update_checking = true;
        let epoch = self.model.source_epoch();
        cx.spawn(async move |this, cx| {
            let observed = cx
                .background_executor()
                .spawn(async move { hack_desktop_core::upgrade::observe_update(&checked) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.model.source_epoch() != epoch {
                    return;
                }
                use hack_desktop_core::upgrade::UpdateObservation;
                this.health.update_checking = false;
                this.health.signals.offline = observed == UpdateObservation::NetworkUnavailable;
                this.health.signals.update = match observed {
                    UpdateObservation::Available(version) => Some(version),
                    _ => None,
                };
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn accept_health_report(
        &mut self,
        generation: u64,
        runs: Vec<DoctorRun>,
        report: Report,
    ) -> Finish {
        let now = Instant::now();
        let current = self.doctor_target_keys();
        let result = self
            .doctor
            .finish(generation, &runs, current.as_deref(), now);
        if result != Finish::Discarded {
            if report.cards.iter().any(|card| {
                card.id == "routing" && card.status == hack_desktop_core::setup::Status::Passed
            }) {
                self.health.signals.routing_permission_denied = false;
            }
            self.health.observed_setup = Some((now, report));
            self.health.runs = runs;
        }
        result
    }

    pub(crate) fn load_doctor(&mut self, cx: &mut Context<Self>) {
        if self.health.queue.is_some() || self.doctor.is_loading() {
            return;
        }
        self.health.confirmed.clear();
        self.health.recent_failure = None;
        if !self.live {
            if self.health.fixture.is_none() {
                self.show_doctor_now();
            }
            cx.notify();
            return;
        }
        let targets = self.doctor_targets().unwrap_or_default();
        let generation = self.doctor.begin(self.doctor_target_keys().as_deref());
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let (report, runs) = read(cx.background_executor(), source, targets).await;
            let _ = this.update(cx, |this, cx| {
                if this.accept_health_report(generation, runs, report) == Finish::AppliedStale {
                    this.maybe_auto_refresh(cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn start_health_repairs(
        &mut self,
        repairs: Vec<Repair>,
        all: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.live
            || self.machine.busy()
            || self.health.queue.is_some()
            || self.doctor.is_loading()
        {
            return;
        }
        let Some(queue) = RepairQueue::new(repairs, all) else {
            return;
        };
        self.health.confirmed.clear();
        self.health.recent_failure = None;
        self.health.queue = Some(queue);
        self.launch_health_repair(window, cx);
    }

    fn launch_health_repair(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(queue) = &self.health.queue else {
            return;
        };
        let command = queue.command();
        if !shared::run(self, command, window, cx) {
            self.health.queue = None;
            self.health.recent_failure = Some("The terminal couldn’t start this repair.".into());
        }
        cx.notify();
    }

    pub(crate) fn stop_health_repair(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(queue) = &mut self.health.queue {
            if !self.live {
                self.health.queue = None;
                cx.notify();
                return;
            }
            queue.stopping = true;
            if !queue.checking {
                shared::stop(self, window, cx);
            }
            cx.notify();
        }
    }

    pub(crate) fn show_health_drawer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        shared::show(self, window, cx);
    }

    #[allow(dead_code)]
    pub(crate) fn health_command_exited(
        &mut self,
        run: u64,
        exit: CommandExit,
        diagnosis: Option<String>,
        repair: Option<Repair>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(repair) = repair {
            self.health.queue = RepairQueue::new(vec![repair], false);
        }
        let Some(queue) = &mut self.health.queue else {
            return;
        };
        queue.checking = true;
        let targets = self.doctor_targets().unwrap_or_default();
        let generation = self.doctor.begin(self.doctor_target_keys().as_deref());
        let setup_generation = self.setup.begin();
        let source = self.source.clone();
        cx.spawn_in(window, async move |this, cx| {
            let (report, runs) = read(cx.background_executor(), source, targets).await;
            let _ = cx.update(|window, cx| {
                let _ = this.update(cx, |this, cx| {
                    if !this.setup.is_current(setup_generation) || this.health.queue.is_none() {
                        return;
                    }
                    this.setup.finish(setup_generation, report.clone());
                    let result = this.accept_health_report(generation, runs, report);
                    if result != Finish::Discarded {
                        this.finish_health_check(run, exit, diagnosis, result, window, cx);
                    }
                });
            });
        })
        .detach();
        cx.notify();
    }

    fn finish_health_check(
        &mut self,
        run: u64,
        exit: CommandExit,
        diagnosis: Option<String>,
        result: Finish,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(mut queue) = self.health.queue.take() else {
            return;
        };
        let target = queue.current().target.clone();
        let confirmed =
            result == Finish::Applied && target.confirmed(self.health_report(), &self.health.runs);
        let passed = exit == CommandExit::Code(0) && confirmed && !queue.stopping;
        if passed {
            self.health.confirmed.push(target.clone());
        }
        if matches!(&target, RepairTarget::Setup(id) if id == "routing")
            && matches!(exit, CommandExit::Code(code) if code != 0)
            && diagnosis.as_deref().is_some_and(sudo_refused)
        {
            self.health.signals.routing_permission_denied = true;
        }
        let reason = if queue.stopping {
            Some("Repairs stopped.".into())
        } else if exit != CommandExit::Code(0) {
            Some(diagnosis.unwrap_or_else(|| {
                "The command did not finish successfully. See terminal output.".into()
            }))
        } else if !confirmed {
            Some("The command finished, but the fresh check couldn’t confirm the repair.".into())
        } else {
            None
        };
        self.health.recent_failure = reason.clone();
        shared::checked(self, run, passed, reason, cx);
        if queue.advance(&exit, confirmed && result == Finish::Applied) {
            // A repair can make another finding pass or change its action.
            // Only carry forward commands that are still offered by the new read.
            while queue
                .current()
                .target
                .confirmed(self.health_report(), &self.health.runs)
            {
                let target = queue.current().target.clone();
                self.health.confirmed.push(target);
                if !queue.advance(&CommandExit::Code(0), true) {
                    self.refresh_now_async(cx);
                    cx.notify();
                    return;
                }
            }
            let still_offered = crate::doctor_view::repairs(self).iter().any(|repair| {
                repair.target == queue.current().target
                    && repair.control.availability == queue.current().control.availability
            });
            if still_offered && !self.machine.busy() {
                self.health.queue = Some(queue);
                self.launch_health_repair(window, cx);
            } else {
                self.health.recent_failure = Some("A remaining check changed. Review the new results before running more repairs.".into());
            }
        }
        self.refresh_now_async(cx);
        cx.notify();
    }
}

fn sudo_refused(diagnosis: &str) -> bool {
    let line = diagnosis.to_ascii_lowercase();
    line.contains("not in the sudoers file") || line.contains("not allowed to run sudo")
}

async fn read(
    executor: &gpui_kit::BackgroundExecutor,
    source: std::sync::Arc<dyn hack_desktop_core::source::Source>,
    targets: Vec<hack_desktop_core::source::DoctorTarget>,
) -> (Report, Vec<DoctorRun>) {
    let setup_source = source.clone();
    let setup = executor.spawn(async move { setup_source.setup() });
    let doctor = executor.spawn(async move { source.doctor_runs(&targets) });
    (setup.await, doctor.await)
}

pub fn copy(command: &CommandControl, cx: &mut Context<HackApp>) {
    if let CommandAvailability::Ready(spec) | CommandAvailability::CopyOnly(spec) =
        &command.availability
        && let Ok(display) = spec.display()
    {
        cx.write_to_clipboard(ClipboardItem::new_string(display));
    }
}

pub use shared::{AVAILABLE, drawer, render, show_fixture};

// The drawer branch currently publishes the command contract. Until its
// renderer lands, these controls only copy the checked command.
mod shared {
    use super::*;
    use gpui_kit::{IntoElement, ParentElement, Styled, div, prelude::*, px};
    use hack_desktop_core::terminal::CommandControlSize;
    use hack_desktop_ui::{
        components::{StyledExt as _, action_button},
        icons::Glyph,
        tokens::{radius, space, text},
    };

    pub const AVAILABLE: bool = false;

    pub fn render(
        command: CommandControl,
        _repair: Option<Repair>,
        _busy: bool,
        ui: &Ui,
        cx: &mut Context<HackApp>,
    ) -> AnyElement {
        let runnable = matches!(command.availability, CommandAvailability::Ready(_));
        let copyable = runnable || matches!(command.availability, CommandAvailability::CopyOnly(_));
        let label = command.label.clone();
        let size = command.size;
        let id = command.id.clone();
        let mut copy_button = action_button(
            format!("copy-command-{id}"),
            Glyph::Copy,
            "Copy",
            copyable,
            ui,
        )
        .w(px(64.))
        .h(px(24.))
        .justify_center();
        if copyable {
            copy_button = copy_button.on_click(cx.listener(move |_, _, _, cx| copy(&command, cx)));
        }
        let buttons = div()
            .flex()
            .items_center()
            .gap(space::S2)
            .child(
                action_button(
                    format!("run-unavailable-{id}"),
                    Glyph::Play,
                    "Run",
                    false,
                    ui,
                )
                .w(px(64.))
                .h(px(24.))
                .justify_center(),
            )
            .child(copy_button);
        if size == CommandControlSize::Compact {
            return buttons.into_any_element();
        }
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .min_h(px(44.))
            .px(space::S3)
            .gap(space::S3)
            .rounded(radius::CONTROL)
            .hairline(ui.p.border)
            .child(
                div()
                    .flex_1()
                    .font_family(ui.mono.clone())
                    .type_step(text::MONO)
                    .child(format!("$ {label}")),
            )
            .child(buttons)
            .into_any_element()
    }

    pub fn drawer(
        _app: &mut HackApp,
        _ui: &Ui,
        _window: &mut Window,
        _cx: &mut Context<HackApp>,
    ) -> Option<AnyElement> {
        None
    }

    pub fn run(
        _app: &mut HackApp,
        _command: CommandControl,
        _window: &mut Window,
        _cx: &mut Context<HackApp>,
    ) -> bool {
        false
    }

    pub fn stop(_app: &mut HackApp, _window: &mut Window, _cx: &mut Context<HackApp>) {}
    pub fn show(_app: &mut HackApp, _window: &mut Window, _cx: &mut Context<HackApp>) {}
    pub fn checked(
        _app: &mut HackApp,
        _run: u64,
        _passed: bool,
        _reason: Option<String>,
        _cx: &mut Context<HackApp>,
    ) {
    }
    pub fn show_fixture(
        _app: &mut HackApp,
        _command: CommandControl,
        _window: &mut Window,
        _cx: &mut Context<HackApp>,
    ) {
    }
}
