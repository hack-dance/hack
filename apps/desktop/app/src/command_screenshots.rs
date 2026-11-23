//! Native screenshots of the shared control and drawer with harmless PTY fixtures.
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Bounds, HeadlessAppContext, WindowBounds, WindowOptions, size};
use hack_desktop_core::fixtures::Fixture;
use hack_desktop_core::setup::{Remedy, Status};
use hack_desktop_core::setup_fixtures;

use super::*;

const FRAMES: [&str; 8] = [
    "h05-hackd-running",
    "h08-dns-needs-action",
    "h10-dns-password",
    "h11-dns-failed",
    "h12-dns-succeeded",
    "h13-drawer-closed-last-run",
    "h26-drawer-menu",
    "h13-successful-run-history",
];

pub(crate) fn capture(dir: &Path, cx: &mut HeadlessAppContext) {
    std::fs::create_dir_all(dir).expect("create command screenshot directory");
    for (mode, theme) in [(ThemeMode::Light, "light"), (ThemeMode::Dark, "dark")] {
        cx.update(|cx| Theme::change(mode, None, cx));
        for (index, frame) in FRAMES.into_iter().enumerate() {
            let options = WindowOptions {
                focus: false,
                show: false,
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Default::default(),
                    size: size(px(1280.), px(800.)),
                })),
                ..crate::window_options()
            };
            let (handle, app) = cx
                .update(|cx| {
                    gpui_kit::open_window(options, cx, |window, cx| {
                        cx.new(|cx| fixture(index, window, cx))
                    })
                })
                .expect("open command screenshot window");
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .expect("draw command");
            wait_for_frame(index, &app, cx);
            cx.update_window(handle, |_, window, cx| {
                app.update(cx, |app, cx| {
                    if matches!(index, 5 | 7) {
                        app.close_command_drawer(cx);
                    }
                    if index == 6 {
                        app.panels.command.menu = true;
                        cx.notify();
                    }
                });
                window.render_frame(cx);
                window.render_frame(cx);
            })
            .expect("draw finished command screenshot");
            cx.capture_screenshot(handle)
                .expect("capture command screenshot")
                .save(dir.join(format!("{frame}-{theme}.png")))
                .expect("write command screenshot");
            cx.update_window(handle, |_, window, cx| {
                app.update(cx, |app, cx| app.reset_command_drawer(window, cx));
                window.remove_window();
            })
            .expect("close screenshot window");
        }
    }
}

fn fixture(index: usize, window: &mut Window, cx: &mut Context<HackApp>) -> HackApp {
    let mut app = HackApp::new(crate::source_for(Some(Fixture::Empty)), false, window, cx);
    app.use_default_terminal_look();
    let daemon = index == 0;
    let id = if daemon { "daemon" } else { "routing" };
    let mut report = setup_fixtures::load("partial").expect("setup fixture");
    report.cli_program = Some("/usr/bin/true".into());
    report
        .cards
        .retain(|card| card.id == "cli" || card.id == id);
    let card = report
        .cards
        .iter_mut()
        .find(|card| card.id == id)
        .expect("fixture card");
    if !daemon {
        card.title = "Set up local domains".into();
        card.detail = "5 of 8 DNS pieces are set up.".into();
        card.status = Status::NeedsAttention;
        card.remedy = Remedy::Admin(vec!["global".into(), "install".into()]);
    }
    app.show_setup_now(report);
    if index == 1 {
        // Use checked fixture props to render the enabled control. No action is clicked.
        app.live = true;
        return app;
    }
    let script = match index {
        0 => {
            "printf '%s\\n' 'Starting hackd 5.0.0…' 'Waiting for hackd to answer'; IFS= read -r unused"
        }
        2 | 6 => {
            "printf '%s\\n' 'Installing local DNS and routing for *.hack'; /bin/stty -echo; printf '%s' '[sudo] password for alex: '; IFS= read -r unused"
        }
        3 | 5 => {
            "printf '%s\\n' 'Installing local DNS and routing for *.hack' 'error Port 53 is already used by another app.' 'hint Stop the other app, then try again.'; exit 1"
        }
        4 | 7 => {
            "printf '%s\\n' 'Installing local DNS and routing for *.hack' 'Local domains ready.'"
        }
        _ => unreachable!(),
    };
    let props = CommandControl {
        id: format!("setup:{id}"),
        label: if daemon {
            "hack daemon start"
        } else {
            "hack global install"
        }
        .into(),
        title: "Terminal".into(),
        availability: CommandAvailability::Ready(CommandSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
        }),
        size: CommandControlSize::Standard,
        cwd: None,
        expects_password: !daemon,
    };
    app.live = true;
    assert!(app.run_drawer_command(
        props,
        move |app, completion, cx| {
            if matches!(index, 4 | 7) && completion.exit == CommandExit::Code(0) {
                let mut checked = app.setup.report.clone();
                let card = checked
                    .cards
                    .iter_mut()
                    .find(|card| card.id == id)
                    .expect("fixture card");
                card.status = Status::Passed;
                card.detail = "All 8 DNS pieces are set up.".into();
                // Deliver a synthetic fresh check through the actual Setup
                // completion path used by the command control.
                let generation = app.setup.begin();
                app.setup_command_check = Some((completion.run, id.into()));
                app.setup_checked(generation, checked, cx);
            }
        },
        window,
        cx
    ));
    app
}

fn settle(app: &mut HackApp, cx: &mut Context<HackApp>) {
    if let Some(view) = app
        .panels
        .command
        .session
        .as_ref()
        .and_then(|p| p.read(cx).active())
        .cloned()
    {
        view.update(cx, |term, cx| {
            term.settle(Duration::from_millis(100), Duration::from_secs(2), cx)
        });
    }
}

