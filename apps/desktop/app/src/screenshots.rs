//! Offscreen rendering of every fixture state, light and dark, to PNG.
//!
//! Uses GPUI's headless renderer (WGPU on Linux, Metal on macOS). No window
//! is shown and no display server is needed beyond a Vulkan device (a
//! software one such as lavapipe works).

use std::path::Path;
use std::sync::Arc;

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, HeadlessAppContext, WindowOptions};
use hack_desktop_core::fixtures::{self, Fixture};
use hack_desktop_core::logs::fixtures::LogsFixture;

use crate::view::HackApp;

fn fixture_context() -> HeadlessAppContext {
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(hack_desktop_ui::icons::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        hack_desktop_ui::tokens::init(cx);
        #[cfg(target_os = "linux")]
        crate::theme::capture_fonts(cx);
    });
    cx
}

#[cfg(hack_terminal)]
pub(crate) fn run_command_drawer(dir: &Path) {
    crate::command_control::capture(dir, &mut fixture_context());
}

pub fn run(dir: &Path, fixture: Option<Fixture>) {
    std::fs::create_dir_all(dir).expect("create screenshot dir");
    let mut cx = fixture_context();
    // Every app fixture, then every Logs tab fixture on its base project state.
    let mut shots: Vec<(&'static str, Fixture, Option<LogsFixture>)> =
        Fixture::ALL.iter().map(|f| (f.name(), *f, None)).collect();
    for l in LogsFixture::ALL {
        let base = if l == LogsFixture::Stopped {
            Fixture::Stopped
        } else {
            Fixture::Running
        };
        shots.push((l.name(), base, Some(l)));
    }
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        for &(name, f, logs) in shots
            .iter()
            .filter(|(_, f, logs)| fixture.is_none_or(|selected| selected == *f && logs.is_none()))
        {
            cx.update(|cx| Theme::change(mode, None, cx));
            let opts = WindowOptions {
                focus: false,
                show: false,
                ..crate::health_fixtures::window_options(Some(f))
            };
            let (handle, _app) = cx
                .update(|cx| {
                    gpui_kit::open_window(opts, cx, |window, cx| {
                        cx.new(|cx| {
                            let mut app =
                                HackApp::new(crate::source_for(Some(f)), false, window, cx);
                            app.select(fixtures::selected(f));
                            crate::health_fixtures::open(&mut app, f, window, cx);
                            // No controls are clicked during capture. Show the
                            // enabled appearance of checked fixture commands.
                            if matches!(f, Fixture::DoctorHealth | Fixture::ErrorsSheet) {
                                app.live = true;
                            }
                            if fixtures::loads_doctor(f) {
                                app.show_doctor_now();
                                if !fixtures::opens_doctor(f) {
                                    app.show_project();
                                }
                            }
                            if fixtures::opens_hackd(f) {
                                app.show_hackd_now();
                            }
                            if fixtures::opens_upgrade(f) {
                                app.show_upgrade_now();
                            }
                            if fixtures::loads_usage(f) {
                                app.show_usage_now();
                            }
                            if f.name().starts_with("catalog-") {
                                app.show_catalog_fixture(f.name(), window, cx);
                            }
                            if f.name().starts_with("changes-") {
                                app.show_changes_fixture(f.name());
                            }
                            if f.name().starts_with("copies-") {
                                app.show_copies_fixture(f.name());
                            }
                            if f.name().starts_with("env-") {
                                app.show_env_fixture(f.name(), window, cx);
                            }
                            if f == Fixture::Files {
                                app.show_files_fixture(window, cx);
                            }
                            if matches!(
                                f,
                                Fixture::DaemonDown | Fixture::DaemonMismatch | Fixture::HackdOff
                            ) {
                                app.simulate_daemon_unavailable(f == Fixture::DaemonMismatch);
                            }
                            if let Some(a) = fixtures::local(f).in_flight {
                                app.simulate_in_flight(a);
                            }
                            if let Some(l) = logs {
                                app.show_logs_fixture(l, window, cx);
                            }
                            app
                        })
                    })
                })
                .expect("open offscreen window");
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .expect("render");
            // The terminal panel's tabs start on the first frame; let their
            // output arrive, then draw again.
            #[cfg(hack_terminal)]
            cx.update_window(handle, |_, window, cx| {
                if f == Fixture::Files {
                    _app.update(cx, HackApp::toggle_panel);
                    window.render_frame(cx);
                }
                _app.update(cx, |app, cx| {
                    app.settle_terminals(cx);
                    if f == Fixture::DoctorFixAll {
                        app.settle_command_fixture(cx);
                    }
                });
                window.render_frame(cx);
                window.render_frame(cx);
            })
            .expect("settle");
            let img = cx
                .capture_screenshot(handle)
                .expect("offscreen rendering must be available");
            let suffix = if mode == ThemeMode::Dark {
                "dark"
            } else {
                "light"
            };
            let path = dir.join(format!("{name}-{suffix}.png"));
            img.save(&path).expect("write png");
            println!("{}", path.display());
            cx.update_window(handle, |_, window, _cx| {
                #[cfg(hack_terminal)]
                if f == Fixture::DoctorFixAll {
                    _app.update(_cx, |app, cx| app.reset_command_drawer(window, cx));
                }
                window.remove_window();
            })
            .ok();
        }
    }
    if fixture.is_none() {
        setup_shots(dir, &mut cx);
    }
}

