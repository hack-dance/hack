//! Design v1 tokens: type, spacing, radii, borders and colour, light and dark.
//!
//! Every value here is named in `apps/desktop/DESIGN-V1.md`; change both
//! together. Components read tokens, never raw numbers or gpui-kit theme
//! colours, so the window keeps one look whatever gpui-kit's defaults are.

use gpui_kit::{Hsla, Pixels, Rgba, px, rgb, rgba};

/// Light or dark. The app follows the system unless `--theme` says otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
}

/// One step of the type scale: size, line height and weight.
#[derive(Debug, Clone, Copy)]
pub struct TypeStep {
    pub size: Pixels,
    pub line: Pixels,
    pub weight: gpui_kit::FontWeight,
}

const fn step(size: f32, line: f32, weight: gpui_kit::FontWeight) -> TypeStep {
    TypeStep {
        size: px(size),
        line: px(line),
        weight,
    }
}

/// Type scale. UI text uses the platform UI font (SF Pro on macOS); code,
/// URLs, routes and logs use the platform monospace font.
pub mod text {
    use super::{TypeStep, step};
    use gpui_kit::FontWeight;

    /// Project name in the detail header.
    pub const TITLE: TypeStep = step(17., 22., FontWeight::SEMIBOLD);
    /// Empty and error pane headline.
    pub const HEADLINE: TypeStep = step(15., 20., FontWeight::SEMIBOLD);
    /// Body: rows, tabs, buttons, table cells.
    pub const BODY: TypeStep = step(13., 18., FontWeight::NORMAL);
    /// Selected row, selected tab, window title.
    pub const BODY_STRONG: TypeStep = step(13., 18., FontWeight::MEDIUM);
    /// Captions, table header, pills, status bar.
    pub const SMALL: TypeStep = step(12., 16., FontWeight::NORMAL);
    pub const SMALL_STRONG: TypeStep = step(12., 16., FontWeight::MEDIUM);
    /// URLs, routes and log lines (monospace).
    pub const MONO: TypeStep = step(12., 18., FontWeight::NORMAL);
    /// Count inside a pill, keyboard hint.
    pub const MICRO: TypeStep = step(11., 14., FontWeight::MEDIUM);
}

/// 4-point spacing scale.
pub mod space {
    use gpui_kit::{Pixels, px};
    pub const S1: Pixels = px(2.);
    pub const S2: Pixels = px(4.);
    pub const S3: Pixels = px(6.);
    pub const S4: Pixels = px(8.);
    pub const S5: Pixels = px(10.);
    pub const S6: Pixels = px(12.);
    pub const S7: Pixels = px(16.);
    pub const S8: Pixels = px(20.);
    pub const S9: Pixels = px(24.);
}

/// Fixed sizes.
pub mod size {
    use gpui_kit::{Pixels, px};
    pub const TITLE_BAR: Pixels = px(38.);
    pub const STATUS_BAR: Pixels = px(26.);
    pub const SIDEBAR: Pixels = px(208.);
    pub const ROW: Pixels = px(28.);
    pub const TABLE_ROW: Pixels = px(32.);
    pub const CONTROL: Pixels = px(26.);
    pub const DOT: Pixels = px(8.);
    pub const ICON: Pixels = px(14.);
    pub const ICON_ROW: Pixels = px(15.);
    pub const SEARCH_W: Pixels = px(240.);
    /// Leaves room for the macOS traffic lights in the title bar.
    pub const TRAFFIC_LIGHTS: Pixels = px(76.);
}

/// Corner radii.
pub mod radius {
    use gpui_kit::{Pixels, px};
    pub const CONTROL: Pixels = px(6.);
    pub const PILL: Pixels = px(5.);
    pub const PANEL: Pixels = px(8.);
    pub const WINDOW: Pixels = px(12.);
}

/// Hairline border width: one device pixel on a 2x display.
pub const HAIRLINE: Pixels = px(0.5);

