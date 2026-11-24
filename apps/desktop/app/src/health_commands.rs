//! Doctor and follow-up command lifecycle. The shared drawer owns the PTY.

use std::time::{Duration, Instant};

#[cfg(hack_terminal)]
use crate::command_control::CommandCompletion;
use gpui_kit::{AnyElement, ClipboardItem, Context, Window};
#[cfg(hack_terminal)]
use gpui_kit::{AnyWindowHandle, AppContext as _};
#[cfg(hack_terminal)]
use hack_desktop_core::machine_gate::Holder;
use hack_desktop_core::{
    doctor::{DoctorRun, Finish},
    setup::Report,
    terminal::{CommandAvailability, CommandControl},
};
use hack_desktop_ui::components::Ui;

#[cfg(hack_terminal)]
use crate::health_model::RepairTarget;
use crate::{
    health_model::{Repair, RepairQueue},
    view::HackApp,
};
#[cfg(hack_terminal)]
use hack_desktop_core::terminal::CommandExit;

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
                    UpdateObservation::Available(release) => Some(release),
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
        if self.health.queue.is_some() || self.doctor.is_loading() || self.machine.busy() {
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

    pub(crate) fn health_repairs_busy(&self) -> bool {
        self.machine.busy() || self.health.queue.is_some() || self.doctor.is_loading()
    }

    #[cfg(hack_terminal)]
    pub(crate) fn health_drawer_stop_requested(&mut self, id: &str) {
        if let Some(queue) = &mut self.health.queue
            && queue.current().control.id == id
        {
            queue.stopping = true;
        }
    }

    pub(crate) fn start_health_repairs(
        &mut self,
        repairs: Vec<Repair>,
        all: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !AVAILABLE || !self.live || self.health_repairs_busy() || (all && self.doctor.stale) {
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
                shared::stop(self, window, cx);
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

    pub(crate) fn health_waiting_for_password(&self, id: &str) -> bool {
        #[cfg(hack_terminal)]
        {
            self.panels.command.waiting_for_password(id)
        }
        #[cfg(not(hack_terminal))]
        {
            let _ = id;
            false
        }
    }

    pub(crate) fn show_health_drawer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        shared::show(self, window, cx);
    }

    #[cfg(hack_terminal)]
    fn health_command_exited(
        &mut self,
        completion: CommandCompletion,
        window: AnyWindowHandle,
        cx: &mut Context<Self>,
    ) {
        let Some(queue) = &mut self.health.queue else {
            return;
        };
        queue.checking = true;
        // The drawer releases its process ticket before delivering the exit.
        // Hold the machine during readback so a second fix cannot invalidate it.
        let ticket = self.machine.try_begin(Holder::Command);
        let targets = self.doctor_targets().unwrap_or_default();
        let generation = self.doctor.begin(self.doctor_target_keys().as_deref());
        let setup_generation = self.setup.begin();
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let (report, runs) = read(cx.background_executor(), source, targets).await;
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |this, cx| {
                    if let Some(ticket) = ticket {
                        this.machine.finish(ticket);
                    }
                    if !this.setup.is_current(setup_generation) || this.health.queue.is_none() {
                        return;
                    }
                    this.setup_checked(setup_generation, report.clone(), cx);
                    let result = this.accept_health_report(generation, runs, report);
                    if result != Finish::Discarded {
                        this.finish_health_check(completion, result, window, cx);
                    }
                });
            });
        })
        .detach();
        cx.notify();
    }

    #[cfg(hack_terminal)]
    fn finish_health_check(
        &mut self,
        completion: CommandCompletion,
        result: Finish,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(mut queue) = self.health.queue.take() else {
            return;
        };
        let CommandCompletion {
            run,
            exit,
            diagnosis,
        } = completion;
        let target = queue.current().target.clone();
        let confirmed = target.confirmed(self.health_report(), &self.health.runs);
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
        self.command_checked(run, reason.clone().map_or(Ok(()), Err), cx);
        if result == Finish::AppliedStale {
            self.maybe_auto_refresh(cx);
            self.health.recent_failure = reason.or_else(|| {
                (queue.index + 1 < queue.repairs.len()).then(|| {
                    "Projects changed during the check. Remaining repairs were stopped.".into()
                })
            });
            self.refresh_now_async(cx);
            cx.notify();
            return;
        }
        self.health.recent_failure = reason;
        if queue.advance(&exit, confirmed) {
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

#[cfg(hack_terminal)]
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
    #[cfg(hack_terminal)]
    let text = crate::command_control::copy_text(command);
    #[cfg(not(hack_terminal))]
    let text = match &command.availability {
        CommandAvailability::Ready(spec) | CommandAvailability::CopyOnly(spec) => {
            spec.display_in(command.cwd.as_deref()).ok()
        }
        _ => None,
    };
    if let Some(text) = text {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }
}

pub use shared::{AVAILABLE, render, show_fixture};

#[cfg(hack_terminal)]
mod shared {
    use super::*;
    use crate::command_control;
    use hack_desktop_core::terminal::CommandSpec;

    pub const AVAILABLE: bool = true;

    pub fn render(
        app: &HackApp,
        command: CommandControl,
        repair: Option<Repair>,
        busy: bool,
        ui: &Ui,
        _window: &Window,
        cx: &mut Context<HackApp>,
    ) -> AnyElement {
        let Some(repair) = repair else {
            return command_control::render(command, busy, app, ui, cx, |_, _, _| {});
        };
        command_control::render_with_run(command, busy, app, ui, cx, move |app, _, window, cx| {
            app.start_health_repairs(vec![repair.clone()], false, window, cx);
        })
    }

    pub fn run(
        app: &mut HackApp,
        command: CommandControl,
        window: &mut Window,
        cx: &mut Context<HackApp>,
    ) -> bool {
        let handle = window.window_handle();
        app.run_drawer_command(
            command,
            move |app, exit, cx| app.health_command_exited(exit, handle, cx),
            window,
            cx,
        )
    }

    pub fn stop(app: &mut HackApp, _window: &mut Window, cx: &mut Context<HackApp>) {
        app.stop_drawer_command(cx);
    }

    pub fn show(app: &mut HackApp, window: &mut Window, cx: &mut Context<HackApp>) {
        if let Some(queue) = &app.health.queue {
            let id = queue.current().control.id.clone();
            app.show_command_output(&id, window, cx);
        }
    }

    pub fn show_fixture(
        app: &mut HackApp,
        mut command: CommandControl,
        window: &mut Window,
        cx: &mut Context<HackApp>,
    ) {
        command.availability = CommandAvailability::Ready(CommandSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), concat!(
                r"printf '%s\n' 'Fix all · 1 of 4  hack global install' '✓ Local domains ready. exit 0' '' ",
                "'Fix all · 2 of 4  hack global trust' 'Adding the Hack local CA to the system trust store…'; ",
                "/bin/stty -echo; printf '%s' '[sudo] password for alex: '; IFS= read -r unused",
            ).into()],
        });
        // The fixture starts only the fixed transcript process above. Its
        // visible controls never submit fixture commands to the real CLI.
        let live = std::mem::replace(&mut app.live, true);
        let started = app.run_drawer_command(command, |_, _, _| {}, window, cx);
        app.live = live;
        assert!(started, "start Doctor terminal fixture");
    }
}

