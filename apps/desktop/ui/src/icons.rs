//! The app's icon set: Lucide icons bundled by gpui-kit-assets (ISC licence,
//! shipped inside the pinned crate). Only the icons listed here are embedded.

use std::borrow::Cow;

use gpui_kit::assets::icon_assets;
use gpui_kit::{AssetSource, SharedString};

/// Every icon the window uses, and where (see DESIGN-V1.md, "Icons").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Glyph {
    /// Title bar search field.
    Search,
    /// Sidebar: always-on project.
    Pin,
    /// Sidebar: Routing and DNS.
    Globe,
    /// Sidebar: Doctor.
    Stethoscope,
    /// Header: Open in browser.
    ExternalLink,
    /// Header: Restart.
    Restart,
    /// Header: Stop.
    Stop,
    /// Header: Start.
    Play,
    /// Service row / header: Exec shell (terminal surface, later).
    Terminal,
    /// Banners.
    Alert,
    /// Empty state: no projects.
    Folder,
    /// Error / CLI missing.
    CircleAlert,
    WifiOff,
    Minus,
    /// Daemon recovery.
    Power,
    /// Loading.
    Loader,
    /// Terminal panel: Logs tab.
    Logs,
    /// Terminal panel: shell in a container.
    Container,
    /// Terminal panel: host shell.
    HostShell,
    /// Terminal panel: close tab.
    Close,
    /// Terminal panel: new tab.
    Plus,
    /// Terminal panel: new-tab menu caret.
    ChevronDown,
    /// Terminal panel: maximize / restore.
    Maximize,
    Restore,
    /// Terminal panel: expand from collapsed.
    ChevronUp,
    /// Machine: Upgrade.
    Upgrade,
    /// Sidebar and header: a branch instance.
    Branch,
    /// Header: copy the URL.
    /// Env tab: reveal and hide a secret value.
    Eye,
    EyeOff,
    /// Env tab: the secret key line.
    Key,
    /// Env tab: edit a value.
    Pencil,
    Copy,
    Lock,
    More,
    /// Header: copied.
    Check,
    SetupDone,
    SetupIdle,
    SetupBlocked,
    SetupUnchecked,
    SetupFailed,
    SetupSkipped,
    Clock,
    ChevronRight,
    Link,
    Pause,
    Filter,
    Wrap,
    Braces,
    ListFilter,
    Layers,
    /// Service file browser.
    Directory,
    FileText,
    Server,
    Ellipsis,
    Info,
}

impl Glyph {
    #[must_use]
    pub fn path(self) -> &'static str {
        match self {
            Self::Search => "icons/search.svg",
            Self::Pin => "icons/pin.svg",
            Self::Globe => "icons/globe.svg",
            Self::Stethoscope => "icons/stethoscope.svg",
            Self::ExternalLink => "icons/external-link.svg",
            Self::Restart => "icons/rotate-cw.svg",
            Self::Stop => "icons/square.svg",
            Self::Play => "icons/play.svg",
            Self::Terminal => "icons/square-terminal.svg",
            Self::Alert => "icons/triangle-alert.svg",
            Self::Folder => "icons/folder-plus.svg",
            Self::CircleAlert => "icons/circle-alert.svg",
            Self::WifiOff => "icons/wifi-off.svg",
            Self::Minus => "icons/minus.svg",
            Self::Power => "icons/power.svg",
            Self::Loader => "icons/loader-circle.svg",
            Self::Logs => "icons/list.svg",
            Self::Container => "icons/box.svg",
            Self::HostShell => "icons/terminal.svg",
            Self::Close => "icons/x.svg",
            Self::Plus => "icons/plus.svg",
            Self::ChevronDown => "icons/chevron-down.svg",
            Self::Maximize => "icons/maximize-2.svg",
            Self::Restore => "icons/minimize-2.svg",
            Self::ChevronUp => "icons/chevron-up.svg",
            Self::Upgrade => "icons/circle-arrow-up.svg",
            Self::Branch => "icons/git-branch.svg",
            Self::Copy => "icons/copy.svg",
            Self::Lock => "icons/lock-keyhole.svg",
            Self::More => "icons/ellipsis.svg",
            Self::Check => "icons/check.svg",
            Self::Link => "icons/link.svg",
            Self::Pause => "icons/pause.svg",
            Self::Filter => "icons/list-filter.svg",
            Self::Wrap => "icons/text-wrap.svg",
            Self::Braces => "icons/braces.svg",
            Self::ListFilter => "icons/rows-2.svg",
            Self::Layers => "icons/layers.svg",
            Self::Eye => "icons/eye.svg",
            Self::EyeOff => "icons/eye-off.svg",
            Self::Key => "icons/key-round.svg",
            Self::Pencil => "icons/pencil.svg",
            Self::SetupDone => "icons/circle-check.svg",
            Self::SetupIdle => "icons/circle.svg",
            Self::SetupBlocked => "icons/lock-keyhole.svg",
            Self::SetupUnchecked => "icons/circle-question-mark.svg",
            Self::SetupFailed => "icons/circle-x.svg",
            Self::SetupSkipped => "icons/skip-forward.svg",
            Self::Clock => "icons/clock.svg",
            Self::ChevronRight => "icons/chevron-right.svg",
            Self::Directory => "icons/folder.svg",
            Self::FileText => "icons/file-text.svg",
            Self::Server => "icons/server.svg",
            Self::Ellipsis => "icons/ellipsis.svg",
            Self::Info => "icons/info.svg",
        }
    }
}

