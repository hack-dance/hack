//! Serialize publication effects with explicit pool-wide quiescence recovery.
//! Publishers release this gate after binding; their ordinary run lock remains held.
//! Recovery retains it before taking run locks and the provider engine lease.
use crate::{Candidate, CandidateError, provider::state};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf};

pub(crate) struct Guard {
    root: PathBuf,
    directory: (u64, u64),
    lock: state::Lock,
}

impl Guard {
    /// Selection/recovery observes an existing publication gate without creating authority.
    #[cfg(all(target_os = "macos", feature = "native-config-plan"))]
    pub(crate) fn acquire_existing(candidate: &Candidate) -> Result<Self, CandidateError> {
        let root = candidate.state_root.join("run/graph-publication-gate");
        let lock = state::Lock::acquire_existing(&root)?;
        let metadata = fs::symlink_metadata(&root).map_err(state::io)?;
        let guard = Self {
            root,
            directory: (metadata.dev(), metadata.ino()),
            lock,
        };
        guard.verify(candidate)?;
        Ok(guard)
    }

    pub(crate) fn acquire(candidate: &Candidate) -> Result<Self, CandidateError> {
        let root = candidate.state_root.join("run/graph-publication-gate");
        let lock = state::Lock::acquire(&root)?;
        let metadata = fs::symlink_metadata(&root).map_err(state::io)?;
        let guard = Self {
            root,
            directory: (metadata.dev(), metadata.ino()),
            lock,
        };
        guard.verify(candidate)?;
        Ok(guard)
    }

    pub(crate) fn verify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        let root = candidate.state_root.join("run/graph-publication-gate");
        state::check_private_directory(&root)?;
        let directory = fs::symlink_metadata(&root).map_err(state::io)?;
        let lock = fs::symlink_metadata(root.join("operation.lock")).map_err(state::io)?;
        if self.root != root
            || !directory.is_dir()
            || directory.file_type().is_symlink()
            || (directory.dev(), directory.ino()) != self.directory
            || !lock.is_file()
            || lock.file_type().is_symlink()
            || lock.nlink() != 1
            || lock.uid() != unsafe { libc::geteuid() }
            || lock.mode() & 0o077 != 0
            || (lock.dev(), lock.ino()) != self.lock.identity()?
        {
            return Err(CandidateError::new(
                "graph_publication_gate",
                "Graph publication gate changed; recovery and publication were refused.",
            ));
        }
        Ok(())
    }
}
