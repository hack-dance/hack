//! The GPUI terminal view: libghostty-vt state painted as GPUI quads and
//! shaped text, so it composes like any other element (clipping, z-order,
//! focus, overlays such as the search bar drawn above it).
//!
//! A [`TerminalView`] wraps a [`TerminalCore`]: a read-only stream (logs) or
//! an app-owned PTY (an interactive shell or `hack exec`). Dropping the view
//! drops the core, which ends the stream's or the PTY's session. On app quit
//! the PTY session is ended on the background executor, with a grace short
//! enough to finish inside GPUI's shutdown window.
//!
//! Nothing here blocks the UI thread on the child: output arrives through a
//! bounded queue, input is queued for a writer thread, and input that cannot
//! be queued is dropped whole and shown as a notice.
//!
//! Keys (PTY): typed text and keys are encoded by libghostty for the
//! program's modes. Copy: Cmd-C (macOS) or Ctrl-Shift-C. Paste: Cmd-V or
//! Ctrl-Shift-V. Search: Cmd-F or Ctrl-Shift-F; Enter older, Shift-Enter
//! newer, Escape closes. Stream views also scroll with PageUp/PageDown,
//! Home/End, and toggle follow with `f`.

use std::time::Duration;

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    App, Bounds, ClipboardItem, Context, FocusHandle, Focusable, Font, FontStyle, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Render, ScrollDelta, ScrollEvent,
    SharedString, StrikethroughStyle, Styled as _, TextAlign, TextRun, UnderlineStyle, Window,
    canvas, div, fill, point, px, size,
};

use crate::emulator::{Emulator, Frame, KeyInput, Rgb, SearchState, TermTheme};
use crate::pty::{PtyOptions, QUIT_GRACE};
use crate::stream::StreamSource;
pub use crate::terminal::Status;
use crate::terminal::TerminalCore;

const PAD: f32 = 8.0;
/// GPUI gives quit handlers 200 ms in total.
const QUIT_DEADLINE: Duration = Duration::from_millis(180);

/// Font settings. Defaults to the theme's monospace family.
#[derive(Clone, Debug)]
pub struct TermFont {
    pub family: Option<SharedString>,
    pub size: Pixels,
    pub line_height: f32,
}

impl Default for TermFont {
    fn default() -> Self {
        Self {
            family: None,
            size: px(13.),
            line_height: 1.3,
        }
    }
}

pub struct TerminalView {
    core: TerminalCore,
    focus: FocusHandle,
    font: TermFont,
    /// Cell size and canvas origin from the last layout.
    cell: (Pixels, Pixels),
    origin: gpui_kit::Point<Pixels>,
    selecting: bool,
    scroll_carry: f32,
    search_open: bool,
    query: String,
    search: SearchState,
    applied_theme: Option<TermTheme>,
}

impl TerminalView {
    /// A read-only view over a file or process (log stream).
    pub fn new_stream(
        source: &StreamSource,
        scrollback_lines: usize,
        cx: &mut Context<Self>,
    ) -> std::io::Result<Self> {
        Ok(Self::with_core(
            TerminalCore::stream(source, scrollback_lines)?,
            cx,
        ))
    }

    /// An interactive view over a program on an app-owned PTY.
    pub fn new_pty(opts: &PtyOptions, cx: &mut Context<Self>) -> std::io::Result<Self> {
        let core = TerminalCore::pty(opts)?;
        // End the session before the process exits; Drop alone may not run
        // when the app quits. The signalling and the wait run on the
        // background executor, never on the UI thread.
        cx.on_app_quit(|this, cx| {
            let pty = this.core.take_pty();
            // GPUI awaits the returned task inside its shutdown window.
            cx.background_executor().spawn(async move {
                if let Some(pty) = pty {
                    pty.terminate_blocking_with(QUIT_GRACE, QUIT_DEADLINE);
                }
            })
        })
        .detach();
        Ok(Self::with_core(core, cx))
    }

