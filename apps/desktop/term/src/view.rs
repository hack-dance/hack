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
//! Keys: the view forwards keys to the program on the PTY, encoded by
//! libghostty for the program's modes, and takes typed text for its find
//! field while that is open. It binds no shortcuts. Copy, paste, find,
//! find navigation and scrolling are actions ([`crate::actions`]) that the
//! app binds to keys; each is also a public method here.

use std::collections::HashSet;
use std::time::Duration;

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::{
    App, Bounds, ClipboardItem, ContentMask, Context, FocusHandle, Focusable, Font, FontStyle,
    FontWeight, Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Render,
    ScrollDelta, ScrollEvent, SharedString, StrikethroughStyle, Styled as _, TextAlign, TextRun,
    UnderlineStyle, Window, canvas, div, fill, point, px, size,
};

use crate::actions;
use crate::emulator::{CursorShape, Emulator, Frame, KeyInput, Rgb, SearchState, TermTheme};
use crate::ghostty_config::GhosttyLook;
use crate::glyphs::{self, BundledSymbols, SymbolFallback};
use crate::launch::{SessionKind, SessionPlan};
use crate::pty::{PtyOptions, QUIT_GRACE};
use crate::sprite::{self, Seg, Shape};
use crate::stream::StreamSource;
pub use crate::terminal::Status;
use crate::terminal::TerminalCore;

/// Terminal families tried last, after the theme's monospace family.
#[cfg(target_os = "macos")]
const PLATFORM_MONO_FAMILIES: &[&str] = &["SF Mono", "Menlo", "Monaco", "Courier New"];
#[cfg(not(target_os = "macos"))]
const PLATFORM_MONO_FAMILIES: &[&str] = &[
    "DejaVu Sans Mono",
    "Liberation Mono",
    "Noto Sans Mono",
    "Ubuntu Mono",
];

/// The outcome of [`pick_family`].
#[derive(Debug, PartialEq, Eq)]
struct Picked {
    /// The family to draw with; `None` when no installed family qualifies.
    family: Option<String>,
    /// The first candidate skipped, by index, and why.
    first_skipped: Option<(usize, &'static str)>,
}

/// The first candidate that is installed (names compared without case) and
/// monospaced. When every candidate fails, the first monospaced installed
/// family, trying names that contain "mono" first: a grid is never drawn
/// in a proportional font while a monospaced one exists.
fn pick_family(
    candidates: &[SharedString],
    installed: &[String],
    monospaced: impl Fn(&str) -> bool,
) -> Picked {
    let lower: std::collections::HashSet<String> =
        installed.iter().map(|n| n.to_lowercase()).collect();
    let mut first_skipped = None;
    for (index, family) in candidates.iter().enumerate() {
        let why = if !lower.contains(&family.to_lowercase()) {
            "is not installed"
        } else if !monospaced(family) {
            "is not monospaced"
        } else {
            return Picked {
                family: Some(family.to_string()),
                first_skipped,
            };
        };
        first_skipped.get_or_insert((index, why));
    }
    let (named_mono, others): (Vec<&String>, Vec<&String>) = installed
        .iter()
        .partition(|n| n.to_lowercase().contains("mono"));
    let family = named_mono
        .into_iter()
        .chain(others)
        .find(|n| monospaced(n))
        .cloned();
    Picked {
        family,
        first_skipped,
    }
}

#[cfg(test)]
mod pick_tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn exhausted_candidates_fall_back_to_an_installed_monospaced_family() {
        // The configured family is missing and the theme's is proportional:
        // a monospaced family that is installed but not listed is used.
        let candidates = [SharedString::from("Missing"), SharedString::from("UI Sans")];
        let installed = names(&["UI Sans", "Serif Text", "Code Mono"]);
        let picked = pick_family(&candidates, &installed, |f| f == "Code Mono");
        assert_eq!(picked.family.as_deref(), Some("Code Mono"));
        assert_eq!(picked.first_skipped, Some((0, "is not installed")));
    }

    #[test]
    fn a_monospaced_family_without_mono_in_its_name_is_found_too() {
        let candidates = [SharedString::from("Missing")];
        let installed = names(&["Sans", "Fixed Grid"]);
        let picked = pick_family(&candidates, &installed, |f| f == "Fixed Grid");
        assert_eq!(picked.family.as_deref(), Some("Fixed Grid"));
    }

    #[test]
    fn candidates_win_in_order_and_names_ignore_case() {
        let candidates = [
            SharedString::from("ui sans"),
            SharedString::from("code mono"),
        ];
        let installed = names(&["UI Sans", "Code Mono", "Other Mono"]);
        let picked = pick_family(&candidates, &installed, |f| {
            f.contains("Mono") || f.contains("mono")
        });
        assert_eq!(picked.family.as_deref(), Some("code mono"));
        assert_eq!(picked.first_skipped, Some((0, "is not monospaced")));
    }

    #[test]
    fn no_monospaced_family_at_all_picks_none() {
        let picked = pick_family(
            &[SharedString::from("UI Sans")],
            &names(&["UI Sans"]),
            |_| false,
        );
        assert_eq!(picked.family, None);
    }
}

