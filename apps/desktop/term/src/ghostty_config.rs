//! Read the look of the user's Ghostty terminal from their Ghostty config,
//! so the app's terminal matches it: font, colours, cursor and padding.
//!
//! Only these keys are read: `font-family`, `font-size`, `background`,
//! `foreground`, `palette`, `cursor-style`, `window-padding-x`,
//! `window-padding-y`, plus `theme` and `config-file` to find the rest.
//! Every other line is skipped without being kept. Nothing from the file is
//! logged, and a missing or unreadable file is the same as an empty one:
//! the caller falls back to the app's own tokens for whatever is `None`.
//!
//! Reading is bounded end to end. Each file is opened once and read
//! through a limit on that handle, so a file that grows or is replaced
//! after it was looked at cannot exceed it. A file is identified by its
//! canonical path before it is opened and is never read twice. One load
//! has a total budget, in bytes and in files, across the config files,
//! every include and the theme. Only regular files are read.
//!
//! Rules follow Ghostty's documentation:
//!
//! - Files: `$XDG_CONFIG_HOME/ghostty/config.ghostty` then `.../config`
//!   (`~/.config` when the variable is unset); on macOS also
//!   `~/Library/Application Support/com.mitchellh.ghostty/` with the same
//!   two names, loaded after the XDG ones. Later values win.
//! - Syntax: `key = value`, `#` comments on their own line, optional double
//!   quotes, and an empty value resets the key (`palette =` drops every
//!   palette entry set so far, the theme's included).
//! - `config-file = path` is processed at the end of the file that contains
//!   it, relative to that file; a leading `?` makes it optional; cycles are
//!   ignored.
//! - `theme = name`, `theme = /absolute/path` or `theme = light:A,dark:B`.
//!   Names are looked up in `<config>/ghostty/themes`, then in Ghostty's
//!   resources. The user's own colour settings override the theme's. A
//!   theme file cannot set `theme` or `config-file`.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::color::Rgb;

/// The largest config or theme file that is read.
const MAX_FILE_BYTES: u64 = 1 << 20;
/// The most bytes one load reads in total, over every file.
const MAX_TOTAL_BYTES: u64 = 4 << 20;
/// The most files one load opens.
const MAX_FILES: usize = 64;
/// How deep `config-file` includes may nest.
const MAX_INCLUDE_DEPTH: usize = 8;

/// What one load read. For tests and diagnostics; holds no file content.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoadStats {
    /// Files opened and read (each at most once).
    pub files_read: usize,
    /// Bytes read from them, including the bytes of files that turned out
    /// to be over the limit.
    pub bytes_read: u64,
}

/// The state of one load: which files were visited and what is left of the
/// budget.
struct Walk {
    seen: HashSet<PathBuf>,
    bytes_left: u64,
    files_left: usize,
    stats: LoadStats,
}

impl Walk {
    fn new() -> Self {
        Self {
            seen: HashSet::new(),
            bytes_left: MAX_TOTAL_BYTES,
            files_left: MAX_FILES,
            stats: LoadStats::default(),
        }
    }
}

/// Where to look. Built from the process environment in the app and by hand
/// in tests, so a test never reads the real home directory.
#[derive(Clone, Debug, Default)]
pub struct ConfigEnv {
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// Also read the macOS Application Support location.
    pub macos: bool,
    /// Directories that hold Ghostty's bundled `themes` directory.
    pub resource_dirs: Vec<PathBuf>,
}

impl ConfigEnv {
    /// The real locations for this process.
    pub fn from_process() -> Self {
        let var = |name: &str| {
            std::env::var_os(name)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        let mut resource_dirs: Vec<PathBuf> = var("GHOSTTY_RESOURCES_DIR").into_iter().collect();
        resource_dirs.extend(
            [
                "/usr/share/ghostty",
                "/usr/local/share/ghostty",
                "/opt/homebrew/share/ghostty",
                "/Applications/Ghostty.app/Contents/Resources/ghostty",
            ]
            .map(PathBuf::from),
        );
        Self {
            home: var("HOME"),
            xdg_config_home: var("XDG_CONFIG_HOME").filter(|p| p.is_absolute()),
            macos: cfg!(target_os = "macos"),
            resource_dirs,
        }
    }

    fn xdg_dir(&self) -> Option<PathBuf> {
        self.xdg_config_home
            .clone()
            .or_else(|| self.home.as_ref().map(|h| h.join(".config")))
            .map(|d| d.join("ghostty"))
    }

    /// The config files Ghostty would load, in load order. They need not exist.
    pub fn config_files(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = self.xdg_dir().into_iter().collect();
        if self.macos
            && let Some(home) = &self.home
        {
            dirs.push(home.join("Library/Application Support/com.mitchellh.ghostty"));
        }
        dirs.iter()
            .flat_map(|d| [d.join("config.ghostty"), d.join("config")])
            .collect()
    }

    fn theme_dirs(&self) -> Vec<PathBuf> {
        self.xdg_dir()
            .into_iter()
            .chain(self.resource_dirs.iter().cloned())
            .map(|d| d.join("themes"))
            .collect()
    }
}

/// Ghostty's `cursor-style` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Bar,
    Underline,
    BlockHollow,
}

