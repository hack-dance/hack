//! WU04: private local operation journal and bounded fixture supervisors.
mod journal;
mod ownership;
mod supervisor;
mod transport;

pub use journal::{Mutation, Receipt, Request, Store};
pub use ownership::ProcessIdentity;
pub use supervisor::{fixture, supervise};
pub use transport::{call, serve};

use crate::{Candidate, CandidateError};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(crate) type Result<T> = std::result::Result<T, CandidateError>;
pub(crate) fn error(message: impl ToString) -> CandidateError {
    CandidateError::new("node_error", message.to_string())
}
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("node")
}

pub(crate) fn private_directory(path: &Path, create: bool) -> Result<()> {
    crate::reject_aliased_state(path)?;
    if create {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(error)?;
    }
    let m = path.symlink_metadata().map_err(error)?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
        return Err(error(
            "Node directory must be owned by this UID with mode 0700.",
        ));
    }
    Ok(())
}

pub(crate) fn private_file(path: &Path, create: bool) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(error)?;
    let m = file.metadata().map_err(error)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err(error(
            "Node files must be private, singly linked regular files.",
        ));
    }
    Ok(file)
}

pub(crate) fn try_lock(path: &Path) -> Result<Option<File>> {
    let file = private_file(path, true)?;
    // SAFETY: valid owned file descriptor; lock is released when File drops.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let e = std::io::Error::last_os_error();
    if e.kind() == std::io::ErrorKind::WouldBlock {
        Ok(None)
    } else {
        Err(error(e))
    }
}
