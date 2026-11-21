//! Private layout, generation locking and atomic cache file publication.

use super::{Result, Store, invalid, io_error};
use crate::provider::state::{check_private_directory, flock, private_directory};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const VERSION: &[u8] = b"hack.store/1\n";
const DIRECTORIES: [&str; 5] = ["records", "cas", "files", "tags", "tmp"];

pub(super) fn open(root: &Path) -> Result<Store> {
    let root = store_path(root)?;
    // Most opens only take a shared lock. Initialization waits briefly for other
    // openers to finish probing, but refuses to rotate a store with live handles.
    for _ in 0..32 {
        let owner = create_directory(&root)?;
        let lock_path = root.join("lock");
        let lock = match open_lock(&lock_path, owner) {
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            result => result.map_err(io_error)?,
        };
        lock_shared(&lock)?;
        if !is_current(&lock, &lock_path)? {
            continue;
        }
        if read_version(&root, owner)? == Some(true) {
            // A key that cannot be read is repaired under the exclusive lock below.
            if let Ok(Some(key)) = read_key(&root, owner) {
                create_layout(&root)?;
                return Ok(Store {
                    root,
                    owner,
                    key,
                    _lock: lock,
                });
            }
        }

        // Upgrade to exclusive without blocking. Linux may release the shared lock
        // during the conversion; macOS keeps it when the upgrade fails. Either way a
        // failed upgrade drops this handle and retries (up to 32 times, 5 ms apart),
        // and both the inode and the contents are checked again once exclusive.
        match flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                drop(lock);
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            Err(error) => return Err(io_error(error)),
        }
        if !is_current(&lock, &lock_path)? {
            continue;
        }
        initialize(&root, owner)?;
        // Reopen under a shared lock, possibly on the newly created root.
    }
    Err(invalid("Step store initialization is busy."))
}

fn store_path(root: &Path) -> Result<PathBuf> {
    if root.as_os_str().is_empty() || root.components().any(|part| part == Component::ParentDir) {
        return Err(invalid("Invalid step store directory."));
    }
    let absolute = if root.is_absolute() {
        root.to_owned()
    } else {
        std::env::current_dir().map_err(io_error)?.join(root)
    };
    let path: PathBuf = absolute.components().collect();
    if path.parent().is_none() {
        return Err(invalid("Invalid step store directory."));
    }
    Ok(path)
}

/// Bring the store to a usable state under the exclusive lock.
///
/// - Another `VERSION`: the whole store is set aside (no migrations).
/// - `VERSION` present but the key missing or unreadable: the store is set aside
///   too. Keyed digests made with the lost key can never be reproduced, so its
///   records are useless; a cache rebuilds rather than refusing every open.
/// - No `VERSION`: an initialization that never finished. A missing or torn key
///   is replaced. The key is written, synced, and its directory synced before
///   `VERSION` is published, so a durable `VERSION` always has a whole key.
fn initialize(root: &Path, owner: u32) -> Result<()> {
    let version = read_version(root, owner)?;
    let key = read_key(root, owner);
    match (version, &key) {
        (Some(false), _) | (Some(true), Ok(None) | Err(_)) => return set_aside(root),
        (Some(true), Ok(Some(_))) => return Ok(()),
        (None, _) => {}
    }
    create_layout(root)?;
    match key {
        Ok(Some(_)) => {}
        Ok(None) => create_key(root, owner)?,
        Err(_) => {
            remove_entry(&root.join("key"))?;
            create_key(root, owner)?;
        }
    }
    publish(root, &root.join("VERSION"), VERSION)
}

fn set_aside(root: &Path) -> Result<()> {
    let backup = root.with_file_name(format!("store.old-{}", unix_millis()?));
    match fs::symlink_metadata(&backup) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
        Ok(_) => return Err(invalid("Step store archive already exists.")),
    }
    fs::rename(root, backup).map_err(io_error)
}

/// A blocking shared lock, retried when a signal interrupts the wait.
fn lock_shared(lock: &File) -> Result<()> {
    loop {
        match flock(lock, libc::LOCK_SH) {
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            result => return result.map_err(io_error),
        }
    }
}

fn create_layout(root: &Path) -> Result<()> {
    for name in DIRECTORIES {
        create_directory(&root.join(name))?;
    }
    Ok(())
}

/// The ownership check in provider state establishes the effective UID for file validation.
pub(super) fn create_directory(path: &Path) -> Result<u32> {
    private_directory(path).map_err(|_| invalid("Unsafe step store directory."))?;
    directory_owner(path)
}

fn directory_owner(path: &Path) -> Result<u32> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || metadata.mode() & 0o7777 != 0o700 {
        return Err(invalid("Unsafe step store directory."));
    }
    Ok(metadata.uid())
}

pub(super) fn existing_directory(path: &Path, owner: u32) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
        Ok(_) => {}
    }
    check_private_directory(path).map_err(|_| invalid("Unsafe step store directory."))?;
    if directory_owner(path)? != owner {
        return Err(invalid("Unsafe step store directory."));
    }
    Ok(true)
}

