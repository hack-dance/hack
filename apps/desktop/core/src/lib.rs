//! Hack desktop app core: no GUI dependency.
//!
//! - [`models`]: typed views of `hack ... --json` and `hackd` payloads.
//! - [`runner`]: runs the CLI as the user with timeouts.
//! - [`daemon`]: read-only `hackd` socket client.
//! - [`state`]: project display state and actions.
//! - [`viewmodel`]: list and detail state machines; [`logs`]: the Logs tab.
//! - [`source`]: live and fixture data sources; [`fixtures`]: canned states.
//! - [`stats`]: in-memory service usage history.
//!
//! The app holds no credentials. It saves window preferences and keeps stats
//! history for the current session. Every action is one CLI command.

pub mod cli_choice;
pub mod config;
pub mod daemon;
pub mod doctor;
mod doctor_acl;
mod doctor_plugins;
mod doctor_tools;
pub mod files;
pub mod fixtures;
pub mod git_changes;
pub mod logs;
pub mod machine;
pub mod machine_gate;
pub mod models;
mod process;
pub mod resources;
pub mod runner;
pub mod service_catalog;
pub mod setup;
pub mod setup_fixtures;
pub mod setup_io;
mod setup_login;
pub mod source;
pub mod state;
pub mod stats;
pub mod upgrade;
pub mod usage;
pub mod viewmodel;

pub mod env;
pub mod execution;
pub mod terminal;

#[cfg(test)]
mod test_support;