/// What the user's Ghostty config says about the terminal's look. `None`
/// and empty mean "not set": use the app's own value.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GhosttyLook {
    /// Font families in preference order; later ones are fallbacks.
    pub font_families: Vec<String>,
    /// Font size in points, as Ghostty counts it.
    pub font_size_pt: Option<f32>,
    pub background: Option<Rgb>,
    pub foreground: Option<Rgb>,
    pub cursor_color: Option<Rgb>,
    pub cursor_text: Option<Rgb>,
    pub selection_background: Option<Rgb>,
    pub selection_foreground: Option<Rgb>,
    /// Palette entries the config sets, by index 0 to 255.
    pub palette: BTreeMap<u8, Rgb>,
    pub cursor_style: Option<CursorShape>,
    /// Left and right padding in points.
    pub padding_x: Option<(f32, f32)>,
    /// Top and bottom padding in points.
    pub padding_y: Option<(f32, f32)>,
}

impl GhosttyLook {
    /// Whether the config set none of the keys read here.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Read the user's config. `dark` picks the side of a `light:A,dark:B`
    /// theme. Never fails: anything missing or malformed is left unset.
    pub fn load(env: &ConfigEnv, dark: bool) -> Self {
        Self::load_counted(env, dark).0
    }

    /// [`Self::load`], also returning how much was read.
    pub fn load_counted(env: &ConfigEnv, dark: bool) -> (Self, LoadStats) {
        let mut walk = Walk::new();
        let mut user = Raw::default();
        for file in env.config_files() {
            load_file(&file, env, &mut user, &mut walk, 0, Source::Config);
        }
        let mut look = Self::default();
        if let Some(theme) = user.theme.as_deref().and_then(|t| theme_name(t, dark))
            && let Some(path) = find_theme(&theme, env)
        {
            let mut base = Raw::default();
            load_file(&path, env, &mut base, &mut walk, 0, Source::Theme);
            base.apply_to(&mut look);
        }
        // The user's own settings override the theme's.
        user.apply_to(&mut look);
        (look, walk.stats)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Config,
    /// A theme file: `theme` and `config-file` are not allowed in it.
    Theme,
}

/// Settings as written, before a theme is merged in. An outer `Some` means
/// the key appeared; an inner `None` means it was reset with an empty value.
#[derive(Default)]
struct Raw {
    font_families: Option<Vec<String>>,
    font_size_pt: Option<Option<f32>>,
    background: Option<Option<Rgb>>,
    foreground: Option<Option<Rgb>>,
    cursor_color: Option<Option<Rgb>>,
    cursor_text: Option<Option<Rgb>>,
    selection_background: Option<Option<Rgb>>,
    selection_foreground: Option<Option<Rgb>>,
    /// An empty `palette =` was seen: drop every entry from before it,
    /// including a theme's. `palette` holds the entries set after it.
    palette_reset: bool,
    palette: BTreeMap<u8, Rgb>,
    cursor_style: Option<Option<CursorShape>>,
    padding_x: Option<Option<(f32, f32)>>,
    padding_y: Option<Option<(f32, f32)>>,
    theme: Option<String>,
}

impl Raw {
    fn apply_to(self, look: &mut GhosttyLook) {
        if let Some(f) = self.font_families {
            look.font_families = f;
        }
        if let Some(v) = self.font_size_pt {
            look.font_size_pt = v;
        }
        if let Some(v) = self.background {
            look.background = v;
        }
        if let Some(v) = self.foreground {
            look.foreground = v;
        }
        if let Some(v) = self.cursor_color {
            look.cursor_color = v;
        }
        if let Some(v) = self.cursor_text {
            look.cursor_text = v;
        }
        if let Some(v) = self.selection_background {
            look.selection_background = v;
        }
        if let Some(v) = self.selection_foreground {
            look.selection_foreground = v;
        }
        if self.palette_reset {
            look.palette.clear();
        }
        look.palette.extend(self.palette);
        if let Some(v) = self.cursor_style {
            look.cursor_style = v;
        }
        if let Some(v) = self.padding_x {
            look.padding_x = v;
        }
        if let Some(v) = self.padding_y {
            look.padding_y = v;
        }
    }

