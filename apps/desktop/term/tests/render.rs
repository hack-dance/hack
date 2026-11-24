//! Pixels: prompt symbols, powerline separators and box drawing must
//! render as real glyphs, not as the missing-glyph box.
//!
//! This draws a row of code points offscreen and looks at each cell. It
//! needs GPUI's offscreen renderer: a GPU, or a software Vulkan driver.
//! Without one the test reports that it could not run and passes, unless
//! `HACK_TERM_REQUIRE_RENDERER=1` is set, as it is in CI.
//!
//! On macOS GPUI's real platform, which these cases need for real fonts,
//! must be created on the process's main thread, and a libtest or nextest
//! test runs on a worker thread. So this target has `harness = false`: its
//! `main` runs every case on the main thread, in order, and speaks the part
//! of the libtest command line nextest uses (`--list`, `--exact <name>`).

#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
fn main() {
    harness::run(&[
        (
            "prompt_symbols_separators_and_box_drawing_are_real_glyphs",
            prompt_symbols_separators_and_box_drawing_are_real_glyphs,
        ),
        (
            "a_double_width_symbol_is_drawn_in_both_of_its_cells",
            a_double_width_symbol_is_drawn_in_both_of_its_cells,
        ),
        (
            "a_missing_or_proportional_configured_font_falls_back_to_a_monospaced_one",
            a_missing_or_proportional_configured_font_falls_back_to_a_monospaced_one,
        ),
        (
            "pretty_logs_keep_the_clis_colours_and_styles",
            pretty_logs_keep_the_clis_colours_and_styles,
        ),
        (
            "selection_background_covers_find_highlights",
            selection_background_covers_find_highlights,
        ),
    ]);
}

/// The libtest command line as nextest drives it: `--list [--format terse]
/// [--ignored]` lists cases (`name: test`); otherwise the arguments that
/// do not start with `-` filter cases (exactly with `--exact`), and every
/// selected case runs on this thread. Exits 101 if a case fails.
#[cfg(unix)]
mod harness {
    pub fn run(cases: &[(&'static str, fn())]) {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let has = |flag: &str| args.iter().any(|a| a == flag);
        if has("--list") {
            if !has("--ignored") {
                for (name, _) in cases {
                    println!("{name}: test");
                }
            }
            return;
        }
        // No case is ignored: asked for ignored cases only, run none.
        if has("--ignored") {
            println!("test result: ok. 0 passed; 0 failed");
            return;
        }
        let exact = has("--exact");
        let mut filters: Vec<&str> = Vec::new();
        let mut skips: Vec<&str> = Vec::new();
        let mut it = args.iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--skip" => skips.extend(it.next().map(String::as_str)),
                // Options that take a value this harness does not use.
                "--test-threads" | "--format" | "--color" | "-Z" => {
                    it.next();
                }
                // Accepted and meaningless here: every case runs on the
                // main thread, one at a time, with output shown.
                "--exact" | "--nocapture" | "--show-output" | "--quiet" | "-q"
                | "--include-ignored" => {}
                s if s.starts_with('-') => {
                    eprintln!("render tests: unsupported option {s}");
                    std::process::exit(2);
                }
                s => filters.push(s),
            }
        }
        let matches = |name: &str, f: &str| if exact { name == f } else { name.contains(f) };
        let selected = cases.iter().filter(|(name, _)| {
            (filters.is_empty() || filters.iter().any(|f| matches(name, f)))
                && !skips.iter().any(|f| matches(name, f))
        });
        let mut failed = 0;
        let mut ran = 0;
        for (name, case) in selected {
            ran += 1;
            let ok = std::panic::catch_unwind(*case).is_ok();
            println!("test {name} ... {}", if ok { "ok" } else { "FAILED" });
            if !ok {
                failed += 1;
            }
        }
        println!(
            "test result: {}. {} passed; {failed} failed",
            if failed == 0 { "ok" } else { "FAILED" },
            ran - failed
        );
        if failed > 0 {
            std::process::exit(101);
        }
    }
}

#[cfg(unix)]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{TempHome, sh_source};
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, px, size,
};
use hack_desktop_term::emulator::TermTheme;
use hack_desktop_term::glyphs::{self, BundledSymbols};
use hack_desktop_term::stream::StreamSource;
use hack_desktop_term::view::{GridMetrics, TermFont, TerminalView};