/// Padding around the grid when the user's config sets none.
const DEFAULT_PAD: f32 = 8.0;
/// GPUI gives quit handlers 200 ms in total.
pub(crate) const QUIT_DEADLINE: Duration = Duration::from_millis(180);

/// Ghostty counts font size and padding in points. On macOS a point is a
/// logical pixel; elsewhere Ghostty assumes 96 DPI, so 72 points are 96 px.
fn points(pt: f32) -> f32 {
    if cfg!(target_os = "macos") {
        pt
    } else {
        pt * 96.0 / 72.0
    }
}

/// Padding in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Pad {
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
}

/// What the last `render` drew, for hosts and tests that need to know a
/// state change reached the screen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rendered {
    /// How many times the view has rendered.
    pub count: u64,
    /// The notice shown in that render, if any.
    pub notice: Option<String>,
    /// The match count and selection the find overlay showed in that
    /// render; `None` when find was closed.
    pub find: Option<SearchState>,
    /// How many match highlights that frame drew: the matches on screen.
    pub highlights: usize,
    /// The font family the grid was drawn with.
    pub font_family: String,
    /// Shown when a configured font family was skipped: not installed, or
    /// not monospaced.
    pub font_note: Option<String>,
}

/// Where the grid was laid out last, in logical pixels: for tests that
/// look at rendered cells.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridMetrics {
    /// The top-left corner of the first cell.
    pub origin: (f32, f32),
    /// One cell's width and height.
    pub cell: (f32, f32),
}

/// Font settings. Defaults to the theme's monospace family.
#[derive(Clone, Debug)]
pub struct TermFont {
    pub family: Option<SharedString>,
    pub size: Pixels,
    pub line_height: f32,
    /// When symbols come from the bundled symbols font.
    pub symbols: BundledSymbols,
}

impl Default for TermFont {
    fn default() -> Self {
        Self {
            family: None,
            size: px(13.),
            line_height: 1.3,
            symbols: BundledSymbols::default(),
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
    waiting_for_password: bool,
    query: String,
    search: SearchState,
    applied_theme: Option<TermTheme>,
    /// The user's terminal look, and whether it still has to be applied.
    look: GhosttyLook,
    look_pending: bool,
    /// Installed family names, read once per view.
    installed_fonts: Option<std::sync::Arc<Vec<String>>>,
    /// The family chosen for a list of candidates, and the note to show.
    chosen_font: Option<(Vec<SharedString>, SharedString, Option<String>)>,
    rendered: Rendered,
    /// Which symbols the terminal's font lacks, remembered across frames.
    symbols: SymbolFallback,
    /// The symbols the last frame took from the symbols font.
    fallback_symbols: Vec<char>,
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
        Ok(Self::with_core(TerminalCore::pty(opts)?, cx))
    }

    /// An interactive view for a session plan: a container shell, a host
    /// shell, or a host shell with env. See [`crate::launch`].
    pub fn new_session(plan: SessionPlan, cx: &mut Context<Self>) -> std::io::Result<Self> {
        Ok(Self::with_core(TerminalCore::session(plan)?, cx))
    }

    /// A view over a core built beforehand. Starting a session can fail, and
    /// GPUI builds entities infallibly, so build the core first:
    /// `let core = TerminalCore::session(plan)?;` then
    /// `cx.new(|cx| TerminalView::from_core(core, cx))`.
    pub fn from_core(core: TerminalCore, cx: &mut Context<Self>) -> Self {
        Self::with_core(core, cx)
    }

    fn with_core(core: TerminalCore, cx: &mut Context<Self>) -> Self {
        // End the session before the process exits; Drop alone may not run
        // when the app quits. This covers both kinds of backend: a PTY and
        // a process-backed stream. The signalling and the wait run on the
        // background executor, never on the UI thread, and GPUI awaits the
        // returned task inside its shutdown window.
        //
        // Backends the core ended by itself (end of output, the session
        // ended, a failed attempt) may still be on a reaper thread waiting
        // out the close grace: cut that short and await them too.
        cx.on_app_quit(|this, cx| {
            let shutdown = this.core.take_shutdown();
            let retired = this.core.take_retired().pending;
            for pending in &retired {
                pending.hurry();
            }
            cx.background_executor().spawn(async move {
                let deadline = std::time::Instant::now() + QUIT_DEADLINE;
                if let Some(shutdown) = shutdown {
                    shutdown.terminate_blocking_with(QUIT_GRACE, QUIT_DEADLINE);
                }
                for pending in &retired {
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    if pending.wait(left).is_none() && left.is_zero() {
                        break;
                    }
                }
            })
        })
        .detach();
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
            waiting_for_password: false,
            query: String::new(),
            search: SearchState::default(),
            applied_theme: None,
            look: GhosttyLook::default(),
            look_pending: false,
            installed_fonts: None,
            chosen_font: None,
            rendered: Rendered::default(),
            symbols: SymbolFallback::default(),
            fallback_symbols: Vec::new(),
        }
    }

    /// What this tab is; its label and badge come from the kind.
    pub fn kind(&self) -> &SessionKind {
        self.core.kind()
    }

