//! Process creation boundary. Apple children close all unlisted descriptors,
//! including descriptors another thread has not yet marked close-on-exec.

#[cfg(not(target_os = "macos"))]
pub(crate) use std::process::Child;

#[cfg(not(target_os = "macos"))]
pub(crate) fn spawn(command: &mut std::process::Command) -> std::io::Result<Child> {
    command.spawn()
}

#[cfg(target_os = "macos")]
mod apple;
#[cfg(target_os = "macos")]
pub(crate) use apple::{Child, spawn};
