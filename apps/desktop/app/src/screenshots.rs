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
    cx.update(gpui_kit::init);
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
                window_bounds: if f == Fixture::GroupedSidebar {
                    Some(gpui_kit::WindowBounds::Windowed(gpui_kit::Bounds::new(
                        gpui_kit::point(gpui_kit::px(0.), gpui_kit::px(0.)),
                        gpui_kit::size(gpui_kit::px(1280.), gpui_kit::px(800.)),
                    )))
                } else {
                    crate::window_options().window_bounds
                },
                ..crate::window_options()
            };
            let (handle, _app) = cx
                .update(|cx| {
                    gpui_kit::open_window(opts, cx, |window, cx| {
                        cx.new(|cx| {
                            let mut app =
                                HackApp::new(crate::source_for(Some(f)), false, window, cx);
                            app.select(fixtures::selected(f));
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
                _app.update(cx, |app, cx| app.settle_terminals(cx));
                window.render_frame(cx);
                window.render_frame(cx);
            })
            .expect("settle");
            if f == Fixture::GroupedSidebar {
                cx.update_window(handle, |_, window, cx| {
                    window.click("copy-storefront-1", cx);
                    assert_eq!(
                        _app.read(cx)
                            .model
                            .selected_key()
                            .and_then(|key| key.branch),
                        Some("feature-search".into()),
                    );
                    _app.update(cx, |app, _cx| {
                        app.show_usage_now();
                        #[cfg(hack_terminal)]
                        app.toggle_panel(_cx);
                    });
                    window.render_frame(cx);
                    assert!(window.find(("other-copy", 2_usize)).visible());
                    window.hover("service-web", cx);
                })
                .expect("select worktree and hover a service");
            }
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
            if f == Fixture::GroupedSidebar {
                cx.update_window(handle, |_, window, cx| {
                    window.hover("service-api", cx);
                    window.within("service-api").click("select-service", cx);
                    let selected = _app
                        .read(cx)
                        .model
                        .selected_service()
                        .expect("service selected");
                    assert_eq!(selected.name, "api");
                    assert_eq!(
                        selected.destination,
                        hack_desktop_core::viewmodel::ServiceDestination::Logs
                    );
                    window.within("service-api").click("service-more", cx);
                    assert_eq!(_app.read(cx).sidebar_menu.as_deref(), Some("api"));
                    assert!(window.try_find(("service-command", 4_usize)).is_some());
                })
                .expect("open the service row menu");
                let path = dir.join(format!("service-row-menu-{suffix}.png"));
                cx.capture_screenshot(handle)
                    .expect("capture service row menu")
                    .save(&path)
                    .expect("write service menu png");
                println!("{}", path.display());
                cx.update_window(handle, |_, window, cx| {
                    window.click(("service-command", 3_usize), cx);
                    let selection = _app
                        .read(cx)
                        .model
                        .selected_service()
                        .expect("service selected");
                    assert_eq!(selection.name, "api");
                    assert_eq!(
                        selection.destination,
                        hack_desktop_core::viewmodel::ServiceDestination::Files
                    );
                    assert_eq!(_app.read(cx).tab, crate::files_view::FILES_TAB);
                    window.hover("service-web", cx);
                    window.within("service-web").click("service-more", cx);
                    window.click(("service-command", 3_usize), cx);
                    let app = _app.read(cx);
                    let detail = app.model.detail().expect("copy detail");
                    assert_eq!(app.files_service(&detail).map(String::as_str), Some("web"));
                    window.click("copy-storefront-3", cx);
                    assert!(_app.read(cx).model.selected_service().is_none());
                    assert!(window.try_find("service-api").is_none());
                    assert!(window.try_find("service-deploy").is_some());
                    assert_eq!(
                        _app.read(cx).model.detail().and_then(|d| d.url),
                        Some("https://release-2.storefront.hack".into())
                    );
                    window.click("copy-storefront-1", cx);
                    window.hover("service-api", cx);
                    window.within("service-api").click("service-more", cx);
                    window.click(("service-command", 1_usize), cx);
                    assert_eq!(_app.read(cx).logs.model.service.as_deref(), Some("api"));
                    _app.update(cx, |app, cx| {
                        let mut snapshot = app.model.snapshot().expect("fixture snapshot").clone();
                        let project = snapshot
                            .projects
                            .projects
                            .iter_mut()
                            .find(|project| project.name == "storefront")
                            .expect("fixture project");
                        let instance = project
                            .branch_runtime
                            .iter_mut()
                            .find(|runtime| runtime.branch == "feature-search")
                            .expect("fixture branch");
                        instance
                            .runtime
                            .services
                            .retain(|service| service.service != "api");
                        let refresh = app.model.begin_refresh();
                        assert!(app.apply_refresh(refresh, Ok(snapshot), cx));
                        assert!(app.model.selected_service().is_none());
                        assert!(app.logs.model.service.is_none());
                    });
                })
                .expect("activate Files and switch to a stopped copy");
            }
            cx.update_window(handle, |_, window, _| window.remove_window())
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
    cx.update(gpui_kit::init);
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
