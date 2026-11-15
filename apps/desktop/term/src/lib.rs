//! Terminal surface for the Hack desktop app (unsupported preview).
//!
//! - [`pty`]: an app-owned PTY whose child leads its own session; dropping it
//!   ends the session (process group and job groups). Input and output go
//!   through bounded queues on worker threads, so the caller never blocks.
//! - [`session`]: session ownership, verified signalling and teardown.
//! - [`stream`]: read-only byte sources (a file, or a process in its own
//!   session) for log views, through a bounded queue.
//! - [`emulator`] (feature `ghostty`): libghostty-vt terminal state with
//!   scrollback, follow, search, selection and copy, exposed as plain frames.
//! - [`terminal`] (feature `ghostty`): an emulator joined to a stream or a
//!   PTY, with no GUI dependency in its logic.
//! - [`view`] (feature `ghostty`): the GPUI element and view that paint a
//!   frame and route input.
//! - [`launch`]: what a tab is (logs, container shell, host shell, host
//!   shell with env), its label and badge, and the command each kind runs.
//! - [`ghostty_config`]: the user's Ghostty font, colours, cursor and
//!   padding, read from their config.
//! - [`panel`] and [`actions`] (feature `ghostty`): the tabbed panel and
//!   its keyboard actions.
//! - [`sprite`]: box-drawing, block and powerline glyphs as cell-exact
//!   geometry; [`glyphs`] (feature `ghostty`): the bundled symbols font
//!   used when the terminal's font has no glyph for a Nerd Font symbol.
//!
//! The crate never logs terminal contents, never types secrets and never
//! puts values in argv beyond the program and arguments its caller passes.
//! What a process prints is shown as printed. See `DECISION.md`.

#![cfg(unix)]

#[cfg(feature = "ghostty")]
pub mod actions;
pub mod color;
#[cfg(feature = "ghostty")]
pub mod emulator;
mod fdio;
pub mod ghostty_config;
#[cfg(feature = "ghostty")]
pub mod glyphs;
pub mod launch;
#[cfg(feature = "ghostty")]
pub mod panel;
pub mod pty;
mod queue;
pub mod session;
pub mod sprite;
pub mod stream;
#[cfg(feature = "ghostty")]
pub mod terminal;
#[cfg(test)]
mod testutil;
#[cfg(feature = "ghostty")]
pub mod view;
