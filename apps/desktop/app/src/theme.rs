//! Native component colors and deterministic fonts for design captures.

use gpui_kit::{App, component::Theme};
use std::rc::Rc;

pub fn init(cx: &mut App) {
    gpui_kit::init(cx);
    Theme::update(cx, |theme| {
        let dark = Rc::make_mut(&mut theme.dark_theme);
        dark.name = "Merino Dark".into();
        dark.colors.background = Some("#0d1117".into());
        dark.colors.foreground = Some("#e6edf3".into());
        dark.colors.selection = Some("#24272b".into());
        dark.colors.border = Some("#2b3036".into());
        dark.colors.muted = Some("#1a1e24".into());
        dark.colors.muted_foreground = Some("#8b9197".into());
        dark.colors.primary = Some("#e6edf3".into());
        dark.colors.primary_foreground = Some("#0d1117".into());
    });
    Theme::change(Theme::global(cx).mode, None, cx);
}

#[cfg(all(feature = "screenshots", target_os = "linux"))]
pub fn capture_fonts(cx: &mut App) {
    use std::borrow::Cow;

    // Geist 1.4.2, bundled under the SIL Open Font License for Linux captures.
    let fonts: [&'static [u8]; 2] = [
        include_bytes!("../assets/capture-fonts/Geist-Variable.ttf"),
        include_bytes!("../assets/capture-fonts/GeistMono-Variable.ttf"),
    ];
    let text_system = cx.text_system();
    text_system
        .add_fonts(fonts.into_iter().map(Cow::Borrowed).collect())
        .expect("register Geist capture fonts");
    let families = text_system.all_font_names();
    assert!(families.iter().any(|name| name == "Geist"));
    assert!(families.iter().any(|name| name == "Geist Mono"));

    Theme::update(cx, |theme| {
        for config in [&mut theme.light_theme, &mut theme.dark_theme] {
            let config = Rc::make_mut(config);
            config.font_family = Some("Geist".into());
            config.mono_font_family = Some("Geist Mono".into());
        }
    });
    Theme::change(Theme::global(cx).mode, None, cx);
}