#[cfg(not(hack_terminal))]
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
        _app: &HackApp,
        command: CommandControl,
        _repair: Option<Repair>,
        _busy: bool,
        ui: &Ui,
        _window: &Window,
        cx: &mut Context<HackApp>,
    ) -> AnyElement {
        let label = command.label.clone();
        let size = command.size;
        let copyable = matches!(
            command.availability,
            CommandAvailability::Ready(_) | CommandAvailability::CopyOnly(_)
        );
        if let CommandAvailability::Blocked(reason) | CommandAvailability::VersionMismatch(reason) =
            &command.availability
        {
            return div()
                .type_step(text::SMALL)
                .text_color(ui.p.text_muted)
                .child(reason.clone())
                .into_any_element();
        }
        let mut button = action_button(
            format!("copy-command-{}", command.id),
            Glyph::Copy,
            "Copy",
            copyable,
            ui,
        );
        if copyable {
            button = button.on_click(cx.listener(move |_, _, _, cx| copy(&command, cx)));
        }
        if size == CommandControlSize::Compact {
            return button.into_any_element();
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
            .child(button)
            .into_any_element()
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
    pub fn show_fixture(
        _app: &mut HackApp,
        _command: CommandControl,
        _window: &mut Window,
        _cx: &mut Context<HackApp>,
    ) {
    }
}

#[cfg(all(test, hack_terminal, feature = "screenshots"))]
mod tests {
    use std::{
        fs,
        os::unix::fs::PermissionsExt as _,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use gpui_kit::{HeadlessAppContext, WindowOptions};
    use hack_desktop_core::{
        execution::ExecutionContext,
        fixtures::Fixture,
        models::{DoctorCheck, DoctorReport, LogEntry},
        setup::{Card, Remedy, Status},
        source::{
            ActionOutcome, DoctorTarget, FixtureSource, LogFeed, Snapshot, Source, SourceError,
        },
        state::Action,
    };

    use super::*;

    struct RepairSource {
        home: PathBuf,
    }

    impl Drop for RepairSource {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    impl Source for RepairSource {
        fn snapshot(&self) -> Result<Snapshot, SourceError> {
            FixtureSource(Fixture::Empty).snapshot()
        }

        fn act(
            &self,
            root: &Path,
            native: bool,
            branch: Option<&str>,
            action: Action,
        ) -> Result<ActionOutcome, SourceError> {
            FixtureSource(Fixture::Empty).act(root, native, branch, action)
        }

        fn log_tail(
            &self,
            root: &Path,
            native: bool,
            branch: Option<&str>,
            lines: u32,
        ) -> Result<Vec<LogEntry>, String> {
            FixtureSource(Fixture::Empty).log_tail(root, native, branch, lines)
        }

        fn open_logs(
            &self,
            root: &Path,
            native: bool,
            branch: Option<&str>,
            args: &[String],
        ) -> Result<Box<dyn LogFeed>, String> {
            FixtureSource(Fixture::Empty).open_logs(root, native, branch, args)
        }

        fn doctor_runs(&self, _projects: &[DoctorTarget]) -> Vec<DoctorRun> {
            vec![DoctorRun::machine(Ok(DoctorReport {
                checks: vec![DoctorCheck {
                    id: "daemon".into(),
                    status: "ok".into(),
                    ..DoctorCheck::default()
                }],
                summary: vec![],
            }))]
        }

        fn setup(&self) -> Report {
            let checked = |id: &str, command: &str| {
                let passed = self.home.join(id).exists();
                if passed {
                    fs::write(self.home.join(format!("checked-{id}")), "").unwrap();
                }
                Card {
                    id: id.into(),
                    title: id.into(),
                    status: if passed {
                        Status::Passed
                    } else {
                        Status::NeedsAttention
                    },
                    detail: String::new(),
                    remedy: if id == "trust" && self.home.join("changed-remedy").exists() {
                        Remedy::Doc("https://example.invalid/certificates".into())
                    } else {
                        Remedy::Admin(vec!["global".into(), command.into()])
                    },
                }
            };
            Report {
                cli_program: Some(self.home.join("hack").to_string_lossy().into_owned()),
                context: ExecutionContext::from_values(&[(
                    "HOME".into(),
                    self.home.to_string_lossy().into_owned(),
                )])
                .ok(),
                force_cli_gate: false,
                cards: vec![
                    Card {
                        id: "cli".into(),
                        title: "Hack CLI".into(),
                        status: Status::Passed,
                        detail: "Hack 5".into(),
                        remedy: Remedy::Doc(String::new()),
                    },
                    checked("routing", "install"),
                    checked("trust", "trust"),
                ],
                project_registry_read: false,
            }
        }
    }

    #[test]
    fn the_shared_drawer_waits_for_confirmation_before_the_next_repair() {
        for case in [
            "repaired",
            "unchanged",
            "failed",
            "skipped",
            "changed",
            "stopped",
            "row-stopped",
        ] {
            let home =
                std::env::temp_dir().join(format!("hack-repair-{}-{case}", std::process::id()));
            fs::create_dir(&home).unwrap();
            let source = Arc::new(RepairSource { home: home.clone() });
            let script = home.join("hack");
            fs::write(
                &script,
                r#"#!/bin/sh
[ "$1" = global ] || exit 11
printf '%s\n' "$2" >> "$HOME/order"
case "$2" in
  install)
    [ ! -f "$HOME/failed" ] || exit 9
    if [ -f "$HOME/stopped" ] || [ -f "$HOME/row-stopped" ]; then
      trap ': > "$HOME/routing"; exit 0' INT
      : > "$HOME/ready"
      while :; do /bin/sleep 0.05; done
    fi
    [ -f "$HOME/unchanged" ] || : > "$HOME/routing"
    if [ -f "$HOME/skipped" ]; then : > "$HOME/trust"; fi
    if [ -f "$HOME/changed" ]; then : > "$HOME/changed-remedy"; fi
    ;;
  trust) [ -f "$HOME/checked-routing" ] || exit 7; : > "$HOME/trust" ;;
esac
"#,
            )
            .unwrap();
            fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(home.join(case), "").unwrap();
            let mut cx = HeadlessAppContext::with_platform(
                Arc::new(gpui_kit::NoopTextSystem::new()),
                Arc::new(hack_desktop_ui::icons::Assets),
                || Ok(None),
            );
            cx.update(gpui_kit::init);
            let (window, app) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            show: false,
                            focus: false,
                            ..WindowOptions::default()
                        },
                        cx,
                        |window, cx| {
                            cx.new(|cx| {
                                let mut app = HackApp::new(source.clone(), false, window, cx);
                                app.show_doctor_now();
                                app.live = true;
                                let mut repairs = crate::doctor_view::repairs(&app);
                                assert_eq!(repairs.len(), 2);
                                let all = case != "row-stopped";
                                if !all {
                                    repairs.truncate(1);
                                }
                                app.start_health_repairs(repairs, all, window, cx);
                                app
                            })
                        },
                    )
                })
                .unwrap();

            let deadline = Instant::now() + Duration::from_secs(15);
            let mut interrupt_sent = false;
            loop {
                cx.update(|cx| {
                    app.update(cx, |app, cx| {
                        app.settle_command_fixture(cx);
                        if matches!(case, "stopped" | "row-stopped")
                            && !interrupt_sent
                            && home.join("ready").exists()
                        {
                            app.stop_drawer_command(cx);
                            interrupt_sent = true;
                        }
                    })
                });
                cx.run_until_parked();
                if cx.update(|cx| app.read(cx).health.queue.is_none()) {
                    break;
                }
                assert!(Instant::now() < deadline, "repair fixture did not settle");
            }
            let order = fs::read_to_string(home.join("order")).unwrap();
            cx.update(|cx| {
                let app = app.read(cx);
                assert!(!app.machine.busy());
                if case == "repaired" || case == "skipped" {
                    let expected = if case == "repaired" {
                        "install\ntrust\n"
                    } else {
                        "install\n"
                    };
                    assert_eq!(order, expected);
                    assert_eq!(app.health.confirmed.len(), 2);
                    assert!(app.health.recent_failure.is_none());
                    assert!(home.join("checked-trust").exists());
                } else {
                    assert_eq!(order, "install\n");
                    assert!(app.health.recent_failure.is_some());
                    if case != "changed" {
                        assert!(app.panels.command.visible());
                    }
                    if case == "changed" {
                        assert!(
                            app.health
                                .recent_failure
                                .as_deref()
                                .unwrap()
                                .starts_with("A remaining check changed")
                        );
                    }
                    if matches!(case, "stopped" | "row-stopped") {
                        assert!(interrupt_sent);
                        assert!(app.health.confirmed.is_empty());
                        assert!(
                            home.join("checked-routing").exists(),
                            "interrupt trap exits successfully"
                        );
                        assert_eq!(
                            app.health.recent_failure.as_deref(),
                            Some("Repairs stopped.")
                        );
                    }
                }
            });
            cx.update_window(window, |_, window, cx| {
                app.update(cx, |app, cx| app.reset_command_drawer(window, cx));
                window.remove_window();
            })
            .unwrap();
        }
    }
}