    fn with_core(core: TerminalCore, cx: &mut Context<Self>) -> Self {
        cx.spawn(async move |this, cx| {
            loop {
                let Ok(busy) = this.update(cx, |v, cx| v.pump(cx)) else {
                    break;
                };
                let wait = if busy { 8 } else { 33 };
                cx.background_executor()
                    .timer(Duration::from_millis(wait))
                    .await;
            }
        })
        .detach();
        Self {
            core,
            focus: cx.focus_handle(),
            font: TermFont::default(),
            cell: (px(8.), px(17.)),
            origin: point(px(0.), px(0.)),
            selecting: false,
            scroll_carry: 0.,
            search_open: false,
            query: String::new(),
            search: SearchState::default(),
            applied_theme: None,
        }
    }

    pub fn set_font(&mut self, font: TermFont) {
        self.font = font;
    }

    pub fn status(&self) -> &Status {
        self.core.status()
    }

    pub fn follow(&self) -> bool {
        self.core.emu().follow()
    }

    pub fn set_follow(&mut self, follow: bool, cx: &mut Context<Self>) {
        self.core.emulator().set_follow(follow);
        cx.notify();
    }

    /// Search hook: set the query (empty clears) and jump to the newest match.
    pub fn search(&mut self, query: &str, cx: &mut Context<Self>) -> SearchState {
        self.query = query.to_owned();
        self.search_open = !query.is_empty();
        self.search = self.core.emulator().search(Some(query));
        cx.notify();
        self.search
    }

    /// Search hook: step to an older or newer match.
    pub fn search_step(&mut self, older: bool, cx: &mut Context<Self>) -> SearchState {
        self.search = self.core.emulator().search_step(older);
        cx.notify();
        self.search
    }

    /// Pump synchronously until nothing arrives for `quiet` or `deadline`
    /// passes. For headless capture and tests; the window uses its timer.
    pub fn settle(&mut self, quiet: Duration, deadline: Duration, cx: &mut Context<Self>) {
        self.core.settle(quiet, deadline);
        cx.notify();
    }

    /// Queue input for the PTY as if typed (no-op for a stream view).
    pub fn type_text(&mut self, text: &str) {
        self.core.send(text.as_bytes());
    }

    /// The emulator, for hosts that need more than the hooks above.
    pub fn emulator(&mut self) -> &mut Emulator {
        self.core.emulator()
    }

    /// Process pending output. Returns whether anything arrived.
    fn pump(&mut self, cx: &mut Context<Self>) -> bool {
        let busy = self.core.pump();
        if busy {
            if self.search_open {
                self.search = self.core.emu().search_state();
            }
            cx.notify();
        }
        busy
    }

    fn send(&mut self, bytes: &[u8]) {
        self.core.send(bytes);
    }

    fn cell_at(&self, pos: gpui_kit::Point<Pixels>) -> (u16, u16) {
        let x = ((pos.x - self.origin.x) / self.cell.0).max(0.) as u16;
        let y = ((pos.y - self.origin.y) / self.cell.1).max(0.) as u16;
        (
            x.min(self.core.emu().cols().saturating_sub(1)),
            y.min(self.core.emu().rows().saturating_sub(1)),
        )
    }

