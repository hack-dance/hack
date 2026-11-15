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
    /// Daemon recovery.
    Power,
    /// Loading.
    Loader,
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
            Self::Power => "icons/power.svg",
            Self::Loader => "icons/loader-circle.svg",
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
        Power,
        LoaderCircle,
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
            Glyph::Power,
            Glyph::Loader,
        ] {
            assert!(
                Assets.load(g.path()).unwrap().is_some(),
                "{} is not embedded",
                g.path()
            );
        }
    }
}