/// A block of rendered pixels, row by row, as RGB.
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

    /// The box around the ink: left, top, right, bottom, in pixels from the
    /// top left corner. `None` when there is no ink.
    fn ink_box(&self, bg: [u8; 3]) -> Option<[f32; 4]> {
        let mut found: Option<[usize; 4]> = None;
        for y in 0..self.h {
            for x in 0..self.w {
                if self.is_ink(x, y, bg) {
                    let b = found.get_or_insert([x, y, x, y]);
                    *b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
                }
            }
        }
        found.map(|b| {
            [
                b[0] as f32,
                b[1] as f32,
                (b[2] + 1) as f32,
                (b[3] + 1) as f32,
            ]
        })
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

/// One offscreen render of a terminal view and where its grid is.
struct Capture {
    image: image::RgbaImage,
    scale: f32,
    metrics: GridMetrics,
    /// The symbols the view drew from the bundled font.
    fallback: Vec<char>,
    /// The grid as drawn.
    frame: hack_desktop_term::emulator::Frame,
}

impl Capture {
    /// The device pixel a column's left edge is on: the edge the view paints to.
    fn edge_x(&self, col: usize) -> u32 {
        ((self.metrics.origin.0 + self.metrics.cell.0 * col as f32) * self.scale).round() as u32
    }

    fn edge_y(&self, row: usize) -> u32 {
        ((self.metrics.origin.1 + self.metrics.cell.1 * row as f32) * self.scale).round() as u32
    }

    fn crop(&self, xs: std::ops::Range<u32>, ys: std::ops::Range<u32>) -> Cell {
        let mut px = Vec::new();
        for y in ys.clone() {
            for x in xs.clone() {
                let p = self.image.get_pixel(x, y).0;
                px.push([p[0], p[1], p[2]]);
            }
        }
        Cell {
            w: xs.len(),
            h: ys.len(),
            px,
        }
    }

    /// Exactly `n` cells of a row, on the edges the view paints to.
    fn cells(&self, col: usize, row: usize, n: usize) -> Cell {
        self.crop(
            self.edge_x(col)..self.edge_x(col + n),
            self.edge_y(row)..self.edge_y(row + 1),
        )
    }

    /// A cell and the one after it, always the same width, so two of them
    /// can be compared pixel by pixel.
    fn pair(&self, col: usize, row: usize) -> Cell {
        let width = (2.0 * self.metrics.cell.0 * self.scale).floor() as u32;
        let x0 = self.edge_x(col);
        self.crop(x0..x0 + width, self.edge_y(row)..self.edge_y(row + 1))
    }

    /// The top left cell is blank in every render here.
    fn background(&self) -> [u8; 3] {
        self.cells(0, 0, 1).at(0, 0)
    }

    /// How many pixels just outside a room are not the background. The
    /// room is `n` cells of `row` from `col`; "just outside" is the row
    /// above, the row below and the cell before it, and the cell after it
    /// too when `after` is set. Those cells must be blank in the render.
    /// Any visible difference counts, however faint.
    fn stray(&self, col: usize, row: usize, n: usize, after: bool) -> usize {
        let bg = self.background();
        let room_x = self.edge_x(col)..self.edge_x(col + n);
        let room_y = self.edge_y(row)..self.edge_y(row + 1);
        let xs = self.edge_x(col - 1)..self.edge_x(col + n + usize::from(after));
        let ys = self.edge_y(row - 1)..self.edge_y(row + 2);
        let mut stray = 0;
        for y in ys {
            for x in xs.clone() {
                if room_x.contains(&x) && room_y.contains(&y) {
                    continue;
                }
                let p = self.image.get_pixel(x, y).0;
                stray += usize::from((0..3).any(|i| p[i].abs_diff(bg[i]) > 8));
            }
        }
        stray
    }
}

/// Render `text` as a log in an offscreen window. `None` when this machine
/// has no offscreen renderer and one is not required.
fn capture(text: &str, font: Option<TermFont>, dump: &str) -> Option<Capture> {
    capture_sized(text, font, dump, (560., 120.))
}

fn capture_sized(
    text: &str,
    font: Option<TermFont>,
    dump: &str,
    (width, height): (f32, f32),
) -> Option<Capture> {
    capture_with_view(text, font, dump, (width, height), |_, _| {})
}

fn capture_with_view(
    text: &str,
    font: Option<TermFont>,
    dump: &str,
    (width, height): (f32, f32),
    prepare: impl FnOnce(&mut TerminalView, &mut gpui_kit::Context<TerminalView>),
) -> Option<Capture> {
    let required = std::env::var_os("HACK_TERM_REQUIRE_RENDERER").is_some_and(|v| v == "1");
    let home = TempHome::new();
    let log = home.path().join("glyphs.log");
    std::fs::write(&log, text).unwrap();

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
            size: size(px(width), px(height)),
        })),
        ..WindowOptions::default()
    };
    let (window, view) = cx
        .update(|cx| {
            gpui_kit::open_window(options, cx, |_, cx| {
                cx.new(|cx| {
                    let mut view = TerminalView::new_stream(&StreamSource::File(log), 1_000, cx)
                        .expect("open");
                    if let Some(font) = font {
                        view.set_font(font);
                    }
                    view
                })
            })
        })
        .expect("open an offscreen window");
    cx.update_window(window, |_, w, cx| w.render_frame(cx))
        .unwrap();
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.settle(Duration::from_millis(100), Duration::from_secs(20), cx);
            prepare(v, cx);
        });
    });
    cx.update_window(window, |_, w, cx| w.render_frame(cx))
        .unwrap();
    let image = match cx.capture_screenshot(window) {
        Ok(image) => image,
        Err(error) if !required => {
            eprintln!("NOT RUN: no offscreen renderer on this machine ({error})");
            return None;
        }
        Err(error) => panic!("an offscreen renderer is required here: {error}"),
    };
    // For a person to look at when an assertion needs explaining: set
    // HACK_TERM_RENDER_DUMP to a directory.
    if let Some(dir) = std::env::var_os("HACK_TERM_RENDER_DUMP") {
        image
            .save(std::path::Path::new(&dir).join(dump))
            .expect("write the capture");
    }
    let scale = cx
        .update_window(window, |_, w, _| w.scale_factor())
        .unwrap();
    let (metrics, fallback) = cx.update(|cx| {
        let v = view.read(cx);
        (v.grid_metrics(), v.fallback_symbols().to_vec())
    });
    let frame = cx.update(|cx| view.update(cx, |v, _| v.emulator().frame().expect("frame")));
    Some(Capture {
        image,
        scale,
        metrics,
        fallback,
        frame,
    })
}