/// Colour tokens for one mode.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub mode: Mode,
    /// Window and detail pane.
    pub surface: Hsla,
    /// Sidebar, title bar and status bar.
    pub chrome: Hsla,
    /// Hover, log block, neutral pills.
    pub surface_1: Hsla,
    /// Pressed.
    pub surface_2: Hsla,
    /// Selected navigation and file rows.
    pub selection: Hsla,
    /// Read-only file preview body.
    pub preview_surface: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub text_primary: Hsla,
    pub text_secondary: Hsla,
    pub text_muted: Hsla,
    pub accent: Hsla,
    pub states: States,
}

/// Dot, pill background and pill text for each state.
#[derive(Debug, Clone, Copy)]
pub struct StateColors {
    pub dot: Hsla,
    pub bg: Hsla,
    pub fg: Hsla,
}

#[derive(Debug, Clone, Copy)]
pub struct States {
    pub running: StateColors,
    pub busy: StateColors,
    pub degraded: StateColors,
    pub failed: StateColors,
    pub stopped: StateColors,
    pub unknown: StateColors,
}

fn c(v: Rgba) -> Hsla {
    v.into()
}

impl Palette {
    #[must_use]
    pub fn for_mode(mode: Mode) -> Self {
        match mode {
            Mode::Light => Self::light(),
            Mode::Dark => Self::dark(),
        }
    }

    #[must_use]
    pub fn light() -> Self {
        Self {
            mode: Mode::Light,
            surface: c(rgb(0xFFFFFF)),
            chrome: c(rgb(0xF7F7F5)),
            surface_1: c(rgb(0xEFEFEC)),
            surface_2: c(rgb(0xE6E6E2)),
            selection: c(rgb(0xEFEFEC)),
            preview_surface: c(rgb(0xEFEFEC)),
            border: c(rgba(0x0000_0017)),
            border_strong: c(rgba(0x0000_002E)),
            text_primary: c(rgb(0x1C1C1A)),
            text_secondary: c(rgb(0x5C5B57)),
            text_muted: c(rgb(0x8B8A85)),
            accent: c(rgb(0x2F6FDB)),
            states: States {
                running: StateColors {
                    dot: c(rgb(0x1D9E75)),
                    bg: c(rgb(0xE2F3EC)),
                    fg: c(rgb(0x146B50)),
                },
                busy: StateColors {
                    dot: c(rgb(0x378ADD)),
                    bg: c(rgb(0xE5EEFA)),
                    fg: c(rgb(0x235E9E)),
                },
                degraded: StateColors {
                    dot: c(rgb(0xEF9F27)),
                    bg: c(rgb(0xFBEFDA)),
                    fg: c(rgb(0x8A5608)),
                },
                failed: StateColors {
                    dot: c(rgb(0xE24B4A)),
                    bg: c(rgb(0xFBE6E5)),
                    fg: c(rgb(0xA82E2D)),
                },
                stopped: StateColors {
                    dot: c(rgb(0xBDBCB6)),
                    bg: c(rgb(0xEFEFEC)),
                    fg: c(rgb(0x5C5B57)),
                },
                unknown: StateColors {
                    dot: c(rgb(0x9C9B95)),
                    bg: c(rgb(0xEFEFEC)),
                    fg: c(rgb(0x5C5B57)),
                },
            },
        }
    }

