//! The project terminal panel: an edge-to-edge panel docked at the bottom of
//! the content area, with a drag handle, a tab strip and the terminal
//! surface. This module draws it from plain data; the `term` crate owns the
//! PTYs and the emulator, and the app owns the state.

use gpui_kit::{Div, Hsla, ParentElement, SharedString, Styled, div, prelude::*, px, relative};

use crate::components::{StyledExt as _, Ui, icon};
use crate::icons::Glyph;
use crate::tokens::{TermPalette, panel, radius, size, space, text};

/// How much of the content area the panel takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelState {
    /// Only the tab strip is shown, at the bottom of the content area.
    Collapsed,
    /// The remembered height (default half the content area).
    Open { fraction_milli: u16 },
    /// Fills the content area; the project header collapses to one row.
    Maximized,
}

impl PanelState {
    #[must_use]
    pub fn half() -> Self {
        Self::Open {
            fraction_milli: (panel::DEFAULT_FRACTION * 1000.) as u16,
        }
    }
}

/// What a terminal tab runs. Every kind has a fixed label; an injected
/// environment adds a badge with names only, never values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabKind {
    /// Read-only stream of the project's logs (always the first tab).
    Logs,
    /// Single command run in the same embedded terminal panel.
    Command { label: String },
    /// `hack exec <service> -- <shell>`.
    ContainerShell { service: String, shell: String },
    /// The user's login shell in the project root.
    HostShell { shell: String },
    /// `hack host shell --env <overlay> --scope <scope>`.
    HostShellWithEnv {
        shell: String,
        overlay: String,
        scope: String,
        /// The overlay is the project's default. Otherwise the badge warns.
        is_default: bool,
    },
}

impl TabKind {
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Logs => "Logs".into(),
            Self::Command { label } => label.clone(),
            Self::ContainerShell { service, shell } => format!("{service} · {shell}"),
            Self::HostShell { shell } | Self::HostShellWithEnv { shell, .. } => {
                format!("host · {shell}")
            }
        }
    }

    #[must_use]
    pub fn glyph(&self) -> Glyph {
        match self {
            Self::Logs => Glyph::Logs,
            Self::Command { .. } => Glyph::Terminal,
            Self::ContainerShell { .. } => Glyph::Container,
            Self::HostShell { .. } | Self::HostShellWithEnv { .. } => Glyph::HostShell,
        }
    }

    /// Env badge text and whether it warns: "env staging · api".
    #[must_use]
    pub fn badge(&self) -> Option<(String, bool)> {
        match self {
            Self::HostShellWithEnv {
                overlay,
                scope,
                is_default,
                ..
            } => Some((format!("env {overlay} · {scope}"), !is_default)),
            _ => None,
        }
    }

    #[must_use]
    pub fn closable(&self) -> bool {
        !matches!(self, Self::Logs)
    }
}

/// Colour of one run of terminal text. Real output keeps the colours the
/// program printed; these name the fallback theme's ANSI slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ansi {
    Fg,
    Dim,
    Green,
    BrightGreen,
    Blue,
    Magenta,
    Yellow,
    Red,
    Cyan,
}

impl Ansi {
    fn color(self, t: &TermPalette) -> Hsla {
        match self {
            Self::Fg => t.fg,
            Self::Dim => t.dim,
            Self::Green => t.green,
            Self::BrightGreen => t.bright_green,
            Self::Blue => t.blue,
            Self::Magenta => t.magenta,
            Self::Yellow => t.yellow,
            Self::Red => t.red,
            Self::Cyan => t.cyan,
        }
    }
}

/// A run of terminal text with one style.
#[derive(Debug, Clone)]
pub struct Span {
    pub text: String,
    pub fg: Ansi,
    pub bold: bool,
}

#[must_use]
pub fn span(text: impl Into<String>, fg: Ansi) -> Span {
    Span {
        text: text.into(),
        fg,
        bold: false,
    }
}

