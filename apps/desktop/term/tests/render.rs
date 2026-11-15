//! Pixels: prompt symbols, powerline separators and box drawing must
//! render as real glyphs, not as the missing-glyph box.
//!
//! This draws a row of code points offscreen and looks at each cell. It
//! needs GPUI's offscreen renderer: a GPU, or a software Vulkan driver.
//! Without one the test reports that it could not run and passes, unless
//! `HACK_TERM_REQUIRE_RENDERER=1` is set, as it is in CI.
#![cfg(all(unix, feature = "screenshots"))]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::TempHome;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, px, size,
};
use hack_desktop_term::stream::StreamSource;
use hack_desktop_term::view::TerminalView;

/// One rendered cell: its pixels, row by row, as RGB.
struct Cell {
    w: usize,
    h: usize,
    px: Vec<[u8; 3]>,
}

impl Cell {
    fn at(&self, x: usize, y: usize) -> [u8; 3] {
        self.px[y * self.w + x]
    }

    fn is_ink(&self, x: usize, y: usize, background: [u8; 3]) -> bool {
        let p = self.at(x, y);
        (0..3).any(|i| p[i].abs_diff(background[i]) > 40)
    }

    /// The share of pixels, in a part of the cell, that are not background.
    fn ink(&self, xs: std::ops::Range<usize>, ys: std::ops::Range<usize>, bg: [u8; 3]) -> f32 {
        let total = (xs.len() * ys.len()).max(1);
        let mut n = 0;
        for y in ys {
            for x in xs.clone() {
                n += usize::from(self.is_ink(x, y, bg));
            }
        }
        n as f32 / total as f32
    }

    fn all_ink(&self, bg: [u8; 3]) -> f32 {
        self.ink(0..self.w, 0..self.h, bg)
    }

    /// The share of pixels that differ between two cells of the same size.
    fn difference(&self, other: &Self) -> f32 {
        assert_eq!((self.w, self.h), (other.w, other.h));
        let n = self
            .px
            .iter()
            .zip(&other.px)
            .filter(|(a, b)| (0..3).any(|i| a[i].abs_diff(b[i]) > 40))
            .count();
        n as f32 / self.px.len() as f32
    }
}

/// The glyphs under test, one per cell with a blank cell between them.
const SAMPLES: &[(&str, char)] = &[
    ("powerline right arrow", '\u{e0b0}'),
    ("powerline left arrow", '\u{e0b2}'),
    ("branch", '\u{e0a0}'),
    ("octicon", '\u{f418}'),
    ("devicon", '\u{e718}'),
    ("folder", '\u{f07b}'),
    ("box horizontal", '─'),
    ("box vertical", '│'),
    ("box corner", '┌'),
    ("box double cross", '╬'),
    ("full block", '█'),
    ("lower half block", '▄'),
    // A private-use code point no font has, the symbols font included:
    // whatever this cell shows is this machine's missing-glyph rendering.
    ("known-missing", '\u{e050}'),
];