    /// Apply the user's terminal look (font, colours, cursor, padding).
    /// Anything it leaves unset keeps following the app's theme.
    pub fn set_look(&mut self, look: GhosttyLook, cx: &mut Context<Self>) {
        self.look = look;
        self.look_pending = true;
        cx.notify();
    }

    /// The notice currently set, whether or not it has been drawn yet.
    pub fn notice(&self) -> Option<&str> {
        self.core.notice()
    }

    /// Give up the session's process side so the caller can end it and
    /// get the result (closing a tab). The view stays, showing what it has.
    pub fn take_shutdown(&mut self) -> Option<crate::terminal::Shutdown> {
        self.core.take_shutdown()
    }

    /// Give up the teardowns of backends the session ended by itself that
    /// are still running (see [`TerminalCore::take_retired`]).
    pub fn take_retired(&mut self) -> crate::terminal::Retired {
        self.core.take_retired()
    }

    /// The grid's font family: the first candidate that is installed and
    /// monospaced. Candidates, in order: the user's terminal config
    /// families, an explicit [`TermFont::family`], the theme's monospace
    /// family (already resolved to an installed one), then common terminal
    /// families. A proportional font is never used for the grid, so a
    /// missing configured family cannot misalign the cells. When the first
    /// configured family is skipped, the note says so.
    fn choose_family(
        &mut self,
        size: Pixels,
        window: &mut Window,
        cx: &App,
    ) -> (SharedString, Option<String>) {
        let mut candidates: Vec<SharedString> = self
            .look
            .font_families
            .iter()
            .cloned()
            .map(SharedString::from)
            .collect();
        candidates.extend(self.font.family.clone());
        candidates.push(cx.theme().mono_font_family.clone());
        candidates.extend(
            PLATFORM_MONO_FAMILIES
                .iter()
                .map(|f| SharedString::from(*f)),
        );
        if let Some((key, family, note)) = &self.chosen_font
            && *key == candidates
        {
            return (family.clone(), note.clone());
        }
        let installed = self
            .installed_fonts
            .get_or_insert_with(|| std::sync::Arc::new(window.text_system().all_font_names()))
            .clone();
        let ts = window.text_system();
        let monospaced = |family: &str| {
            let id = ts.resolve_font(&gpui_kit::font(family.to_owned()));
            let width = |c| ts.advance(id, size, c).map(|s| s.width).ok();
            let m = width('m');
            m.is_some_and(|m| m > px(0.)) && ['i', 'W', '.', '@'].iter().all(|c| width(*c) == m)
        };
        let picked = pick_family(&candidates, &installed, monospaced);
        let family = picked
            .family
            .map(SharedString::from)
            // No monospaced font is installed at all: the theme's family is
            // the best that can be done.
            .unwrap_or_else(|| cx.theme().mono_font_family.clone());
        let note = picked
            .first_skipped
            .filter(|(index, _)| *index == 0 && !self.look.font_families.is_empty())
            .map(|(_, why)| {
                format!(
                    "font \"{}\" {why}; using {family}",
                    self.look.font_families[0]
                )
            });
        self.chosen_font = Some((candidates, family.clone(), note.clone()));
        (family, note)
    }

    /// What the last render drew.
    pub fn rendered(&self) -> &Rendered {
        &self.rendered
    }

    /// Where the grid was laid out last.
    pub fn grid_metrics(&self) -> GridMetrics {
        GridMetrics {
            origin: (f32::from(self.origin.x), f32::from(self.origin.y)),
            cell: (f32::from(self.cell.0), f32::from(self.cell.1)),
        }
    }

    /// The symbols the last frame drew from the bundled symbols font,
    /// because the terminal's own font has no glyph for them. Sorted.
    pub fn fallback_symbols(&self) -> &[char] {
        &self.fallback_symbols
    }

    /// Open the find field.
    pub fn open_find(&mut self, cx: &mut Context<Self>) {
        self.search_open = true;
        cx.notify();
    }

    /// Close the find field and clear its highlights.
    pub fn close_find(&mut self, cx: &mut Context<Self>) {
        self.search_open = false;
        self.query.clear();
        self.search = self.core.emulator().search(None);
        cx.notify();
    }

    /// Whether the find field is open.
    pub fn find_open(&self) -> bool {
        self.search_open
    }

    /// Copy the selection to the clipboard, if there is one.
    pub fn copy_selection(&self, cx: &mut App) {
        if let Some(text) = self.core.emu().selection_text() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    /// Paste the clipboard's text: into the find field while it is open,
    /// otherwise into the PTY.
    pub fn paste_clipboard(&mut self, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) else {
            return;
        };
        self.paste(&text, cx);
    }

    /// Paste `text` as the Paste action does with the clipboard's text:
    /// into the find field while it is open, otherwise into the PTY.
    pub fn paste(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.search_open {
            self.paste_into_find(text, cx);
        } else {
            self.paste_text(text, cx);
        }
    }

    /// Add pasted text to the find query. The field is one line: line
    /// breaks and other control characters become spaces. Nothing reaches
    /// the program.
    fn paste_into_find(&mut self, text: &str, cx: &mut Context<Self>) {
        let line: String = text
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        self.query.push_str(&line);
        self.search = self.core.emulator().search(Some(&self.query));
        cx.notify();
    }

    /// The text in the find field.
    pub fn find_query(&self) -> &str {
        &self.query
    }