fn wait_for_frame(index: usize, app: &Entity<HackApp>, cx: &mut HeadlessAppContext) {
    if index == 1 {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.update(|cx| app.update(cx, settle));
        let ready = cx.update(|cx| {
            let drawer = &app.read(cx).panels.command;
            let run = drawer.last.as_ref().expect("command fixture run");
            match index {
                0 => drawer
                    .session
                    .as_ref()
                    .and_then(|panel| panel.read(cx).active())
                    .and_then(|term| term.read(cx).output_text())
                    .is_some_and(|output| output.contains("Waiting for hackd to answer")),
                2 | 6 => run.waiting_for_password,
                _ => !run.running(),
            }
        });
        if ready {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "fixture {} did not reach its state",
            FRAMES[index]
        );
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use gpui_kit::AnyWindowHandle;
    use std::sync::Arc;

    pub(crate) fn open(index: usize) -> (HeadlessAppContext, AnyWindowHandle, Entity<HackApp>) {
        let mut cx = HeadlessAppContext::with_platform(
            Arc::new(gpui_kit::NoopTextSystem::new()),
            Arc::new(hack_desktop_ui::icons::Assets),
            || Ok(None),
        );
        cx.update(hack_desktop_ui::tokens::init);
        let (window, app) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        show: false,
                        focus: false,
                        ..WindowOptions::default()
                    },
                    cx,
                    |window, cx| cx.new(|cx| fixture(index, window, cx)),
                )
            })
            .unwrap();
        wait_for_frame(index, &app, &mut cx);
        (cx, window, app)
    }

    pub(crate) fn assert_rendered_status(
        cx: &mut HeadlessAppContext,
        window: AnyWindowHandle,
        id: &str,
        sidebar: &str,
        card: Option<&str>,
    ) {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(window.find(id.to_owned()).label(), Some(sidebar));
            if let Some(card) = card {
                assert_eq!(window.find(("setup-status", 1_usize)).label(), Some(card));
            }
        })
        .unwrap();
    }

    #[test]
    fn the_rendered_hackd_dot_matches_the_off_card_despite_a_green_project_read() {
        let (mut cx, window, app) = open(0);
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.hackd_tone_from_snapshot(),
                Some(hack_desktop_core::machine::Tone::Ok)
            );
            let card = &app.setup.report.cards[1];
            assert!(card.detail.contains("hackd off"));
        });
        assert_rendered_status(
            &mut cx,
            window,
            "hackd",
            "hackd: Needs attention",
            Some("Needs attention"),
        );
    }

    #[test]
    fn closing_hides_a_password_prompt_and_stop_releases_the_machine_gate() {
        let (mut cx, window, app) = open(2);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                let last = app.panels.command.last.as_ref().unwrap();
                assert!(last.waiting_for_password);
                app.close_command_drawer(cx);
                assert!(!app.panels.command.visible());
                assert!(app.machine.held_by(Holder::Command));
            })
        });
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| {
                assert!(app.toggle_command_drawer(window, cx));
                assert!(app.panels.command.visible());
                app.stop_drawer_command(cx);
            });
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let ended = cx.update(|cx| {
                app.update(cx, settle);
                !app.read(cx).machine.busy()
            });
            if ended {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Ctrl-C never stopped the fixture"
            );
        }
        cx.update(|cx| {
            let app = app.read(cx);
            let last = app.panels.command.last.as_ref().unwrap();
            assert!(app.panels.command.visible());
            assert!(matches!(
                last.phase,
                Phase::Ended {
                    exit: CommandExit::Signal(2) | CommandExit::Code(130),
                    ..
                }
            ));
        });
    }

    #[test]
    fn fresh_success_closes_after_the_delay_and_nonzero_exit_stays_open() {
        let (mut cx, window, app) = open(4);
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(matches!(
                app.panels.command.last.as_ref().unwrap().phase,
                Phase::Ended {
                    exit: CommandExit::Code(0),
                    check: Check::Closing,
                    ..
                }
            ));
        });
        cx.run_until_parked();
        cx.advance_clock(CLOSE_DELAY - Duration::from_millis(1));
        cx.run_until_parked();
        assert!(cx.update(|cx| app.read(cx).panels.command.visible()));
        cx.advance_clock(Duration::from_millis(2));
        cx.run_until_parked();
        assert!(!cx.update(|cx| app.read(cx).panels.command.visible()));
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| {
                let card = app
                    .setup
                    .report
                    .cards
                    .iter()
                    .find(|c| c.id == "routing")
                    .unwrap();
                assert_eq!(card.status, Status::Passed);
                let ui = app.ui(cx);
                assert!(render_history("setup:routing", app, &ui, cx).is_some());
                assert!(render_history("setup:trust", app, &ui, cx).is_none());
                app.show_command_output("setup:routing", window, cx);
                assert!(app.panels.command.visible());
                let terminal = app.panels.command.session.as_ref().unwrap().read(cx);
                let text = terminal.active().unwrap().read(cx).output_text().unwrap();
                assert!(text.contains("Local domains ready."));
            });
        })
        .unwrap();

        let (mut cx, _, app) = open(3);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                let run = app.panels.command.last.as_ref().unwrap();
                assert!(matches!(
                    run.phase,
                    Phase::Ended {
                        exit: CommandExit::Code(1),
                        ..
                    }
                ));
                let id = run.id;
                app.command_checked(id, Ok(()), cx);
                assert!(app.panels.command.visible());
                assert!(matches!(
                    app.panels.command.last.as_ref().unwrap().phase,
                    Phase::Ended {
                        check: Check::Pending,
                        ..
                    }
                ));
            })
        });
    }
}
