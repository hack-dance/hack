//! Rough throughput numbers for the terminal surface. Run it in release:
//!
//! ```sh
//! cargo run --release -p hack-desktop-term --features screenshots --example term_bench
//! ```
//!
//! It measures three things on the current machine:
//!
//! 1. emulation: bytes per second through `Emulator::feed` (libghostty-vt)
//!    for a coloured log flood and for full-screen repaints;
//! 2. frame extraction: `Emulator::frame` for a full 200x60 grid;
//! 3. paint: one offscreen GPUI frame of the same grid, with every row
//!    changed (worst case) and with nothing changed. This is the CPU side
//!    (layout, shaping, scene building, submission), not GPU time or
//!    display latency.
//!
//! These are a sanity check, not a qualification. A debug build is far
//! slower; libghostty-vt is built unoptimised there.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, px, size,
};
use hack_desktop_term::emulator::{Emulator, EmulatorOptions};
use hack_desktop_term::stream::StreamSource;
use hack_desktop_term::view::TerminalView;

const COLS: u16 = 200;
const ROWS: u16 = 60;

fn log_flood(bytes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes + 256);
    let mut i = 0u64;
    while out.len() < bytes {
        out.extend_from_slice(
            format!(
                "\x1b[90m12:{:02}:{:02}.{:03}\x1b[0m \x1b[36mworker\x1b[0m \x1b[32mINFO \x1b[0m request {i} handled in \x1b[38;2;120;170;255m{}ms\x1b[0m path=/api/v1/items/{} status=200\n",
                (i / 60) % 60,
                i % 60,
                (i * 37) % 1000,
                (i * 7) % 250,
                i * 31
            )
            .as_bytes(),
        );
        i += 1;
    }
    out
}

/// One full-screen repaint, the way a TUI redraws: home, then every row
/// with a few colour changes. `seed` makes each frame differ.
fn tui_frame(seed: u32) -> Vec<u8> {
    let mut out = b"\x1b[H".to_vec();
    for r in 0..u32::from(ROWS) {
        out.extend_from_slice(format!("\x1b[{};1H", r + 1).as_bytes());
        for c in 0..u32::from(COLS) / 10 {
            let n = (seed + r * 7 + c * 13) % 256;
            out.extend_from_slice(format!("\x1b[38;5;{n}m{:>9} ", seed + r * c).as_bytes());
        }
    }
    out.extend_from_slice(b"\x1b[0m");
    out
}

fn mean_and_worst(samples: &[Duration]) -> (f64, f64) {
    let ms = |d: &Duration| d.as_secs_f64() * 1000.0;
    let mean = samples.iter().map(ms).sum::<f64>() / samples.len() as f64;
    let worst = samples.iter().map(ms).fold(0.0, f64::max);
    (mean, worst)
}

fn main() {
    if cfg!(debug_assertions) {
        eprintln!("note: this is a debug build; run with --release for meaningful numbers");
    }
    let opts = EmulatorOptions {
        cols: COLS,
        rows: ROWS,
        scrollback_lines: 10_000,
        newline_is_crlf: true,
        ..EmulatorOptions::default()
    };

    // 1. Emulation throughput.
    let flood = log_flood(64 << 20);
    let mut emu = Emulator::new(opts).expect("emulator");
    let start = Instant::now();
    for chunk in flood.chunks(64 * 1024) {
        emu.feed(chunk);
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "emulate log flood:   {:>8.1} MiB/s  ({} MiB, {} lines of scrollback kept)",
        flood.len() as f64 / secs / (1 << 20) as f64,
        flood.len() >> 20,
        emu.scrollback_rows()
    );
    let frames: Vec<Vec<u8>> = (0..500).map(tui_frame).collect();
    let bytes: usize = frames.iter().map(Vec::len).sum();
    let mut emu = Emulator::new(opts).expect("emulator");
    let start = Instant::now();
    for f in &frames {
        emu.feed(f);
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "emulate TUI repaint: {:>8.1} MiB/s  ({:.0} full {COLS}x{ROWS} repaints/s)",
        bytes as f64 / secs / (1 << 20) as f64,
        frames.len() as f64 / secs
    );

    // 2. Frame extraction for a full grid.
    let mut samples = Vec::new();
    for f in frames.iter().take(200) {
        emu.feed(f);
        let start = Instant::now();
        let frame = emu.frame().expect("frame");
        samples.push(start.elapsed());
        assert_eq!(frame.rows.len(), usize::from(ROWS));
    }
    let (mean, worst) = mean_and_worst(&samples);
    println!(
        "extract frame:       {mean:>8.3} ms mean, {worst:.3} ms worst  ({COLS}x{ROWS}, all rows changed)"
    );

    // 3. Offscreen GPUI paint of the same grid.
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(gpui_kit::assets::Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(gpui_kit::init);
    cx.update(|cx| Theme::change(ThemeMode::Dark, None, cx));
    let tmp = std::env::temp_dir().join(format!("hack-term-bench-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("temp dir");
    let empty = tmp.join("empty.log");
    std::fs::write(&empty, b"").expect("write");
    let window = WindowOptions {
        focus: false,
        show: false,
        // 200x60 cells at the default 13 px font is about 1600x1050.
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: Default::default(),
            size: size(px(1640.), px(1040.)),
        })),
        ..WindowOptions::default()
    };
    let (handle, view) = cx
        .update(|cx| {
            gpui_kit::open_window(window, cx, |_, cx| {
                cx.new(|cx| {
                    TerminalView::new_stream(&StreamSource::File(empty.clone()), 10_000, cx)
                        .expect("open stream")
                })
            })
        })
        .expect("open offscreen window");
    let draw = |cx: &mut HeadlessAppContext| {
        let start = Instant::now();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .expect("render");
        start.elapsed()
    };
    draw(&mut cx);
    let grid = cx.update(|cx| view.update(cx, |v, _| (v.emulator().cols(), v.emulator().rows())));
    // Warm up glyph and layout caches, then measure.
    let mut changed = Vec::new();
    for (i, f) in frames.iter().enumerate().take(260) {
        cx.update(|cx| {
            view.update(cx, |v, cx| {
                v.emulator().feed(f);
                cx.notify();
            });
        });
        let took = draw(&mut cx);
        if i >= 60 {
            changed.push(took);
        }
    }
    let unchanged: Vec<Duration> = (0..200)
        .map(|_| {
            cx.update(|cx| view.update(cx, |_, cx| cx.notify()));
            draw(&mut cx)
        })
        .collect();
    let (mean, worst) = mean_and_worst(&changed);
    println!(
        "paint, all changed:  {mean:>8.3} ms mean, {worst:.3} ms worst  ({}x{} grid; {:.0} frames/s of CPU budget)",
        grid.0,
        grid.1,
        1000.0 / mean
    );
    let (mean, worst) = mean_and_worst(&unchanged);
    println!("paint, unchanged:    {mean:>8.3} ms mean, {worst:.3} ms worst");
    cx.update_window(handle, |_, window, _| window.remove_window())
        .ok();
    let _ = std::fs::remove_dir_all(&tmp);
}
