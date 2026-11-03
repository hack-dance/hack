//! Test-only supervisor pause points for the real-process kill harness.
//!
//! This module exists only with the `node-kill-harness` Cargo feature, and an
//! optimized build refuses that feature (see `node/mod.rs`). Release scripts name
//! their features explicitly and never enable it, and CI checks that the built
//! release candidate carries none of the [`MARKER`] strings below.
//!
//! A test arms a point by creating `<root>/node-kill-harness-<point>.arm`. The first
//! supervisor to reach that point removes the arm file, publishes its PID and job ID
//! in `<root>/node-kill-harness-<point>.reached`, and blocks so the test can send
//! SIGKILL inside the window. With no arm file a point is a single failed unlink.
//! A pause that is never killed fails closed after [`PAUSE_LIMIT`]: the supervisor
//! returns an error and the job is quarantined, never resumed or replayed.
use super::{Result, error};
use std::path::Path;
use std::time::{Duration, Instant};

/// Prefix of every harness file name. CI asserts release binaries do not contain it.
pub const MARKER: &str = "node-kill-harness-";
const PAUSE_LIMIT: Duration = Duration::from_secs(30);

/// A window in which a supervisor holds state that is not yet in the journal.
#[derive(Clone, Copy, Debug)]
pub enum Point {
    /// The claim (`preparing` -> `running`) is committed; nothing is spawned yet.
    ClaimSpawn,
    /// The child is reaped (`finishing`); its exit status is not yet persisted.
    ExitPersist,
}

impl Point {
    pub fn name(self) -> &'static str {
        match self {
            Self::ClaimSpawn => "claim-spawn",
            Self::ExitPersist => "exit-persist",
        }
    }
    pub fn arm_file(self, root: &Path) -> std::path::PathBuf {
        root.join(format!("{MARKER}{}.arm", self.name()))
    }
    pub fn reached_file(self, root: &Path) -> std::path::PathBuf {
        root.join(format!("{MARKER}{}.reached", self.name()))
    }
}

pub(crate) fn pause(root: &Path, id: &str, point: Point) -> Result<()> {
    // Removing the arm file is the one-shot claim on this pause.
    match std::fs::remove_file(point.arm_file(root)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(error(e)),
    }
    let staged = root.join(format!("{MARKER}{}.staged", point.name()));
    std::fs::write(&staged, format!("{} {id}", std::process::id())).map_err(error)?;
    // Publish atomically so the driver never reads a partial PID.
    std::fs::rename(&staged, point.reached_file(root)).map_err(error)?;
    let deadline = Instant::now() + PAUSE_LIMIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(error(format!(
        "Kill harness pause {} expired without SIGKILL.",
        point.name()
    )))
}
