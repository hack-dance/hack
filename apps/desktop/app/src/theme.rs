//! Native component colors and deterministic fonts for design captures.

pub use hack_desktop_ui::tokens::init;

#[cfg(all(feature = "screenshots", target_os = "linux"))]
pub fn capture_fonts(cx: &mut gpui_kit::App) {
    use gpui_kit::component::Theme;
    use std::borrow::Cow;
    use std::rc::Rc;

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
