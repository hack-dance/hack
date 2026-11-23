//! libghostty-vt terminal state behind a small, GUI-free API.
//!
//! [`Emulator`] owns one `ghostty_vt::Terminal` plus its render state and
//! search. It is `!Send`: drive it from one thread (the GPUI main thread).
//! [`Emulator::frame`] turns the viewport into a plain [`Frame`] the GPUI
//! element paints; tests read the same frame.
//!
//! Search is the hook the Logs tab builds on: [`Emulator::search`] sets a
//! needle and returns [`SearchState`]; [`Emulator::search_step`] moves the
//! selected match and scrolls it into view. Matches cover the scrollback.

use ghostty_vt::fmt::{Formatter, FormatterOptions};
use ghostty_vt::key;
use ghostty_vt::render::{CellIterator, Dirty, RowIterator};
use ghostty_vt::screen::CellWide;
use ghostty_vt::search::{Scroll, Search};
use ghostty_vt::selection::{FormatOptions, Selection};
use ghostty_vt::style::{RgbColor, Underline};
use ghostty_vt::terminal::{Event, Mode, Point, PointCoordinate, PointSpace, ScrollViewport};
use ghostty_vt::{RenderState, Terminal, TerminalOptions};

pub use ghostty_vt::Error as VtError;

pub use crate::color::Rgb;
pub use crate::ghostty_config::CursorShape;

impl From<RgbColor> for Rgb {
    fn from(c: RgbColor) -> Self {
        Self::new(c.r, c.g, c.b)
    }
}

impl From<Rgb> for RgbColor {
    fn from(c: Rgb) -> Self {
        Self {
            r: c.r,
            g: c.g,
            b: c.b,
        }
    }
}

/// Colours the host theme supplies. Programs can still set their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TermTheme {
    pub foreground: Rgb,
    pub background: Rgb,
    pub cursor: Rgb,
    pub selection_bg: Rgb,
    pub match_bg: Rgb,
    pub active_match_bg: Rgb,
    /// ANSI colours 0-15 (programs may still override them with OSC 4).
    pub ansi: [Rgb; 16],
}

impl TermTheme {
    pub const DARK: Self = Self {
        foreground: Rgb::new(0xd8, 0xdb, 0xe2),
        background: Rgb::new(0x16, 0x18, 0x1d),
        cursor: Rgb::new(0xd8, 0xdb, 0xe2),
        selection_bg: Rgb::new(0x34, 0x4a, 0x6e),
        match_bg: Rgb::new(0x5a, 0x4b, 0x1f),
        active_match_bg: Rgb::new(0x9a, 0x6b, 0x10),
        ansi: [
            Rgb::new(0x2a, 0x2e, 0x36),
            Rgb::new(0xf0, 0x6b, 0x6b),
            Rgb::new(0x8f, 0xd1, 0x7f),
            Rgb::new(0xe8, 0xc2, 0x6a),
            Rgb::new(0x6f, 0xa8, 0xf5),
            Rgb::new(0xc6, 0x8c, 0xf0),
            Rgb::new(0x5f, 0xc8, 0xd1),
            Rgb::new(0xc8, 0xcc, 0xd4),
            Rgb::new(0x6b, 0x72, 0x80),
            Rgb::new(0xff, 0x8a, 0x8a),
            Rgb::new(0xa8, 0xe0, 0x98),
            Rgb::new(0xf2, 0xd4, 0x8a),
            Rgb::new(0x93, 0xbf, 0xff),
            Rgb::new(0xd8, 0xa8, 0xff),
            Rgb::new(0x86, 0xdc, 0xe3),
            Rgb::new(0xf3, 0xf4, 0xf6),
        ],
    };
    pub const LIGHT: Self = Self {
        foreground: Rgb::new(0x1f, 0x23, 0x28),
        background: Rgb::new(0xfb, 0xfb, 0xfc),
        cursor: Rgb::new(0x1f, 0x23, 0x28),
        selection_bg: Rgb::new(0xc5, 0xd9, 0xf7),
        match_bg: Rgb::new(0xfb, 0xe6, 0xa2),
        active_match_bg: Rgb::new(0xf5, 0xb9, 0x42),
        ansi: [
            Rgb::new(0x1f, 0x23, 0x28),
            Rgb::new(0xc0, 0x26, 0x2d),
            Rgb::new(0x1a, 0x7f, 0x37),
            Rgb::new(0x9a, 0x67, 0x00),
            Rgb::new(0x0b, 0x5c, 0xd5),
            Rgb::new(0x82, 0x50, 0xdf),
            Rgb::new(0x0f, 0x76, 0x80),
            Rgb::new(0x6e, 0x77, 0x81),
            Rgb::new(0x57, 0x60, 0x6a),
            Rgb::new(0xd1, 0x24, 0x2f),
            Rgb::new(0x2c, 0x97, 0x4b),
            Rgb::new(0xb0, 0x88, 0x00),
            Rgb::new(0x21, 0x8b, 0xff),
            Rgb::new(0xa4, 0x75, 0xf9),
            Rgb::new(0x1b, 0x8f, 0x99),
            Rgb::new(0x8c, 0x95, 0x9f),
        ],
    };
}

