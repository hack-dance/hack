//! Exact private receipt incarnation, retained across each read-only tool admission.
use super::*;
use crate::provider::{native_input, state};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf};

#[derive(PartialEq, Eq)]
pub(super) struct Saved {
    root: PathBuf,
    directories: Vec<(PathBuf, u64, u64)>,
    file: (u64, u64),
    bytes: Vec<u8>,
}
impl Saved {
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn capture(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = journal::directory(candidate, run)?;
        let mut directories = Vec::new();
        for path in root
            .ancestors()
            .take_while(|path| path.starts_with(&candidate.state_root))
        {
            state::check_private_directory(path).map_err(|_| refused())?;
            let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
            if !metadata.is_dir() {
                return Err(refused());
            }
            directories.push((path.to_owned(), metadata.dev(), metadata.ino()));
        }
        let path = root.join("state.json");
        let before = fs::symlink_metadata(&path).map_err(|_| refused())?;
        let bytes = native_input::read_file(&path, 64 * 1024).map_err(|_| refused())?;
        let saved = Self {
            root,
            directories,
            file: (before.dev(), before.ino()),
            bytes,
        };
        saved.verify()?;
        let receipt = saved.receipt()?;
        receipt
            .validate(run, &receipt.owner)
            .map_err(|_| refused())?;
        Ok(saved)
    }
    pub(super) fn receipt(&self) -> Result<Receipt, CandidateError> {
        serde_json::from_slice(&self.bytes).map_err(|_| refused())
    }
    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        self.paths()?;
        let path = self.root.join("state.json");
        let before = fs::symlink_metadata(&path).map_err(|_| refused())?;
        let bytes = native_input::read_file(&path, 64 * 1024).map_err(|_| refused())?;
        let after = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if (before.dev(), before.ino()) != self.file
            || (after.dev(), after.ino()) != self.file
            || bytes != self.bytes
        {
            return Err(refused());
        }
        self.paths()
    }
    fn paths(&self) -> Result<(), CandidateError> {
        for (path, device, inode) in &self.directories {
            state::check_private_directory(path).map_err(|_| refused())?;
            let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
            if !metadata.is_dir() || (metadata.dev(), metadata.ino()) != (*device, *inode) {
                return Err(refused());
            }
        }
        match fs::symlink_metadata(self.root.join("state.pending")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(refused()),
        }
    }
    pub(super) fn parents(&self) -> Result<(), CandidateError> {
        for (path, device, inode) in self.directories.iter().skip(1) {
            state::check_private_directory(path).map_err(|_| refused())?;
            let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
            if !metadata.is_dir() || (metadata.dev(), metadata.ino()) != (*device, *inode) {
                return Err(refused());
            }
        }
        Ok(())
    }
}