fn selection_background_covers_find_highlights() {
    let Some(shot) = capture_with_view(
        " MMMM  MMMM\n",
        None,
        "selection-and-find.png",
        (560., 120.),
        |view, cx| {
            Theme::change(ThemeMode::Dark, None, cx);
            assert_eq!(view.search("MMMM", cx).total, 2);
            view.emulator().select_start(1, 0);
            view.emulator().select_to(4, 0);
            cx.notify();
        },
    ) else {
        return;
    };
    assert_eq!(shot.frame.matches.len(), 2, "both matches are visible");
    assert_eq!(shot.frame.selection[0], Some((1, 4)));
    let color = TermTheme::DARK.selection_bg;
    let selected = [color.r, color.g, color.b];
    let overlap = shot.cells(1, 0, 4).all_ink(selected);
    assert!(
        (0.01..0.5).contains(&overlap),
        "selected text should have visible ink on the selection background ({overlap})"
    );
    assert!(
        shot.cells(7, 0, 4).all_ink(shot.background()) > 0.8,
        "the unselected match should retain its Find highlight"
    );
}

/// How a sample is expected to be drawn.
#[derive(Clone, Copy, PartialEq)]
enum Drawn {
    /// As geometry, in exactly its own cell.
    Sprite,
    /// From the bundled font, in its cell and the blank one after it.
    Symbol,
    /// By the text system, as whatever this machine shows for no glyph.
    Missing,
}