/// Everything the panel shows.
pub struct PanelView {
    pub state: PanelState,
    pub tabs: Vec<TabKind>,
    pub selected: usize,
    /// Lines of the selected tab (the emulator's visible rows).
    pub lines: Vec<Vec<Span>>,
    /// Draw a block cursor after the last line (interactive tabs).
    pub cursor: bool,
    /// Show the new-tab menu (gallery only; the app opens it on click).
    pub menu: Option<Vec<String>>,
    /// Terminal font family (Ghostty `font-family`, else the app's mono).
    pub font: SharedString,
    pub term: TermPalette,
}

/// The drag handle on the panel's top edge. Drag to resize; drag to the top
/// (or double-click) to maximize; drag down to collapse.
fn handle(ui: &Ui) -> Div {
    let p = ui.p;
    div()
        .h(panel::HANDLE)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .bg(p.surface_1)
        .hairline_t(p.border_strong)
        .cursor_row_resize()
        .child(
            div()
                .w(panel::GRIP_W)
                .h(panel::GRIP_H)
                .rounded(px(2.))
                .bg(p.border_strong),
        )
}

fn badge(label: String, warn: bool, t: &TermPalette) -> Div {
    let (bg, fg) = if warn {
        (t.badge_warn_bg, t.badge_warn_fg)
    } else {
        (t.badge_bg, t.badge_fg)
    };
    div()
        .flex_none()
        .px(space::S3)
        .rounded(radius::PILL)
        .bg(bg)
        .text_color(fg)
        .type_step(text::MICRO)
        .child(label)
}

fn strip(v: &PanelView, ui: &Ui) -> Div {
    let t = v.term;
    let mut tabs = div().flex().items_stretch().min_w_0().overflow_hidden();
    for (i, kind) in v.tabs.iter().enumerate() {
        let sel = i == v.selected;
        let fg = if sel { t.fg } else { t.tab_fg };
        tabs = tabs.child(
            div()
                .id(("term-tab", i))
                .flex()
                .items_center()
                .gap(space::S3)
                .px(space::S5)
                .hairline_r(t.strip_border)
                .when(sel, |d| d.bg(t.bg))
                .text_color(fg)
                .type_step(if sel { text::SMALL_STRONG } else { text::SMALL })
                .whitespace_nowrap()
                .cursor_pointer()
                .child(icon(kind.glyph(), size::ICON, fg))
                .child(kind.label())
                .when_some(kind.badge(), |d, (label, warn)| {
                    d.child(badge(label, warn, &t))
                })
                .when(kind.closable(), |d| {
                    d.child(icon(Glyph::Close, px(12.), t.tab_fg))
                }),
        );
    }
    // Outside the clipped tab row, so its menu can open above the strip.
    let new_tab = div()
        .id("term-new")
        .relative()
        .flex_none()
        .flex()
        .items_center()
        .gap(space::S1)
        .px(space::S5)
        .cursor_pointer()
        .child(icon(Glyph::Plus, size::ICON, t.tab_fg))
        .child(icon(Glyph::ChevronDown, px(12.), t.tab_fg))
        .when_some(v.menu.as_ref(), |d, items| {
            // Opens toward the larger space: above the strip when the panel
            // is docked low, below it when the panel is maximized (the strip
            // is then near the top of the window).
            let anchor = div().absolute().left(px(0.));
            let anchor = if v.state == PanelState::Maximized {
                anchor.top(panel::STRIP + px(4.))
            } else {
                anchor.bottom(panel::STRIP + px(4.))
            };
            // Deferred so it paints above the terminal surface drawn after it.
            d.child(gpui_kit::deferred(anchor.child(menu(items, ui))).with_priority(1))
        });
    let (size_glyph, find) = match v.state {
        PanelState::Collapsed => (Glyph::ChevronUp, false),
        PanelState::Open { .. } => (Glyph::Maximize, true),
        PanelState::Maximized => (Glyph::Restore, true),
    };
    div()
        .h(panel::STRIP)
        .flex_none()
        .flex()
        .items_stretch()
        .bg(t.strip)
        .hairline_b(t.strip_border)
        .child(tabs)
        .child(new_tab)
        .child(div().flex_1())
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S5)
                .px(space::S5)
                .when(find, |d| d.child(icon(Glyph::Search, size::ICON, t.tab_fg)))
                .child(icon(size_glyph, size::ICON, t.tab_fg)),
        )
}