/// Emulator settings.
#[derive(Clone, Copy, Debug)]
pub struct EmulatorOptions {
    pub cols: u16,
    pub rows: u16,
    /// Scrollback bound in lines (pruned at page granularity by libghostty).
    pub scrollback_lines: usize,
    /// A memory ceiling for scrollback, in bytes. The line bound is the
    /// intended limit; this only stops a very wide grid from growing without
    /// limit. libghostty applies whichever is reached first, and its own
    /// default (10 MB) would cut a 200-column grid to about 5,500 lines.
    pub scrollback_max_bytes: usize,
    /// Treat a bare LF as CR+LF (ANSI mode 20). On for log streams whose
    /// lines end in `\n` only; off for a PTY, whose line discipline adds CR.
    pub newline_is_crlf: bool,
    pub theme: TermTheme,
}

impl Default for EmulatorOptions {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            scrollback_lines: 10_000,
            scrollback_max_bytes: 256 << 20,
            newline_is_crlf: false,
            theme: TermTheme::DARK,
        }
    }
}

/// One painted cell. `text` is empty for a blank cell.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrameCell {
    pub text: String,
    pub fg: Rgb,
    /// `None` means the frame background.
    pub bg: Option<Rgb>,
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub underline: bool,
    pub strikethrough: bool,
    /// The first cell of a double-width character; the next cell is a spacer.
    pub wide: bool,
    /// The tail of a double-width character: draw nothing.
    pub spacer: bool,
}

/// The viewport as plain data.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub cols: u16,
    pub rows: Vec<Vec<FrameCell>>,
    pub foreground: Rgb,
    pub background: Rgb,
    /// (col, row) in the viewport when the cursor is visible there.
    pub cursor: Option<(u16, u16)>,
    /// The shape the program asked for, or the configured default.
    pub cursor_shape: Option<CursorShape>,
    pub cursor_color: Rgb,
    /// Selected columns per row, inclusive.
    pub selection: Vec<Option<(u16, u16)>>,
    /// Search highlights in viewport coordinates: (row, start_col, end_col, active).
    pub matches: Vec<(u16, u16, u16, bool)>,
    /// The search's state from the same pass as `matches`: what a count
    /// shown beside these highlights should say.
    pub search: SearchState,
    /// Scrollback position: total rows, offset of the viewport, viewport rows.
    pub scroll: (u64, u64, u64),
}

impl Frame {
    /// A row's text with trailing blanks trimmed (spacer cells skipped).
    pub fn row_text(&self, row: usize) -> String {
        let mut s: String = self.rows[row]
            .iter()
            .filter(|c| !c.spacer)
            .map(|c| {
                if c.text.is_empty() {
                    " "
                } else {
                    c.text.as_str()
                }
            })
            .collect();
        s.truncate(s.trim_end().len());
        s
    }
}

/// A key press in host terms. `key` is the host's key name (GPUI names:
/// `a`, `enter`, `up`, `f5`, ...); `text` is what the key would type.
#[derive(Clone, Copy, Debug, Default)]
pub struct KeyInput<'a> {
    pub key: &'a str,
    pub text: Option<&'a str>,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