    fn copy(&self, cx: &mut App) {
        if let Some(text) = self.core.emu().selection_text() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let m = k.modifiers;
        let chord = m.platform || (m.control && m.shift);
        if chord && k.key == "c" {
            self.copy(cx);
            return;
        }
        if chord && k.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                let bytes = self.core.emulator().encode_paste(&text);
                self.send(&bytes);
            }
            return;
        }
        if chord && k.key == "f" {
            self.search_open = true;
            cx.notify();
            return;
        }
        if self.search_open {
            match k.key.as_str() {
                "escape" => {
                    self.search_open = false;
                    self.query.clear();
                    self.search = self.core.emulator().search(None);
                }
                "enter" => self.search = self.core.emulator().search_step(!m.shift),
                "backspace" => {
                    self.query.pop();
                    self.search = self.core.emulator().search(Some(&self.query));
                }
                _ => {
                    if let Some(t) = k.key_char.as_deref().filter(|_| !m.control && !m.platform) {
                        self.query.push_str(t);
                        self.search = self.core.emulator().search(Some(&self.query));
                    }
                }
            }
            cx.notify();
            return;
        }
        let rows = self.core.emu().rows() as isize;
        match (self.core.read_only(), k.key.as_str()) {
            (true, "pageup") => self.core.emulator().scroll(-rows),
            (true, "pagedown") => self.core.emulator().scroll(rows),
            (true, "home") => self.core.emulator().scroll(isize::MIN / 2),
            (true, "end") => self.core.emulator().set_follow(true),
            (true, "f") => {
                let follow = !self.core.emu().follow();
                self.core.emulator().set_follow(follow);
            }
            (true, _) => return,
            (false, _) => {
                if m.shift && matches!(k.key.as_str(), "pageup" | "pagedown") {
                    self.core
                        .emulator()
                        .scroll(if k.key == "pageup" { -rows } else { rows });
                } else {
                    let bytes = self.core.emulator().encode_key(KeyInput {
                        key: &k.key,
                        text: k.key_char.as_deref(),
                        shift: m.shift,
                        ctrl: m.control,
                        alt: m.alt,
                        meta: m.platform,
                    });
                    self.core.emulator().clear_selection();
                    self.core.emulator().set_follow(true);
                    self.send(&bytes);
                }
            }
        }
        cx.notify();
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let (c, r) = self.cell_at(ev.position);
        if (ev.modifiers.platform || ev.modifiers.control)
            && let Some(url) = self.core.emulator().link_at(c, r)
        {
            cx.open_url(&url);
            return;
        }
        if ev.click_count >= 3 {
            self.core.emulator().select_all();
        } else {
            self.core.emulator().select_start(c, r);
            self.selecting = true;
        }
        cx.notify();
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting && ev.pressed_button == Some(MouseButton::Left) {
            let (c, r) = self.cell_at(ev.position);
            self.core.emulator().select_to(c, r);
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_scroll(&mut self, ev: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let lines = match ev.delta {
            ScrollDelta::Lines(p) => p.y * 3.,
            ScrollDelta::Pixels(p) => p.y / self.cell.1,
        };
        self.scroll_carry -= lines;
        let whole = self.scroll_carry.trunc();
        if whole != 0. {
            self.scroll_carry -= whole;
            self.core.emulator().scroll(whole as isize);
            cx.notify();
        }
    }

    fn sync_theme(&mut self, cx: &App) {
        let t = cx.theme();
        let theme = TermTheme {
            foreground: rgb_of(t.foreground),
            background: rgb_of(t.background),
            cursor: rgb_of(t.foreground),
            selection_bg: rgb_of(t.selection),
            ..if t.is_dark() {
                TermTheme::DARK
            } else {
                TermTheme::LIGHT
            }
        };
        if self.applied_theme != Some(theme) {
            let _ = self.core.emulator().set_theme(theme);
            self.applied_theme = Some(theme);
        }
    }

    /// Size the grid to the canvas (and tell the PTY), then build the frame.
    fn layout(&mut self, bounds: Bounds<Pixels>, cell: (Pixels, Pixels)) -> Option<Frame> {
        self.cell = cell;
        self.origin = point(bounds.origin.x + px(PAD), bounds.origin.y + px(PAD));
        let cols = ((bounds.size.width - px(2. * PAD)) / cell.0)
            .floor()
            .max(1.) as u16;
        let rows = ((bounds.size.height - px(2. * PAD)) / cell.1)
            .floor()
            .max(1.) as u16;
        let (cw, ch) = (
            f32::from(cell.0).round() as u16,
            f32::from(cell.1).round() as u16,
        );
        self.core.resize(cols, rows, cw, ch);
        self.core.emulator().frame().ok()
    }
}