fn surface(v: &PanelView) -> Div {
    let t = v.term;
    let mut body = div()
        .id("term-surface")
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .flex()
        .flex_col()
        .px(panel::PAD_X)
        .py(panel::PAD_Y)
        .bg(t.bg)
        .text_color(t.fg)
        .font_family(v.font.clone())
        .text_size(panel::FONT)
        .line_height(panel::LINE);
    let last = v.lines.len().saturating_sub(1);
    for (i, line) in v.lines.iter().enumerate() {
        let mut row = div().flex().whitespace_nowrap();
        for s in line {
            row = row.child(
                div()
                    .text_color(s.fg.color(&t))
                    .when(s.bold, |d| d.font_weight(gpui_kit::FontWeight::BOLD))
                    .child(s.text.clone()),
            );
        }
        if v.cursor && i == last {
            row = row.child(div().w(px(7.5)).h(panel::LINE).bg(t.cursor));
        }
        body = body.child(row);
    }
    div().flex_1().min_h_0().flex().flex_col().child(body)
}

fn menu(items: &[String], ui: &Ui) -> gpui_kit::Stateful<Div> {
    let p = ui.p;
    let mut m = div()
        .id("term-menu")
        .w(px(220.))
        .max_h(panel::MENU_MAX_H)
        .overflow_y_scroll()
        .py(space::S2)
        .rounded(radius::PANEL)
        .bg(p.surface)
        .hairline(p.border_strong)
        .shadow_lg()
        .type_step(text::BODY)
        .text_color(p.text_primary);
    for (i, item) in items.iter().enumerate() {
        if item.is_empty() {
            m = m.child(div().my(space::S2).hairline_t(p.border));
            continue;
        }
        let glyph = if item.starts_with("Shell in") {
            Glyph::Container
        } else {
            Glyph::HostShell
        };
        m = m.child(
            div()
                .id(("term-menu", i))
                .mx(space::S2)
                .h(size::ROW)
                .px(space::S4)
                .flex()
                .items_center()
                .gap(space::S4)
                .rounded(radius::CONTROL)
                .when(i == 0, |d| d.bg(p.surface_1))
                .child(icon(glyph, size::ICON, p.text_secondary))
                .child(item.clone()),
        );
    }
    m
}

/// The panel: handle, tab strip, terminal. The caller places it at the
/// bottom of the content column; its height follows [`PanelState`].
pub fn terminal_panel(v: &PanelView, ui: &Ui) -> Div {
    let base = div().flex().flex_col().min_h_0().relative();
    match v.state {
        PanelState::Collapsed => base.flex_none().child(handle(ui)).child(strip(v, ui)),
        PanelState::Open { fraction_milli } => base
            .flex_none()
            .h(relative(f32::from(fraction_milli) / 1000.))
            .child(handle(ui))
            .child(strip(v, ui))
            .child(surface(v)),
        PanelState::Maximized => base.flex_1().child(strip(v, ui)).child(surface(v)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_badges_carry_names_only() {
        let t = TabKind::HostShellWithEnv {
            shell: "zsh".into(),
            overlay: "staging".into(),
            scope: "api".into(),
            is_default: false,
        };
        assert_eq!(t.label(), "host · zsh");
        assert_eq!(t.badge(), Some(("env staging · api".into(), true)));
        let d = TabKind::HostShellWithEnv {
            shell: "zsh".into(),
            overlay: "local".into(),
            scope: "web".into(),
            is_default: true,
        };
        assert_eq!(d.badge(), Some(("env local · web".into(), false)));
        assert_eq!(
            TabKind::ContainerShell {
                service: "api".into(),
                shell: "sh".into()
            }
            .label(),
            "api · sh"
        );
        assert!(TabKind::Logs.badge().is_none());
        assert!(!TabKind::Logs.closable());
    }
}
