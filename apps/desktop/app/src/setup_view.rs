//! Setup check orchestration and guarded navigation.

use gpui_kit::Context;
use hack_desktop_core::machine_gate::Holder;
use hack_desktop_core::setup::{CheckScope, Remedy, Report, SafeAction, Status};

use crate::doctor_view::Pane;
use crate::setup_flow::{ADVANCE_DELAY, Screen, Step, StepState};
use crate::view::HackApp;

impl HackApp {
    #[cfg(hack_terminal)]
    pub(super) fn setup_position(&self) -> String {
        if self.pane != Pane::Setup {
            return "closed".into();
        }
        match self.setup_flow.screen {
            Screen::Welcome => "welcome".into(),
            Screen::Done => "done".into(),
            Screen::Step(step) => format!("{} {:?}", step.id(), self.setup_step_state(step)),
        }
    }

    pub(super) fn setup_step_state(&self, step: Step) -> StepState {
        if self.setup_flow.step() == Some(step)
            && let Some((id, waiting)) = self.running_setup_command()
            && id == step.id()
        {
            return if waiting {
                StepState::Password
            } else {
                StepState::Running
            };
        }
        self.setup_flow.state(step, &self.setup)
    }

    fn running_setup_command(&self) -> Option<(&str, bool)> {
        #[cfg(hack_terminal)]
        return self
            .panels
            .command
            .running_control()
            .and_then(|(id, waiting)| {
                Some((
                    id.strip_prefix(crate::setup_command::CONTROL_PREFIX)?,
                    waiting,
                ))
            });
        #[cfg(not(hack_terminal))]
        None
    }

    pub(super) fn setup_command_running(&self) -> bool {
        self.setup.action_busy || self.running_setup_command().is_some()
    }

    #[cfg(hack_terminal)]
    pub(super) fn setup_drawer_finished(
        &mut self,
        epoch: u64,
        step: Step,
        completion: crate::command_control::CommandCompletion,
        cx: &mut Context<Self>,
    ) {
        use hack_desktop_core::terminal::CommandExit;
        if self.setup.source_epoch() != epoch {
            return;
        }
        if completion.exit == CommandExit::Code(0) {
            self.setup_command_check = Some((completion.run, step));
        }
        self.setup_flow.outcome = Some(crate::setup_flow::RunOutcome {
            step,
            exit: completion.exit,
            diagnosis: completion.diagnosis,
        });
        self.load_setup(cx);
    }

    /// Use a report without machine reads when drawing fixtures.
    #[cfg(feature = "screenshots")]
    pub(crate) fn show_setup_now(&mut self, report: Report) {
        self.pane = Pane::Setup;
        let generation = self.setup.begin();
        self.setup.finish(generation, report);
    }

    pub(crate) fn open_setup(&mut self, cx: &mut Context<Self>) {
        self.user_navigated();
        self.pane = Pane::Setup;
        self.setup_flow.enter(Screen::Welcome);
        cx.notify();
    }

