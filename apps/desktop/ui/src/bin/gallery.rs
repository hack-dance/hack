//! Design v1 gallery: the main window, drawn with the v1 components from the
//! app's fixtures. It runs no command, never polls and reads no user config.
//!
//! ```text
//! hack-desktop-gallery --fixture running --theme dark [--panel collapsed|half|max]
//! hack-desktop-gallery --screenshots <dir>     (feature `screenshots`) every
//!                                              fixture plus the terminal panel
//!                                              scenes, light and dark, offscreen
//! ```

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{AppContext as _, Bounds, SharedString, WindowBounds, WindowOptions, px, size};
use hack_desktop_core::fixtures::Fixture;
use hack_desktop_ui::panel::{PanelState, TabKind};
use hack_desktop_ui::tokens::Mode;
use hack_desktop_ui::window::{MainWindow, WindowData};

fn usage() -> ! {
    eprintln!(
        "usage: hack-desktop-gallery [--fixture <state>] [--theme light|dark] [--panel collapsed|half|max] [--screenshots <dir>]"
    );
    std::process::exit(2)
}

fn window_options() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1040.), px(720.)),
        })),
        app_id: Some("dance.hack.desktop.gallery".into()),
        ..WindowOptions::default()
    }
}

/// One rendered scene: a fixture plus a terminal panel arrangement.
pub struct Scene {
    pub name: String,
    pub fixture: Fixture,
    pub panel: PanelState,
    pub tabs: Vec<TabKind>,
    pub selected: usize,
    pub menu: bool,
}

fn env_tab() -> TabKind {
    TabKind::HostShellWithEnv {
        shell: "zsh".into(),
        overlay: "staging".into(),
        scope: "api".into(),
        is_default: false,
    }
}

/// Every fixture (panel half open, Logs), then the panel scenes.
pub fn scenes() -> Vec<Scene> {
    let mut out: Vec<Scene> = Fixture::ALL
        .iter()
        .map(|&f| Scene {
            name: f.name().into(),
            fixture: f,
            panel: PanelState::half(),
            tabs: vec![TabKind::Logs],
            selected: 0,
            menu: false,
        })
        .collect();
    let running_tabs = vec![
        TabKind::Logs,
        TabKind::ContainerShell {
            service: "api".into(),
            shell: "sh".into(),
        },
        env_tab(),
    ];
    let failed_tabs = vec![
        TabKind::Logs,
        TabKind::HostShell {
            shell: "zsh".into(),
        },
    ];
    for (name, fixture, panel, tabs, selected, menu) in [
        (
            "panel-running-collapsed",
            Fixture::Running,
            PanelState::Collapsed,
            &running_tabs,
            0,
            false,
        ),
        (
            "panel-running-half",
            Fixture::Running,
            PanelState::half(),
            &running_tabs,
            2,
            false,
        ),
        (
            "panel-running-max",
            Fixture::Running,
            PanelState::Maximized,
            &running_tabs,
            0,
            false,
        ),
        (
            "panel-running-menu",
            Fixture::Running,
            PanelState::half(),
            &running_tabs,
            0,
            true,
        ),
        (
            "panel-running-max-menu",
            Fixture::Running,
            PanelState::Maximized,
            &running_tabs,
            0,
            true,
        ),
        (
            "panel-many-menu",
            Fixture::ManyProjects,
            PanelState::half(),
            &running_tabs,
            0,
            true,
        ),
        (
            "panel-failed-collapsed",
            Fixture::FailedStart,
            PanelState::Collapsed,
            &failed_tabs,
            0,
            false,
        ),
        (
            "panel-failed-half",
            Fixture::FailedStart,
            PanelState::half(),
            &failed_tabs,
            0,
            false,
        ),
        (
            "panel-failed-max",
            Fixture::FailedStart,
            PanelState::Maximized,
            &failed_tabs,
            1,
            false,
        ),
    ] {
        out.push(Scene {
            name: name.into(),
            fixture,
            panel,
            tabs: tabs.clone(),
            selected,
            menu,
        });
    }
    out
}

fn build(
    scene: &Scene,
    mode: Mode,
    traffic_lights: bool,
    term_font: Option<SharedString>,
) -> MainWindow {
    let mut w = MainWindow::new(WindowData::from_fixture(scene.fixture), mode);
    w.traffic_lights = traffic_lights;
    w.panel = scene.panel;
    w.panel_tabs = scene.tabs.clone();
    w.panel_selected = scene.selected;
    w.panel_menu = scene.menu;
    w.term_font = term_font;
    w
}

/// A Nerd Font for prompt glyphs when one is installed: a stand-in for the
/// user's Ghostty `font-family`, which the gallery deliberately does not read.
fn nerd_font(cx: &gpui_kit::App) -> Option<SharedString> {
    cx.text_system()
        .all_font_names()
        .into_iter()
        .find(|n| n.contains("Nerd Font") && n.contains("Mono"))
        .map(Into::into)
}

fn main() {
    let mut fixture = Fixture::Running;
    let mut mode = Mode::Light;
    let mut panel = PanelState::half();
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
            "--panel" => {
                panel = match it.next().as_deref() {
                    Some("collapsed") => PanelState::Collapsed,
                    Some("half") => PanelState::half(),
                    Some("max") => PanelState::Maximized,
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
    let scene = Scene {
        name: fixture.name().into(),
        fixture,
        panel,
        tabs: vec![TabKind::Logs, env_tab()],
        selected: 0,
        menu: false,
    };
    gpui_kit::application()
        .with_assets(hack_desktop_ui::icons::Assets)
        .run(move |cx| {
            hack_desktop_ui::tokens::init(cx);
            gpui_kit::open_window(window_options(), cx, move |window, cx| {
                Theme::change(theme_mode(mode), Some(window), cx);
                let font = nerd_font(cx);
                cx.new(|_| build(&scene, mode, false, font))
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
    use hack_desktop_ui::tokens::Mode;

    pub fn run(dir: &Path) {
        std::fs::create_dir_all(dir).expect("create screenshot dir");
        let mut cx = HeadlessAppContext::with_platform(
            gpui_kit::platform::current_platform(true).text_system(),
            Arc::new(hack_desktop_ui::icons::Assets),
            gpui_kit::platform::current_headless_renderer,
        );
        cx.update(hack_desktop_ui::tokens::init);
        let font = cx.update(|cx| super::nerd_font(cx));
        for mode in [Mode::Light, Mode::Dark] {
            for scene in super::scenes() {
                cx.update(|cx| Theme::change(super::theme_mode(mode), None, cx));
                let opts = WindowOptions {
                    focus: false,
                    show: false,
                    ..super::window_options()
                };
                let font = font.clone();
                let (handle, _) = cx
                    .update(|cx| {
                        gpui_kit::open_window(opts, cx, |_, cx| {
                            cx.new(|_| super::build(&scene, mode, true, font))
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
                let path = dir.join(format!("{}-{suffix}.png", scene.name));
                img.save(&path).expect("write png");
                println!("{}", path.display());
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .ok();
            }
        }
    }
}
