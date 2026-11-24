//! Hack desktop app (unsupported preview, HACK-2214).
//!
//! ```text
//! hack-desktop                         live: hackd + `hack ... --json`
//! hack-desktop --fixtures running      canned data for one designed state
//! hack-desktop --list-fixtures
//! hack-desktop --theme light|dark      default: follow the system
//! hack-desktop --sequence <dir>        (feature `screenshots`) render the
//!                                      window after each step of a short
//!                                      click-through, on fixtures
//! hack-desktop --screenshots <dir>     (feature `screenshots`) render every
//!                                      fixture, light and dark, offscreen
//! hack-desktop --command-screenshots <dir>
//!                                      render only the shared drawer fixtures
//! hack-desktop --drive <steps> [--hidden]
//!                                      (feature `terminal`) run a steps file
//!                                      in the real window, quit, and report
//!                                      what the terminal tabs left running
//!                                      (see `drive.rs`)
//! ```

mod changes_view;
mod clipboard;
#[cfg(hack_terminal)]
mod command_control;
mod copies_view;
mod doctor_view;
#[cfg(hack_terminal)]
mod drive;
mod env_view;
mod files_view;
mod follow_up_view;
mod health_commands;
mod health_fixtures;
mod health_model;
mod logs_view;
mod machine_view;
#[cfg(feature = "screenshots")]
mod screenshots;
mod service_catalog;
mod service_view;
mod setup_view;
mod sidebar_view;
mod stats_view;
#[cfg(hack_terminal)]
mod terminal;
mod theme;
mod upgrade_view;
mod usage_view;
mod view;

use std::sync::Arc;

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};
use hack_desktop_core::fixtures::{self, Fixture};
use hack_desktop_core::source::{FixtureSource, LiveSource, Source};

pub(crate) struct Args {
    pub fixture: Option<Fixture>,
    pub logs_fixture: Option<hack_desktop_core::logs::fixtures::LogsFixture>,
    pub theme: Option<ThemeMode>,
    pub screenshots: Option<std::path::PathBuf>,
    pub service_screenshots: Option<std::path::PathBuf>,
    pub command_screenshots: Option<std::path::PathBuf>,
    pub sequence: Option<std::path::PathBuf>,
    /// `--drive`: run the steps file in a child app and report.
    pub drive: Option<std::path::PathBuf>,
    /// `--drive-child`: this is that child.
    pub drive_child: Option<std::path::PathBuf>,
    /// Open the window without showing it (`--drive` on a machine where a
    /// window should not appear).
    pub hidden: bool,
    /// Every argument but `--drive <steps>`, for the child.
    pub rest: Vec<String>,
}

fn usage() -> ! {
    eprintln!(
        "usage: hack-desktop [--fixtures <state> | --logs-fixture <state>] [--theme light|dark] [--list-fixtures] [--screenshots <dir> | --command-screenshots <dir>] [--drive <steps> [--hidden]]"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args {
        fixture: None,
        logs_fixture: None,
        theme: None,
        screenshots: None,
        service_screenshots: None,
        command_screenshots: None,
        sequence: None,
        drive: None,
        drive_child: None,
        hidden: false,
        rest: Vec::new(),
    };
    let all: Vec<String> = std::env::args().skip(1).collect();
    let mut it = all.iter().cloned();
    while let Some(arg) = it.next() {
        if arg == "--drive" {
            a.drive = Some(it.next().unwrap_or_else(|| usage()).into());
            continue;
        }
        a.rest.push(arg.clone());
        match arg.as_str() {
            "--fixtures" => {
                let name = it.next().unwrap_or_else(|| usage());
                a.rest.push(name.clone());
                a.fixture = Some(Fixture::parse(&name).unwrap_or_else(|| {
                    eprintln!("unknown fixture {name:?}; see --list-fixtures");
                    std::process::exit(2)
                }));
            }
            "--logs-fixture" => {
                let name = it.next().unwrap_or_else(|| usage());
                a.rest.push(name.clone());
                a.logs_fixture = Some(
                    hack_desktop_core::logs::fixtures::LogsFixture::parse(&name).unwrap_or_else(
                        || {
                            eprintln!("unknown logs fixture {name:?}; see --list-fixtures");
                            std::process::exit(2)
                        },
                    ),
                );
            }
            "--list-fixtures" => {
                for f in Fixture::ALL {
                    println!("{}", f.name());
                }
                for f in hack_desktop_core::logs::fixtures::LogsFixture::ALL {
                    println!("--logs-fixture {}", f.name());
                }
                std::process::exit(0)
            }
            "--theme" => {
                let mode = it.next();
                a.rest.extend(mode.clone());
                a.theme = Some(match mode.as_deref() {
                    Some("light") => ThemeMode::Light,
                    Some("dark") => ThemeMode::Dark,
                    _ => usage(),
                });
            }
            "--screenshots" => a.screenshots = Some(it.next().unwrap_or_else(|| usage()).into()),
            "--service-screenshots" => {
                a.service_screenshots = Some(it.next().unwrap_or_else(|| usage()).into())
            }
            "--command-screenshots" => {
                a.command_screenshots = Some(it.next().unwrap_or_else(|| usage()).into());
            }
            "--sequence" => a.sequence = Some(it.next().unwrap_or_else(|| usage()).into()),
            "--drive-child" => {
                let steps = it.next().unwrap_or_else(|| usage());
                a.rest.push(steps.clone());
                a.drive_child = Some(steps.into());
            }
            "--hidden" => a.hidden = true,
            "-h" | "--help" => usage(),
            _ => usage(),
        }
    }
    a
}

pub(crate) fn source_for(fixture: Option<Fixture>) -> Arc<dyn Source> {
    match fixture {
        Some(f) => Arc::new(FixtureSource(f)),
        None => Arc::new(LiveSource::from_env()),
    }
}

/// One title bar: ours. On macOS the window has a transparent, full-size
/// content title bar, and the system traffic lights sit inside the app's
/// header row (gpui-kit `TitleBar` moves the window and handles double
/// clicks). On Linux the window asks for client-side decorations, so the
/// header row is the title bar there too and gpui-kit draws the window
/// controls; a compositor that keeps server-side decorations draws its own
/// title bar instead, and the header row then sits under it.
pub(crate) fn window_options() -> WindowOptions {
    let base = gpui_kit::component::TitleBar::window_options();
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1120.), px(720.)),
        })),
        window_min_size: Some(size(px(760.), px(480.))),
        titlebar: Some(gpui_kit::TitlebarOptions {
            title: Some("Hack".into()),
            appears_transparent: true,
            // Centred in the 38 pt header row.
            traffic_light_position: Some(gpui_kit::point(px(14.), px(12.))),
        }),
        #[cfg(target_os = "linux")]
        window_decorations: Some(gpui_kit::WindowDecorations::Client),
        app_id: Some("dance.hack.desktop".into()),
        ..base
    }
}