/// The glyphs under test. Each has two blank cells after it, and the rows
/// above and below are blank, so the pixels around each one can be checked.
const SAMPLES: &[(&str, char, Drawn)] = &[
    ("powerline right arrow", '\u{e0b0}', Drawn::Sprite),
    ("powerline left arrow", '\u{e0b2}', Drawn::Sprite),
    ("branch", '\u{e0a0}', Drawn::Symbol),
    ("octicon", '\u{f418}', Drawn::Symbol),
    ("devicon", '\u{e718}', Drawn::Symbol),
    ("folder", '\u{f07b}', Drawn::Symbol),
    // Two glyphs whose ink rises above the font's ascender.
    ("sort", '\u{f0dc}', Drawn::Symbol),
    ("sort up", '\u{f0de}', Drawn::Symbol),
    ("box horizontal", '─', Drawn::Sprite),
    ("box vertical", '│', Drawn::Sprite),
    ("box corner", '┌', Drawn::Sprite),
    ("box double cross", '╬', Drawn::Sprite),
    // Diagonals: a stroke from corner to corner is wider than the cell
    // at its ends.
    ("box diagonal", '╱', Drawn::Sprite),
    ("box diagonal cross", '╳', Drawn::Sprite),
    ("full block", '█', Drawn::Sprite),
    ("lower half block", '▄', Drawn::Sprite),
    // A private-use code point no font has, the symbols font included:
    // whatever this cell shows is this machine's missing-glyph rendering.
    ("known-missing", '\u{e050}', Drawn::Missing),
];
/// The row the samples are on, and the column of the first one.
const ROW: usize = 1;
const FIRST: usize = 1;
const STEP: usize = 3;

/// Assert that what is in a room is the bundled glyph, where the view's
/// own placement rule puts it: the ink's box matches to within a pixel and
/// a half on each side.
fn assert_placed(shot: &Capture, ch: char, col: usize, row: usize, n: usize, report: &str) {
    let outline = glyphs::outline(ch).expect("in the bundled font");
    let room = shot.cells(col, row, n);
    let want = outline.place(room.w as f32, room.h as f32).ink(&outline);
    let got = room
        .ink_box(shot.background())
        .unwrap_or_else(|| panic!("U+{:04X} is blank{report}", ch as u32));
    for side in 0..4 {
        assert!(
            (got[side] - want[side]).abs() <= 1.5,
            "U+{:04X}: ink box {got:?}, the bundled glyph placed in {}x{} is {want:?}{report}",
            ch as u32,
            room.w,
            room.h
        );
    }
}

