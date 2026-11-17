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
//! ```

mod doctor_view;
mod logs_view;
#[cfg(feature = "screenshots")]
mod screenshots;
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
    pub sequence: Option<std::path::PathBuf>,
}

fn usage() -> ! {
    eprintln!(
        "usage: hack-desktop [--fixtures <state> | --logs-fixture <state>] [--theme light|dark] [--list-fixtures] [--screenshots <dir>]"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args {
        fixture: None,
        logs_fixture: None,
        theme: None,
        screenshots: None,
        sequence: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--fixtures" => {
                let name = it.next().unwrap_or_else(|| usage());
                a.fixture = Some(Fixture::parse(&name).unwrap_or_else(|| {
                    eprintln!("unknown fixture {name:?}; see --list-fixtures");
                    std::process::exit(2)
                }));
            }
            "--logs-fixture" => {
                let name = it.next().unwrap_or_else(|| usage());
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
                a.theme = Some(match it.next().as_deref() {
                    Some("light") => ThemeMode::Light,
                    Some("dark") => ThemeMode::Dark,
                    _ => usage(),
                });
            }
            "--screenshots" => a.screenshots = Some(it.next().unwrap_or_else(|| usage()).into()),
            "--sequence" => a.sequence = Some(it.next().unwrap_or_else(|| usage()).into()),
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
    #[cfg(feature = "screenshots")]
    if let Some(dir) = &args.sequence {
        screenshots::sequence(dir);
        return;
    }
    #[cfg(feature = "screenshots")]
    if let Some(dir) = &args.screenshots {
        screenshots::run(dir, args.fixture);
        return;
    }
    #[cfg(not(feature = "screenshots"))]
    if args.screenshots.is_some() || args.sequence.is_some() {
        eprintln!("--screenshots and --sequence need a build with --features screenshots");
        std::process::exit(2);
    }
    gpui_kit::application()
        .with_assets(hack_desktop_ui::icons::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
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
            gpui_kit::open_window(window_options(), cx, move |window, cx| {
                match theme {
                    Some(mode) => Theme::change(mode, Some(window), cx),
                    None => Theme::sync_system_appearance(Some(window), cx),
                }
                cx.new(|cx| {
                    let mut app = view::HackApp::new(source, fixture.is_none(), window, cx);
                    app.watch_window(window, cx);
                    if let Some(f) = fixture {
                        app.select(fixtures::selected(f));
                        if fixtures::loads_doctor(f) {
                            app.show_doctor_now();
                            if !fixtures::opens_doctor(f) {
                                app.show_project();
                            }
                        }
                        if f.name().starts_with("env-") {
                            app.show_env_fixture();
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
        });
}