    /// Scroll one screen toward older (`up`) or newer output.
    pub fn scroll_page(&mut self, up: bool, cx: &mut Context<Self>) {
        let rows = self.core.emu().rows() as isize;
        self.core.emulator().scroll(if up { -rows } else { rows });
        cx.notify();
    }

    /// Scroll to the oldest output kept. Following stops.
    pub fn scroll_to_top(&mut self, cx: &mut Context<Self>) {
        self.core.emulator().scroll(isize::MIN / 2);
        cx.notify();
    }

    /// Paste text into the PTY as the user would (bracketed when the
    /// program asked for it). No-op for a stream view.
    pub fn paste_text(&mut self, text: &str, cx: &mut Context<Self>) {
        // A read-only tab (logs) takes no input, pasted or typed.
        if self.core.read_only() {
            return;
        }
        let bytes = self.core.emu().encode_paste(text);
        self.send(&bytes, cx);
    }

    pub fn set_font(&mut self, font: TermFont) {
        self.font = font;
    }

    /// The running session's leader pid; see [`TerminalCore::leader`].
    pub fn leader(&self) -> Option<u32> {
        self.core.leader()
    }

    /// Every session leader this tab has started; see
    /// [`TerminalCore::leaders`].
    pub fn leaders(&self) -> &[u32] {
        self.core.leaders()
    }

    pub fn status(&self) -> &Status {
        self.core.status()
    }

    pub fn exit_status(&self) -> Option<crate::session::ExitInfo> {
        self.core.exit_status()
    }

    pub fn waiting_for_password(&self) -> bool {
        self.waiting_for_password
    }

    pub fn output_text(&self) -> Option<String> {
        self.core.emu().output_text()
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
        self.waiting_for_password = self.core.waiting_for_password();
        cx.notify();
    }

    /// Queue input for the PTY as if typed (no-op for a stream view).
    pub fn type_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.send(text.as_bytes(), cx);
    }

    /// The emulator, for hosts that need more than the hooks above.
    pub fn emulator(&mut self) -> &mut Emulator {
        self.core.emulator()
    }

    /// Process pending output. Returns whether anything arrived.
    fn pump(&mut self, cx: &mut Context<Self>) -> bool {
        let busy = self.core.pump();
        let waiting = self.core.waiting_for_password();
        if busy || waiting != self.waiting_for_password {
            self.waiting_for_password = waiting;
            // The find count is brought up to date in `render`, in the
            // same pass as the frame's highlights.
            cx.notify();
        }
        busy
    }

    /// Queue input. Always notifies: sending can set or clear the notice
    /// about undelivered input, and that has to reach the next frame even
    /// when the child prints nothing in response.
    fn send(&mut self, bytes: &[u8], cx: &mut Context<Self>) {
        self.core.send(bytes);
        cx.notify();
    }

    fn cell_at(&self, pos: gpui_kit::Point<Pixels>) -> (u16, u16) {
        let x = ((pos.x - self.origin.x) / self.cell.0).max(0.) as u16;
        let y = ((pos.y - self.origin.y) / self.cell.1).max(0.) as u16;
        (
            x.min(self.core.emu().cols().saturating_sub(1)),
            y.min(self.core.emu().rows().saturating_sub(1)),
        )
    }

    /// Keys go to the find field while it is open, and otherwise to the
    /// program on the PTY. Nothing here is a shortcut: a key the app has
    /// bound to an action never reaches this handler.
    fn on_key(&mut self, ev: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let m = k.modifiers;
        if self.search_open {
            // Text entry for the find field.
            let typed = k
                .key_char
                .as_deref()
                .filter(|t| !m.control && !m.platform && !t.chars().any(char::is_control));
            match (k.key.as_str(), typed) {
                ("backspace", _) => {
                    self.query.pop();
                }
                (_, Some(text)) => self.query.push_str(text),
                _ => return,
            }
            self.search = self.core.emulator().search(Some(&self.query));
            cx.notify();
            return;
        }
        if self.core.read_only() {
            return;
        }
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
        self.send(&bytes, cx);
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

    /// Colours: the user's terminal config where it sets them, the app's
    /// theme for the rest.
    fn sync_theme(&mut self, cx: &App) {
        let t = cx.theme();
        let fallback = if t.is_dark() {
            TermTheme::DARK
        } else {
            TermTheme {
                foreground: rgb_of(t.foreground),
                background: rgb_of(t.background),
                cursor: rgb_of(t.foreground),
                selection_bg: rgb_of(t.selection),
                ..TermTheme::LIGHT
            }
        };
        let theme = apply_ghostty_colors(fallback, &self.look);
        if self.applied_theme != Some(theme) || self.look_pending {
            let extra: Vec<(u8, Rgb)> = self
                .look
                .palette
                .range(16..)
                .map(|(i, c)| (*i, *c))
                .collect();
            let emu = self.core.emulator();
            let _ = emu.set_theme(theme);
            let _ = emu.set_palette_entries(&extra);
            let _ = emu.set_default_cursor(self.look.cursor_style);
            self.applied_theme = Some(theme);
            self.look_pending = false;
        }
    }

    fn pad(&self) -> Pad {
        let (left, right) = self
            .look
            .padding_x
            .map_or((DEFAULT_PAD, DEFAULT_PAD), |(l, r)| (points(l), points(r)));
        let (top, bottom) = self
            .look
            .padding_y
            .map_or((DEFAULT_PAD, DEFAULT_PAD), |(t, b)| (points(t), points(b)));
        Pad {
            left,
            right,
            top,
            bottom,
        }
    }

    /// Size the grid to the canvas (and tell the PTY), then build the frame.
    fn layout(
        &mut self,
        bounds: Bounds<Pixels>,
        cell: (Pixels, Pixels),
        font: &Font,
        font_size: Pixels,
        window: &Window,
    ) -> Option<(Frame, HashSet<char>)> {
        self.cell = cell;
        let pad = self.pad();
        self.origin = point(
            bounds.origin.x + px(pad.left),
            bounds.origin.y + px(pad.top),
        );
        let cols = ((bounds.size.width - px(pad.left + pad.right)) / cell.0)
            .floor()
            .max(1.) as u16;
        let rows = ((bounds.size.height - px(pad.top + pad.bottom)) / cell.1)
            .floor()
            .max(1.) as u16;
        let (cw, ch) = (
            f32::from(cell.0).round() as u16,
            f32::from(cell.1).round() as u16,
        );
        self.core.resize(cols, rows, cw, ch);
        let frame = self.core.emulator().frame().ok()?;
        self.rendered.highlights = frame.matches.len();
        // `render` read the find count before this resize. If the resize
        // changed it (text reflowed), draw again with the count that goes
        // with this frame's highlights.
        if self.search_open && frame.search != self.search {
            self.search = frame.search;
            window.request_animation_frame();
        }
        // Which symbols on screen the terminal's font lacks: those are
        // drawn from the bundled symbols font.
        let mut from_symbols = HashSet::new();
        for cell in frame.rows.iter().flatten() {
            if let Some(ch) = single_char(&cell.text)
                && !sprite::covers(ch)
                && glyphs::in_symbols_font(ch)
                && !from_symbols.contains(&ch)
                && (self.font.symbols == BundledSymbols::Always
                    || self.symbols.uses_symbols_font(ch, font, font_size, window))
            {
                from_symbols.insert(ch);
            }
        }
        self.fallback_symbols = from_symbols.iter().copied().collect();
        self.fallback_symbols.sort_unstable();
        Some((frame, from_symbols))
    }
}