icon_assets!(
    AppIcons,
    [
        Search,
        Pin,
        Globe,
        Stethoscope,
        ExternalLink,
        RotateCw,
        Square,
        Play,
        SquareTerminal,
        TriangleAlert,
        FolderPlus,
        CircleAlert,
        WifiOff,
        Minus,
        Power,
        LoaderCircle,
        List,
        Box,
        Terminal,
        X,
        Plus,
        ChevronDown,
        Maximize2,
        Minimize2,
        ChevronUp,
        CircleArrowUp,
        GitBranch,
        Copy,
        LockKeyhole,
        Ellipsis,
        Check,
        Link,
        Pause,
        TextWrap,
        Braces,
        ListFilter,
        Rows2,
        Layers,
        Eye,
        EyeOff,
        KeyRound,
        Pencil,
        CircleCheck,
        Circle,
        CircleQuestionMark,
        CircleX,
        SkipForward,
        Clock,
        ChevronRight,
        Folder,
        FileText,
        Server,
        Info,
    ]
);

/// The app's icons first, then gpui-kit's default component bundle (for the
/// icons gpui-kit components draw themselves, such as the switch).
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = AppIcons.load(path)? {
            return Ok(Some(bytes));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        let mut all = AppIcons.list(path)?;
        all.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_glyph_is_embedded() {
        for g in [
            Glyph::Search,
            Glyph::Pin,
            Glyph::Globe,
            Glyph::Stethoscope,
            Glyph::ExternalLink,
            Glyph::Restart,
            Glyph::Stop,
            Glyph::Play,
            Glyph::Terminal,
            Glyph::Alert,
            Glyph::Folder,
            Glyph::CircleAlert,
            Glyph::Info,
            Glyph::WifiOff,
            Glyph::Minus,
            Glyph::Power,
            Glyph::Loader,
            Glyph::Logs,
            Glyph::Container,
            Glyph::HostShell,
            Glyph::Close,
            Glyph::Plus,
            Glyph::ChevronDown,
            Glyph::Maximize,
            Glyph::Restore,
            Glyph::ChevronUp,
            Glyph::Upgrade,
            Glyph::Branch,
            Glyph::Copy,
            Glyph::Lock,
            Glyph::More,
            Glyph::Check,
            Glyph::Eye,
            Glyph::EyeOff,
            Glyph::Key,
            Glyph::Pencil,
            Glyph::SetupDone,
            Glyph::SetupIdle,
            Glyph::SetupBlocked,
            Glyph::SetupUnchecked,
            Glyph::SetupFailed,
            Glyph::SetupSkipped,
            Glyph::Clock,
            Glyph::ChevronRight,
        ] {
            assert!(
                Assets.load(g.path()).unwrap().is_some(),
                "{} is not embedded",
                g.path()
            );
        }
    }
}
