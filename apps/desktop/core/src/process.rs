//! Process creation boundary. Apple children close all unlisted descriptors,
//! including descriptors another thread has not yet marked close-on-exec.

#[cfg(not(target_os = "macos"))]
pub(crate) use std::process::Child;

/// Spawn `command`. `inherit_env` must be false exactly when the caller
/// applied `env_clear` (`Command` has no accessor for that flag, and the
/// Apple boundary builds the child environment itself); `stdin: true` makes
/// stdin a pipe the caller writes, else it is empty. Here the `Command`
/// already carries both (`CliRunner` sets them).
#[cfg(not(target_os = "macos"))]
pub(crate) fn spawn_with(
    command: &mut std::process::Command,
    inherit_env: bool,
    stdin: bool,
) -> std::io::Result<Child> {
    let _ = (inherit_env, stdin); // std carries both on this platform.
    command.spawn()
}

#[cfg(target_os = "macos")]
mod apple;
#[cfg(target_os = "macos")]
pub(crate) use apple::{Child, spawn_with};
