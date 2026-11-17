//! Process creation boundary. Apple children close all unlisted descriptors,
//! including descriptors another thread has not yet marked close-on-exec.

#[cfg(not(target_os = "macos"))]
pub(crate) use std::process::Child;

/// Spawn `command`, with stdin a pipe the caller writes (`stdin: true`), else
/// empty.
/// Here the `Command` already says so (`CliRunner` sets it); the macOS
/// boundary cannot read that setting, so the flag is explicit.
#[cfg(not(target_os = "macos"))]
pub(crate) fn spawn_with(
    command: &mut std::process::Command,
    _stdin: bool,
) -> std::io::Result<Child> {
    command.spawn()
}

#[cfg(target_os = "macos")]
mod apple;
#[cfg(target_os = "macos")]
pub(crate) use apple::{Child, spawn_with};