fn prompt_symbols_separators_and_box_drawing_are_real_glyphs() {
    let row: String = SAMPLES.iter().map(|(_, ch, _)| format!("{ch}  ")).collect();
    let Some(shot) = capture(&format!("\n {row}\n\n"), None, "glyphs.png") else {
        return;
    };
    let background = shot.background();
    let col_of = |ch: char| FIRST + STEP * SAMPLES.iter().position(|s| s.1 == ch).expect("sample");
    let cells: Vec<(&str, char, Cell)> = SAMPLES
        .iter()
        .map(|(name, ch, _)| (*name, *ch, shot.pair(col_of(*ch), ROW)))
        .collect();
    let wide = |ch: char| &cells.iter().find(|c| c.1 == ch).expect("sample").2;
    let by = |ch: char| shot.cells(col_of(ch), ROW, 1);
    let report: String = cells
        .iter()
        .map(|(name, ch, cell)| {
            format!(
                "\n  U+{:04X} {name}: {}x{} ink {:.2}",
                *ch as u32,
                cell.w,
                cell.h,
                cell.all_ink(background)
            )
        })
        .collect();
    let report = format!(
        "\nscale {}, from the symbols font: {:04X?}{report}",
        shot.scale, shot.fallback
    );
    eprintln!("{report}");

    // Every glyph draws something.
    let missing = wide('\u{e050}');
    for (name, ch, cell) in &cells {
        if *ch == '\u{e050}' {
            continue;
        }
        assert!(
            cell.all_ink(background) > 0.02,
            "U+{:04X} {name} is blank{report}",
            *ch as u32
        );
        // And it is not this machine's missing-glyph box.
        assert!(
            cell.difference(missing) > 0.03,
            "U+{:04X} {name} renders like a missing glyph{report}",
            *ch as u32
        );
    }
    // Missing glyphs all look alike; real icons do not.
    let icons = ['\u{e0a0}', '\u{f418}', '\u{e718}', '\u{f07b}'];
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
        let cell = wide(ch);
        let ink_rows = (0..cell.h)
            .filter(|&y| (0..cell.w).any(|x| cell.is_ink(x, y, background)))
            .count();
        assert!(
            ink_rows as f32 >= cell.h as f32 * 0.5,
            "U+{:04X} is only {ink_rows} of {} rows tall{report}",
            ch as u32,
            cell.h
        );
    }
    // The view's default font is not a Nerd Font, so every symbol comes from
    // the bundled font and none from whatever fonts this machine has. A
    // machine font may define one of these code points as something else.
    let mut expected: Vec<char> = SAMPLES
        .iter()
        .filter(|s| s.2 == Drawn::Symbol)
        .map(|s| s.1)
        .collect();
    expected.sort_unstable();
    assert_eq!(
        shot.fallback, expected,
        "the icons are drawn from the bundled symbols font{report}"
    );
    // And what is on screen is the bundled glyph, placed by its ink: no
    // part of it is cut off and it is the size its room allows.
    for (_, ch, drawn) in SAMPLES {
        if *drawn == Drawn::Symbol {
            assert_placed(&shot, *ch, col_of(*ch), ROW, 2, &report);
        }
    }
    // Nothing is drawn outside a glyph's room: not in the rows above and
    // below it, nor in the blank cells before and after it.
    for (name, ch, drawn) in SAMPLES {
        let n = match drawn {
            Drawn::Sprite => 1,
            Drawn::Symbol => 2,
            Drawn::Missing => continue,
        };
        let stray = shot.stray(col_of(*ch), ROW, n, true);
        assert_eq!(
            stray, 0,
            "U+{:04X} {name} paints {stray} pixels outside its {n}-cell room{report}",
            *ch as u32
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

fn a_double_width_symbol_is_drawn_in_both_of_its_cells() {
    // U+26A1 is double width and in the bundled font. Many fonts have it
    // too, so the bundled font is asked for outright. The "x" straight
    // after it shows that the two cells are the symbol's own and not a
    // blank neighbour borrowed.
    let bolt = '\u{26a1}';
    let font = TermFont {
        symbols: BundledSymbols::Always,
        ..TermFont::default()
    };
    let Some(shot) = capture(&format!("\n {bolt}x\n\n"), Some(font), "wide.png") else {
        return;
    };
    let bg = shot.background();
    let report = format!(
        "\nscale {}, from the symbols font: {:04X?}",
        shot.scale, shot.fallback
    );
    assert_eq!(shot.fallback, [bolt], "drawn from the bundled font{report}");
    assert!(
        shot.cells(3, ROW, 1).all_ink(bg) > 0.02 && shot.cells(4, ROW, 1).all_ink(bg) == 0.0,
        "the symbol takes two cells: the x is in the fourth column{report}"
    );
    // The glyph is placed in the two cells together.
    assert_placed(&shot, bolt, 1, ROW, 2, &report);
    // Which is larger than it would be in one cell, and reaches the second.
    let outline = glyphs::outline(bolt).unwrap();
    let (one, two) = (shot.cells(1, ROW, 1), shot.cells(1, ROW, 2));
    let [_, top, _, bottom] = two.ink_box(bg).expect("ink");
    let [_, one_top, _, one_bottom] = outline.place(one.w as f32, one.h as f32).ink(&outline);
    assert!(
        bottom - top > (one_bottom - one_top) + 2.0,
        "the symbol is {} pixels tall; fitted to one cell it would be {}{report}",
        bottom - top,
        one_bottom - one_top
    );
    assert!(
        shot.cells(2, ROW, 1).all_ink(bg) > 0.02,
        "the symbol reaches into its second cell{report}"
    );
    // And it stays in them. The cell after is the x, so it is not checked.
    let stray = shot.stray(1, ROW, 2, false);
    assert_eq!(stray, 0, "{stray} pixels outside the two cells{report}");
}

/// Every printable ASCII character of `family` has the same advance.
fn fixed_advance(window: &mut gpui_kit::Window, family: &str) -> bool {
    let ts = window.text_system();
    let id = ts.resolve_font(&gpui_kit::font(family.to_owned()));
    let size = gpui_kit::px(13.);
    let widths: Vec<_> = (0x21u8..0x7f)
        .map(|c| ts.advance(id, size, char::from(c)).map(|s| s.width).ok())
        .collect();
    widths.iter().all(|w| w.is_some() && *w == widths[0])
}

fn a_missing_or_proportional_configured_font_falls_back_to_a_monospaced_one() {
    use hack_desktop_term::ghostty_config::GhosttyLook;
    let home = TempHome::new();
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(gpui_kit::assets::Assets),
        || Ok(None),
    );
    cx.update(gpui_kit::init);
    let source = sh_source("echo ready; exec sleep 120", &home);
    let options = WindowOptions {
        focus: false,
        show: false,
        ..WindowOptions::default()
    };
    let (window, view) = cx
        .update(|cx| {
            gpui_kit::open_window(options, cx, |_, cx| {
                cx.new(|cx| TerminalView::new_stream(&source, 100, cx).expect("open"))
            })
        })
        .expect("open a headless window");
    let draw_with = |cx: &mut HeadlessAppContext, family: &str| {
        let look = GhosttyLook {
            font_families: vec![family.to_owned()],
            ..GhosttyLook::default()
        };
        cx.update(|cx| view.update(cx, |v, cx| v.set_look(look, cx)));
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .expect("draw");
        let drawn = cx.update(|cx| view.read(cx).rendered().clone());
        let fixed = cx
            .update_window(window, |_, window, _| {
                fixed_advance(window, &drawn.font_family)
            })
            .expect("measure");
        (drawn, fixed)
    };

    let missing = "Hack Test Family That Is Not Installed";
    let (drawn, fixed) = draw_with(&mut cx, missing);
    assert_ne!(drawn.font_family, missing);
    assert!(fixed, "{} is not monospaced", drawn.font_family);
    let note = drawn.font_note.expect("a note says the font was not found");
    assert!(
        note.contains(missing) && note.contains("not installed"),
        "{note}"
    );

    // A proportional family that is installed is refused too, when this
    // machine has one.
    let proportional = cx
        .update_window(window, |_, window, _| {
            window
                .text_system()
                .all_font_names()
                .into_iter()
                .find(|f| !fixed_advance(window, f))
        })
        .expect("list fonts");
    if let Some(proportional) = proportional {
        let (drawn, fixed) = draw_with(&mut cx, &proportional);
        assert_ne!(drawn.font_family, proportional);
        assert!(fixed, "{} is not monospaced", drawn.font_family);
        assert!(
            drawn
                .font_note
                .as_deref()
                .is_some_and(|n| n.contains("not monospaced")),
            "{:?}",
            drawn.font_note
        );
    }
}

/// `hack logs --pretty` output (captured on a PTY from the CLI's shared
/// formatter, `formatPrettyLogLine`, over synthetic service lines) keeps its
/// styling in the grid: coloured levels, bold 256-colour service names and
/// dim keys. Without `--pretty` only what services print themselves is
/// coloured.
fn pretty_logs_keep_the_clis_colours_and_styles() {
    let sample = include_str!("fixtures/logs-pretty.ansi");
    let Some(shot) = capture_sized(sample, None, "logs-pretty.png", (720., 200.)) else {
        return;
    };
    let f = &shot.frame;
    let cells = || {
        f.rows
            .iter()
            .flatten()
            .filter(|c| !c.text.trim().is_empty())
    };
    let styled = cells()
        .filter(|c| c.fg != f.foreground || c.bold || c.faint)
        .count();
    let bold = cells().filter(|c| c.bold).count();
    let faint = cells().filter(|c| c.faint).count();
    let mut colours: Vec<_> = cells().map(|c| c.fg).collect();
    colours.sort_by_key(|c| (c.r, c.g, c.b));
    colours.dedup();
    assert!(styled >= 50, "styled cells: {styled}");
    assert!(bold > 0 && faint > 0, "bold {bold}, faint {faint}");
    assert!(
        colours.len() >= 5,
        "distinct foreground colours: {}",
        colours.len()
    );
}