#[test]
fn prompt_symbols_separators_and_box_drawing_are_real_glyphs() {
    let required = std::env::var_os("HACK_TERM_REQUIRE_RENDERER").is_some_and(|v| v == "1");
    let home = TempHome::new();
    let log = home.path().join("glyphs.log");
    let row: String = SAMPLES.iter().map(|(_, ch)| format!("{ch} ")).collect();
    std::fs::write(&log, format!("{row}\n")).unwrap();

    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(gpui_kit::assets::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(gpui_kit::init);
    let options = WindowOptions {
        focus: false,
        show: false,
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(520.), px(120.)),
        })),
        ..WindowOptions::default()
    };
    let (window, view) = cx
        .update(|cx| {
            gpui_kit::open_window(options, cx, |_, cx| {
                cx.new(|cx| {
                    TerminalView::new_stream(&StreamSource::File(log), 1_000, cx).expect("open")
                })
            })
        })
        .expect("open an offscreen window");
    cx.update_window(window, |_, w, cx| w.render_frame(cx))
        .unwrap();
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.settle(Duration::from_millis(100), Duration::from_secs(20), cx);
        });
    });
    cx.update_window(window, |_, w, cx| w.render_frame(cx))
        .unwrap();
    let image = match cx.capture_screenshot(window) {
        Ok(image) => image,
        Err(error) if !required => {
            eprintln!("NOT RUN: no offscreen renderer on this machine ({error})");
            return;
        }
        Err(error) => panic!("an offscreen renderer is required here: {error}"),
    };
    // For a person to look at when the assertions below need explaining.
    if let Some(path) = std::env::var_os("HACK_TERM_RENDER_DUMP") {
        image
            .save(std::path::Path::new(&path))
            .expect("write the capture");
    }
    let scale = cx
        .update_window(window, |_, w, _| w.scale_factor())
        .unwrap();
    let (metrics, fallback) = cx.update(|cx| {
        let v = view.read(cx);
        (v.grid_metrics(), v.fallback_symbols().to_vec())
    });
    let edge =
        |origin: f32, step: f32, i: usize| ((origin + step * i as f32) * scale).round() as u32;
    let crop = |x0: u32, x1: u32| {
        let (y0, y1) = (
            edge(metrics.origin.1, metrics.cell.1, 0),
            edge(metrics.origin.1, metrics.cell.1, 1),
        );
        let mut px = Vec::new();
        for y in y0..y1 {
            for x in x0..x1 {
                let p = image.get_pixel(x, y).0;
                px.push([p[0], p[1], p[2]]);
            }
        }
        Cell {
            w: (x1 - x0) as usize,
            h: (y1 - y0) as usize,
            px,
        }
    };
    // Exactly one cell, on the same device-pixel edges the view paints to.
    let cell = |col: usize| {
        crop(
            edge(metrics.origin.0, metrics.cell.0, col),
            edge(metrics.origin.0, metrics.cell.0, col + 1),
        )
    };
    // The glyph's cell and the blank one after it, always the same width,
    // so two of them can be compared pixel by pixel. A symbol may use both.
    let pair_width = (2.0 * metrics.cell.0 * scale).floor() as u32;
    let pair = |col: usize| {
        let x0 = edge(metrics.origin.0, metrics.cell.0, col);
        crop(x0, x0 + pair_width)
    };
    // The blank cell at the very end of the row is the background.
    let background = cell(2 * SAMPLES.len() + 1).at(0, 0);
    let col_of = |ch: char| 2 * SAMPLES.iter().position(|s| s.1 == ch).expect("sample");
    let cells: Vec<(&str, char, Cell)> = SAMPLES
        .iter()
        .map(|(name, ch)| (*name, *ch, pair(col_of(*ch))))
        .collect();
    let wide = |ch: char| &cells.iter().find(|c| c.1 == ch).expect("sample").2;
    let by = |ch: char| cell(col_of(ch));
    let report: String = cells
        .iter()
        .map(|(name, ch, c)| {
            format!(
                "\n  U+{:04X} {name}: {}x{} ink {:.2}",
                *ch as u32,
                c.w,
                c.h,
                c.all_ink(background)
            )
        })
        .collect();
    eprintln!("scale {scale}, from the symbols font: {fallback:04X?}{report}");

    // Every glyph draws something.
    let missing = wide('\u{e050}');
    for (name, ch, c) in &cells {
        if *ch == '\u{e050}' {
            continue;
        }
        assert!(
            c.all_ink(background) > 0.02,
            "U+{:04X} {name} is blank{report}",
            *ch as u32
        );
        // And it is not this machine's missing-glyph box.
        assert!(
            c.difference(missing) > 0.03,
            "U+{:04X} {name} renders like a missing glyph{report}",
            *ch as u32
        );
    }
    // Missing glyphs all look alike; real icons do not.
    let icons = ['\u{e0a0}', '\u{f418}', '\u{e718}', '\u{f07b}'];
    // The view's default font is not a Nerd Font, so every icon comes from
    // the bundled font and none from whatever fonts this machine has. A
    // machine font may define one of these code points as something else.
    let mut expected = icons.to_vec();
    expected.sort_unstable();
    assert_eq!(
        fallback, expected,
        "the icons are drawn from the bundled symbols font{report}"
    );
    // And what is on screen has the shape of the bundled glyph: its ink is
    // as wide for its height as the outline in the font.
    for ch in icons {
        let outline = hack_desktop_term::glyphs::outline(ch).expect("in the bundled font");
        let [x0, y0, x1, y1] = outline.bounds;
        let want = (x1 - x0) / (y1 - y0);
        let c = wide(ch);
        let inked: Vec<(usize, usize)> = (0..c.h)
            .flat_map(|y| (0..c.w).map(move |x| (x, y)))
            .filter(|&(x, y)| c.is_ink(x, y, background))
            .collect();
        let span = |f: fn(&(usize, usize)) -> usize| {
            let lo = inked.iter().map(f).min().expect("ink");
            let hi = inked.iter().map(f).max().expect("ink");
            (hi - lo + 1) as f32
        };
        let got = span(|p| p.0) / span(|p| p.1);
        assert!(
            (got / want - 1.0).abs() < 0.25,
            "U+{:04X} is {got:.2} wide for its height; the bundled glyph is {want:.2}{report}",
            ch as u32
        );
    }
    for (i, a) in icons.iter().enumerate() {
        for b in &icons[i + 1..] {
            assert!(
                wide(*a).difference(wide(*b)) > 0.03,
                "U+{:04X} and U+{:04X} render the same: a missing-glyph box?{report}",
                *a as u32,
                *b as u32
            );
        }
    }
    // An icon fills a good part of its cell: it is not a speck.
    for ch in icons {
        let c = wide(ch);
        let ink_rows = (0..c.h)
            .filter(|&y| (0..c.w).any(|x| c.is_ink(x, y, background)))
            .count();
        assert!(
            ink_rows as f32 >= c.h as f32 * 0.5,
            "U+{:04X} is only {ink_rows} of {} rows tall{report}",
            ch as u32,
            c.h
        );
    }

    // The glyphs drawn as geometry fit the cell exactly.
    let (c, bg) = (by('█'), background);
    assert!(
        c.all_ink(bg) > 0.99,
        "the full block fills its cell{report}"
    );
    let c = by('▄');
    assert!(
        c.ink(0..c.w, c.h / 2 + 1..c.h, bg) > 0.99,
        "lower half is solid{report}"
    );
    assert!(
        c.ink(0..c.w, 0..c.h / 2 - 1, bg) < 0.01,
        "upper half is empty{report}"
    );
    // A horizontal line touches both side edges and is a thin band.
    let c = by('─');
    assert!(
        c.ink(0..1, 0..c.h, bg) > 0.0 && c.ink(c.w - 1..c.w, 0..c.h, bg) > 0.0,
        "─ reaches both edges{report}"
    );
    assert!(c.all_ink(bg) < 0.25, "─ is a thin line{report}");
    assert!(
        c.ink(0..c.w, 0..c.h / 4, bg) < 0.01,
        "─ is in the middle{report}"
    );
    // A vertical line touches the top and bottom edges.
    let c = by('│');
    assert!(
        c.ink(0..c.w, 0..1, bg) > 0.0 && c.ink(0..c.w, c.h - 1..c.h, bg) > 0.0,
        "│ reaches both edges{report}"
    );
    // A corner reaches the right and bottom edges only.
    let c = by('┌');
    assert!(
        c.ink(c.w - 1..c.w, 0..c.h, bg) > 0.0 && c.ink(0..c.w, c.h - 1..c.h, bg) > 0.0,
        "┌ right and down{report}"
    );
    assert!(
        c.ink(0..1, 0..c.h, bg) < 0.01 && c.ink(0..c.w, 0..1, bg) < 0.01,
        "┌ not left or up{report}"
    );
    // The solid arrows: flat and full height on one side, a point on the other.
    let c = by('\u{e0b0}');
    assert!(
        c.ink(0..1, 0..c.h, bg) > 0.9,
        "the right arrow is flat on its left edge{report}"
    );
    assert!(
        c.ink(c.w - 1..c.w, 0..c.h, bg) < 0.25,
        "and comes to a point{report}"
    );
    let c = by('\u{e0b2}');
    assert!(
        c.ink(c.w - 1..c.w, 0..c.h, bg) > 0.9,
        "the left arrow is flat on its right edge{report}"
    );
    assert!(
        c.ink(0..1, 0..c.h, bg) < 0.25,
        "and comes to a point{report}"
    );
}