fn map_key(name: &str) -> key::Key {
    use key::Key as K;
    let named = match name {
        "enter" => Some(K::Enter),
        "tab" => Some(K::Tab),
        "backspace" => Some(K::Backspace),
        "escape" => Some(K::Escape),
        "space" | " " => Some(K::Space),
        "up" => Some(K::ArrowUp),
        "down" => Some(K::ArrowDown),
        "left" => Some(K::ArrowLeft),
        "right" => Some(K::ArrowRight),
        "home" => Some(K::Home),
        "end" => Some(K::End),
        "pageup" => Some(K::PageUp),
        "pagedown" => Some(K::PageDown),
        "delete" => Some(K::Delete),
        "insert" => Some(K::Insert),
        "-" => Some(K::Minus),
        "=" => Some(K::Equal),
        "[" => Some(K::BracketLeft),
        "]" => Some(K::BracketRight),
        "\\" => Some(K::Backslash),
        ";" => Some(K::Semicolon),
        "'" => Some(K::Quote),
        "," => Some(K::Comma),
        "." => Some(K::Period),
        "/" => Some(K::Slash),
        "`" => Some(K::Backquote),
        _ => None,
    };
    if let Some(k) = named {
        return k;
    }
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        let base = match c.to_ascii_lowercase() {
            c @ 'a'..='z' => Some(i32::from(K::A) + (c as i32 - 'a' as i32)),
            c @ '0'..='9' => Some(i32::from(K::Digit0) + (c as i32 - '0' as i32)),
            _ => None,
        };
        if let Some(k) = base.and_then(|v| K::try_from(v).ok()) {
            return k;
        }
    }
    if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<i32>().ok())
        && (1..=12).contains(&n)
        && let Ok(k) = K::try_from(i32::from(K::F1) + n - 1)
    {
        return k;
    }
    K::Unidentified
}

/// The outcome of a search call.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchState {
    pub total: usize,
    /// Index of the selected match.
    pub selected: Option<usize>,
}

/// libghostty-vt terminal + render state + search.
pub struct Emulator {
    term: Terminal,
    render: RenderState,
    rows_it: RowIterator,
    cells_it: CellIterator,
    search: Option<Search>,
    /// Counts every change the search's results depend on: output, a
    /// resize (which reflows), a viewport move, the needle and the
    /// selected match. See [`Self::search_refresh`].
    revision: u64,
    /// The revision the search last ran at, and its state then.
    searched: Option<(u64, SearchState)>,
    search_runs: u64,
    keys: key::Encoder,
    key_event: key::Event,
    theme: TermTheme,
    follow: bool,
    /// The terminal's selection is only the anchor of a drag that has not
    /// moved yet: installed so libghostty keeps it on its line when old
    /// scrollback is pruned, but not drawn and not copied.
    anchor_only: bool,
}

impl std::fmt::Debug for Emulator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Emulator")
            .field("follow", &self.follow)
            .finish_non_exhaustive()
    }
}

impl Emulator {
    pub fn new(opts: EmulatorOptions) -> Result<Self, VtError> {
        let mut term = Terminal::new(TerminalOptions {
            cols: opts.cols.max(1),
            rows: opts.rows.max(1),
            ..TerminalOptions::default()
        })?;
        term.set_scrollback_max_bytes(Some(opts.scrollback_max_bytes))?
            .set_scrollback_max_lines(Some(opts.scrollback_lines))?;
        if opts.newline_is_crlf {
            term.set_mode(Mode::LINEFEED, true)?;
        }
        let mut emu = Self {
            term,
            render: RenderState::new()?,
            rows_it: RowIterator::new()?,
            cells_it: CellIterator::new()?,
            search: None,
            revision: 0,
            searched: None,
            search_runs: 0,
            keys: key::Encoder::new()?,
            key_event: key::Event::new()?,
            theme: opts.theme,
            follow: true,
            anchor_only: false,
        };
        emu.set_theme(opts.theme)?;
        Ok(emu)
    }