fn apply_ghostty_colors(mut theme: TermTheme, look: &GhosttyLook) -> TermTheme {
    if let Some(fg) = look.foreground {
        theme.foreground = fg;
    }
    if let Some(bg) = look.background {
        theme.background = bg;
    }
    // The foreground supplies the cursor color unless Ghostty sets one.
    if let Some(color) = look.cursor_color.or(look.foreground) {
        theme.cursor = color;
        // A custom cursor uses the terminal background for its text
        // unless Ghostty explicitly supplies cursor-text.
        theme.cursor_fg = None;
    }
    theme.cursor_fg = look.cursor_text.or(theme.cursor_fg);
    if let Some(bg) = look.selection_background {
        theme.selection_bg = bg;
        // Keep the cell's foreground unless the custom palette pairs the
        // background with an explicit selection foreground.
        theme.selection_fg = None;
    }
    theme.selection_fg = look.selection_foreground.or(theme.selection_fg);
    for (index, color) in look.palette.range(..16) {
        theme.ansi[usize::from(*index)] = *color;
    }
    theme
}

#[cfg(test)]
mod appearance_tests {
    use super::*;

    #[test]
    fn ghostty_colors_override_merino_per_setting() {
        let dark = TermTheme::DARK;
        assert_eq!(apply_ghostty_colors(dark, &GhosttyLook::default()), dark);

        let look = GhosttyLook {
            background: Some(Rgb::from_u32(0x171717)),
            foreground: Some(Rgb::from_u32(0xFAFAFA)),
            cursor_color: Some(Rgb::from_u32(0xFFFF00)),
            cursor_text: Some(Rgb::from_u32(0x222222)),
            selection_background: Some(Rgb::from_u32(0x335577)),
            selection_foreground: Some(Rgb::from_u32(0xFFFFFF)),
            palette: [(1, Rgb::from_u32(0xFF2222)), (100, Rgb::from_u32(0x332211))].into(),
            ..Default::default()
        };
        let theme = apply_ghostty_colors(dark, &look);
        assert_eq!(Some(theme.background), look.background);
        assert_eq!(Some(theme.foreground), look.foreground);
        assert_eq!(Some(theme.cursor), look.cursor_color);
        assert_eq!(theme.cursor_fg, look.cursor_text);
        assert_eq!(Some(theme.selection_bg), look.selection_background);
        assert_eq!(theme.selection_fg, look.selection_foreground);
        assert_eq!(theme.ansi[1], look.palette[&1]);
        assert_eq!(theme.ansi[2..], dark.ansi[2..]);
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
        // Font: the user's terminal config, then an explicit `set_font`,
        // then the app's monospace family. Later families in the config are
        // fallbacks for glyphs the first one lacks (prompt symbols).
        let font_size_for_choice = self
            .look
            .font_size_pt
            .map_or(self.font.size, |pt| px(points(pt)));
        let (family, font_note) = self.choose_family(font_size_for_choice, window, cx);
        let mut base_font = gpui_kit::font(family.clone());
        let fallbacks: Vec<String> = self.look.font_families.iter().skip(1).cloned().collect();
        if !fallbacks.is_empty() {
            base_font.fallbacks = Some(gpui_kit::FontFallbacks::from_fonts(fallbacks));
        }
        let font_size = self
            .look
            .font_size_pt
            .map_or(self.font.size, |pt| px(points(pt)));
        let pad = self.pad();
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

        let layout_font = base_font.clone();
        let surface = canvas(
            move |bounds, window, cx| {
                entity.update(cx, |v, _| {
                    v.layout(bounds, (cell_w, cell_h), &layout_font, font_size, window)
                })
            },
            move |bounds, laid_out, window, cx| {
                let Some((frame, symbols)) = laid_out else {
                    return;
                };
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
                        pad,
                        symbols: &symbols,
                    },
                    window,
                    cx,
                );
            },
        )
        .size_full();

        // New output may have added or removed matches, and the search
        // only learns of it when it is run. Bring it up to date before
        // reading the count, so the overlay and the highlights `layout`
        // takes below come from the same pass: the emulator runs the
        // search once per change, and not at all for an unchanged redraw.
        // Without this the count stays one batch of output behind, for as
        // long as the source is then quiet.
        if self.search_open {
            self.search = self.core.emulator().search_refresh();
        }
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
            (None, Status::Ended(s)) if !matches!(self.kind(), SessionKind::Command { .. }) => {
                Some(s.clone())
            }
            (None, Status::Running) if self.core.read_only() && !self.core.emu().follow() => {
                Some("paused".into())
            }
            _ => None,
        };
        // Contexts for the app's key bindings; see `crate::actions`.
        let mut key_context = gpui_kit::KeyContext::default();
        key_context.add("Terminal");
        if matches!(self.kind(), SessionKind::Command { .. }) {
            key_context.add("TerminalCommand");
        }
        if self.core.read_only() {
            key_context.add("TerminalLogs");
        }
        if self.search_open {
            key_context.add("TerminalFind");
        }
        // Lowest priority: a running session with nothing else to say shows
        // why its font is not the configured one.
        let status = status.or_else(|| font_note.clone());
        self.rendered = Rendered {
            count: self.rendered.count + 1,
            notice: self.core.notice().map(str::to_owned),
            find: self.search_open.then_some(self.search),
            highlights: self.rendered.highlights,
            font_family: family.to_string(),
            font_note,
        };
        let status = status.map(|s| {
            let t = cx.theme();
            div()
                .id("terminal-status")
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
            .key_context(key_context)
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(hsla(theme.background))
            .on_action(cx.listener(|this, _: &actions::Copy, _, cx| this.copy_selection(cx)))
            .on_action(cx.listener(|this, _: &actions::Paste, _, cx| this.paste_clipboard(cx)))
            .on_action(cx.listener(|this, _: &actions::Find, _, cx| this.open_find(cx)))
            .on_action(cx.listener(|this, _: &actions::FindOlder, _, cx| {
                this.search_step(true, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::FindNewer, _, cx| {
                this.search_step(false, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::CloseFind, _, cx| this.close_find(cx)))
            .on_action(cx.listener(|this, _: &actions::ScrollPageUp, _, cx| {
                this.scroll_page(true, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::ScrollPageDown, _, cx| {
                this.scroll_page(false, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::ScrollToTop, _, cx| {
                this.scroll_to_top(cx);
            }))
            .on_action(cx.listener(|this, _: &actions::ScrollToBottom, _, cx| {
                this.set_follow(true, cx);
            }))
            .on_action(cx.listener(|this, _: &actions::ToggleFollow, _, cx| {
                let follow = !this.follow();
                this.set_follow(follow, cx);
            }))
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
    pad: Pad,
    /// Symbols to draw from the bundled symbols font.
    symbols: &'a HashSet<char>,
}

/// The cell's character, when it holds exactly one.
fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) => Some(ch),
        _ => None,
    }
}

/// A cell that is not drawn as ordinary text.
#[derive(Clone, Copy)]
enum Special {
    /// Drawn as geometry: box drawing, blocks, powerline separators.
    Sprite(char),
    /// Drawn from the bundled symbols font.
    Symbol(char),
}

/// Draw one self-drawn glyph into a cell given in whole device pixels.
/// Nothing is drawn outside the cell: a diagonal's stroke, for one, is
/// wider than the cell at its corners and is cut off at the cell's edges.
fn paint_sprite(ch: char, cell: [f32; 4], scale: f32, color: Hsla, window: &mut Window) {
    let [x0, y0, x1, y1] = cell;
    let (w, h) = (x1 - x0, y1 - y0);
    let Some(shapes) = sprite::shapes(ch, w, h, sprite::line_thickness(w)) else {
        return;
    };
    let at = |x: f32, y: f32| point(px((x0 + x) / scale), px((y0 + y) / scale));
    let bounds = Bounds::from_corners(at(0., 0.), at(w, h));
    window.with_content_mask(Some(ContentMask { bounds }), |window| {
        paint_shapes(shapes, &at, scale, color, window);
    });
}

fn paint_shapes(
    shapes: Vec<Shape>,
    at: &dyn Fn(f32, f32) -> Point<Pixels>,
    scale: f32,
    color: Hsla,
    window: &mut Window,
) {
    let trace = |builder: &mut gpui_kit::PathBuilder, path: &[Seg]| {
        for seg in path {
            match *seg {
                Seg::Move(x, y) => builder.move_to(at(x, y)),
                Seg::Line(x, y) => builder.line_to(at(x, y)),
                Seg::Cubic(a, b, to) => {
                    builder.cubic_bezier_to(at(to.0, to.1), at(a.0, a.1), at(b.0, b.1));
                }
                Seg::Close => builder.close(),
            }
        }
    };
    for shape in shapes {
        match shape {
            Shape::Rect {
                x0,
                y0,
                x1,
                y1,
                alpha,
            } => window.paint_quad(fill(
                Bounds::from_corners(at(x0, y0), at(x1, y1)),
                color.opacity(alpha),
            )),
            Shape::Fill(path) => {
                let mut builder = gpui_kit::PathBuilder::fill();
                trace(&mut builder, &path);
                builder.close();
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
            }
            Shape::Stroke { path, width } => {
                let mut builder = gpui_kit::PathBuilder::stroke(px(width / scale));
                trace(&mut builder, &path);
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
            }
        }
    }
}

/// How many cells a symbol from the bundled font has to draw in, starting
/// at `row[x]`.
///
/// A double-width character has the two cells the emulator gave it. A
/// narrow one has its own cell, and the next cell as well when that one is
/// blank: fitting an icon to a single narrow cell makes it small, prompt
/// themes put a space after their icons, and Ghostty and other terminals
/// treat that space the same way. A double-width symbol is not widened
/// further: it already has the two cells the blank-cell rule exists to give.
fn symbol_cells(row: &[crate::emulator::FrameCell], x: usize) -> u16 {
    if row[x].wide {
        return 2;
    }
    let next_blank = row
        .get(x + 1)
        .is_some_and(|n| !n.spacer && !n.wide && (n.text.is_empty() || n.text == " "));
    if next_blank { 2 } else { 1 }
}

/// Draw one symbol from the bundled symbols font into its room (see
/// [`symbol_cells`]). The glyph's outline is placed so that all its ink is
/// inside the room (see [`glyphs::SymbolOutline::place`]) and filled as a
/// vector path; the room is also the clip, so nothing can land in a
/// neighbouring cell.
fn paint_symbol(ch: char, room: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    let Some(outline) = glyphs::outline(ch) else {
        return;
    };
    let place = outline.place(f32::from(room.size.width), f32::from(room.size.height));
    let left = f32::from(room.origin.x) + place.left;
    let baseline = f32::from(room.origin.y) + place.baseline;
    let k = place.scale;
    // Font units have y pointing up.
    let at = |(x, y): (f32, f32)| point(px(left + x * k), px(baseline - y * k));
    // TrueType outlines are filled with the non-zero rule.
    let mut builder = gpui_kit::PathBuilder::fill().with_style(gpui_kit::PathStyle::Fill(
        gpui_kit::FillOptions::default().with_fill_rule(gpui_kit::FillRule::NonZero),
    ));
    for seg in &outline.path {
        match *seg {
            Seg::Move(x, y) => builder.move_to(at((x, y))),
            Seg::Line(x, y) => builder.line_to(at((x, y))),
            Seg::Cubic(a, b, to) => builder.cubic_bezier_to(at(to), at(a), at(b)),
            Seg::Close => builder.close(),
        }
    }
    if let Ok(path) = builder.build() {
        window.with_content_mask(Some(ContentMask { bounds: room }), |window| {
            window.paint_path(path, color);
        });
    }
}

/// Paint backgrounds, highlights, the cursor, then text. Text is shaped in
/// runs of narrow cells with a forced per-glyph advance of one cell, so the
/// grid stays exact; wide characters are placed on their own two cells.
fn paint_frame(a: &PaintArgs<'_>, window: &mut Window, cx: &mut App) {
    let (cw, ch) = a.cell;
    let ox = a.bounds.origin.x + px(a.pad.left);
    let oy = a.bounds.origin.y + px(a.pad.top);
    let at = |col: u16, row: usize| point(ox + cw * f32::from(col), oy + ch * row as f32);
    // Cell edges on whole device pixels. Backgrounds, highlights, the
    // cursor and the self-drawn glyphs all use them, so neighbouring cells
    // tile without seams at any font size.
    let scale = window.scale_factor();
    let edge_x = |col: usize| ((f32::from(ox) + f32::from(cw) * col as f32) * scale).round();
    let edge_y = |row: usize| ((f32::from(oy) + f32::from(ch) * row as f32) * scale).round();
    let rect = |col: u16, row: usize, n: u16| {
        let col = usize::from(col);
        Bounds::from_corners(
            point(px(edge_x(col) / scale), px(edge_y(row) / scale)),
            point(
                px(edge_x(col + usize::from(n)) / scale),
                px(edge_y(row + 1) / scale),
            ),
        )
    };
    let special = |cell: &crate::emulator::FrameCell| {
        let ch = single_char(&cell.text)?;
        if sprite::covers(ch) {
            Some(Special::Sprite(ch))
        } else if a.symbols.contains(&ch) {
            Some(Special::Symbol(ch))
        } else {
            None
        }
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
    // Keep selected glyphs paired with their selection background even
    // when a Find highlight crosses the selection.
    let mut selection = hsla(a.theme.selection_bg);
    if a.theme.selection_fg.is_none() {
        selection = selection.opacity(0.45);
    }
    for (row, span) in a.frame.selection.iter().enumerate() {
        if let Some((start, end)) = span {
            window.paint_quad(fill(rect(*start, row, end - start + 1), selection));
        }
    }
    // A block cursor covers its cell. Bar, underline and hollow cursors
    // leave the lettering as it is.
    let shape = a.frame.cursor_shape.unwrap_or(CursorShape::Block);
    let block_cursor = a.show_cursor && a.focused && shape == CursorShape::Block;
    if let Some((cx_, cy)) = a.frame.cursor.filter(|_| a.show_cursor) {
        let r = rect(cx_, usize::from(cy), 1);
        let c = hsla(a.frame.cursor_color);
        let thin = px(2.);
        match (a.focused, shape) {
            (false, _) | (true, CursorShape::BlockHollow) => {
                window.paint_quad(gpui_kit::outline(r, c, gpui_kit::BorderStyle::Solid));
            }
            (true, CursorShape::Block) => window.paint_quad(fill(r, c)),
            (true, CursorShape::Bar) => window.paint_quad(fill(
                Bounds {
                    origin: r.origin,
                    size: size(thin, ch),
                },
                c,
            )),
            (true, CursorShape::Underline) => window.paint_quad(fill(
                Bounds {
                    origin: point(r.origin.x, r.origin.y + ch - thin),
                    size: size(cw, thin),
                },
                c,
            )),
        }
    }

    let glyph_fg = |x: usize, y: usize, fg: Rgb| {
        let col = x as u16;
        if block_cursor && a.frame.cursor == Some((col, y as u16)) {
            return a.theme.cursor_fg.unwrap_or(a.frame.background);
        }
        if let Some(selection_fg) = a.theme.selection_fg
            && let Some(Some((start, end))) = a.frame.selection.get(y)
            && (*start..=*end).contains(&col)
        {
            return selection_fg;
        }
        fg
    };
    let ts = window.text_system().clone();
    for (y, row) in a.frame.rows.iter().enumerate() {
        let mut x = 0usize;
        while x < row.len() {
            if row[x].spacer || row[x].text.is_empty() && row[x].bg.is_none() && !row[x].underline {
                x += 1;
                continue;
            }
            if let Some(kind) = special(&row[x]) {
                let c = &row[x];
                let mut color = hsla(glyph_fg(x, y, c.fg));
                if c.faint {
                    color = color.opacity(0.6);
                }
                match kind {
                    Special::Sprite(ch) => paint_sprite(
                        ch,
                        [edge_x(x), edge_y(y), edge_x(x + 1), edge_y(y + 1)],
                        scale,
                        color,
                        window,
                    ),
                    Special::Symbol(ch) => {
                        let room = rect(x as u16, y, symbol_cells(row, x));
                        paint_symbol(ch, room, color, window);
                    }
                }
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
                let mut color = hsla(glyph_fg(x, y, c.fg));
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
                if wide
                    || x >= row.len()
                    || row[x].wide
                    || row[x].spacer
                    || special(&row[x]).is_some()
                {
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

#[cfg(test)]
mod tests {
    use super::symbol_cells;
    use crate::emulator::FrameCell;

    fn cell(text: &str) -> FrameCell {
        FrameCell {
            text: text.into(),
            ..FrameCell::default()
        }
    }

    #[test]
    fn a_symbol_gets_the_cells_the_emulator_gave_it_then_a_blank_neighbour() {
        let wide = FrameCell {
            wide: true,
            ..cell("\u{26a1}")
        };
        let spacer = FrameCell {
            spacer: true,
            ..FrameCell::default()
        };
        // A double-width symbol has two cells whatever follows its spacer.
        for after in ["x", " ", ""] {
            let row = [wide.clone(), spacer.clone(), cell(after)];
            assert_eq!(symbol_cells(&row, 0), 2, "followed by {after:?}");
        }
        assert_eq!(symbol_cells(&[wide.clone(), spacer.clone()], 0), 2);
        // A narrow symbol borrows a blank cell after it, and nothing else.
        let icon = cell("\u{f07b}");
        assert_eq!(symbol_cells(&[icon.clone(), cell(" ")], 0), 2);
        assert_eq!(symbol_cells(&[icon.clone(), cell("")], 0), 2);
        assert_eq!(symbol_cells(&[icon.clone(), cell("x")], 0), 1);
        assert_eq!(symbol_cells(&[icon.clone(), icon.clone()], 0), 1);
        assert_eq!(symbol_cells(&[icon.clone(), wide, spacer], 0), 1);
        assert_eq!(symbol_cells(&[icon], 0), 1, "at the end of the row");
    }
}