    pub(crate) fn load_setup(&mut self, cx: &mut Context<Self>) {
        let scope = if self.pane == Pane::Setup {
            self.setup_flow
                .step()
                .map_or(CheckScope::Full, Step::check_scope)
        } else {
            CheckScope::Full
        };
        if self.setup.loading && self.setup_flow.checking_scope == Some(scope) {
            self.setup.refresh_again = true;
            return;
        }
        if self.setup_command_running() {
            return;
        }
        let generation = self.setup.begin();
        self.setup_flow.checking_scope = Some(scope);
        self.setup.refresh_again = false;
        self.setup_flow.advance_at = None;
        if !self.live {
            let report = self.source.setup_for(scope);
            self.setup_checked(generation, report, cx);
            return;
        }
        let source = self.source.clone();
        cx.spawn(async move |this, cx| {
            let report = cx
                .background_executor()
                .spawn(async move { source.setup_for(scope) })
                .await;
            let _ = this.update(cx, |this, cx| this.setup_checked(generation, report, cx));
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn setup_checked(
        &mut self,
        generation: u64,
        report: Report,
        cx: &mut Context<Self>,
    ) {
        if !self.setup.is_current(generation) {
            return;
        }
        let scope = self.setup_flow.checking_scope.take().unwrap_or_default();
        let report = report.with_prior(&self.setup.report, scope);
        let needed = report.needed();
        self.setup.finish(generation, report);
        if std::mem::take(&mut self.setup_on_launch) && needed {
            self.pane = Pane::Setup;
        }
        if self.setup.report.force_cli_gate
            && !self.setup.report.cli_ready()
            && self.pane == Pane::Project
        {
            self.pane = Pane::Setup;
        }
        if self.pane == Pane::Setup {
            self.setup_flow.reconcile(&self.setup);
        }
        if std::mem::take(&mut self.setup.refresh_again) {
            self.load_setup(cx);
        } else {
            self.setup.pending_fix = false;
            #[cfg(hack_terminal)]
            if let Some((run, step)) = self.setup_command_check.take() {
                let result = if self.setup_flow.evidence(step, &self.setup) == StepState::Passed {
                    Ok(())
                } else {
                    Err(format!("{} still needs a passing check.", step.name()))
                };
                self.command_checked(run, result, cx);
            }
            self.schedule_setup_advance(cx);
        }
        cx.notify();
    }

    fn schedule_setup_advance(&mut self, cx: &mut Context<Self>) {
        if self.pane != Pane::Setup
            || self.setup_flow.stay
            || !self.setup_flow.can_advance(&self.setup)
        {
            return;
        }
        let start = std::time::Instant::now();
        self.setup_flow.advance_at = Some(start);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(ADVANCE_DELAY).await;
            let _ = this.update(cx, |this, cx| {
                if this.setup_flow.advance_at == Some(start) {
                    this.advance_setup(cx);
                }
            });
        })
        .detach();
    }

    pub(crate) fn user_navigated(&mut self) {
        self.setup_on_launch = false;
        self.setup_flow.advance_at = None;
    }

    pub(super) fn start_setup(&mut self, cx: &mut Context<Self>) {
        if !self.setup_command_running() {
            self.enter_setup_step(Step::Cli, cx);
        }
    }

    pub(super) fn reopen_setup_step(&mut self, step: Step, cx: &mut Context<Self>) {
        if !self.setup_command_running()
            && !self.setup.loading
            && self.setup_flow.can_open(step, &self.setup)
        {
            self.enter_setup_step(step, cx);
        }
    }

    fn enter_setup_step(&mut self, step: Step, cx: &mut Context<Self>) {
        self.setup_flow.enter(Screen::Step(step));
        self.load_setup(cx);
    }

    pub(super) fn stay_on_setup_step(&mut self, cx: &mut Context<Self>) {
        self.setup_flow.advance_at = None;
        self.setup_flow.stay = true;
        cx.notify();
    }

    pub(super) fn advance_setup(&mut self, cx: &mut Context<Self>) {
        if self.pane != Pane::Setup
            || self.setup_command_running()
            || !self.setup_flow.can_advance(&self.setup)
        {
            return;
        }
        if let Some(step) = self.setup_flow.step() {
            self.setup_flow
                .enter(self.setup_flow.next_screen(step, &self.setup));
            self.check_next_setup_step(cx);
        }
    }

    pub(super) fn skip_setup(&mut self, step: Step, cx: &mut Context<Self>) {
        if !self.setup_command_running() && self.setup_flow.can_skip(step, &self.setup) {
            self.setup_flow.skip(step, &mut self.setup);
            self.check_next_setup_step(cx);
        }
    }

    fn check_next_setup_step(&mut self, cx: &mut Context<Self>) {
        if self.setup_flow.step().is_some() {
            self.load_setup(cx);
        }
        cx.notify();
    }

    pub(super) fn retry_setup_check(&mut self, cx: &mut Context<Self>) {
        self.setup_flow.outcome = None;
        self.setup_flow.stay = false;
        self.setup_flow.terminal_notice = None;
        self.load_setup(cx);
    }

    pub(super) fn finish_setup(&mut self, cx: &mut Context<Self>) {
        if self.setup_flow.screen == Screen::Done
            && self.setup_flow.first_unresolved(&self.setup).is_none()
            && !self.setup.loading
            && !self.setup.action_busy
        {
            self.pane = Pane::Project;
            cx.notify();
        }
    }

    fn setup_offers(&self, remedy: &Remedy) -> bool {
        self.pane == Pane::Setup
            && self
                .setup_flow
                .step()
                .and_then(|step| step.remedy_card(&self.setup.report))
                .is_some_and(|card| card.status == Status::NeedsAttention && &card.remedy == remedy)
    }

    /// One of the fixed daemon actions, only while a card offers it.
    pub(super) fn run_setup_action(&mut self, action: SafeAction, cx: &mut Context<Self>) {
        let offered = self.setup_offers(&Remedy::Run(action));
        if self.setup.action_busy
            || self.machine.busy()
            || self.setup.loading
            || !self.setup.report.cli_ready()
            || !offered
        {
            return;
        }
        if !self.live {
            self.setup.result = Some("Fixture: no action executed".into());
            cx.notify();
            return;
        }
        let Some(ticket) = self.machine.try_begin(Holder::Setup) else {
            return;
        };
        self.setup.result = None;
        self.setup_flow.terminal_notice = None;
        self.setup.action_busy = true;
        let epoch = self.setup.source_epoch();
        let source = self.source.clone();
        let checked = self.setup.report.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { source.setup_action(action, &checked) })
                .await;
            let _ = this.update(cx, |this, cx| {
                // Started under a CLI the app has since switched away from.
                if this.setup.source_epoch() != epoch {
                    return;
                }
                this.machine.finish(ticket);
                this.setup.action_busy = false;
                this.setup.result = Some(result);
                this.setup.pending_fix = true;
                this.load_setup(cx);
            });
        })
        .detach();
        cx.notify();
    }

    /// Hand an admin step to the user's terminal: it shows the command and
    /// waits for Enter. Launching proves nothing; checks run again after.
    pub(super) fn open_setup_terminal(&mut self, args: Vec<String>, cx: &mut Context<Self>) {
        use hack_desktop_core::terminal::{Platform, Script, SystemLauncher, linux_adapter};
        let offered = self.setup_offers(&Remedy::Admin(args.clone()));
        if self.setup.action_busy
            || self.machine.busy()
            || self.setup.loading
            || !self.setup.report.cli_ready()
            || !offered
        {
            return;
        }
        if !self.live {
            self.setup.result = Some("Fixture: no terminal opened".into());
            cx.notify();
            return;
        }
        let command = self.setup.report.command(args);
        // Not admitted through the machine gate: the app only opens the
        // terminal; the command runs there, under the user's control, for as
        // long as they take, and the app cannot see it finish. It does wait
        // for a machine action the app runs itself (checked above), and
        // checks again when the user comes back.
        self.setup.result = None;
        self.setup_flow.terminal_notice = None;
        self.setup.action_busy = true;
        let epoch = self.setup.source_epoch();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let spec = command?;
                    let adapter = linux_adapter();
                    if !cfg!(target_os = "macos") && adapter.is_none() {
                        return Err("No terminal adapter (xdg-terminal-exec); use Copy command".into());
                    }
                    let platform = if cfg!(target_os = "macos") {
                        Platform::Mac
                    } else {
                        Platform::Linux
                    };
                    Script::create(&std::env::temp_dir(), &spec)?.open(
                        platform,
                        adapter.as_deref(),
                        &SystemLauncher,
                    )
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.setup.source_epoch() != epoch {
                    return;
                }
                this.setup.action_busy = false;
                this.setup.pending_fix = result.is_ok();
                let notice = match result {
                    Ok(()) => "Press Enter in your terminal to run the command. Check again when it finishes.".into(),
                    Err(error) => {
                        let notice = error.lines().next().unwrap_or("Couldn’t open the terminal. Use Copy.").to_owned();
                        this.setup.result = Some(error);
                        notice
                    }
                };
                this.setup_flow.terminal_notice = Some(notice);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

// A headless app needs GPUI's test support (the `screenshots` feature).
#[cfg(all(test, feature = "screenshots"))]
mod tests {
    use std::sync::Arc;

    use gpui_kit::{AppContext as _, HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;

    use super::*;

    fn app() -> (HeadlessAppContext, gpui_kit::Entity<HackApp>) {
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
                    cx.new(|cx| {
                        HackApp::new(Arc::new(FixtureSource(Fixture::Running)), false, window, cx)
                    })
                })
            })
            .expect("open a headless window");
        (cx, app)
    }

    #[test]
    fn setup_starts_at_welcome_and_open_hack_requires_completion() {
        let (mut cx, app) = app();
        cx.update(|cx| app.update(cx, |a, cx| a.open_setup(cx)));
        assert_eq!(
            cx.update(|cx| app.read(cx).setup_flow.screen),
            Screen::Welcome
        );
        cx.update(|cx| app.update(cx, |a, cx| a.start_setup(cx)));
        assert!(cx.update(|cx| app.read(cx).setup.report.cli_ready()));
        cx.update(|cx| app.update(cx, |a, cx| a.finish_setup(cx)));
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Setup);
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.show_setup_now(hack_desktop_core::setup_fixtures::load("ready").unwrap());
                a.setup_flow.enter(Screen::Done);
                a.finish_setup(cx);
            })
        });
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Project);
    }

    #[test]
    fn starting_setup_does_not_wait_for_an_in_flight_full_check() {
        let (mut cx, app) = app();
        let old_generation = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_setup(cx);
                a.setup_flow.checking_scope = Some(CheckScope::Full);
                let generation = a.setup.begin();
                a.start_setup(cx);
                generation
            })
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                assert!(!a.setup.loading, "the scoped CLI check finished");
                assert!(a.setup.report.cli_ready());
                a.setup_checked(
                    old_generation,
                    hack_desktop_core::setup_fixtures::load("missing-cli").unwrap(),
                    cx,
                );
                assert!(
                    a.setup.report.cli_ready(),
                    "the old full check did not overwrite the CLI check"
                );
            })
        });
    }

    #[test]
    fn a_pass_waits_two_seconds_and_stay_cancels_the_advance() {
        let (mut cx, app) = app();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_setup(cx);
                a.start_setup(cx);
            })
        });
        cx.run_until_parked();
        cx.advance_clock(ADVANCE_DELAY - std::time::Duration::from_millis(1));
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| app.read(cx).setup_flow.step()),
            Some(Step::Cli)
        );
        cx.update(|cx| app.update(cx, |a, cx| a.stay_on_setup_step(cx)));
        cx.advance_clock(ADVANCE_DELAY);
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| app.read(cx).setup_flow.step()),
            Some(Step::Cli)
        );

        cx.update(|cx| app.update(cx, |a, cx| a.retry_setup_check(cx)));
        cx.run_until_parked();
        cx.advance_clock(ADVANCE_DELAY);
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| app.read(cx).setup_flow.step()),
            Some(Step::Daemon)
        );
    }

    /// A launch check that finishes after the user opened something (the
    /// drive's select, Logs, host shell) leaves the window where it is.
    #[test]
    fn a_late_launch_check_never_replaces_what_the_user_opened() {
        let (mut cx, app) = app();
        let partial = hack_desktop_core::setup_fixtures::load("partial").expect("fixture");
        assert!(partial.needed(), "the fixture has something to do");
        // Launch: the check is in flight and nobody has moved yet.
        let generation = cx.update(|cx| {
            app.update(cx, |a, _| {
                a.setup_on_launch = true;
                a.setup.begin()
            })
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| a.select_project("storefront".into(), cx));
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| a.setup_checked(generation, partial.clone(), cx));
        });
        assert_eq!(
            cx.update(|cx| app.read(cx).pane),
            Pane::Project,
            "the project the user selected stays on screen"
        );
        // A detail tab the user clicks counts as well.
        let (mut cx, app) = super::tests::app();
        let generation = cx.update(|cx| {
            app.update(cx, |a, _| {
                a.setup_on_launch = true;
                a.setup.begin()
            })
        });
        cx.update(|cx| app.update(cx, |a, cx| a.set_tab(2, cx)));
        cx.update(|cx| {
            app.update(cx, |a, cx| a.setup_checked(generation, partial.clone(), cx));
        });
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Project);
        // Without any navigation, the launch check still opens setup.
        let (mut cx, app) = super::tests::app();
        let generation = cx.update(|cx| {
            app.update(cx, |a, _| {
                a.setup_on_launch = true;
                a.setup.begin()
            })
        });
        cx.update(|cx| app.update(cx, |a, cx| a.setup_checked(generation, partial, cx)));
        assert_eq!(cx.update(|cx| app.read(cx).pane), Pane::Setup);
    }

    /// The minute tick checks a shown Setup pane again once its result is
    /// ten minutes old, and leaves a fresh one alone.
    #[test]
    fn a_setup_pane_left_open_is_checked_again_after_ten_minutes() {
        let (mut cx, app) = app();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_setup(cx);
                a.load_setup(cx);
            })
        });
        let first = cx
            .update(|cx| app.read(cx).setup.checked_at)
            .expect("checked");
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.window_visible = true;
                a.minute_tick(cx);
            });
        });
        assert_eq!(
            cx.update(|cx| app.read(cx).setup.checked_at),
            Some(first),
            "fresh: not checked again"
        );
        let old = first
            .checked_sub(hack_desktop_core::setup::RECHECK_EVERY)
            .expect("clock");
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.setup.checked_at = Some(old);
                a.minute_tick(cx);
            });
        });
        cx.run_until_parked();
        let after = cx
            .update(|cx| app.read(cx).setup.checked_at)
            .expect("checked");
        assert!(after > old, "checked again");
        // Not when another pane is shown.
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.pane = Pane::Project;
                a.setup.checked_at = Some(old);
                a.minute_tick(cx);
            });
        });
        assert_eq!(cx.update(|cx| app.read(cx).setup.checked_at), Some(old));
    }

    #[test]
    fn setup_is_checked_again_when_the_window_regains_focus() {
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
        let (window, app) = cx
            .update(|cx| {
                gpui_kit::open_window(options, cx, |window, cx| {
                    cx.new(|cx| {
                        let mut a = HackApp::new(
                            Arc::new(FixtureSource(Fixture::Running)),
                            false,
                            window,
                            cx,
                        );
                        a.watch_window(window, cx);
                        a.show_setup_now(
                            hack_desktop_core::setup_fixtures::load("partial").expect("fixture"),
                        );
                        a
                    })
                })
            })
            .expect("open a headless window");
        let before = cx.update(|cx| app.read(cx).setup.checked_at);
        cx.update_window(window, |_, w, _| w.activate_window())
            .expect("activate");
        cx.run_until_parked();
        let after = cx.update(|cx| app.read(cx).setup.checked_at);
        assert_ne!(before, after, "focus coming back checks setup again");
    }

    #[test]
    fn a_skip_lasts_for_the_session_and_the_cli_cannot_be_skipped() {
        let (mut cx, app) = app();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.open_setup(cx);
                a.load_setup(cx);
            })
        });
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.setup_flow.enter(Screen::Step(Step::Cli));
                a.skip_setup(Step::Cli, cx);
                a.setup_flow.enter(Screen::Step(Step::Daemon));
                a.skip_setup(Step::Daemon, cx);
            })
        });
        let skipped = cx.update(|cx| app.read(cx).setup.skipped.clone());
        assert!(!skipped.contains("cli"));
        assert!(skipped.contains("daemon"));
        cx.update(|cx| app.update(cx, |a, cx| a.load_setup(cx)));
        assert!(cx.update(|cx| app.read(cx).setup.skipped.contains("daemon")));
    }

    #[test]
    fn fixtures_never_run_an_action_or_open_a_terminal() {
        let (mut cx, app) = app();
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.show_setup_now(
                    hack_desktop_core::setup_fixtures::load("partial").expect("fixture"),
                );
                a.setup_flow.enter(Screen::Step(Step::Daemon));
                a.run_setup_action(SafeAction::StartDaemon, cx);
            })
        });
        assert_eq!(
            cx.update(|cx| app.read(cx).setup.result.clone()).as_deref(),
            Some("Fixture: no action executed")
        );
        cx.update(|cx| {
            app.update(cx, |a, cx| {
                let card = a
                    .setup
                    .report
                    .cards
                    .iter_mut()
                    .find(|card| card.id == Step::Domains.id())
                    .unwrap();
                card.status = Status::Unknown;
                let Remedy::Admin(args) = card.remedy.clone() else {
                    panic!("expected an admin remedy")
                };
                a.setup_flow.enter(Screen::Step(Step::Domains));
                a.setup.result = None;
                a.open_setup_terminal(args.clone(), cx);
                assert!(
                    a.setup.result.is_none(),
                    "an unchecked card does not open a terminal"
                );
                let card = a
                    .setup
                    .report
                    .cards
                    .iter_mut()
                    .find(|card| card.id == Step::Domains.id())
                    .unwrap();
                card.status = Status::NeedsAttention;
                a.open_setup_terminal(args, cx);
                assert_eq!(
                    a.setup.result.as_deref(),
                    Some("Fixture: no terminal opened")
                );
            })
        });
    }
}

