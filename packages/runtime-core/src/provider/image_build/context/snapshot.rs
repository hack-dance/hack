//! A private copy of exactly the context entries the build key describes.
//!
//! BuildKit reads its context directory while it builds, so building from the project
//! directory would let an edit made during the build (even one undone before it ends)
//! reach the image under a key that describes other bytes. Instead, on every path that
//! runs BuildKit, [`Snapshot::create`] copies each recorded entry into a private
//! directory and BuildKit reads only that:
//!
//! - directories and symlinks are created as recorded (a symlink's target is checked
//!   against the record first); regular files are copied in one pass that hashes the
//!   bytes it writes, and the copy's size, hash and permission bits must equal the
//!   record. Anything else refuses `native_build_context_changed`;
//! - the entry set is the recorded one by construction: entries added to the project
//!   since the key walk are not copied, and a recorded entry that vanished refuses;
//! - sources are opened without following symlinks and without blocking, and must still
//!   be regular files, so a swapped-in symlink, FIFO or device is refused, never read;
//! - every created file and directory's mode is read back and must equal the record
//!   (`chmod` may silently drop a setgid bit), else `native_build_context_copy`;
//! - modification times are carried over so image layers keep the project's times;
//!   owners are not (BuildKit `COPY` assigns its own unless told otherwise).
//!
//! The copy is private: a mode-0700 holder directory contains the context root, which
//! takes the recorded root mode. [`Snapshot`] removes the whole tree when dropped (on
//! every exit path); a tree a killed process left behind is removed by the next attempt
//! under the same key lock. The copy observes the operation's cancellation and
//! deadline before every entry and every chunk of a file.
use super::{Entry, Kind, changed, unreadable};
use crate::{CandidateError, provider::state};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{self, File, FileTimes, OpenOptions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const COPY_BUFFER: usize = 256 * 1024;
const ROOT: &str = "context";

/// Why a copy stopped before it finished, other than a refusal.
#[derive(Debug, Eq, PartialEq)]
pub(in crate::provider::image_build) enum Stopped {
    Canceled,
    Expired,
}

/// The private snapshot tree; removed when dropped.
#[derive(Debug)]
pub(in crate::provider::image_build) struct Snapshot {
    holder: PathBuf,
}

impl Snapshot {
    /// The context root BuildKit is pointed at.
    pub(in crate::provider::image_build) fn context(&self) -> PathBuf {
        self.holder.join(ROOT)
    }

    /// Copy `recorded` (sorted, root first, as the key walk returns it) from `source`
    /// into a fresh private tree at `holder`. `stop` is polled between entries.
    pub(in crate::provider::image_build) fn create(
        source: &Path,
        holder: &Path,
        recorded: &[Entry],
        stop: &dyn Fn() -> Option<Stopped>,
    ) -> Result<Result<Self, Stopped>, CandidateError> {
        remove_tree(holder)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(holder)
            .map_err(state::io)?;
        state::check_private_directory(holder)?;
        // From here the guard removes whatever was created, on every return.
        let snapshot = Self {
            holder: holder.to_owned(),
        };
        let root = snapshot.context();
        let mut directories: Vec<(PathBuf, u32, (i64, i64))> = Vec::new();
        for entry in recorded {
            if let Some(stopped) = stop() {
                return Ok(Err(stopped));
            }
            let relative = Path::new(OsStr::from_bytes(&entry.path));
            let (from, to) = if entry.path.is_empty() {
                (source.to_owned(), root.clone())
            } else {
                (source.join(relative), root.join(relative))
            };
            match &entry.kind {
                Kind::Directory => {
                    // Writable while it is filled; the recorded mode is set afterwards.
                    fs::DirBuilder::new()
                        .mode(0o700)
                        .create(&to)
                        .map_err(state::io)?;
                    directories.push((to, entry.mode, entry.mtime));
                }
                Kind::Symlink(target) => {
                    let current = fs::read_link(&from).map_err(|_| changed())?;
                    if current.as_os_str().as_bytes() != target.as_slice() {
                        return Err(changed());
                    }
                    std::os::unix::fs::symlink(OsStr::from_bytes(target), &to)
                        .map_err(state::io)?;
                }
                Kind::File(hash, size) => {
                    if let Err(stopped) =
                        copy_file(&from, &to, entry.mode, *hash, *size, entry.mtime, stop)?
                    {
                        return Ok(Err(stopped));
                    }
                }
            }
        }
        // Children first, so a read-only directory is set only once it is full.
        for (path, mode, mtime) in directories.iter().rev() {
            fs::set_permissions(path, fs::Permissions::from_mode(*mode)).map_err(state::io)?;
            set_mtime(path, *mtime)?;
            require_mode(path, *mode)?;
        }
        Ok(Ok(snapshot))
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = remove_tree(&self.holder);
    }
}

#[cfg(test)]
pub(super) type AfterMode = std::cell::RefCell<Option<Box<dyn FnMut(&Path)>>>;
#[cfg(test)]
thread_local! {
    /// Test seam: runs on each created file or directory just before its mode is read
    /// back, so a test can drop a bit as a filesystem might.
    pub(super) static BEFORE_MODE_CHECK: AfterMode = const { std::cell::RefCell::new(None) };
}

/// Read back a created entry's mode (without following a symlink): `chmod` can succeed
/// while dropping bits (setgid for a group the user is not in, or a filesystem that
/// does not keep them), and BuildKit must see exactly the keyed mode.
fn require_mode(path: &Path, mode: u32) -> Result<(), CandidateError> {
    #[cfg(test)]
    BEFORE_MODE_CHECK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(path);
        }
    });
    let metadata = fs::symlink_metadata(path).map_err(state::io)?;
    if metadata.mode() & 0o7777 != mode {
        return Err(crate::CandidateError::new(
            "native_build_context_copy",
            "The build context's file permissions cannot be reproduced in the build copy; no image was built.",
        ));
    }
    Ok(())
}

