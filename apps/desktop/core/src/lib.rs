//! Hack desktop app core: no GUI dependency.
//!
//! - [`models`]: typed views of `hack ... --json` and `hackd` payloads.
//! - [`runner`]: runs the CLI as the user with timeouts.
//! - [`daemon`]: read-only `hackd` socket client.
//! - [`state`]: project display state and actions.
//! - [`viewmodel`]: list and detail state machines.
//! - [`source`]: live and fixture data sources; [`fixtures`]: canned states.
//!
//! The app keeps no state of its own beyond window layout and holds no
//! credentials; every action is one CLI command.

pub mod daemon;
pub mod fixtures;
pub mod models;
pub mod runner;
pub mod source;
pub mod state;
pub mod viewmodel;

pub mod daemon_state;
