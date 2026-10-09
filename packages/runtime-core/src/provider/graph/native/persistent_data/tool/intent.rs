//! One durable in-flight transport fence under the original run directory.
//! Unknown work is retained; no caller can reopen, clear, or replay it. The
//! private issued value alone can clear its exact inode after known completion.
use super::*;
use crate::provider::{native_input, state};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
};

const NAME: &str = "storage-call.pending";
const BYTES: &[u8] = b"native-storage-call-v1\n";
pub(super) struct Intent {
    root: PathBuf,
    directory: (u64, u64),
    file: (u64, u64),
}
pub(super) fn absent(root: &Path) -> Result<(), CandidateError> {
    match fs::symlink_metadata(root.join(NAME)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(refused()),
    }
}
fn directory(root: &Path) -> Result<(File, (u64, u64)), CandidateError> {
    state::check_private_directory(root).map_err(|_| refused())?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(root)
        .map_err(|_| refused())?;
    let metadata = file.metadata().map_err(|_| refused())?;
    if !metadata.is_dir() {
        return Err(refused());
    }
    Ok((file, (metadata.dev(), metadata.ino())))
}
impl Intent {
    pub(super) fn begin(root: &Path) -> Result<Self, CandidateError> {
        let (parent, directory) = directory(root)?;
        absent(root)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join(NAME))
            .map_err(|_| refused())?;
        let metadata = file.metadata().map_err(|_| refused())?;
        let intent = Self {
            root: root.into(),
            directory,
            file: (metadata.dev(), metadata.ino()),
        };
        // Publication failure leaves whatever was created. No Drop unlinks it.
        file.write_all(BYTES).map_err(|_| refused())?;
        file.sync_all().map_err(|_| refused())?;
        parent.sync_all().map_err(|_| refused())?;
        intent.verify()?;
        Ok(intent)
    }
    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        if directory(&self.root)?.1 != self.directory {
            return Err(refused());
        }
        let path = self.root.join(NAME);
        let before = fs::symlink_metadata(&path).map_err(|_| refused())?;
        let bytes = native_input::read_file(&path, BYTES.len()).map_err(|_| refused())?;
        let after = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if (before.dev(), before.ino()) != self.file
            || (after.dev(), after.ino()) != self.file
            || before.mode() & 0o777 != 0o600
            || after.mode() & 0o777 != 0o600
            || bytes != BYTES
            || directory(&self.root)?.1 != self.directory
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn complete(self) -> Result<(), CandidateError> {
        self.verify()?;
        let (parent, identity) = directory(&self.root)?;
        if identity != self.directory {
            return Err(refused());
        }
        fs::remove_file(self.root.join(NAME)).map_err(|_| refused())?;
        parent.sync_all().map_err(|_| refused())?;
        if directory(&self.root)?.1 != self.directory {
            return Err(refused());
        }
        absent(&self.root)
    }
}
