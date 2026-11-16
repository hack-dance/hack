//! Design v1 for the Hack desktop app (HACK-2252): tokens, icons and small
//! presentational components, and the main window composed from them.
//!
//! The spec is `apps/desktop/DESIGN-V1.md`. This crate draws; it runs no
//! command and holds no state beyond what the caller passes in. The
//! `hack-desktop-gallery` binary renders every fixture with it.

pub mod components;
pub mod icons;
pub mod panel;
pub mod status;
pub mod tokens;
pub mod window;