/// Every setup fixture (`setup_fixtures::NAMES`), light and dark, as
/// `setup-<name>-<light|dark>.png`.
fn setup_shots(dir: &Path, cx: &mut HeadlessAppContext) {
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        for name in hack_desktop_core::setup_fixtures::NAMES {
            cx.update(|cx| Theme::change(mode, None, cx));
            let opts = WindowOptions {
                focus: false,
                show: false,
                ..crate::window_options()
            };
            let report = hack_desktop_core::setup_fixtures::load(name).expect("setup fixture");
            let (handle, _app) = cx
                .update(|cx| {
                    gpui_kit::open_window(opts, cx, |window, cx| {
                        cx.new(|cx| {
                            // The window behind setup: no CLI for that card,
                            // an empty registry otherwise.
                            let base = if name == "missing-cli" {
                                Fixture::CliMissing
                            } else {
                                Fixture::Empty
                            };
                            let mut app =
                                HackApp::new(crate::source_for(Some(base)), false, window, cx);
                            app.show_setup_now(report);
                            app
                        })
                    })
                })
                .expect("open offscreen window");
            cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                .expect("render");
            let img = cx
                .capture_screenshot(handle)
                .expect("offscreen rendering must be available");
            let suffix = if mode == ThemeMode::Dark {
                "dark"
            } else {
                "light"
            };
            let path = dir.join(format!("setup-{name}-{suffix}.png"));
            img.save(&path).expect("write png");
            println!("{}", path.display());
            cx.update_window(handle, |_, window, _| window.remove_window())
                .ok();
        }
    }
}

/// One step of the click-through: a name and what the click does.
type Step = (
    &'static str,
    fn(&mut HackApp, &mut gpui_kit::Window, &mut gpui_kit::Context<HackApp>),
);

