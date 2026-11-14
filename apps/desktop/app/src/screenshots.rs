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

use crate::view::HackApp;

pub fn run(dir: &Path, selected: Option<Fixture>) {
    std::fs::create_dir_all(dir).expect("create screenshot dir");
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(gpui_kit::assets::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(gpui_kit::init);
    for mode in [ThemeMode::Light, ThemeMode::Dark] {
        for f in Fixture::ALL
            .into_iter()
            .filter(|f| selected.is_none_or(|s| s == *f))
        {
            cx.update(|cx| Theme::change(mode, None, cx));
            let opts = WindowOptions {
                focus: false,
                show: false,
                ..crate::window_options()
            };
            let (handle, _) = cx
                .update(|cx| {
                    gpui_kit::open_window(opts, cx, |_, cx| {
                        cx.new(|cx| {
                            let mut app = HackApp::new(crate::source_for(Some(f)), false, cx);
                            app.select(fixtures::selected(f));
                            if let Some(a) = fixtures::local(f).in_flight {
                                app.simulate_in_flight(a);
                            }
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
            let path = dir.join(format!("{}-{suffix}.png", f.name()));
            img.save(&path).expect("write png");
            println!("{}", path.display());
            cx.update_window(handle, |_, window, _| window.remove_window())
                .ok();
        }
    }
}
