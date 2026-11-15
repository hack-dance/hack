//! Process creation boundary. Apple children close all unlisted descriptors,
//! including descriptors another thread has not yet marked close-on-exec.

#[cfg(not(target_os = "macos"))]
pub(crate) use std::process::Child;

/// `inherit_env` must be false exactly when the caller applied `env_clear`:
/// `Command` has no accessor for that flag, and the Apple boundary builds the
/// child environment itself.
#[cfg(not(target_os = "macos"))]
pub(crate) fn spawn(
    command: &mut std::process::Command,
    inherit_env: bool,
) -> std::io::Result<Child> {
    let _ = inherit_env; // std carries env_clear on this platform.
    command.spawn()
}

#[cfg(target_os = "macos")]
mod apple;
#[cfg(target_os = "macos")]
pub(crate) use apple::{Child, spawn};
