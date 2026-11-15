//! The symbols fallback font, and which glyphs it is used for.
//!
//! Prompt themes (starship, oh-my-zsh and the like) print Nerd Font symbols:
//! code points in the private-use areas that only a patched font has. When
//! the terminal's font lacks one, the system has nothing sensible to fall
//! back to. It draws a missing-glyph box, or the unrelated glyph some other
//! installed font happens to have at that code point. Ghostty avoids that
//! by embedding a symbols-only Nerd Font; this module does the same.
//!
//! The font is **Symbols Nerd Font Mono** from Nerd Fonts v3.5.1, embedded
//! in the binary (2.6 MB).
//!
//! Its glyphs are drawn as **vector paths** from the font's outlines, not
//! through the text system. GPUI's text system cannot select this font on
//! Linux: it refuses to load any family that has no glyph for the letter
//! "m", as a font or as a fallback. Drawing the outlines ourselves is the
//! same on every platform and does not depend on what fonts are installed.
//!
//! Which font a symbol comes from:
//!
//! - A private-use code point this font has: from this font, unless the
//!   terminal's font is itself a Nerd Font and has the glyph. Then the
//!   user's patched font is used, as in their own terminal.
//! - An ordinary Unicode character this font also has (the heavy angle
//!   brackets prompts use, the power symbols): from this font only when the
//!   terminal's font has no glyph for it.
//!
//! Box drawing, block elements and the powerline separators never come
//! from a font: see [`crate::sprite`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use gpui_kit::{Font, Hsla, Pixels, SharedString, TextRun, Window};

use crate::sprite::Seg;

/// The family name of the embedded font.
pub const SYMBOLS_FAMILY: &str = "Symbols Nerd Font Mono";

/// Symbols Nerd Font Mono, verified against its pinned sha256 by `build.rs`.
static SYMBOLS_FONT: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/SymbolsNerdFontMono-Regular.ttf"));

/// The code points the embedded font has, as inclusive ranges. From the
/// font's character map (v3.5.1); the render test checks samples of them.
const SYMBOL_RANGES: [(u32, u32); 29] = [
    (0x23fb, 0x23fe),
    (0x2630, 0x2630),
    (0x2665, 0x2665),
    (0x26a1, 0x26a1),
    (0x276c, 0x2771),
    (0x2b58, 0x2b58),
    (0xe000, 0xe00a),
    (0xe0a0, 0xe0a3),
    (0xe0b0, 0xe0c8),
    (0xe0ca, 0xe0ca),
    (0xe0cc, 0xe0d2),
    (0xe0d4, 0xe0d4),
    (0xe0d6, 0xe0d7),
    (0xe200, 0xe2a9),
    (0xe300, 0xe3e3),
    (0xe5fa, 0xe6bb),
    (0xe700, 0xe958),
    (0xea60, 0xea88),
    (0xea8a, 0xea8c),
    (0xea8f, 0xeac7),
    (0xeac9, 0xeac9),
    (0xeacc, 0xeb09),
    (0xeb0b, 0xeb4e),
    (0xeb50, 0xec5e),
    (0xec60, 0xec84),
    (0xed00, 0xefcf),
    (0xf000, 0xf385),
    (0xf400, 0xf533),
    (0xf0001, 0xf1af0),
];

/// Whether the embedded symbols font has a glyph for `ch`.
pub fn in_symbols_font(ch: char) -> bool {
    let cp = ch as u32;
    cp >= 0x23fb && SYMBOL_RANGES.iter().any(|&(a, b)| a <= cp && cp <= b)
}

/// One glyph of the symbols font, in font units with y pointing up.
#[derive(Debug)]
pub struct SymbolOutline {
    /// Closed contours, filled with the non-zero rule.
    pub path: Vec<Seg>,
    /// The glyph's box is this wide; every glyph in this font has the same.
    pub advance: f32,
    pub units_per_em: f32,
    pub ascender: f32,
    pub descender: f32,
    /// The ink: x min, y min, x max, y max.
    pub bounds: [f32; 4],
}

fn face() -> Option<&'static ttf_parser::Face<'static>> {
    static FACE: OnceLock<Option<ttf_parser::Face<'static>>> = OnceLock::new();
    FACE.get_or_init(|| ttf_parser::Face::parse(SYMBOLS_FONT, 0).ok())
        .as_ref()
}