fn rgb_of(h: Hsla) -> Rgb {
    let c = h.to_rgb();
    let q = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
    Rgb::new(q(c.r), q(c.g), q(c.b))
}

fn hsla(c: Rgb) -> Hsla {
    gpui_kit::rgb(c.to_u32()).into()
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_theme(cx);
        let family = self
            .font
            .family
            .clone()
            .unwrap_or_else(|| cx.theme().mono_font_family.clone());
        let base_font = gpui_kit::font(family);
        let font_size = self.font.size;
        let ts = window.text_system();
        let font_id = ts.resolve_font(&base_font);
        let cell_w = ts
            .advance(font_id, font_size, 'm')
            .map(|s| s.width)
            .unwrap_or(font_size * 0.6);
        let cell_h = (font_size * self.font.line_height).round();
        let focused = self.focus.is_focused(window);
        let theme = self.applied_theme.unwrap_or(TermTheme::DARK);
        let entity = cx.entity();
        // A log stream has no input, so it has no cursor.
        let show_cursor = !self.core.read_only();

        let surface = canvas(
            move |bounds, _window, cx| entity.update(cx, |v, _| v.layout(bounds, (cell_w, cell_h))),
            move |bounds, frame, window, cx| {
                let Some(frame) = frame else { return };
                paint_frame(
                    &PaintArgs {
                        bounds,
                        frame: &frame,
                        font: &base_font,
                        font_size,
                        cell: (cell_w, cell_h),
                        focused,
                        show_cursor,
                        theme,
                    },
                    window,
                    cx,
                );
            },
        )
        .size_full();

        let overlay = self.search_open.then(|| {
            let t = cx.theme();
            let count = match (self.search.total, self.search.selected) {
                (0, _) => "no matches".to_owned(),
                (n, Some(i)) => format!("{} of {n}", i + 1),
                (n, None) => format!("{n} matches"),
            };
            div()
                .absolute()
                .top(px(6.))
                .right(px(14.))
                .px(px(10.))
                .py(px(4.))
                .rounded(px(6.))
                .bg(t.popover)
                .border_1()
                .border_color(t.border)
                .text_color(t.foreground)
                .text_size(px(12.))
                .flex()
                .gap(px(10.))
                .child(format!("Find: {}▏", self.query))
                .child(div().text_color(t.muted_foreground).child(count))
        });

        // A notice about undelivered input outranks the status line.
        let status = match (self.core.notice(), self.core.status()) {
            (Some(notice), _) => Some(notice.to_owned()),
            (None, Status::Ended(s)) => Some(s.clone()),
            (None, Status::Running) if self.core.read_only() && !self.core.emu().follow() => {
                Some("paused (End to follow)".into())
            }
            _ => None,
        };
        let status = status.map(|s| {
            let t = cx.theme();
            div()
                .absolute()
                .bottom(px(6.))
                .right(px(14.))
                .px(px(8.))
                .py(px(2.))
                .rounded(px(4.))
                .bg(t.secondary)
                .text_color(t.muted_foreground)
                .text_size(px(11.))
                .child(s)
        });

        div()
            .id("terminal")
            .track_focus(&self.focus)
            .key_context("Terminal")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(hsla(theme.background))
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_scroll(cx.listener(Self::on_scroll))
            .child(surface)
            .children(overlay)
            .children(status)
    }
}

struct PaintArgs<'a> {
    bounds: Bounds<Pixels>,
    frame: &'a Frame,
    font: &'a Font,
    font_size: Pixels,
    cell: (Pixels, Pixels),
    focused: bool,
    show_cursor: bool,
    theme: TermTheme,
}

