//! Hack desktop app (unsupported preview, HACK-2214).
//!
//! ```text
//! hack-desktop                         live: hackd + `hack ... --json`
//! hack-desktop --fixtures running      canned data for one designed state
//! hack-desktop --list-fixtures
//! hack-desktop --theme light|dark      default: follow the system
//! hack-desktop --screenshots <dir>     (feature `screenshots`) render every
//!                                      fixture, light and dark, offscreen
//! ```

mod doctor_view;
#[cfg(feature = "screenshots")]
mod screenshots;
mod view;

use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};
use hack_desktop_core::daemon::{DaemonClient, default_socket_path};
use hack_desktop_core::fixtures::{self, Fixture};
use hack_desktop_core::runner::CliRunner;
use hack_desktop_core::source::{FixtureSource, LiveSource, Source};

pub(crate) struct Args {
    pub fixture: Option<Fixture>,
    pub theme: Option<ThemeMode>,
    pub screenshots: Option<std::path::PathBuf>,
}

fn usage() -> ! {
    eprintln!(
        "usage: hack-desktop [--fixtures <state>] [--theme light|dark] [--list-fixtures] [--screenshots <dir>]"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args {
        fixture: None,
        theme: None,
        screenshots: None,
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
            "--list-fixtures" => {
                for f in Fixture::ALL {
                    println!("{}", f.name());
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
            "-h" | "--help" => usage(),
            _ => usage(),
        }
    }
    a
}

pub(crate) fn source_for(fixture: Option<Fixture>) -> Arc<dyn Source> {
    match fixture {
        Some(f) => Arc::new(FixtureSource(f)),
        None => {
            let socket = default_socket_path(
                std::env::var("HACK_HOME").ok().as_deref(),
                std::env::var("HOME").ok().as_deref(),
            );
            Arc::new(LiveSource {
                runner: CliRunner::new("hack"),
                daemon: socket.map(|s| DaemonClient::new(s, Duration::from_secs(3))),
            })
        }
    }
}

pub(crate) fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1040.), px(680.)),
        })),
        app_id: Some("dance.hack.desktop".into()),
        ..WindowOptions::default()
    }
}

fn main() {
    let args = parse_args();
    #[cfg(feature = "screenshots")]
    if let Some(dir) = &args.screenshots {
        screenshots::run(dir);
        return;
    }
    #[cfg(not(feature = "screenshots"))]
    if args.screenshots.is_some() {
        eprintln!("--screenshots needs a build with --features screenshots");
        std::process::exit(2);
    }
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let fixture = args.fixture;
        let theme = args.theme;
        let source = source_for(fixture);
        gpui_kit::open_window(window_options(), cx, move |window, cx| {
            match theme {
                Some(mode) => Theme::change(mode, Some(window), cx),
                None => Theme::sync_system_appearance(Some(window), cx),
            }
            cx.new(|cx| {
                let mut app = view::HackApp::new(source, fixture.is_none(), cx);
                if let Some(f) = fixture {
                    app.select(fixtures::selected(f));
                    if fixtures::loads_doctor(f) {
                        app.show_doctor_now();
                        if !fixtures::opens_doctor(f) {
                            app.show_project();
                        }
                    }
                }
                if let Some(a) = fixture.and_then(|f| fixtures::local(f).in_flight) {
                    app.simulate_in_flight(a);
                }
                app
            })
        })
        .expect("failed to open the window");
    });
}