    #[must_use]
    pub fn dark() -> Self {
        // Merino Dark, from the HACK-2595 desktop frames.
        let surface_1 = c(rgb(0x1A1E24));
        let selection = c(rgb(0x24272B));
        let text_primary = c(rgb(0xE6EDF3));
        let text_secondary = c(rgb(0xBFC5CB));
        let text_muted = c(rgb(0x8B9197));
        Self {
            mode: Mode::Dark,
            surface: c(rgb(0x0D1117)),
            chrome: c(rgb(0x090C10)),
            surface_1,
            surface_2: selection,
            selection,
            preview_surface: c(rgb(0x1E2329)),
            border: c(rgb(0x1E2329)),
            border_strong: c(rgb(0x2B3036)),
            text_primary,
            text_secondary,
            text_muted,
            accent: text_primary,
            states: States {
                running: StateColors {
                    dot: c(rgb(0x3FB950)),
                    bg: c(rgb(0x152C20)),
                    fg: c(rgb(0x56D364)),
                },
                busy: StateColors {
                    dot: c(rgb(0x58A6FF)),
                    bg: c(rgba(0x58A6_FF30)),
                    fg: c(rgb(0x79C0FF)),
                },
                degraded: StateColors {
                    dot: c(rgb(0xD29922)),
                    bg: c(rgba(0xD299_222E)),
                    fg: c(rgb(0xE3B341)),
                },
                failed: StateColors {
                    dot: c(rgb(0xFF7B72)),
                    bg: c(rgb(0x2F2024)),
                    fg: c(rgb(0xFFA198)),
                },
                stopped: StateColors {
                    dot: c(rgb(0x686D73)),
                    bg: surface_1,
                    fg: text_secondary,
                },
                unknown: StateColors {
                    dot: text_muted,
                    bg: surface_1,
                    fg: text_secondary,
                },
            },
        }
    }
}

/// Fallback terminal theme, used when the user has no Ghostty config. The
/// panel is dark in both app modes (as in the approved mockup); a Ghostty
/// theme replaces every value here.
#[derive(Debug, Clone, Copy)]
pub struct TermPalette {
    pub bg: Hsla,
    pub fg: Hsla,
    pub dim: Hsla,
    /// Tab strip and its separators.
    pub strip: Hsla,
    pub strip_border: Hsla,
    pub tab_fg: Hsla,
    pub green: Hsla,
    pub bright_green: Hsla,
    pub blue: Hsla,
    pub magenta: Hsla,
    pub yellow: Hsla,
    pub red: Hsla,
    pub cyan: Hsla,
    pub cursor: Hsla,
    /// Env badge: non-default overlay (warning) and default overlay.
    pub badge_warn_bg: Hsla,
    pub badge_warn_fg: Hsla,
    pub badge_bg: Hsla,
    pub badge_fg: Hsla,
}

impl TermPalette {
    #[must_use]
    pub fn fallback() -> Self {
        Self {
            bg: c(rgb(0x1C1C1A)),
            fg: c(rgb(0xE8E6DC)),
            dim: c(rgb(0x8B8A85)),
            strip: c(rgb(0x2A2A28)),
            strip_border: c(rgb(0x3A3A37)),
            tab_fg: c(rgb(0xB4B2A9)),
            green: c(rgb(0x5DCAA5)),
            bright_green: c(rgb(0x97C459)),
            blue: c(rgb(0x85B7EB)),
            magenta: c(rgb(0xAFA9EC)),
            yellow: c(rgb(0xEF9F27)),
            red: c(rgb(0xF07B7A)),
            cyan: c(rgb(0x6CCFD9)),
            cursor: c(rgb(0xE8E6DC)),
            badge_warn_bg: c(rgb(0x633806)),
            badge_warn_fg: c(rgb(0xFAC775)),
            badge_bg: c(rgb(0x3A3A37)),
            badge_fg: c(rgb(0xD3D1C7)),
        }
    }
}

/// Terminal panel sizes.
pub mod panel {
    use gpui_kit::{Pixels, px};
    /// Drag handle on the panel's top edge.
    pub const HANDLE: Pixels = px(9.);
    pub const GRIP_W: Pixels = px(36.);
    pub const GRIP_H: Pixels = px(3.);
    /// Tab strip height (also the collapsed panel height).
    pub const STRIP: Pixels = px(32.);
    /// Default height as a fraction of the content area.
    pub const DEFAULT_FRACTION: f32 = 0.5;
    /// Terminal text inset.
    pub const PAD_X: Pixels = px(14.);
    pub const PAD_Y: Pixels = px(10.);
    /// Fallback terminal font size and line height.
    pub const FONT: Pixels = px(12.5);
    pub const LINE: Pixels = px(19.);
    /// New-tab menu: longer service lists scroll.
    pub const MENU_MAX_H: Pixels = px(300.);
}