/// Paint backgrounds, highlights, the cursor, then text. Text is shaped in
/// runs of narrow cells with a forced per-glyph advance of one cell, so the
/// grid stays exact; wide characters are placed on their own two cells.
fn paint_frame(a: &PaintArgs<'_>, window: &mut Window, cx: &mut App) {
    let (cw, ch) = a.cell;
    let ox = a.bounds.origin.x + px(PAD);
    let oy = a.bounds.origin.y + px(PAD);
    let at = |col: u16, row: usize| point(ox + cw * f32::from(col), oy + ch * row as f32);
    let rect = |col: u16, row: usize, n: u16| Bounds {
        origin: at(col, row),
        size: size(cw * f32::from(n), ch),
    };
    window.paint_quad(fill(a.bounds, hsla(a.frame.background)));

    for (y, row) in a.frame.rows.iter().enumerate() {
        // Cell backgrounds, merged into spans.
        let mut x = 0usize;
        while x < row.len() {
            let Some(bg) = row[x].bg else {
                x += 1;
                continue;
            };
            let start = x;
            while x < row.len() && row[x].bg == Some(bg) {
                x += 1;
            }
            let n = u16::try_from(x - start).unwrap_or(u16::MAX);
            window.paint_quad(fill(rect(start as u16, y, n), hsla(bg)));
        }
        if let Some(Some((s, e))) = a.frame.selection.get(y) {
            let sel = hsla(a.theme.selection_bg).opacity(0.45);
            window.paint_quad(fill(rect(*s, y, e - s + 1), sel));
        }
    }
    for &(row, s, e, active) in &a.frame.matches {
        let c = if active {
            a.theme.active_match_bg
        } else {
            a.theme.match_bg
        };
        window.paint_quad(fill(
            rect(s, usize::from(row), e - s + 1),
            hsla(c).opacity(0.9),
        ));
    }
    if let Some((cx_, cy)) = a.frame.cursor.filter(|_| a.show_cursor) {
        let r = rect(cx_, usize::from(cy), 1);
        let c = hsla(a.frame.cursor_color);
        if a.focused {
            window.paint_quad(fill(r, c));
        } else {
            window.paint_quad(gpui_kit::outline(r, c, gpui_kit::BorderStyle::Solid));
        }
    }

    let ts = window.text_system().clone();
    for (y, row) in a.frame.rows.iter().enumerate() {
        let mut x = 0usize;
        while x < row.len() {
            if row[x].spacer || row[x].text.is_empty() && row[x].bg.is_none() && !row[x].underline {
                x += 1;
                continue;
            }
            let start = x;
            let mut text = String::new();
            let mut runs: Vec<TextRun> = Vec::new();
            let wide = row[x].wide;
            loop {
                let c = &row[x];
                let glyph = if c.text.is_empty() {
                    " "
                } else {
                    c.text.as_str()
                };
                let on_cursor =
                    a.show_cursor && a.focused && a.frame.cursor == Some((x as u16, y as u16));
                let fg = if on_cursor { a.frame.background } else { c.fg };
                let mut color = hsla(fg);
                if c.faint {
                    color = color.opacity(0.6);
                }
                let mut font = a.font.clone();
                if c.bold {
                    font.weight = FontWeight::BOLD;
                }
                if c.italic {
                    font.style = FontStyle::Italic;
                }
                let run = TextRun {
                    len: glyph.len(),
                    font,
                    color,
                    background_color: None,
                    underline: c.underline.then_some(UnderlineStyle {
                        thickness: px(1.),
                        color: Some(color),
                        wavy: false,
                    }),
                    strikethrough: c.strikethrough.then_some(StrikethroughStyle {
                        thickness: px(1.),
                        color: Some(color),
                    }),
                };
                match runs.last_mut() {
                    Some(last)
                        if last.font == run.font
                            && last.color == run.color
                            && last.underline == run.underline
                            && last.strikethrough == run.strikethrough =>
                    {
                        last.len += run.len;
                    }
                    _ => runs.push(run),
                }
                text.push_str(glyph);
                x += 1;
                if wide || x >= row.len() || row[x].wide || row[x].spacer {
                    break;
                }
            }
            let forced = (!wide).then_some(cw);
            let line = ts.shape_line(text.into(), a.font_size, &runs, forced);
            // Centre the font's line box in the cell.
            let _ = line.paint(at(start as u16, y), ch, TextAlign::Left, None, window, cx);
        }
    }
}
