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
    checked_private_file(open_private_file(path, create).map_err(error)?)
}

/// Validates a file that exists at open time; a path absent at open time is `None`.
///
/// SQLite deletes its rollback journal at each commit, so a live writer may remove
/// it between any existence check and this open. Absence is decided by the open
/// itself, never by an earlier `stat`. `O_NOFOLLOW` still refuses a symlink, dangling
/// or not, with an error rather than `None`.
pub(crate) fn existing_private_file(path: &Path) -> Result<Option<File>> {
    match open_private_file(path, false) {
        Ok(file) => checked_private_file(file).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
    }
}

fn open_private_file(path: &Path, create: bool) -> std::io::Result<File> {
    #[cfg(test)]
    test_support::before_open(path);
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn checked_private_file(file: File) -> Result<File> {
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

#[cfg(test)]
pub(crate) mod test_support {
    use super::{Receipt, Store};
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    type Hook = (PathBuf, Box<dyn FnOnce(&Path)>);
    thread_local! {
        static BEFORE_OPEN: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    /// Runs this thread's one-shot hook when the node opens `path`, just before the
    /// `open` system call: the instant another writer (SQLite committing) can act.
    pub(crate) fn before_open(path: &Path) {
        let hook = BEFORE_OPEN.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.as_ref().is_some_and(|(target, _)| target == path) {
                slot.take()
            } else {
                None
            }
        });
        if let Some((target, hook)) = hook {
            hook(&target);
        }
    }

    /// Arms a one-shot hook for `path` on this thread; dropping it disarms the hook.
    pub(crate) struct BeforeOpen;
    impl BeforeOpen {
        pub(crate) fn arm(path: &Path, hook: impl FnOnce(&Path) + 'static) -> Self {
            BEFORE_OPEN.with(|cell| cell.replace(Some((path.to_owned(), Box::new(hook)))));
            Self
        }
        pub(crate) fn fired(&self) -> bool {
            BEFORE_OPEN.with(|cell| cell.borrow().is_none())
        }
    }
    impl Drop for BeforeOpen {
        fn drop(&mut self) {
            BEFORE_OPEN.with(|cell| cell.replace(None));
        }
    }

    /// Writes one non-terminal job receipt directly, bypassing admission, so supervisor
    /// and recovery tests can start from an exact journal state.
    pub(crate) fn job(store: &Store, id: &str, state: &str, timeout_ms: u64) -> Receipt {
        let receipt = Receipt {
            job_id: id.into(),
            fixture: "tree".into(),
            source: None,
            state: state.into(),
            accepted_at_ms: super::now(),
            queue_deadline_ms: super::now() + 60_000,
            execution_timeout_ms: timeout_ms,
            starts: 0,
            supervisor_pid: None,
            child_pid: None,
            supervisor_identity: None,
            child_identity: None,
            cancel_requested: false,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            exit_code: None,
            signal: None,
            detail: None,
        };
        store
            .connection
            .execute(
                "INSERT INTO jobs VALUES (?,?)",
                rusqlite::params![id, serde_json::to_string(&receipt).unwrap()],
            )
            .unwrap();
        receipt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_private_file_treats_only_absence_at_open_as_absent() {
        let root = crate::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hkl-node-private",
        );
        let journal = root.join("journal.sqlite-journal");
        // A rollback journal that SQLite already deleted is simply absent.
        assert!(existing_private_file(&journal).unwrap().is_none());
        std::fs::write(&journal, b"").unwrap();
        std::fs::set_permissions(
            &journal,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        assert!(existing_private_file(&journal).unwrap().is_some());
        std::fs::set_permissions(
            &journal,
            std::os::unix::fs::PermissionsExt::from_mode(0o644),
        )
        .unwrap();
        assert!(existing_private_file(&journal).is_err());
        std::fs::remove_file(&journal).unwrap();
        // Aliases still refuse, including a dangling symlink whose target is absent.
        std::os::unix::fs::symlink(root.join("missing"), &journal).unwrap();
        assert!(existing_private_file(&journal).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