    fn set(&mut self, key: &str, value: &str, source: Source) {
        let empty = value.is_empty();
        match key {
            "font-family" => {
                let list = self.font_families.get_or_insert_with(Vec::new);
                if empty {
                    list.clear();
                } else if !list.iter().any(|f| f == value) {
                    list.push(value.to_owned());
                }
            }
            "font-size" => {
                let size = value
                    .parse::<f32>()
                    .ok()
                    .filter(|s| (4.0..=128.0).contains(s));
                if empty || size.is_some() {
                    self.font_size_pt = Some(size);
                }
            }
            "background" => set_color(&mut self.background, value),
            "foreground" => set_color(&mut self.foreground, value),
            "cursor-color" => set_color(&mut self.cursor_color, value),
            "cursor-text" => set_color(&mut self.cursor_text, value),
            "selection-background" => set_color(&mut self.selection_background, value),
            "selection-foreground" => set_color(&mut self.selection_foreground, value),
            "palette" if empty => {
                self.palette_reset = true;
                self.palette.clear();
            }
            "palette" => {
                if let Some((index, color)) = value.split_once('=')
                    && let Some(index) = parse_index(index.trim())
                    && let Some(color) = parse_color(color.trim())
                {
                    self.palette.insert(index, color);
                }
            }
            "cursor-style" => {
                let shape = match value {
                    "block" => Some(CursorShape::Block),
                    "bar" => Some(CursorShape::Bar),
                    "underline" => Some(CursorShape::Underline),
                    "block_hollow" => Some(CursorShape::BlockHollow),
                    _ => None,
                };
                if empty || shape.is_some() {
                    self.cursor_style = Some(shape);
                }
            }
            "window-padding-x" => set_padding(&mut self.padding_x, value),
            "window-padding-y" => set_padding(&mut self.padding_y, value),
            "theme" if source == Source::Config => {
                self.theme = (!empty).then(|| value.to_owned());
            }
            _ => {}
        }
    }
}

fn set_color(slot: &mut Option<Option<Rgb>>, value: &str) {
    let color = parse_color(value);
    if value.is_empty() || color.is_some() {
        *slot = Some(color);
    }
}

fn set_padding(slot: &mut Option<Option<(f32, f32)>>, value: &str) {
    let one = |s: &str| {
        s.trim()
            .parse::<f32>()
            .ok()
            .filter(|v| (0.0..=512.0).contains(v))
    };
    let pair = match value.split_once(',') {
        Some((a, b)) => one(a).zip(one(b)),
        None => one(value).map(|v| (v, v)),
    };
    if value.is_empty() || pair.is_some() {
        *slot = Some(pair);
    }
}

/// A palette index: decimal, or `0x`, `0o`, `0b` prefixed.
fn parse_index(text: &str) -> Option<u8> {
    let (digits, radix) = match text.get(..2) {
        Some("0x") => (&text[2..], 16),
        Some("0o") => (&text[2..], 8),
        Some("0b") => (&text[2..], 2),
        _ => (text, 10),
    };
    u8::from_str_radix(digits, radix).ok()
}

/// Hex always; X11 colour names when libghostty is linked in.
fn parse_color(value: &str) -> Option<Rgb> {
    if let Some(c) = Rgb::from_hex(value) {
        return Some(c);
    }
    #[cfg(feature = "ghostty")]
    if !value.is_empty()
        && let Ok(c) = ghostty_vt::style::RgbColor::parse(value)
    {
        return Some(Rgb::new(c.r, c.g, c.b));
    }
    None
}

/// The theme to use from a `theme` value, for the given appearance.
fn theme_name(value: &str, dark: bool) -> Option<String> {
    let mut light_name = None;
    let mut dark_name = None;
    for part in value.split(',') {
        let part = part.trim();
        if let Some(name) = part.strip_prefix("light:") {
            light_name = Some(name.trim());
        } else if let Some(name) = part.strip_prefix("dark:") {
            dark_name = Some(name.trim());
        }
    }
    let name = match (light_name, dark_name) {
        (None, None) => value.trim(),
        (l, d) => (if dark { d } else { l })?,
    };
    (!name.is_empty()).then(|| name.to_owned())
}

/// The file for a theme: an absolute path as given, or a plain name looked
/// up in the theme directories. A name with a path separator is refused.
fn find_theme(name: &str, env: &ConfigEnv) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() {
        return path.is_file().then(|| path.to_owned());
    }
    if name.contains(['/', '\\']) || name == "." || name == ".." {
        return None;
    }
    env.theme_dirs()
        .into_iter()
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// Read at most `limit` bytes from `reader`. `None` when it holds more:
/// one byte past the limit is read to find that out, and no more.
fn read_bounded(reader: impl Read, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// Open `path` for reading if it is a regular file. Opening does not block
/// on a FIFO or a device, and the check is made on the opened handle, so it
/// is about the file that will be read.
fn open_regular(path: &Path) -> Option<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
        .ok()?;
    file.metadata().ok()?.is_file().then_some(file)
}

fn unquote(value: &str) -> (&str, bool) {
    match value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .filter(|_| value.len() >= 2)
    {
        Some(inner) => (inner, true),
        None => (value, false),
    }
}

fn load_file(
    path: &Path,
    env: &ConfigEnv,
    raw: &mut Raw,
    walk: &mut Walk,
    depth: usize,
    source: Source,
) {
    // Identity first. A file that was already visited is not opened again:
    // this ends include cycles and keeps repeated includes from being
    // re-read. A path that does not resolve is a missing file.
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return;
    };
    if !walk.seen.insert(canonical.clone()) {
        return;
    }
    if walk.files_left == 0 || walk.bytes_left == 0 {
        return;
    }
    let Some(file) = open_regular(&canonical) else {
        return;
    };
    walk.files_left -= 1;
    walk.stats.files_read += 1;
    // The limit is enforced on the handle, whatever the file's size was a
    // moment ago, and never exceeds what is left of the total budget.
    let limit = MAX_FILE_BYTES.min(walk.bytes_left);
    let bytes = read_bounded(file, limit);
    let read = bytes
        .as_ref()
        .map_or(limit.saturating_add(1), |b| b.len() as u64);
    walk.bytes_left = walk.bytes_left.saturating_sub(read);
    walk.stats.bytes_read += read;
    let Some(bytes) = bytes else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut includes: Vec<PathBuf> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, (value, quoted)) = (key.trim(), unquote(value.trim()));
        if key == "config-file" {
            if source == Source::Config
                // Relative to the file as it was named, as Ghostty does, not
                // to where a symlink points.
                && let Some(target) = include_target(path, value, quoted, env)
            {
                includes.push(target);
            }
            continue;
        }
        raw.set(key, value, source);
    }
    // Includes are processed at the end of the file that names them.
    if depth < MAX_INCLUDE_DEPTH {
        for target in includes {
            load_file(&target, env, raw, walk, depth + 1, source);
        }
    }
}