fn open_lock(path: &Path, owner: u32) -> io::Result<File> {
    let file = private_options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    if !private_file(&file.metadata()?, owner) {
        return Err(ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options
}

fn owned_file(metadata: &Metadata, owner: u32) -> bool {
    // A concurrent cache publication can unlink an inode after a reader opened it.
    metadata.is_file() && metadata.uid() == owner && metadata.nlink() <= 1
}

fn private_file(metadata: &Metadata, owner: u32) -> bool {
    owned_file(metadata, owner) && metadata.nlink() == 1 && metadata.mode() & 0o7777 == 0o600
}

pub(super) fn read_owned_file(path: &Path, owner: u32) -> Result<Option<File>> {
    match private_options().read(true).open(path) {
        Ok(file) if owned_file(&file.metadata().map_err(io_error)?, owner) => Ok(Some(file)),
        Ok(_) => Err(invalid("Unsafe step store file.")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn read_version(root: &Path, owner: u32) -> Result<Option<bool>> {
    let Some(file) = read_owned_file(&root.join("VERSION"), owner)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(VERSION.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    Ok(Some(bytes == VERSION))
}

fn read_key(root: &Path, owner: u32) -> Result<Option<Zeroizing<[u8; 32]>>> {
    let Some(mut file) = read_owned_file(&root.join("key"), owner)? else {
        return Ok(None);
    };
    let metadata = file.metadata().map_err(io_error)?;
    if !private_file(&metadata, owner) || metadata.len() != 32 {
        return Err(invalid("Invalid step store key file."));
    }
    let mut key = Zeroizing::new([0; 32]);
    file.read_exact(&mut key[..]).map_err(io_error)?;
    Ok(Some(key))
}

fn random(bytes: &mut [u8]) -> Result<()> {
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(bytes))
        .map_err(io_error)
}

/// Write a new key under the exclusive lock. The bytes go to `tmp/` and are
/// renamed into place, so a crash leaves either no key or a whole one.
fn create_key(root: &Path, owner: u32) -> Result<()> {
    let mut key = Zeroizing::new([0; 32]);
    random(&mut key[..])?;
    publish_synced(root, &root.join("key"), &key[..])?;
    if read_key(root, owner)?.is_none() {
        return Err(invalid("Invalid step store key file."));
    }
    Ok(())
}

/// `publish`, made durable: the file is synced before the rename and the store
/// directory after it. Only the key needs this; everything else is a cache entry.
fn publish_synced(root: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    let mut suffix = [0; 16];
    random(&mut suffix)?;
    let temporary = root.join("tmp").join(format!("{:x}", crate::Hex(suffix)));
    let mut file = private_options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, path))
        .and_then(|()| File::open(root)?.sync_all());
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(io_error(error));
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result.map_err(io_error),
    }
}

pub(super) fn publish(root: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    let mut suffix = [0; 16];
    random(&mut suffix)?;
    let temporary = root.join("tmp").join(format!("{:x}", crate::Hex(suffix)));
    let mut file = private_options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    // The cache can forget writes on a crash. The rename commits complete bytes
    // for concurrent readers without requiring durability.
    if let Err(error) = file
        .write_all(bytes)
        .and_then(|()| fs::rename(&temporary, path))
    {
        let _ = fs::remove_file(&temporary);
        return Err(io_error(error));
    }
    Ok(())
}

fn is_current(file: &File, path: &Path) -> Result<bool> {
    let opened = file.metadata().map_err(io_error)?;
    match fs::symlink_metadata(path) {
        Ok(current) => Ok((opened.dev(), opened.ino()) == (current.dev(), current.ino())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

/// Remove `path` if it is still the inode `file` was opened from.
///
/// A record published between the check and the unlink can still be removed; no
/// pathname API offers a conditional unlink. For a cache that costs one spurious
/// miss, never a wrong hit.
pub(super) fn remove_current(file: &File, path: &Path) -> Result<()> {
    if is_current(file, path)? {
        match fs::remove_file(path) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            result => result.map_err(io_error)?,
        }
    }
    Ok(())
}

/// Read at most `limit` bytes; `None` when the file holds more (the caller treats
/// it as torn or absent), so a huge or growing file is never read into memory.
pub(super) fn read_limited(file: &mut File, limit: u64) -> Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    Read::by_ref(file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

pub(super) fn unix_millis() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| elapsed.as_millis().try_into().ok())
        .ok_or_else(|| invalid("Step store clock is unavailable."))
}

pub(super) fn touch(file: &File) -> Result<()> {
    let now = SystemTime::now();
    let is_stale = || -> Result<bool> {
        let last = file
            .metadata()
            .and_then(|m| m.modified())
            .map_err(io_error)?;
        Ok(now.duration_since(last).unwrap_or_default() >= Duration::from_secs(3600))
    };
    if is_stale()? {
        // Use the record inode to serialize touches without gating cache reads.
        match flock(file, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => {
                if is_stale()? {
                    file.set_modified(now).map_err(io_error)?;
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}