fn time(mtime: (i64, i64)) -> SystemTime {
    match (u64::try_from(mtime.0), u32::try_from(mtime.1)) {
        (Ok(seconds), Ok(nanos)) if nanos < 1_000_000_000 => {
            UNIX_EPOCH + Duration::new(seconds, nanos)
        }
        _ => UNIX_EPOCH,
    }
}

fn set_mtime(path: &Path, mtime: (i64, i64)) -> Result<(), CandidateError> {
    let times = FileTimes::new().set_modified(time(mtime));
    File::open(path)
        .and_then(|file| file.set_times(times))
        .map_err(state::io)
}

/// Copy one regular file in a single pass, hashing exactly the bytes written, and
/// require them and the copy's mode to match the record. `stop` is polled before every
/// chunk, so one large file cannot defer a cancellation or the deadline.
fn copy_file(
    from: &Path,
    to: &Path,
    mode: u32,
    hash: [u8; 32],
    size: u64,
    mtime: (i64, i64),
    stop: &dyn Fn() -> Option<Stopped>,
) -> Result<Result<(), Stopped>, CandidateError> {
    let source = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(from)
        .map_err(|_| changed())?;
    let metadata = source.metadata().map_err(|_| unreadable())?;
    if !metadata.is_file() || metadata.mode() & 0o7777 != mode || metadata.size() != size {
        return Err(changed());
    }
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(to)
        .map_err(state::io)?;
    let mut reader = (&source).take(size.saturating_add(1));
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER];
    let mut total = 0_u64;
    loop {
        if let Some(stopped) = stop() {
            return Ok(Err(stopped));
        }
        let read = reader.read(&mut buffer).map_err(|_| unreadable())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > size {
            return Err(changed());
        }
        digest.update(&buffer[..read]);
        target.write_all(&buffer[..read]).map_err(state::io)?;
    }
    if total != size || digest.finalize().as_slice() != hash {
        return Err(changed());
    }
    target
        .set_permissions(fs::Permissions::from_mode(mode))
        .map_err(state::io)?;
    target
        .set_times(FileTimes::new().set_modified(time(mtime)))
        .map_err(state::io)?;
    drop(target);
    require_mode(to, mode)?;
    Ok(Ok(()))
}

/// Remove a snapshot tree, first making every directory in it writable (a recorded
/// read-only directory would otherwise keep its children). Never follows a symlink.
fn remove_tree(path: &Path) -> Result<(), CandidateError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(state::io(error)),
        Ok(metadata) if !metadata.is_dir() => return fs::remove_file(path).map_err(state::io),
        Ok(_) => {}
    }
    let mut pending = vec![path.to_owned()];
    while let Some(directory) = pending.pop() {
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(state::io)?;
        for entry in fs::read_dir(&directory).map_err(state::io)? {
            let entry = entry.map_err(state::io)?;
            if entry.file_type().map_err(state::io)?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    fs::remove_dir_all(path).map_err(state::io)
}

/// A `stop` check for [`Snapshot::create`] from the operation's cancellation request
/// and deadline.
pub(in crate::provider::image_build) fn stop_check<'a>(
    canceled: &'a dyn Fn() -> bool,
    deadline: Instant,
) -> impl Fn() -> Option<Stopped> + 'a {
    move || {
        if canceled() {
            Some(Stopped::Canceled)
        } else if Instant::now() >= deadline {
            Some(Stopped::Expired)
        } else {
            None
        }
    }
}