/// Resolve a `config-file` value against the file that contains it. A
/// missing file is ignored whether or not it was marked optional with `?`,
/// because this reader never reports errors.
fn include_target(from: &Path, value: &str, quoted: bool, env: &ConfigEnv) -> Option<PathBuf> {
    let value = if quoted {
        value
    } else {
        value.strip_prefix('?').unwrap_or(value)
    };
    if value.is_empty() {
        return None;
    }
    let path = match (value.strip_prefix("~/"), &env.home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(value),
    };
    Some(if path.is_absolute() {
        path
    } else {
        from.parent()?.join(path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempHome;

    /// A private home with `files` written under it, and an environment
    /// that points only inside it.
    fn fixture(files: &[(&str, &str)]) -> (TempHome, ConfigEnv) {
        let home = TempHome::new();
        for (rel, text) in files {
            let path = home.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let env = ConfigEnv {
            home: Some(home.path().to_owned()),
            xdg_config_home: None,
            macos: false,
            resource_dirs: vec![home.path().join("resources/ghostty")],
        };
        (home, env)
    }

    fn rgb(hex: &str) -> Rgb {
        Rgb::from_hex(hex).unwrap()
    }

    #[test]
    fn no_config_means_nothing_is_set() {
        let (_home, env) = fixture(&[]);
        let look = GhosttyLook::load(&env, true);
        assert!(look.is_empty(), "{look:?}");
        // No home at all is fine too.
        assert!(GhosttyLook::load(&ConfigEnv::default(), true).is_empty());
    }

    #[test]
    fn the_listed_keys_are_read_and_everything_else_is_skipped() {
        let (_home, env) = fixture(&[(
            ".config/ghostty/config",
            r##"
# a comment
font-family = "JetBrainsMono Nerd Font"
font-family = Symbols Nerd Font
font-size = 13.5
background = 1e1e2e
foreground = #cdd6f4
palette = 0=#45475a
palette = 0x1=#f38ba8
palette = 255=fff
cursor-style = bar
window-padding-x = 6
window-padding-y = 4,10
keybind = ctrl+shift+c=copy_to_clipboard
command = /bin/secret-wrapper --token do-not-keep
not a setting line
"##,
        )]);
        let look = GhosttyLook::load(&env, true);
        assert_eq!(
            look.font_families,
            ["JetBrainsMono Nerd Font", "Symbols Nerd Font"]
        );
        assert_eq!(look.font_size_pt, Some(13.5));
        assert_eq!(look.background, Some(rgb("1e1e2e")));
        assert_eq!(look.foreground, Some(rgb("cdd6f4")));
        assert_eq!(
            look.palette,
            BTreeMap::from([(0, rgb("45475a")), (1, rgb("f38ba8")), (255, rgb("ffffff"))])
        );
        assert_eq!(look.cursor_style, Some(CursorShape::Bar));
        assert_eq!(look.padding_x, Some((6., 6.)));
        assert_eq!(look.padding_y, Some((4., 10.)));
        // Nothing of the skipped lines is held anywhere in the result.
        assert!(!format!("{look:?}").contains("do-not-keep"));
    }

    #[test]
    fn malformed_values_are_ignored_and_empty_values_reset() {
        let (_home, env) = fixture(&[(
            ".config/ghostty/config",
            "font-size = 14\nfont-size = huge\nfont-size = 9000\n\
             background = #12345\nforeground = #abcdef\nforeground =\n\
             cursor-style = block\ncursor-style = wobble\n\
             window-padding-x = -3\nwindow-padding-y = 2,x\n\
             palette = 256=#000000\npalette = 3=nope-not-a-colour\n\
             font-family = A\nfont-family = B\nfont-family = \"\"\nfont-family = C\n",
        )]);
        let look = GhosttyLook::load(&env, true);
        assert_eq!(
            look.font_size_pt,
            Some(14.),
            "bad sizes do not replace a good one"
        );
        assert_eq!(look.background, None);
        assert_eq!(look.foreground, None, "an empty value resets");
        assert_eq!(look.cursor_style, Some(CursorShape::Block));
        assert_eq!((look.padding_x, look.padding_y), (None, None));
        assert!(look.palette.is_empty());
        assert_eq!(look.font_families, ["C"], "\"\" clears the list");
    }

    #[test]
    fn later_files_win_and_macos_loads_after_xdg() {
        let files = [
            (
                ".config/ghostty/config.ghostty",
                "font-size = 11\ncursor-style = bar\n",
            ),
            (".config/ghostty/config", "font-size = 12\n"),
            (
                "Library/Application Support/com.mitchellh.ghostty/config",
                "font-size = 15\n",
            ),
        ];
        let (_home, mut env) = fixture(&files);
        let look = GhosttyLook::load(&env, true);
        assert_eq!(look.font_size_pt, Some(12.), "config after config.ghostty");
        assert_eq!(look.cursor_style, Some(CursorShape::Bar));
        env.macos = true;
        assert_eq!(GhosttyLook::load(&env, true).font_size_pt, Some(15.));
    }

    #[test]
    fn xdg_config_home_replaces_the_default_directory() {
        let (home, mut env) = fixture(&[
            (".config/ghostty/config", "font-size = 12\n"),
            ("elsewhere/ghostty/config", "font-size = 18\n"),
        ]);
        env.xdg_config_home = Some(home.path().join("elsewhere"));
        assert_eq!(GhosttyLook::load(&env, true).font_size_pt, Some(18.));
    }

    #[test]
    fn config_file_includes_load_at_the_end_relative_to_their_file() {
        let (home, env) = fixture(&[
            (
                ".config/ghostty/config",
                "config-file = extra/fonts.conf\nfont-size = 12\n\
                 config-file = ?missing.conf\nconfig-file = ~/abs-colors.conf\n\
                 config-file = \"?literal\"\n",
            ),
            // Loaded after the main file ends, so it overrides font-size.
            (
                ".config/ghostty/extra/fonts.conf",
                "font-size = 16\nfont-family = Included Mono\nconfig-file = nested.conf\n",
            ),
            (
                ".config/ghostty/extra/nested.conf",
                "cursor-style = underline\n",
            ),
            ("abs-colors.conf", "background = #000000\n"),
            (".config/ghostty/?literal", "window-padding-x = 9\n"),
        ]);
        let look = GhosttyLook::load(&env, true);
        assert_eq!(look.font_size_pt, Some(16.));
        assert_eq!(look.font_families, ["Included Mono"]);
        assert_eq!(look.cursor_style, Some(CursorShape::Underline), "nested");
        assert_eq!(look.background, Some(rgb("000000")), "~/ expands to home");
        assert_eq!(look.padding_x, Some((9., 9.)), "a quoted ? is literal");
        drop(home);
    }

    #[test]
    fn include_cycles_end() {
        let (_home, env) = fixture(&[
            (
                ".config/ghostty/config",
                "font-size = 12\nconfig-file = a.conf\n",
            ),
            (
                ".config/ghostty/a.conf",
                "font-size = 13\nconfig-file = b.conf\n",
            ),
            (
                ".config/ghostty/b.conf",
                "font-size = 14\nconfig-file = a.conf\nconfig-file = config\n",
            ),
        ]);
        assert_eq!(GhosttyLook::load(&env, true).font_size_pt, Some(14.));
    }

    #[test]
    fn a_theme_is_the_base_and_the_users_settings_override_it() {
        let (_home, env) = fixture(&[
            (
                ".config/ghostty/config",
                "theme = My Theme\nforeground = #ffffff\npalette = 1=#ff0000\n\
                 cursor-color = #123456\nselection-background = #abcdef\nselection-foreground =\n",
            ),
            (
                ".config/ghostty/themes/My Theme",
                "background = #101010\nforeground = #c0c0c0\npalette = 1=#aa0000\n\
                 palette = 2=#00aa00\ncursor-style = underline\ncursor-color = #aa4400\n\
                 cursor-text = #eeddcc\nselection-background = #111111\nselection-foreground = #cccccc\n\
                 theme = Other\nconfig-file = ../config-evil\n",
            ),
            (".config/ghostty/config-evil", "font-size = 99\n"),
        ]);
        let look = GhosttyLook::load(&env, true);
        assert_eq!(look.background, Some(rgb("101010")), "from the theme");
        assert_eq!(look.foreground, Some(rgb("ffffff")), "the user's wins");
        assert_eq!(look.palette[&1], rgb("ff0000"), "the user's wins");
        assert_eq!(look.palette[&2], rgb("00aa00"), "from the theme");
        assert_eq!(look.cursor_color, Some(rgb("123456")));
        assert_eq!(look.cursor_text, Some(rgb("eeddcc")));
        assert_eq!(look.selection_background, Some(rgb("abcdef")));
        assert_eq!(look.selection_foreground, None);
        assert_eq!(look.cursor_style, Some(CursorShape::Underline));
        assert_eq!(look.font_size_pt, None, "a theme cannot include files");
    }

    #[test]
    fn themes_resolve_by_appearance_from_user_then_bundled_directories() {
        let (home, env) = fixture(&[
            (".config/ghostty/config", "theme = dark:Night,light:Day\n"),
            ("resources/ghostty/themes/Night", "background = #000011\n"),
            ("resources/ghostty/themes/Day", "background = #ffffee\n"),
            // The user's themes directory is searched first.
            (".config/ghostty/themes/Day", "background = #fafafa\n"),
        ]);
        assert_eq!(
            GhosttyLook::load(&env, true).background,
            Some(rgb("000011"))
        );
        assert_eq!(
            GhosttyLook::load(&env, false).background,
            Some(rgb("fafafa"))
        );

        // An absolute path is used as given.
        let theme = home.path().join("abs-theme");
        std::fs::write(&theme, "background = #123456\n").unwrap();
        std::fs::write(
            home.path().join(".config/ghostty/config"),
            format!("theme = {}\n", theme.display()),
        )
        .unwrap();
        assert_eq!(
            GhosttyLook::load(&env, true).background,
            Some(rgb("123456"))
        );

        // A missing theme, a one-sided pair and a name with a path in it
        // all leave the look unset instead of failing.
        for value in [
            "No Such Theme",
            "light:Day",
            "../../abs-theme",
            "themes/Night",
        ] {
            std::fs::write(
                home.path().join(".config/ghostty/config"),
                format!("theme = {value}\n"),
            )
            .unwrap();
            assert_eq!(GhosttyLook::load(&env, true).background, None, "{value}");
        }
    }

    #[test]
    fn an_oversized_or_non_text_file_is_skipped() {
        let (home, env) = fixture(&[(".config/ghostty/config", "font-size = 12\n")]);
        let path = home.path().join(".config/ghostty/config");
        // Exactly at the limit is read; one byte more is not.
        let mut big = b"font-size = 12\n".to_vec();
        big.resize(MAX_FILE_BYTES as usize, b'#');
        std::fs::write(&path, &big).unwrap();
        let (look, stats) = GhosttyLook::load_counted(&env, true);
        assert_eq!(look.font_size_pt, Some(12.));
        assert_eq!(stats.bytes_read, MAX_FILE_BYTES);
        big.push(b'#');
        std::fs::write(&path, &big).unwrap();
        let (look, stats) = GhosttyLook::load_counted(&env, true);
        assert!(look.is_empty());
        assert_eq!(
            stats.bytes_read,
            MAX_FILE_BYTES + 1,
            "one byte past the limit, and no more"
        );
        // Invalid UTF-8 on one line does not stop the others.
        std::fs::write(&path, b"background = \xff\xfe\nfont-size = 12\n").unwrap();
        assert_eq!(GhosttyLook::load(&env, true).font_size_pt, Some(12.));
        // A directory where the file should be.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(GhosttyLook::load(&env, true).is_empty());
    }

    /// A reader that never ends, counting what is taken from it.
    struct Endless(u64);

    impl Read for Endless {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            buf.fill(b'#');
            self.0 += buf.len() as u64;
            Ok(buf.len())
        }
    }

    #[test]
    fn the_limit_is_enforced_on_the_open_handle_not_on_a_size_seen_earlier() {
        // What a file that grows, or is swapped for a huge one, after any
        // size check looks like to the reader: more bytes than expected,
        // without end. The bound is on what is read.
        let mut endless = Endless(0);
        assert_eq!(read_bounded(&mut endless, 1024), None);
        assert_eq!(
            endless.0, 1025,
            "limit + 1 bytes were taken, then it stopped"
        );
        assert_eq!(read_bounded(&b"abc"[..], 3), Some(b"abc".to_vec()));
        assert_eq!(read_bounded(&b"abcd"[..], 3), None);
        assert_eq!(read_bounded(&b""[..], 0), Some(Vec::new()));
    }

    #[test]
    fn a_fifo_in_place_of_the_config_is_not_read_and_does_not_block() {
        let (home, env) = fixture(&[]);
        let dir = home.path().join(".config/ghostty");
        std::fs::create_dir_all(&dir).unwrap();
        let fifo = std::ffi::CString::new(dir.join("config").to_str().unwrap()).unwrap();
        // SAFETY: a valid path; the FIFO is created in the test's own directory.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        // Nobody writes to it. A blocking open or read would hang here.
        let (look, stats) = GhosttyLook::load_counted(&env, true);
        assert!(look.is_empty());
        assert_eq!(stats, LoadStats::default(), "not a regular file: not read");
    }

    #[test]
    fn duplicate_and_fanned_out_includes_are_each_read_once() {
        // Every level includes the next one three times and the one before
        // it once. Read naively that is 3^6 reads of the last file.
        let levels = 7;
        let mut files: Vec<(String, String)> = Vec::new();
        for i in 0..levels {
            let mut text = format!("palette = {i}=#0000{i:02x}\n");
            if i + 1 < levels {
                for _ in 0..3 {
                    text.push_str(&format!("config-file = level{}.conf\n", i + 1));
                }
            }
            if i > 0 {
                text.push_str(&format!("config-file = level{}.conf\n", i - 1));
            }
            // The same file under another spelling of its path.
            text.push_str(&format!("config-file = ./level{i}.conf\n"));
            files.push((format!(".config/ghostty/level{i}.conf"), text));
        }
        files.push((
            ".config/ghostty/config".into(),
            "config-file = level0.conf\nconfig-file = level0.conf\nconfig-file = ../ghostty/level0.conf\n"
                .into(),
        ));
        let borrowed: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_home, env) = fixture(&borrowed);
        let (look, stats) = GhosttyLook::load_counted(&env, true);
        assert_eq!(look.palette.len(), levels, "every level was reached");
        assert_eq!(
            stats.files_read,
            levels + 1,
            "the config and each level, once each"
        );
        let total: u64 = files.iter().map(|(_, text)| text.len() as u64).sum();
        assert_eq!(stats.bytes_read, total, "no byte was read twice");
    }

    #[test]
    fn one_load_has_a_total_budget_in_bytes_and_in_files() {
        // Bytes: six includes of 900 KiB each are 5.3 MiB; the budget is 4.
        let mut files: Vec<(String, String)> = Vec::new();
        let mut main = String::new();
        for i in 0..6 {
            let mut text = format!("palette = {i}=#0000{i:02x}\n");
            while text.len() < 900 * 1024 {
                text.push_str("# padding padding padding padding padding padding padding\n");
            }
            files.push((format!(".config/ghostty/big{i}.conf"), text));
            main.push_str(&format!("config-file = big{i}.conf\n"));
        }
        files.push((".config/ghostty/config".into(), main));
        let borrowed: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_home, env) = fixture(&borrowed);
        let (look, stats) = GhosttyLook::load_counted(&env, true);
        assert_eq!(
            look.palette.keys().copied().collect::<Vec<_>>(),
            [0, 1, 2, 3],
            "the fifth file does not fit in what is left and is not used"
        );
        assert!(
            stats.bytes_read <= MAX_TOTAL_BYTES + 1,
            "read {} bytes",
            stats.bytes_read
        );
        // The budget is spent: the sixth file is not even opened.
        assert_eq!(
            stats.files_read, 6,
            "config, four that fit, one that did not"
        );

        // Files: a hundred tiny includes; only the budgeted number is opened.
        let mut files: Vec<(String, String)> = Vec::new();
        let mut main = String::new();
        for i in 0..100 {
            files.push((
                format!(".config/ghostty/tiny{i}.conf"),
                format!("palette = {i}=#0000{i:02x}\n"),
            ));
            main.push_str(&format!("config-file = tiny{i}.conf\n"));
        }
        files.push((".config/ghostty/config".into(), main));
        let borrowed: Vec<(&str, &str)> = files
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let (_home, env) = fixture(&borrowed);
        let (look, stats) = GhosttyLook::load_counted(&env, true);
        assert_eq!(stats.files_read, MAX_FILES);
        assert_eq!(
            look.palette.len(),
            MAX_FILES - 1,
            "the config counts as one"
        );
    }

    #[test]
    fn an_empty_palette_value_resets_the_palette() {
        // After earlier assignments in the user's own files.
        let (_home, env) = fixture(&[(
            ".config/ghostty/config",
            "palette = 1=#110000\npalette = 2=#220000\npalette =\npalette = 3=#330000\n",
        )]);
        assert_eq!(
            GhosttyLook::load(&env, true).palette,
            BTreeMap::from([(3, rgb("330000"))]),
            "entries before the reset are gone, entries after it stay"
        );
        // After a theme's entries.
        let theme = (
            ".config/ghostty/themes/T",
            "palette = 1=#aa0000\npalette = 2=#bb0000\nbackground = #101010\n",
        );
        let (_home, env) = fixture(&[(".config/ghostty/config", "theme = T\npalette =\n"), theme]);
        let look = GhosttyLook::load(&env, true);
        assert!(look.palette.is_empty(), "the theme's palette is dropped");
        assert_eq!(
            look.background,
            Some(rgb("101010")),
            "the rest of the theme stays"
        );
        let (_home, env) = fixture(&[
            (
                ".config/ghostty/config",
                "theme = T\npalette = \"\"\npalette = 5=#550000\n",
            ),
            theme,
        ]);
        assert_eq!(
            GhosttyLook::load(&env, true).palette,
            BTreeMap::from([(5, rgb("550000"))])
        );
        // Without a reset the theme's entries remain under the user's.
        let (_home, env) = fixture(&[
            (".config/ghostty/config", "theme = T\npalette = 5=#550000\n"),
            theme,
        ]);
        assert_eq!(
            GhosttyLook::load(&env, true)
                .palette
                .keys()
                .copied()
                .collect::<Vec<_>>(),
            [1, 2, 5]
        );
        // A reset inside the theme only clears what the theme set before it.
        let (_home, env) = fixture(&[
            (".config/ghostty/config", "theme = T2\n"),
            (
                ".config/ghostty/themes/T2",
                "palette = 1=#aa0000\npalette =\npalette = 2=#bb0000\n",
            ),
        ]);
        assert_eq!(
            GhosttyLook::load(&env, true).palette,
            BTreeMap::from([(2, rgb("bb0000"))])
        );
    }
}