#[cfg(all(test, feature = "screenshots"))]
mod gate_tests {
    use super::*;
    use gpui_kit::{AppContext as _, HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_core::source::FixtureSource;
    use std::sync::Arc;

    #[test]
    fn a_setup_action_waits_while_hackd_is_being_recovered_from_the_project_pane() {
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
                    cx.new(|cx| {
                        HackApp::new(Arc::new(FixtureSource(Fixture::Running)), false, window, cx)
                    })
                })
            })
            .unwrap();
        let report = hack_desktop_core::setup_fixtures::NAMES
            .iter()
            .filter_map(|n| hack_desktop_core::setup_fixtures::load(n))
            .find(|r| {
                r.cli_ready()
                    && r.cards
                        .iter()
                        .any(|c| matches!(c.remedy, Remedy::Run(_)) && c.status != Status::Passed)
            })
            .expect("a setup fixture that offers a Run action");
        let action = report
            .cards
            .iter()
            .find_map(|c| match c.remedy {
                Remedy::Run(a) if c.status != Status::Passed => Some(a),
                _ => None,
            })
            .unwrap();
        let result = cx.update(|cx| {
            app.update(cx, |a, cx| {
                a.pane = Pane::Setup;
                a.setup_flow.enter(Screen::Step(match action {
                    SafeAction::StartDaemon => Step::Daemon,
                    SafeAction::InstallDaemon => Step::Login,
                }));
                a.setup.report = report;
                let recovery = a.machine.try_begin(Holder::Recovery).unwrap();
                a.run_setup_action(action, cx);
                let refused = (a.setup.result.clone(), a.setup.action_busy);
                assert!(
                    a.machine.finish(recovery),
                    "Setup did not take or release the gate"
                );
                a.run_setup_action(action, cx);
                (refused, a.setup.result.clone())
            })
        });
        assert_eq!(
            result.0,
            (None, false),
            "refused while recovery holds the gate"
        );
        assert_eq!(
            result.1.as_deref(),
            Some("Fixture: no action executed"),
            "runs once the gate is free"
        );
    }
}