/// Render the window after each step of a short click-through on the
/// `running` fixture, dark: search, select, start, tabs, Doctor. Each step
/// calls the method its click handler calls; it is not a synthetic mouse
/// event. Frames are written as `NN-step.png`.
pub fn sequence(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create sequence dir");
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(hack_desktop_ui::icons::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(hack_desktop_ui::tokens::init);
    cx.update(crate::view::bind_keys);
    cx.update(|cx| Theme::change(ThemeMode::Dark, None, cx));
    let f = Fixture::Running;
    let opts = WindowOptions {
        focus: false,
        show: false,
        ..crate::window_options()
    };
    let (handle, view) = cx
        .update(|cx| {
            gpui_kit::open_window(opts, cx, |window, cx| {
                cx.new(|cx| {
                    let mut app = HackApp::new(crate::source_for(Some(f)), false, window, cx);
                    app.select(fixtures::selected(f));
                    app
                })
            })
        })
        .expect("open offscreen window");
    let steps: Vec<Step> = vec![
        ("open", |_, _, _| {}),
        ("search-bill", |app, window, cx| {
            app.type_search("bill", window, cx)
        }),
        ("select-billing-api", |app, window, cx| {
            app.type_search("", window, cx);
            app.select_project("billing-api".into(), cx);
        }),
        ("click-start", |app, _, cx| {
            app.run_action(hack_desktop_core::state::Action::Start, cx);
        }),
        ("select-storefront", |app, _, cx| {
            app.select_project("storefront".into(), cx);
        }),
        ("select-branch-feature-search", |app, _, cx| {
            app.select_instance(
                hack_desktop_core::viewmodel::InstanceKey::branch("storefront", "feature-search"),
                cx,
            );
        }),
        ("select-branch-fix-login", |app, _, cx| {
            app.select_instance(
                hack_desktop_core::viewmodel::InstanceKey::branch("storefront", "fix-login"),
                cx,
            );
        }),
        ("search-branch-name", |app, window, cx| {
            app.type_search("fix", window, cx)
        }),
        ("select-storefront-again", |app, window, cx| {
            app.type_search("", window, cx);
            app.select_project("storefront".into(), cx);
        }),
        ("tab-env", |app, _, cx| app.set_tab(2, cx)),
        ("tab-logs", |app, _, cx| app.set_tab(1, cx)),
        ("tab-services", |app, _, cx| app.set_tab(0, cx)),
        ("open-doctor", |app, _, cx| app.open_doctor(None, cx)),
    ];
    #[cfg(hack_terminal)]
    let steps = {
        let mut steps = steps;
        steps.extend::<[Step; 5]>([
            ("panel-back-to-storefront", |app, _, cx| {
                app.select_project("storefront".into(), cx);
            }),
            ("panel-new-tab-menu", |app, _, cx| {
                app.open_menu(crate::terminal::Menu::Main, cx);
            }),
            ("panel-maximized", |app, _, cx| {
                app.open_menu(crate::terminal::Menu::Main, cx);
                app.toggle_maximize(cx);
            }),
            ("panel-collapsed", |app, _, cx| {
                app.toggle_maximize(cx);
                app.toggle_panel(cx);
            }),
            ("panel-open-again", |app, _, cx| app.toggle_panel(cx)),
        ]);
        steps
    };
    for (i, (name, step)) in steps.into_iter().enumerate() {
        cx.update_window(handle, |_, window, cx| {
            view.update(cx, |app, cx| step(app, window, cx));
            window.render_frame(cx);
            #[cfg(hack_terminal)]
            {
                view.update(cx, |app, cx| app.settle_terminals(cx));
                window.render_frame(cx);
            }
        })
        .expect("step");
        let img = cx
            .capture_screenshot(handle)
            .expect("offscreen rendering must be available");
        let path = dir.join(format!("{i:02}-{name}.png"));
        img.save(&path).expect("write png");
        println!("{}", path.display());
    }
}

/// Render the four service detail states through the app's own fixture harness.
pub fn service_pane(dir: &Path) {
    use crate::service_view::{SERVICE_TAB_KEYS, ServiceMenu, ServiceTab};
    use gpui_kit::{Bounds, WindowBounds, px, size};
    use hack_desktop_core::viewmodel::InstanceKey;

    std::fs::create_dir_all(dir).expect("create service screenshot directory");
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(hack_desktop_ui::icons::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(gpui_kit::init);
    cx.update(crate::view::bind_keys);
    for (mode, suffix) in [(ThemeMode::Light, "light"), (ThemeMode::Dark, "dark")] {
        cx.update(|cx| Theme::change(mode, None, cx));
        let (handle, app) = cx
            .update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        focus: false,
                        show: false,
                        window_bounds: Some(WindowBounds::Windowed(Bounds {
                            origin: Default::default(),
                            size: size(px(1280.), px(800.)),
                        })),
                        ..crate::window_options()
                    },
                    cx,
                    |window, cx| {
                        cx.new(|cx| {
                            HackApp::new(
                                crate::source_for(Some(Fixture::Branches)),
                                false,
                                window,
                                cx,
                            )
                        })
                    },
                )
            })
            .expect("open service fixture");
        for (shot, tab, menu, key) in [
            ("before", None, None, None),
            ("m02-service-logs", Some(ServiceTab::Logs), None, None),
            (
                "m07-logs-menu",
                Some(ServiceTab::Logs),
                Some(ServiceMenu::LogOptions),
                Some(3),
            ),
            (
                "m06-service-info",
                Some(ServiceTab::Info),
                Some(ServiceMenu::Actions),
                Some(1),
            ),
            (
                "m04-service-terminal",
                Some(ServiceTab::Terminal),
                None,
                Some(4),
            ),
            ("service-stats", Some(ServiceTab::Stats), None, Some(2)),
            ("service-files", Some(ServiceTab::Files), None, Some(5)),
        ] {
            cx.update_window(handle, |_, window, cx| {
                if let Some(key) = key {
                    let keystroke = gpui_kit::Keystroke::parse(SERVICE_TAB_KEYS[key - 1])
                        .expect("service shortcut");
                    window.dispatch_keystroke(keystroke, cx);
                }
                app.update(cx, |app, cx| {
                    let key = InstanceKey::branch("storefront", "feature-search");
                    match tab {
                        None => app.select_instance(key, cx),
                        Some(ServiceTab::Logs) if menu.is_none() => {
                            app.select_service(key, "api".into(), window, cx);
                            app.logs.show_service_fixture();
                        }
                        #[cfg(hack_terminal)]
                        Some(ServiceTab::Terminal) => {
                            assert_eq!(app.service_pane.tab, ServiceTab::Terminal);
                            app.show_service_terminal_fixture(window, cx);
                        }
                        _ => {}
                    }
                    if let Some(tab) = tab {
                        assert_eq!(app.service_pane.tab, tab, "{shot}: service shortcut");
                    }
                });
                window.render_frame(cx);
                #[cfg(hack_terminal)]
                if tab == Some(ServiceTab::Terminal) {
                    app.update(cx, |app, cx| app.settle_terminals(cx));
                    window.render_frame(cx);
                }
                window.render_frame(cx);
                match menu {
                    Some(ServiceMenu::LogOptions) => window.click("service-log-options", cx),
                    Some(ServiceMenu::Actions) => window.click("service-actions", cx),
                    _ => {}
                }
                assert_eq!(app.read(cx).service_pane.menu, menu);
            })
            .expect("render service fixture");
            let path = dir.join(format!("{shot}-{suffix}.png"));
            cx.capture_screenshot(handle)
                .expect("read service screenshot")
                .save(&path)
                .expect("write service png");
            println!("{}", path.display());
            cx.update_window(handle, |_, window, cx| {
                if shot == "m02-service-logs" {
                    assert_eq!(app.read(cx).logs.model.service.as_deref(), Some("api"));
                    window.click("service-log-pause", cx);
                    assert!(app.read(cx).logs.model.paused);
                    window.click("service-log-pause", cx);
                    assert!(!app.read(cx).logs.model.paused);
                }
                if shot == "m07-logs-menu" {
                    window.click("log-all-services", cx);
                    assert!(app.read(cx).logs.model.service.is_none());
                    assert!(app.read(cx).service_pane.menu.is_none());
                }
                #[cfg(hack_terminal)]
                if shot == "m04-service-terminal" {
                    assert_eq!(app.read(cx).drive_tab_count(cx), Some(3));
                    let plus = window.find("term-new").bounds().origin.x;
                    window.click("term-new", cx);
                    window.render_frame(cx);
                    let plus_menu = window.find("term-menu").bounds().origin.x;
                    assert_eq!(plus_menu, plus);
                    window.click("term-dock-menu", cx);
                    window.render_frame(cx);
                    let more_menu = window.find("term-menu").bounds().origin.x;
                    assert!(more_menu > plus_menu);
                    window.click("term-dock-close", cx);
                    let drawer_key = if cfg!(target_os = "macos") {
                        "cmd-j"
                    } else {
                        "ctrl-shift-j"
                    };
                    window.press(drawer_key, cx);
                    assert_eq!(app.read(cx).drive_tab_count(cx), Some(3));
                }
            })
            .expect("exercise service pane controls");
        }
        cx.update_window(handle, |_, window, _| window.remove_window())
            .ok();
    }
}
