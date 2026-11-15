//! Terminal surface for the Hack desktop app (unsupported preview).
//!
//! - [`pty`]: an app-owned PTY whose child leads its own session; dropping it
//!   ends the session (process group and job groups).
//! - [`stream`]: read-only byte sources (a file, or a process in its own
//!   process group) for log views.
//! - [`emulator`] (feature `ghostty`): libghostty-vt terminal state with
//!   scrollback, follow, search, selection and copy, exposed as plain frames.
//! - [`view`] (feature `ghostty`): the GPUI element and view that paint a
//!   frame and route input, for either a stream or a PTY.
//!
//! The crate never logs terminal contents, never types secrets and never
//! puts values in argv beyond the program and arguments its caller passes.
//! What a process prints is shown as printed. See `DECISION.md`.

#![cfg(unix)]

#[cfg(feature = "ghostty")]
pub mod emulator;
pub mod pty;
pub mod session;
pub mod stream;
#[cfg(feature = "ghostty")]
pub mod view;
