//! Design v1 gallery: the main window, drawn with the v1 components from the
//! app's fixtures. It runs no command and never polls.
//!
//! ```text
//! hack-desktop-gallery --fixture running --theme dark   open one fixture
//! hack-desktop-gallery --screenshots <dir>              (feature `screenshots`)
//!                                                       every fixture, light and
//!                                                       dark, to PNG, offscreen
//! ```

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};
use hack_desktop_core::fixtures::Fixture;
use hack_desktop_ui::tokens::Mode;
use hack_desktop_ui::window::{MainWindow, WindowData};

fn usage() -> ! {
    eprintln!(
        "usage: hack-desktop-gallery [--fixture <state>] [--theme light|dark] [--screenshots <dir>]"
    );
    std::process::exit(2)
}

fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1040.), px(680.)),
        })),
        app_id: Some("dance.hack.desktop.gallery".into()),
        ..WindowOptions::default()
    }
}

fn main() {
    let mut fixture = Fixture::Running;
    let mut mode = Mode::Light;
    let mut shots: Option<std::path::PathBuf> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--fixture" => {
                let name = it.next().unwrap_or_else(|| usage());
                fixture = Fixture::parse(&name).unwrap_or_else(|| usage());
            }
            "--theme" => {
                mode = match it.next().as_deref() {
                    Some("light") => Mode::Light,
                    Some("dark") => Mode::Dark,
                    _ => usage(),
                }
            }
            "--screenshots" => shots = Some(it.next().unwrap_or_else(|| usage()).into()),
            _ => usage(),
        }
    }
    if let Some(dir) = shots {
        #[cfg(feature = "screenshots")]
        {
            screenshots::run(&dir);
            return;
        }
        #[cfg(not(feature = "screenshots"))]
        {
            let _ = dir;
            eprintln!("--screenshots needs a build with --features screenshots");
            std::process::exit(2);
        }
    }
    gpui_kit::application()
        .with_assets(hack_desktop_ui::icons::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(window_options(), cx, move |window, cx| {
                Theme::change(theme_mode(mode), Some(window), cx);
                cx.new(|_| MainWindow {
                    data: WindowData::from_fixture(fixture),
                    mode,
                    traffic_lights: false,
                    tab: 0,
                })
            })
            .expect("failed to open the window");
        });
}

fn theme_mode(mode: Mode) -> ThemeMode {
    match mode {
        Mode::Light => ThemeMode::Light,
        Mode::Dark => ThemeMode::Dark,
    }
}

#[cfg(feature = "screenshots")]
mod screenshots {
    use std::path::Path;
    use std::sync::Arc;

    use gpui_kit::component::Theme;
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{AppContext as _, HeadlessAppContext, WindowOptions};
    use hack_desktop_core::fixtures::Fixture;
    use hack_desktop_ui::tokens::Mode;
    use hack_desktop_ui::window::{MainWindow, WindowData};

    pub fn run(dir: &Path) {
        std::fs::create_dir_all(dir).expect("create screenshot dir");
        let mut cx = HeadlessAppContext::with_platform(
            gpui_kit::platform::current_platform(true).text_system(),
            Arc::new(hack_desktop_ui::icons::Assets),
            gpui_kit::platform::current_headless_renderer,
        );
        cx.update(gpui_kit::init);
        for mode in [Mode::Light, Mode::Dark] {
            for f in Fixture::ALL {
                cx.update(|cx| Theme::change(super::theme_mode(mode), None, cx));
                let opts = WindowOptions {
                    focus: false,
                    show: false,
                    ..super::window_options()
                };
                let (handle, _) = cx
                    .update(|cx| {
                        gpui_kit::open_window(opts, cx, |_, cx| {
                            cx.new(|_| MainWindow {
                                data: WindowData::from_fixture(f),
                                mode,
                                traffic_lights: true,
                                tab: 0,
                            })
                        })
                    })
                    .expect("open offscreen window");
                // Two frames: the first loads icon assets.
                for _ in 0..2 {
                    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                        .expect("render");
                    cx.run_until_parked();
                }
                let img = cx
                    .capture_screenshot(handle)
                    .expect("offscreen rendering must be available");
                let suffix = if mode == Mode::Dark { "dark" } else { "light" };
                let path = dir.join(format!("{}-{suffix}.png", f.name()));
                img.save(&path).expect("write png");
                println!("{}", path.display());
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .ok();
            }
        }
    }
}