fn main() {
    let args = parse_args();
    #[cfg(hack_terminal)]
    if let Some(steps) = &args.drive {
        std::process::exit(drive::supervise(steps, &args.rest));
    }
    #[cfg(hack_terminal)]
    let drive_steps = args.drive_child.as_ref().map(|path| {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("read {}: {e}", path.display());
            std::process::exit(2)
        });
        drive::parse(&text, path.parent().unwrap_or(std::path::Path::new("."))).unwrap_or_else(
            |e| {
                eprintln!("{}: {e}", path.display());
                std::process::exit(2)
            },
        )
    });
    #[cfg(not(hack_terminal))]
    if args.drive.is_some() || args.drive_child.is_some() {
        eprintln!("--drive needs a build with --features terminal");
        std::process::exit(2);
    }
    #[cfg(feature = "screenshots")]
    if let Some(dir) = &args.sequence {
        screenshots::sequence(dir);
        return;
    }
    #[cfg(feature = "screenshots")]
    if let Some(dir) = &args.service_screenshots {
        screenshots::service_pane(dir);
        return;
    }
    #[cfg(feature = "screenshots")]
    if let Some(dir) = &args.screenshots {
        screenshots::run(dir, args.fixture);
        return;
    }
    if let Some(dir) = &args.command_screenshots {
        #[cfg(all(feature = "screenshots", hack_terminal))]
        {
            screenshots::run_command_drawer(dir);
            return;
        }
        #[cfg(not(all(feature = "screenshots", hack_terminal)))]
        {
            let _ = dir;
            eprintln!("--command-screenshots needs the terminal and screenshots features");
            std::process::exit(2);
        }
    }
    #[cfg(not(feature = "screenshots"))]
    if args.screenshots.is_some() || args.sequence.is_some() || args.service_screenshots.is_some() {
        eprintln!("--screenshots and --sequence need a build with --features screenshots");
        std::process::exit(2);
    }
    gpui_kit::application()
        .with_assets(hack_desktop_ui::icons::Assets)
        .run(move |cx| {
            theme::init(cx);
            #[cfg(all(feature = "screenshots", target_os = "linux"))]
            if args.fixture.is_some() || args.logs_fixture.is_some() {
                theme::capture_fonts(cx);
            }
            view::bind_keys(cx);
            let fixture = args.fixture.or(args.logs_fixture.map(|l| {
                if l == hack_desktop_core::logs::fixtures::LogsFixture::Stopped {
                    Fixture::Stopped
                } else {
                    Fixture::Running
                }
            }));
            let logs_fixture = args.logs_fixture;
            let theme = args.theme;
            let source = source_for(fixture);
            let options = if args.hidden {
                WindowOptions {
                    focus: false,
                    show: false,
                    ..health_fixtures::window_options(fixture)
                }
            } else {
                health_fixtures::window_options(fixture)
            };
            let (window, app) = gpui_kit::open_window(options, cx, move |window, cx| {
                match theme {
                    Some(mode) => Theme::change(mode, Some(window), cx),
                    None => Theme::sync_system_appearance(Some(window), cx),
                }
                cx.new(|cx| {
                    let mut app = view::HackApp::new(source, fixture.is_none(), window, cx);
                    app.watch_window(window, cx);
                    if let Some(f) = fixture {
                        app.select(fixtures::selected(f));
                        health_fixtures::open(&mut app, f, window, cx);
                        if fixtures::loads_doctor(f) {
                            app.show_doctor_now();
                            if !fixtures::opens_doctor(f) {
                                app.show_project();
                            }
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
                        if matches!(f, Fixture::DaemonDown | Fixture::DaemonMismatch) {
                            app.simulate_daemon_unavailable(f == Fixture::DaemonMismatch);
                        }
                    }
                    if let Some(a) = fixture.and_then(|f| fixtures::local(f).in_flight) {
                        app.simulate_in_flight(a);
                    }
                    if let Some(l) = logs_fixture {
                        app.show_logs_fixture(l, window, cx);
                    }
                    app
                })
            })
            .expect("failed to open the window");
            #[cfg(hack_terminal)]
            if let Some(steps) = drive_steps {
                let win = drive::Win { window, app };
                cx.spawn(async move |cx| drive::run(win, steps, cx).await)
                    .detach();
            }
            #[cfg(not(hack_terminal))]
            let _ = (window, app);
        });
}
