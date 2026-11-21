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
        flock(&lock, libc::LOCK_SH).map_err(io_error)?;
        if !is_current(&lock, &lock_path)? {
            continue;
        }
        if read_version(&root, owner)? == Some(true) {
            if let Some(key) = read_key(&root, owner)? {
                create_layout(&root)?;
                return Ok(Store {
                    root,
                    owner,
                    key,
                    _lock: lock,
                });
            }
        }

        // A flock conversion can release the shared lock before trying exclusive.
        // Recheck both the inode and contents after acquiring the exclusive lock.
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

fn initialize(root: &Path, owner: u32) -> Result<()> {
    let version = read_version(root, owner)?;
    if version == Some(false) {
        let backup = root.with_file_name(format!("store.old-{}", unix_millis()?));
        match fs::symlink_metadata(&backup) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
            Ok(_) => return Err(invalid("Step store archive already exists.")),
        }
        return fs::rename(root, backup).map_err(io_error);
    }
    create_layout(root)?;
    if read_key(root, owner)?.is_none() {
        create_key(root, owner)?;
    }
    if version.is_none() {
        publish(root, &root.join("VERSION"), VERSION)?;
    }
    Ok(())
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

fn create_key(root: &Path, owner: u32) -> Result<()> {
    let mut key = Zeroizing::new([0; 32]);
    random(&mut key[..])?;
    let path = root.join("key");
    let mut file = private_options()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(io_error)?;
    if !private_file(&file.metadata().map_err(io_error)?, owner) {
        remove_current(&file, &path)?;
        return Err(invalid("Invalid step store key file."));
    }
    if let Err(error) = file.write_all(&key[..]) {
        remove_current(&file, &path)?;
        return Err(io_error(error));
    }
    Ok(())
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

pub(super) fn remove_current(file: &File, path: &Path) -> Result<()> {
    if is_current(file, path)? {
        match fs::remove_file(path) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            result => result.map_err(io_error)?,
        }
    }
    Ok(())
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