    /// Process output bytes. Returns bytes the terminal wants written back
    /// to the PTY (query responses); a read-only stream discards them.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        if !bytes.is_empty() {
            self.revision += 1;
        }
        self.term.vt_write(bytes);
        let mut reply = Vec::new();
        for ev in self.term.events() {
            if let Event::PtyWrite(b) = ev {
                reply.extend_from_slice(&b);
            }
        }
        if self.follow {
            self.term.scroll_viewport(ScrollViewport::Bottom);
        }
        reply
    }

    pub fn cols(&self) -> u16 {
        self.term.cols().unwrap_or(1)
    }

    pub fn rows(&self) -> u16 {
        self.term.rows().unwrap_or(1)
    }

    /// Resize the grid. libghostty reflows soft-wrapped lines.
    pub fn resize(&mut self, cols: u16, rows: u16, cell_w_px: u32, cell_h_px: u32) {
        let (cols, rows) = (cols.max(1), rows.max(1));
        if cols == self.cols() && rows == self.rows() {
            return;
        }
        self.revision += 1;
        let _ = self.term.resize(cols, rows, cell_w_px, cell_h_px);
        if self.follow {
            self.term.scroll_viewport(ScrollViewport::Bottom);
        }
    }

    pub fn set_theme(&mut self, theme: TermTheme) -> Result<(), VtError> {
        self.theme = theme;
        self.term
            .set_default_fg_color(Some(theme.foreground.into()))?
            .set_default_bg_color(Some(theme.background.into()))?
            .set_default_cursor_color(Some(theme.cursor.into()))?;
        let mut palette = self.term.default_color_palette()?;
        for (slot, c) in palette.0.iter_mut().zip(theme.ansi) {
            *slot = c.into();
        }
        self.term.set_default_color_palette(Some(palette))?;
        Ok(())
    }

    /// Set palette entries beyond the theme's sixteen ANSI colours (from the
    /// user's terminal config). Programs can still override them.
    pub fn set_palette_entries(&mut self, entries: &[(u8, Rgb)]) -> Result<(), VtError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut palette = self.term.default_color_palette()?;
        for (index, color) in entries {
            palette.0[usize::from(*index)] = (*color).into();
        }
        self.term.set_default_color_palette(Some(palette))?;
        Ok(())
    }

    /// The cursor shape used until a program asks for another.
    pub fn set_default_cursor(&mut self, shape: Option<CursorShape>) -> Result<(), VtError> {
        use ghostty_vt::terminal::CursorStyle;
        let style = shape.map(|s| match s {
            CursorShape::Block => CursorStyle::Block,
            CursorShape::Bar => CursorStyle::Bar,
            CursorShape::Underline => CursorStyle::Underline,
            CursorShape::BlockHollow => CursorStyle::BlockHollow,
        });
        self.term.set_default_cursor_style(style)?;
        Ok(())
    }

    /// Follow on: every feed scrolls to the newest line. Follow off: the
    /// viewport stays where the user left it while output arrives.
    pub fn set_follow(&mut self, follow: bool) {
        self.follow = follow;
        if follow {
            self.revision += 1;
            self.term.scroll_viewport(ScrollViewport::Bottom);
        }
    }

    pub fn follow(&self) -> bool {
        self.follow
    }

    /// Scroll by rows (negative is up). Scrolling up turns follow off;
    /// reaching the bottom turns it back on.
    pub fn scroll(&mut self, delta: isize) {
        if delta != 0 {
            self.revision += 1;
        }
        self.term.scroll_viewport(ScrollViewport::Delta(delta));
        self.follow = self.at_bottom();
    }

    pub fn at_bottom(&self) -> bool {
        self.term
            .scrollbar()
            .map(|s| s.offset + s.len >= s.total)
            .unwrap_or(true)
    }

    /// Rows held in scrollback (above the active area).
    pub fn scrollback_rows(&self) -> usize {
        self.term.scrollback_rows().unwrap_or(0)
    }

    /// Whether the running program asked for the alternate screen or mouse
    /// reporting, so wheel events should go to it rather than scrollback.
    pub fn wants_mouse(&self) -> bool {
        self.term.is_mouse_tracking().unwrap_or(false)
    }

    pub fn bracketed_paste(&self) -> bool {
        self.term.mode(Mode::BRACKETED_PASTE).unwrap_or(false)
    }

    pub fn title(&self) -> Option<String> {
        self.term
            .title()
            .ok()
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    }

    /// Encode a key press for the running program, honouring the modes it
    /// set (cursor-key application mode, kitty keyboard flags, ...).
    pub fn encode_key(&mut self, input: KeyInput<'_>) -> Vec<u8> {
        let mut mods = key::Mods::empty();
        mods.set(key::Mods::SHIFT, input.shift);
        mods.set(key::Mods::CTRL, input.ctrl);
        mods.set(key::Mods::ALT, input.alt);
        mods.set(key::Mods::SUPER, input.meta);
        let k = map_key(input.key);
        let unshifted = {
            let mut c = input.key.chars();
            match (c.next(), c.next()) {
                (Some(ch), None) => ch.to_ascii_lowercase(),
                _ => '\0',
            }
        };
        // Control and Alt combinations are encoded from the key, not the text.
        let text = input
            .text
            .filter(|t| !t.is_empty() && !input.ctrl && !input.alt);
        self.key_event
            .set_action(key::Action::Press)
            .set_key(k)
            .set_mods(mods)
            .set_consumed_mods(if text.is_some() && input.shift {
                key::Mods::SHIFT
            } else {
                key::Mods::empty()
            })
            .set_utf8(text.map(str::to_owned))
            .set_unshifted_codepoint(unshifted);
        self.keys.set_options_from_terminal(&self.term);
        let mut out = Vec::new();
        let _ = self.keys.encode_to_vec(&self.key_event, &mut out);
        if out.is_empty()
            && let Some(t) = text
        {
            out.extend_from_slice(t.as_bytes());
        }
        out
    }

    /// Wrap pasted text for the program (bracketed paste when it asked).
    pub fn encode_paste(&self, text: &str) -> Vec<u8> {
        // Strip control characters a paste could use to escape the bracket.
        let clean: String = text
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t' | '\r'))
            .collect();
        if self.bracketed_paste() {
            let mut v = b"\x1b[200~".to_vec();
            v.extend_from_slice(clean.as_bytes());
            v.extend_from_slice(b"\x1b[201~");
            v
        } else {
            clean.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
        }
    }

    // --- selection -------------------------------------------------------

    fn screen_point(&self, col: u16, row: u16) -> Option<PointCoordinate> {
        let gr = self
            .term
            .grid_ref(Point::Viewport(PointCoordinate {
                x: col,
                y: u32::from(row),
            }))
            .ok()?;
        self.term
            .point_from_grid_ref(&gr, PointSpace::Screen)
            .ok()
            .flatten()
    }

    /// Start a selection at a viewport cell. The anchor is installed as the
    /// terminal's own one-cell selection, which libghostty tracks: when new
    /// output prunes old scrollback during the drag, the anchor stays on the
    /// text that was clicked instead of shifting with a stored row number.
    /// Until the drag moves it is neither drawn nor copied.
    pub fn select_start(&mut self, col: u16, row: u16) {
        let _ = self.term.set_selection(None);
        self.anchor_only = false;
        let Some(point) = self.screen_point(col, row) else {
            return;
        };
        let (Ok(start), Ok(end)) = (
            self.term.grid_ref(Point::Screen(point)),
            self.term.grid_ref(Point::Screen(point)),
        ) else {
            return;
        };
        let sel = Selection::new(start, end, false);
        if self.term.set_selection(Some(&sel)).is_ok() {
            self.anchor_only = true;
        }
    }

    /// Extend the selection from the anchor to a viewport cell. Nothing
    /// happens when there is no anchor, or when pruning removed its line.
    pub fn select_to(&mut self, col: u16, row: u16) {
        let Some(b) = self.screen_point(col, row) else {
            return;
        };
        // A fresh snapshot of the terminal-owned (tracked) selection: valid
        // now, with its start where the clicked text is now.
        let Ok(Some(current)) = self.term.selection() else {
            self.anchor_only = false;
            return;
        };
        let start = current.start();
        let Ok(end) = self.term.grid_ref(Point::Screen(b)) else {
            return;
        };
        let sel = Selection::new(start, end, false);
        if self.term.set_selection(Some(&sel)).is_ok() {
            self.anchor_only = false;
        }
    }

    pub fn clear_selection(&mut self) {
        self.anchor_only = false;
        let _ = self.term.set_selection(None);
    }

    /// The selected text as plain UTF-8, soft wraps joined, trailing blanks trimmed.
    pub fn selection_text(&self) -> Option<String> {
        if self.anchor_only {
            return None;
        }
        let bytes = self
            .term
            .format_selection_alloc(FormatOptions::new().with_unwrap(true).with_trim(true))
            .ok()
            .flatten()?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        (!text.is_empty()).then_some(text)
    }

    /// Copy the screen and its retained scrollback without changing selection.
    pub fn output_text(&self) -> Option<String> {
        let selection = self.term.select_all().ok().flatten()?;
        let options = FormatterOptions::new()
            .with_selection(&selection)
            .with_unwrap(true)
            .with_trim(true);
        let bytes = Formatter::new(&self.term, options)
            .ok()?
            .format_alloc()
            .ok()?;
        let text = String::from_utf8_lossy(&bytes).trim_end().to_owned();
        (!text.is_empty()).then_some(text)
    }

    /// Select everything (screen and scrollback).
    pub fn select_all(&mut self) {
        self.anchor_only = false;
        if let Ok(Some(sel)) = self.term.select_all() {
            let _ = self.term.set_selection(Some(&sel));
        }
    }

    /// OSC 8 hyperlink URI under a viewport cell.
    pub fn link_at(&self, col: u16, row: u16) -> Option<String> {
        let gr = self
            .term
            .grid_ref(Point::Viewport(PointCoordinate {
                x: col,
                y: u32::from(row),
            }))
            .ok()?;
        let mut buf = vec![0u8; 2048];
        let n = gr.hyperlink_uri(&mut buf).ok()?;
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n]).into_owned())
    }

    // --- search ----------------------------------------------------------

    /// Set (or clear with `None`/empty) the search needle and run the search
    /// to completion over screen and scrollback. ASCII letters match
    /// case-insensitively. Selects the newest match and scrolls to it.
    pub fn search(&mut self, needle: Option<&str>) -> SearchState {
        let needle = needle.filter(|n| !n.is_empty());
        self.revision += 1;
        let Some(needle) = needle else {
            self.search = None;
            self.searched = None;
            return SearchState::default();
        };
        if self.search.is_none() {
            self.search = Search::new(&self.term).ok();
        }
        let Some(search) = self.search.as_mut() else {
            return SearchState::default();
        };
        let _ = search.set_select_scroll(Some(Scroll::IfNeeded));
        let _ = search.set_needle(&self.term, Some(needle));
        // From no selection, "next" selects index 0: the newest match,
        // nearest the live end of the output.
        self.search_step(true)
    }

    /// Select the next match toward older output (`older`) or newer output,
    /// and scroll it into view. Matches are indexed newest first.
    pub fn search_step(&mut self, older: bool) -> SearchState {
        // Step among the matches as they are now.
        self.search_refresh();
        let Some(search) = self.search.as_mut() else {
            return SearchState::default();
        };
        // libghostty indexes matches newest first; "next" moves to older
        // output. Both directions wrap.
        let moved = if older {
            search.select_next(&self.term)
        } else {
            search.select_prev(&self.term)
        };
        // The selection changed and the viewport may have moved to show
        // it: the next pass has to run.
        self.revision += 1;
        if moved.unwrap_or(false) {
            self.follow = self.at_bottom();
        }
        self.search_state()
    }

    /// Bring the search up to date with the terminal and return its state.
    ///
    /// The search learns about new output and viewport moves only when it
    /// is run; feeding the terminal does not run it. A run is not free:
    /// libghostty checks every match it holds, so with many matches in
    /// scrollback it costs milliseconds. So the search runs at most once
    /// per change: output, a resize, a viewport move, a new needle or a
    /// new selected match. Until the next change this returns the state
    /// from that one pass, and [`Self::frame`] takes its highlights from
    /// the same pass. Redrawing an unchanged terminal runs nothing.
    ///
    /// Call this, not [`Self::search_state`], before showing a count next
    /// to a frame's highlights.
    pub fn search_refresh(&mut self) -> SearchState {
        let Some(search) = self.search.as_mut() else {
            return SearchState::default();
        };
        if let Some((at, state)) = self.searched
            && at == self.revision
        {
            return state;
        }
        let _ = search.run(&self.term);
        self.search_runs += 1;
        let state = self.search_state();
        self.searched = Some((self.revision, state));
        state
    }

    /// How many times the search has run over the terminal: once per
    /// change while a search is set, however often frames are drawn.
    pub fn search_runs(&self) -> u64 {
        self.search_runs
    }

    /// The search's state as of the last time it ran. See
    /// [`Self::search_refresh`].
    pub fn search_state(&self) -> SearchState {
        let Some(search) = self.search.as_ref() else {
            return SearchState::default();
        };
        SearchState {
            total: search.total_matches().unwrap_or(0),
            selected: search.selected_index().ok().flatten(),
        }
    }

    // --- frame -----------------------------------------------------------

    /// The viewport as a [`Frame`].
    pub fn frame(&mut self) -> Result<Frame, VtError> {
        // One search pass serves this frame's highlights and the count a
        // caller shows beside them; it runs only if something changed.
        let search = self.search_refresh();
        let matches = self.viewport_matches();
        let scroll = self
            .term
            .scrollbar()
            .map(|s| (s.total, s.offset, s.len))
            .unwrap_or_default();
        let snapshot = self.render.update(&self.term)?;
        let colors = snapshot.colors()?;
        let cursor = snapshot.cursor()?;
        let mut frame = Frame {
            cols: snapshot.cols()?,
            foreground: colors.foreground.into(),
            background: colors.background.into(),
            cursor: cursor
                .viewport
                .filter(|_| cursor.visible)
                .map(|v| (v.x, v.y)),
            cursor_color: colors.cursor.map_or(self.theme.cursor, Into::into),
            cursor_shape: Some(match cursor.visual_style {
                ghostty_vt::render::CursorVisualStyle::Bar => CursorShape::Bar,
                ghostty_vt::render::CursorVisualStyle::Underline => CursorShape::Underline,
                ghostty_vt::render::CursorVisualStyle::BlockHollow => CursorShape::BlockHollow,
                _ => CursorShape::Block,
            }),
            matches,
            search,
            scroll,
            ..Frame::default()
        };
        let mut rows = self.rows_it.update(&snapshot)?;
        while let Some(row) = rows.next() {
            let selected = if self.anchor_only {
                None
            } else {
                row.selection()?.map(|s| (s.start_x, s.end_x))
            };
            frame.selection.push(selected);
            let mut cells = self.cells_it.update(row)?;
            let mut out = Vec::with_capacity(usize::from(frame.cols));
            while let Some(cell) = cells.next() {
                let raw = cell.raw_cell()?;
                let wide = raw.wide()?;
                let style = cell.style()?;
                let mut fg: Rgb = cell.fg_color()?.map_or(frame.foreground, Into::into);
                let mut bg: Option<Rgb> = cell.bg_color()?.map(Into::into);
                if style.inverse {
                    let old_fg = fg;
                    fg = bg.unwrap_or(frame.background);
                    bg = Some(old_fg);
                }
                let mut text = String::new();
                if !style.invisible {
                    cell.graphemes_utf8(&mut text)?;
                }
                out.push(FrameCell {
                    text,
                    fg,
                    bg,
                    bold: style.bold,
                    italic: style.italic,
                    faint: style.faint,
                    underline: style.underline != Underline::None,
                    strikethrough: style.strikethrough,
                    wide: wide == CellWide::Wide,
                    spacer: matches!(wide, CellWide::SpacerTail | CellWide::SpacerHead),
                });
            }
            frame.rows.push(out);
        }
        if snapshot.dirty()? != Dirty::Clean {
            snapshot.clean()?;
        }
        Ok(frame)
    }

    fn viewport_matches(&self) -> Vec<(u16, u16, u16, bool)> {
        let Some(search) = self.search.as_ref() else {
            return Vec::new();
        };
        let active = search.selected_match(&self.term).ok().flatten();
        let Ok(matches) = search.viewport_matches(&self.term) else {
            return Vec::new();
        };
        let (cols, rows) = (self.cols(), u32::from(self.rows()));
        let mut out = Vec::new();
        for m in &matches {
            let is_active = active
                .as_ref()
                .is_some_and(|a| a.equals(&self.term, m).unwrap_or(false));
            let (Ok(Some(s)), Ok(Some(e))) = (
                self.term
                    .point_from_grid_ref(&m.start(), PointSpace::Viewport),
                self.term
                    .point_from_grid_ref(&m.end(), PointSpace::Viewport),
            ) else {
                continue;
            };
            // A match can wrap across rows; split it per row. libghostty
            // also lists matches that share a page with the viewport but
            // lie below it: those rows are not on screen.
            for y in s.y..=e.y.min(rows.saturating_sub(1)) {
                let x0 = if y == s.y { s.x } else { 0 };
                let x1 = if y == e.y {
                    e.x
                } else {
                    cols.saturating_sub(1)
                };
                if let Ok(row) = u16::try_from(y) {
                    out.push((row, x0, x1, is_active));
                }
            }
        }
        out
    }
}