/// Collects a glyph's contours, turning quadratic curves into cubic ones.
#[derive(Default)]
struct Collect {
    path: Vec<Seg>,
    at: (f32, f32),
}

impl ttf_parser::OutlineBuilder for Collect {
    fn move_to(&mut self, x: f32, y: f32) {
        self.path.push(Seg::Move(x, y));
        self.at = (x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.path.push(Seg::Line(x, y));
        self.at = (x, y);
    }

    fn quad_to(&mut self, qx: f32, qy: f32, x: f32, y: f32) {
        let (px, py) = self.at;
        let third = 2.0 / 3.0;
        self.path.push(Seg::Cubic(
            (px + third * (qx - px), py + third * (qy - py)),
            (x + third * (qx - x), y + third * (qy - y)),
            (x, y),
        ));
        self.at = (x, y);
    }

    fn curve_to(&mut self, ax: f32, ay: f32, bx: f32, by: f32, x: f32, y: f32) {
        self.path.push(Seg::Cubic((ax, ay), (bx, by), (x, y)));
        self.at = (x, y);
    }

    fn close(&mut self) {
        self.path.push(Seg::Close);
    }
}

/// The outline of `ch` in the symbols font, if it has one.
pub fn outline(ch: char) -> Option<Arc<SymbolOutline>> {
    static CACHE: OnceLock<Mutex<HashMap<char, Option<Arc<SymbolOutline>>>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache
        .entry(ch)
        .or_insert_with(|| {
            let face = face()?;
            let glyph = face.glyph_index(ch)?;
            let mut collect = Collect::default();
            let bounds = face.outline_glyph(glyph, &mut collect)?;
            Some(Arc::new(SymbolOutline {
                path: collect.path,
                advance: f32::from(face.glyph_hor_advance(glyph)?),
                units_per_em: f32::from(face.units_per_em()),
                ascender: f32::from(face.ascender()),
                descender: f32::from(face.descender()),
                bounds: [
                    f32::from(bounds.x_min),
                    f32::from(bounds.y_min),
                    f32::from(bounds.x_max),
                    f32::from(bounds.y_max),
                ],
            }))
        })
        .clone()
}

/// Whether a font family is a Nerd Font, by the names the project gives
/// its patched fonts: `... Nerd Font`, `... Nerd Font Mono`, `... NF`,
/// `... NFM`, `... NFP`.
pub fn is_nerd_font(family: &str) -> bool {
    let name = family.to_ascii_lowercase();
    name.contains("nerd font") || [" nf", " nfm", " nfp"].iter().any(|s| name.ends_with(s))
}

/// Whether `ch` is in a private-use area.
fn is_private_use(ch: char) -> bool {
    matches!(ch as u32, 0xe000..=0xf8ff | 0xf0000..=0xffffd | 0x100000..=0x10fffd)
}

/// Remembers, per terminal font, which symbols that font lacks.
#[derive(Default)]
pub struct SymbolFallback {
    family: SharedString,
    /// For each symbol asked about: whether to draw it from the symbols font.
    from_symbols: HashMap<char, bool>,
}

impl SymbolFallback {
    /// Whether `ch` should be drawn from the symbols font. See the module
    /// docs for the rule.
    pub fn uses_symbols_font(
        &mut self,
        ch: char,
        font: &Font,
        size: Pixels,
        window: &Window,
    ) -> bool {
        if !in_symbols_font(ch) {
            return false;
        }
        // A private-use code point means a Nerd Font symbol here. A font
        // that is not a Nerd Font may still have some other glyph at that
        // code point; that glyph is not what the program meant.
        if is_private_use(ch) && !is_nerd_font(&font.family) {
            return true;
        }
        if self.family != font.family {
            self.family = font.family.clone();
            self.from_symbols.clear();
        }
        if let Some(&known) = self.from_symbols.get(&ch) {
            return known;
        }
        let lacks = !font_has_glyph(ch, font, size, window);
        self.from_symbols.insert(ch, lacks);
        lacks
    }
}

/// Whether `font` itself has a glyph for `ch`: shaping it must use that
/// font and no other, and must not produce the missing-glyph id.
fn font_has_glyph(ch: char, font: &Font, size: Pixels, window: &Window) -> bool {
    let ts = window.text_system();
    let id = ts.resolve_font(font);
    let text = ch.to_string();
    let run = TextRun {
        len: text.len(),
        font: font.clone(),
        color: Hsla::default(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let line = ts.shape_line(text.into(), size, &[run], None);
    !line.runs.is_empty()
        && line.runs.iter().all(|r| {
            r.font_id == id && !r.glyphs.is_empty() && r.glyphs.iter().all(|g| g.id.0 != 0)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_font_is_the_pinned_file_and_covers_prompt_symbols() {
        assert_eq!(
            SYMBOLS_FONT.len(),
            2_610_012,
            "Symbols Nerd Font Mono v3.5.1"
        );
        assert_eq!(&SYMBOLS_FONT[..4], [0, 1, 0, 0], "a TrueType font");
        // Branch, the icons in the render test, folders, a Material icon,
        // the heavy angle bracket prompts use.
        for cp in [
            0xe0a0, 0xe0a3, 0xf418, 0xe718, 0xf07b, 0xf07c, 0xf120, 0xf0001, 0x276f, 0x23fb,
        ] {
            let ch = char::from_u32(cp).unwrap();
            assert!(in_symbols_font(ch), "U+{cp:04X}");
            assert!(outline(ch).is_some(), "U+{cp:04X} has an outline");
        }
        // Ordinary text and private-use code points the font does not have.
        for cp in [
            0x41, 0x2500, 0x4e2d, 0xe050, 0xe09f, 0xf8ff, 0xf386, 0xf1af1,
        ] {
            let ch = char::from_u32(cp).unwrap();
            assert!(!in_symbols_font(ch), "U+{cp:04X}");
            assert!(outline(ch).is_none(), "U+{cp:04X} has no outline");
        }
    }

    #[test]
    fn the_range_table_matches_the_font() {
        // Every code point the table claims has a glyph in the font, and
        // the first code point past each range does not.
        let face = face().expect("the embedded font parses");
        for &(a, b) in &SYMBOL_RANGES {
            for cp in a..=b {
                let ch = char::from_u32(cp).unwrap();
                assert!(
                    face.glyph_index(ch).is_some(),
                    "U+{cp:04X} is in the table, not the font"
                );
            }
            for cp in [a - 1, b + 1] {
                if let Some(ch) = char::from_u32(cp)
                    && !in_symbols_font(ch)
                {
                    assert!(
                        face.glyph_index(ch).is_none() || cp < 0x2000,
                        "U+{cp:04X} is in the font, not the table"
                    );
                }
            }
        }
    }

    #[test]
    fn outlines_are_closed_contours_inside_the_fonts_box() {
        // The branch symbol: taller than wide, inside its one-em box.
        let o = outline('\u{e0a0}').unwrap();
        let [x0, y0, x1, y1] = o.bounds;
        assert!(
            y1 - y0 > x1 - x0,
            "the branch is taller than wide: {:?}",
            o.bounds
        );
        assert!(
            x0 >= 0.0 && x1 <= o.advance,
            "inside its advance: {:?}",
            o.bounds
        );
        assert!(y1 - y0 > 0.8 * o.units_per_em, "and nearly an em tall");
        assert!(matches!(o.path[0], Seg::Move(..)));
        assert_eq!(o.path.last(), Some(&Seg::Close));
        let closes = o.path.iter().filter(|s| **s == Seg::Close).count();
        let moves = o.path.iter().filter(|s| matches!(s, Seg::Move(..))).count();
        assert_eq!(closes, moves, "every contour is closed");
        // Every glyph of this font has the same box, one em wide.
        for ch in ['\u{f418}', '\u{e718}', '\u{f07b}', '\u{f0001}'] {
            let other = outline(ch).unwrap();
            assert_eq!(other.advance, o.advance, "{ch:?}");
            assert_eq!(o.advance, o.units_per_em);
        }
    }

    #[test]
    fn nerd_fonts_are_recognised_by_name() {
        for name in [
            "JetBrainsMono Nerd Font",
            "Hack Nerd Font Mono",
            "FiraCode NF",
            "Iosevka NFM",
            "CaskaydiaCove NFP",
            "symbols nerd font mono",
        ] {
            assert!(is_nerd_font(name), "{name}");
        }
        for name in [
            "JetBrains Mono",
            "Menlo",
            "Adwaita Mono",
            "DejaVu Sans Mono",
            "Info",
            "NF Mono",
        ] {
            assert!(!is_nerd_font(name), "{name}");
        }
        assert!(is_private_use('\u{e0a0}') && is_private_use('\u{f0001}'));
        assert!(!is_private_use('\u{276f}') && !is_private_use('a'));
    }
}
