//! Private layout, generation locking and atomic cache file publication.
//!
//! The store lock is never waited for in a blocking `flock`. On macOS, releasing an
//! exclusive `flock` wakes only one blocked waiter and queues the rest behind it, so
//! a woken opener that keeps its shared lock (as a store handle does) would strand
//! every other blocked opener with no bound. Every lock attempt here is therefore
//! non-blocking. Opening the live store retries after 1 to 5 ms until its deadline.
//! Initialization, key repair and set-aside run under its exclusive lock. Cleanup
//! runs under the live store's shared lock and skips any old lock it cannot take.

use super::{MissReason, Result, Store, invalid, io_error};
use crate::CandidateError;
use crate::provider::state::{flock, private_directory};
use std::ffi::{CStr, CString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

macro_rules! format_v1 {
    () => {
        "1"
    };
}

const VERSION_1: &[u8] = concat!("hack.store/", format_v1!(), "\n").as_bytes();
pub(super) const VERSION: &[u8] = VERSION_1;
pub(super) const FORMAT_DIRECTORY: &str = concat!("hack.store-", format_v1!());
const DIRECTORIES: [&str; 5] = ["records", "cas", "files", "tags", "tmp"];
const SET_ASIDE: &str = "SET_ASIDE";
const ARCHIVE_AGE_MILLIS: u64 = 7 * 24 * 60 * 60 * 1_000;

/// How long `open` may wait for the store lock before it reports the store busy.
pub(super) const OPEN_DEADLINE: Duration = Duration::from_secs(5);

pub(super) fn open(base: &Path) -> Result<Store> {
    open_until(base, Instant::now() + OPEN_DEADLINE)
}

/// Open the store, waiting for its lock no later than `deadline`.
///
/// Every wait is bounded: no `flock` here blocks. Shared and exclusive locks are
/// tried without blocking and retried until the deadline, then the open fails
/// with `step_store_busy`, which a caller treats as "run the step". The deadline
/// bounds lock waits. Cleanup of old copies runs after the store opens, outside
/// that deadline.
pub(super) fn open_until(base: &Path, deadline: Instant) -> Result<Store> {
    let base = store_path(base)?;
    create_directory(&base)?;
    let store = open_locked(&base, deadline)?;
    cleanup_archives(&base, store.owner);
    cleanup_legacy_layout(&base, store.owner);
    Ok(store)
}

fn open_locked(base: &Path, deadline: Instant) -> Result<Store> {
    let root = base.join(FORMAT_DIRECTORY);
    // Most opens only take a shared lock. Initialization waits for other openers
    // to finish probing, but refuses to rotate a store with live handles.
    loop {
        if Instant::now() >= deadline {
            return Err(busy());
        }
        let owner = create_directory(&root)?;
        let lock_path = root.join("lock");
        let lock = match open_lock(&lock_path, owner) {
            // The store was just set aside or not yet created: retry shortly.
            Err(error) if error.kind() == ErrorKind::NotFound => {
                pause();
                continue;
            }
            result => result.map_err(io_error)?,
        };
        match flock(&lock, libc::LOCK_SH | libc::LOCK_NB) {
            Ok(()) => {}
            Err(error) if retryable(&error) => {
                drop(lock);
                pause();
                continue;
            }
            Err(error) => return Err(io_error(error)),
        }
        if !is_current(&lock, &lock_path)? {
            continue;
        }
        if read_version(&root, owner)? == Some(true)
            && let Ok(KeyProbe::File(metadata)) = probe_key(&root, owner)
            && private_file(&metadata, owner)
            && let Ok((_, key)) = read_key(&root, owner, &metadata)
        {
            create_layout(&root)?;
            // A crash can leave the marker before the rename. Holding the shared
            // lock keeps another opener from marking this root while we clear it.
            remove_file_if_present(&root.join(SET_ASIDE)).map_err(io_error)?;
            let directory = private_options()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
                .open(&root)
                .map_err(io_error)?;
            if !private_directory_metadata(&directory.metadata().map_err(io_error)?, owner) {
                return Err(invalid("Unsafe step store directory."));
            }
            return Ok(Store {
                root,
                directory,
                owner,
                key,
                _lock: lock,
            });
        }

        // Upgrade to exclusive without blocking. Linux may release the shared lock
        // during the conversion; macOS keeps it when the upgrade fails. Either way a
        // failed upgrade closes this descriptor and retries until the deadline, and
        // both the inode and the contents are checked again once exclusive. After
        // initializing, the descriptor is closed and the loop opens the store afresh.
        match flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => {}
            Err(error) if retryable(&error) => {
                drop(lock);
                pause();
                continue;
            }
            Err(error) => return Err(io_error(error)),
        }
        if !is_current(&lock, &lock_path)? {
            continue;
        }
        initialize(base, &root, owner)?;
        // Reopen under a shared lock, possibly on the newly created root.
    }
}

fn busy() -> CandidateError {
    CandidateError::new(
        "step_store_busy",
        "The step store is busy; the step runs without it.",
    )
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
/// A conflicting VERSION or definitively lost key sets the format directory
/// aside. A key that still exists can be repaired or retried. The key and its
/// directory must be synced before publishing VERSION, including after an
/// interruption that left a key file in place.
fn initialize(base: &Path, root: &Path, owner: u32) -> Result<()> {
    let version = read_version(root, owner)?;
    if version == Some(false) {
        return set_aside(base, root, unix_millis()?);
    }
    let file = match probe_key(root, owner)? {
        KeyProbe::Missing if version.is_none() => None,
        KeyProbe::Missing | KeyProbe::Damaged => return set_aside(base, root, unix_millis()?),
        KeyProbe::File(metadata) => {
            if !private_file(&metadata, owner) {
                repair_key_mode(root)?;
            }
            Some(read_key(root, owner, &metadata)?.0)
        }
    };
    if version.is_some() {
        return Ok(());
    }

    create_layout(root)?;
    if let Some(file) = file {
        sync_existing_key(root, &file).map_err(|_| key_unavailable())?;
    } else {
        create_key(root)?;
    }
    publish(root, &root.join("VERSION"), VERSION)
}

pub(super) fn set_aside(base: &Path, root: &Path, archived_at: u64) -> Result<()> {
    let millis = archived_at.to_string();
    let backup = base.join(format!("{FORMAT_DIRECTORY}.old-{millis}"));
    match fs::symlink_metadata(&backup) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
        Ok(_) => return Err(invalid("Step store archive already exists.")),
    }
    // The root can be damaged or only partly initialized, including its tmp/.
    publish_in(
        root,
        &root.join(SET_ASIDE),
        &set_aside_marker(base, &millis),
        Some(fs::Permissions::from_mode(0o600)),
    )?;
    fs::rename(root, backup).map_err(io_error)
}

fn set_aside_marker(base: &Path, millis: &str) -> Vec<u8> {
    let mut marker = b"hack.store-set-aside/1\nbase=".to_vec();
    marker.extend_from_slice(base.as_os_str().as_encoded_bytes());
    marker.extend_from_slice(b"\nat=");
    marker.extend_from_slice(millis.as_bytes());
    marker.push(b'\n');
    marker
}

struct Archive {
    path: PathBuf,
    directory: File,
    lock: File,
}

impl Archive {
    fn remove(self) {
        if !(lock_for_cleanup(&self.lock, &self.path)
            && is_current(&self.directory, &self.path).unwrap_or(false))
        {
            return;
        }
        // An archive can itself have been opened as another store's base: that
        // store holds `hack.store-1/lock` inside it. Take that lock too, without
        // waiting; if it is held, or the inner directory is not a plain one, keep
        // the archive.
        let Ok(inner_lock) = lock_inner_store(&self.directory) else {
            return;
        };
        // Both lock descriptors stay open until recursive removal returns.
        // remove_dir_all does not follow symlinks in the tree.
        let _ = fs::remove_dir_all(&self.path);
        drop(inner_lock);
    }
}

/// The lock a store opened with this directory as its base would hold, taken
/// exclusively without waiting. `Ok(None)` when no such store exists inside.
fn lock_inner_store(directory: &File) -> io::Result<Option<File>> {
    let name =
        CString::new(FORMAT_DIRECTORY).map_err(|_| io::Error::from(ErrorKind::InvalidInput))?;
    let inner = match open_at(directory, &name, libc::O_RDONLY | libc::O_DIRECTORY) {
        Ok(inner) => inner,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let lock = match open_at(&inner, c"lock", libc::O_RDWR) {
        Ok(lock) => lock,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !lock.metadata()?.is_file() {
        return Err(ErrorKind::InvalidData.into());
    }
    flock(&lock, libc::LOCK_EX | libc::LOCK_NB)?;
    Ok(Some(lock))
}

/// Use the timestamp in the archive name. A newly set-aside directory may
/// have a much older modification time.
///
/// Only a directory with this base's `SET_ASIDE` marker is ever removed. An
/// archive that lost its marker (for example a crash between writing the marker
/// and the rename, which leaves the marker in the live root, where it is removed)
/// is kept indefinitely rather than guessed at.
pub(super) fn cleanup_archives(base: &Path, owner: u32) {
    #[cfg(test)]
    assert_cleanup_shared_lock(base);
    let (Ok(now), Ok(entries)) = (unix_millis(), fs::read_dir(base)) else {
        return;
    };
    let mut newest: Option<(u64, Archive)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(suffix) = name
            .to_str()
            .and_then(|name| name.strip_prefix(FORMAT_DIRECTORY)?.strip_prefix(".old-"))
        else {
            continue;
        };
        if !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(archived_at) = suffix.parse::<u64>() else {
            continue;
        };
        let path = entry.path();
        let Ok(directory) = open_owned_directory(&path, owner) else {
            continue;
        };
        if !has_marker(
            &directory,
            c"SET_ASIDE",
            owner,
            &set_aside_marker(base, suffix),
        )
        .unwrap_or(false)
        {
            continue;
        }
        let Ok(lock) = open_cleanup_lock(&directory, owner) else {
            continue;
        };
        let archive = Archive {
            path,
            directory,
            lock,
        };
        if now.saturating_sub(archived_at) > ARCHIVE_AGE_MILLIS
            || newest
                .as_ref()
                .is_some_and(|(time, _)| archived_at <= *time)
        {
            archive.remove();
        } else if let Some((_, previous)) = newest.replace((archived_at, archive)) {
            previous.remove();
        }
    }
}

/// Remove the flat v1 layout and its sibling archives left by the opt-in P1 store.
fn cleanup_legacy_layout(base: &Path, owner: u32) {
    #[cfg(test)]
    assert_cleanup_shared_lock(base);
    cleanup_flat_layout(base, owner);

    // A P1 rotation could leave an archive even when the flat store is absent.
    let Some(entries) = base.parent().and_then(|parent| fs::read_dir(parent).ok()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(suffix) = name
            .to_str()
            .and_then(|name| name.strip_prefix("store.old-"))
        else {
            continue;
        };
        let path = entry.path();
        // These archives sit in the user's global Hack directory, beside other
        // state: remove one only if it is recognisably a P1 store (its VERSION
        // holds the P1 format), never on the name alone.
        if path == base || suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if let Ok(directory) = open_owned_directory(&path, owner)
            && has_legacy_version(&directory, owner).unwrap_or(false)
            && let Ok(lock) = open_cleanup_lock(&directory, owner)
        {
            Archive {
                path,
                directory,
                lock,
            }
            .remove();
        }
    }
}

/// The name `VERSION` takes while the flat layout is being removed. It is the
/// last entry removed, so an interrupted migration is finished by a later open.
const FLAT_MIGRATING: &str = "VERSION.migrating";

/// Remove the flat P1 layout from `base`, holding its own lock.
///
/// Order, chosen so any interruption is retried and a P1 process never sees a
/// flat store it would mistake for a damaged one:
/// 1. the flat directories; if any remains, or `key` is not a plain removable
///    file, nothing else is touched;
/// 2. `VERSION` is renamed to `VERSION.migrating` in one step: from then on a
///    P1 opener finds no published flat store (at most an unfinished one, whose
///    key it reuses), never `VERSION` without its key;
/// 3. `key`, then `lock`;
/// 4. `VERSION.migrating` last, the marker that tells a later open to finish.
///
/// When another process holds the flat lock, the open still succeeds and the
/// flat layout is left for a later open (best effort).
fn cleanup_flat_layout(base: &Path, owner: u32) {
    let Ok(directory) = open_owned_directory(base, owner) else {
        return;
    };
    let migrating = CString::new(FLAT_MIGRATING)
        .ok()
        .is_some_and(|name| has_marker(&directory, &name, owner, VERSION_1).unwrap_or(false));
    if !migrating && !has_marker(&directory, c"VERSION", owner, VERSION_1).unwrap_or(false) {
        return;
    }
    // While VERSION is published the flat lock must exist and be taken; once
    // the migration is under way it may already be gone.
    let lock = match open_cleanup_lock(&directory, owner) {
        Ok(lock) => Some(lock),
        Err(error) if migrating && error.kind() == ErrorKind::NotFound => None,
        Err(_) => return,
    };
    if let Some(lock) = &lock
        && !lock_for_cleanup(lock, base)
    {
        return;
    }
    let mut removed = true;
    for name in DIRECTORIES {
        removed &= remove_owned_directory(&base.join(name), owner);
    }
    let key_path = base.join("key");
    let key_removable = match fs::symlink_metadata(&key_path) {
        Err(error) => error.kind() == ErrorKind::NotFound,
        Ok(metadata) => metadata.is_file() && metadata.uid() == owner,
    };
    if !(removed && key_removable) {
        return;
    }
    let marker_path = base.join(FLAT_MIGRATING);
    if !migrating {
        if fs::rename(base.join("VERSION"), &marker_path).is_err() {
            return;
        }
        if flat_step("VERSION.migrating") {
            return;
        }
    }
    if !(remove_file_if_present(&key_path).is_ok() && absent(&key_path)) || flat_step("key") {
        return;
    }
    let lock_path = base.join("lock");
    if !(remove_file_if_present(&lock_path).is_ok() && absent(&lock_path)) || flat_step("lock") {
        return;
    }
    let _ = remove_file_if_present(&marker_path);
    flat_step("marker");
}

/// Record a finished migration step; in tests, `true` stops the migration there
/// (as a crash would). Always `false` outside tests.
fn flat_step(step: &'static str) -> bool {
    #[cfg(test)]
    {
        FLAT_FINAL_REMOVALS.with_borrow_mut(|order| order.push(step));
        STOP_FLAT_AFTER.get() == Some(step)
    }
    #[cfg(not(test))]
    {
        let _ = step;
        false
    }
}

fn open_cleanup_lock(directory: &File, owner: u32) -> io::Result<File> {
    let lock = open_at(directory, c"lock", libc::O_RDWR)?;
    let metadata = lock.metadata()?;
    if !metadata.is_file() || metadata.uid() != owner {
        return Err(ErrorKind::PermissionDenied.into());
    }
    Ok(lock)
}

fn lock_for_cleanup(lock: &File, root: &Path) -> bool {
    flock(lock, libc::LOCK_EX | libc::LOCK_NB).is_ok()
        && is_current(lock, &root.join("lock")).unwrap_or(false)
}

fn has_legacy_version(directory: &File, owner: u32) -> io::Result<bool> {
    #[cfg(test)]
    LEGACY_VERSION_PROBES.set(LEGACY_VERSION_PROBES.get() + 1);
    has_marker(directory, c"VERSION", owner, VERSION_1)
}

fn has_marker(directory: &File, name: &CStr, owner: u32, expected: &[u8]) -> io::Result<bool> {
    let file = open_at(directory, name, libc::O_RDONLY)?;
    let metadata = file.metadata()?;
    Ok(metadata.is_file() && metadata.uid() == owner && marker_matches(file, expected)?)
}

fn open_owned_directory(path: &Path, owner: u32) -> io::Result<File> {
    if !owned_directory(path, owner) {
        return Err(ErrorKind::PermissionDenied.into());
    }
    let directory = private_options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_DIRECTORY)
        .open(path)?;
    if directory.metadata()?.uid() != owner {
        return Err(ErrorKind::PermissionDenied.into());
    }
    Ok(directory)
}

fn owned_directory(path: &Path, owner: u32) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == owner)
}

fn remove_owned_directory(path: &Path, owner: u32) -> bool {
    if owned_directory(path, owner) {
        // Best effort. remove_dir_all does not traverse symlinks inside the directory.
        return fs::remove_dir_all(path).is_ok() && absent(path);
    }
    absent(path)
}

fn absent(path: &Path) -> bool {
    fs::symlink_metadata(path).is_err_and(|error| error.kind() == ErrorKind::NotFound)
}

fn remove_file_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(test)]
fn assert_cleanup_shared_lock(base: &Path) {
    if !CHECK_CLEANUP_LOCK.get() {
        return;
    }
    let probe = File::open(base.join(FORMAT_DIRECTORY).join("lock")).unwrap();
    flock(&probe, libc::LOCK_SH | libc::LOCK_NB)
        .expect("cleanup must run outside the live store's exclusive lock");
}

/// A lock attempt that another holder refused, or a signal interrupted.
fn retryable(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted)
}

/// Sleep 1 to 5 ms before the next lock attempt. The jitter keeps racing openers
/// from retrying in step.
fn pause() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    std::thread::sleep(Duration::from_micros(1_000 + u64::from(nanos % 4_000)));
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

fn private_directory_metadata(metadata: &Metadata, owner: u32) -> bool {
    metadata.is_dir() && metadata.uid() == owner && metadata.mode() & 0o7777 == 0o700
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

fn read_owned_file(path: &Path, owner: u32) -> Result<Option<File>> {
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
    marker_matches(file, VERSION).map(Some).map_err(io_error)
}

fn marker_matches(file: File, expected: &[u8]) -> io::Result<bool> {
    let mut bytes = Vec::new();
    file.take(expected.len() as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes == expected)
}

enum KeyProbe {
    Missing,
    Damaged,
    File(Metadata),
}

fn probe_key(root: &Path, owner: u32) -> Result<KeyProbe> {
    let metadata = match fs::symlink_metadata(root.join("key")) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(KeyProbe::Missing),
        Err(_) => return Err(key_unavailable()),
    };
    if !metadata.is_file() {
        return Ok(KeyProbe::Damaged);
    }
    if metadata.uid() != owner || metadata.nlink() != 1 {
        return Err(invalid("Unsafe step store key file."));
    }
    if metadata.len() != 32 {
        return Ok(KeyProbe::Damaged);
    }
    Ok(KeyProbe::File(metadata))
}

fn key_unavailable() -> CandidateError {
    CandidateError::new(
        "step_store_unavailable",
        "The step store key is unavailable.",
    )
}

fn repair_key_mode(root: &Path) -> Result<()> {
    let path = root.join("key");
    let path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| key_unavailable())?;
    // SAFETY: path is a NUL-terminated absolute path in the private, exclusively
    // locked store. This also repairs an unreadable mode without following a symlink.
    if unsafe {
        libc::fchmodat(
            libc::AT_FDCWD,
            path.as_ptr(),
            0o600,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(key_unavailable());
    }
    Ok(())
}

fn read_key(root: &Path, owner: u32, probed: &Metadata) -> Result<(File, Zeroizing<[u8; 32]>)> {
    let mut file = private_options()
        .read(true)
        .open(root.join("key"))
        .map_err(|_| key_unavailable())?;
    let metadata = file.metadata().map_err(|_| key_unavailable())?;
    if !private_file(&metadata, owner)
        || metadata.len() != 32
        || (metadata.dev(), metadata.ino()) != (probed.dev(), probed.ino())
    {
        return Err(key_unavailable());
    }
    let mut key = Zeroizing::new([0; 32]);
    read_key_bytes(&mut file, &mut key[..]).map_err(|_| key_unavailable())?;
    Ok((file, key))
}

#[cfg(test)]
thread_local! {
    pub(super) static CHECK_CLEANUP_LOCK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static LEGACY_VERSION_PROBES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The steps the flat migration finished, in order.
    pub(super) static FLAT_FINAL_REMOVALS: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
    /// Stop the flat migration after this step, as a crash would.
    pub(super) static STOP_FLAT_AFTER: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    pub(super) static FAIL_CACHE_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static FAIL_KEY_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static FAIL_KEY_DIR_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn read_key_bytes(file: &mut File, key: &mut [u8]) -> io::Result<()> {
    #[cfg(test)]
    if FAIL_KEY_READ.get() {
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
    file.read_exact(key)
}

fn sync_existing_key(root: &Path, file: &File) -> io::Result<()> {
    file.sync_all()?;
    #[cfg(test)]
    if FAIL_KEY_DIR_SYNC.get() {
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
    File::open(root)?.sync_all()
}

fn random(bytes: &mut [u8]) -> Result<()> {
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(bytes))
        .map_err(io_error)
}

/// Write a new key under the exclusive lock. The bytes go to `tmp/` and are
/// renamed into place, so a crash leaves either no key or a whole one.
fn create_key(root: &Path) -> Result<()> {
    let mut key = Zeroizing::new([0; 32]);
    random(&mut key[..])?;
    publish_synced(root, &root.join("key"), &key[..])
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

pub(super) fn publish(root: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    publish_in(&root.join("tmp"), path, bytes, None)
}

fn publish_in(
    temporary_directory: &Path,
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<()> {
    let mut suffix = [0; 16];
    random(&mut suffix)?;
    let temporary = temporary_directory.join(format!("{:x}", crate::Hex(suffix)));
    let mut file = private_options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    // The cache can forget writes on a crash. The rename commits complete bytes
    // for concurrent readers without requiring durability.
    let written = (|| {
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.write_all(bytes)?;
        fs::rename(&temporary, path)
    })();
    if let Err(error) = written {
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

/// A cache file and the parent descriptor used to open it.
pub(super) struct CacheFile {
    pub(super) file: File,
    entry: CacheEntry,
}

impl CacheFile {
    pub(super) fn discard(&self) {
        self.entry.discard();
    }
}

struct CacheEntry {
    parent: File,
    name: CString,
    stat: libc::stat,
}

impl CacheEntry {
    fn open(&self, directory: bool) -> io::Result<File> {
        let flags = libc::O_RDONLY | if directory { libc::O_DIRECTORY } else { 0 };
        open_at(&self.parent, &self.name, flags)
    }

    fn discard(&self) {
        if self.stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
            return;
        }
        if let Ok(current) = stat_at(&self.parent, &self.name)
            && (current.st_dev, current.st_ino) == (self.stat.st_dev, self.stat.st_ino)
        {
            // SAFETY: parent and name are valid for the call. With flags zero,
            // unlinkat removes only this name, never a directory or symlink target.
            // A concurrent rename after the inode check can cost a spurious miss.
            unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0) };
        }
    }
}

fn open_at(parent: &File, name: &CStr, flags: libc::c_int) -> io::Result<File> {
    let flags = flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    // SAFETY: the parent is open, and callers supply a NUL-terminated single
    // component and flags that do not create a file.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a fresh descriptor owned by this File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn stat_at(parent: &File, name: &CStr) -> io::Result<libc::stat> {
    let mut stat = MaybeUninit::uninit();
    // SAFETY: parent is open, name is NUL-terminated, and stat has space for
    // fstatat's output. It is initialized only on success.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful call filled stat.
    Ok(unsafe { stat.assume_init() })
}

/// Walk only the store's own path components, using directory descriptors so
/// that a replaced shard cannot redirect a read or unlink through a symlink.
pub(super) fn read_cache_file(
    root: &File,
    path: &Path,
    owner: u32,
) -> std::result::Result<CacheFile, MissReason> {
    let mut parent = root.try_clone().map_err(|_| MissReason::TornRecord)?;
    let mut components = path.components().peekable();
    while let Some(Component::Normal(name)) = components.next() {
        let name = CString::new(name.as_encoded_bytes()).map_err(|_| MissReason::TornRecord)?;
        let stat = stat_at(&parent, &name).map_err(cache_miss)?;
        let entry = CacheEntry { parent, name, stat };
        let directory = components.peek().is_some();
        let kind = if directory {
            libc::S_IFDIR
        } else {
            libc::S_IFREG
        };
        let mode = if directory { 0o700 } else { 0o600 };
        if stat.st_mode & libc::S_IFMT != kind
            || stat.st_uid != owner
            || stat.st_mode & 0o7777 != mode
            || (!directory && stat.st_nlink > 1)
        {
            entry.discard();
            return Err(MissReason::TornRecord);
        }
        let file = entry.open(directory).map_err(cache_miss)?;
        let metadata = file.metadata().map_err(|_| MissReason::TornRecord)?;
        if directory {
            if !private_directory_metadata(&metadata, owner) {
                return Err(MissReason::TornRecord);
            }
        } else {
            // An inode that a concurrent writer unlinked after open is still
            // readable. A hard-linked file, foreign owner or wrong mode is torn.
            if !owned_file(&metadata, owner) || metadata.mode() & 0o7777 != 0o600 {
                entry.discard();
                return Err(MissReason::TornRecord);
            }
            return Ok(CacheFile { file, entry });
        }
        parent = file;
    }
    Err(MissReason::TornRecord)
}

fn cache_miss(error: io::Error) -> MissReason {
    if error.kind() == ErrorKind::NotFound {
        MissReason::NoRecord
    } else {
        MissReason::TornRecord
    }
}

/// Read at most `limit` bytes; `None` when the file holds more (the caller treats
/// it as torn or absent), so a huge or growing file is never read into memory.
pub(super) fn read_limited(file: &mut File, limit: u64) -> io::Result<Option<Vec<u8>>> {
    #[cfg(test)]
    if FAIL_CACHE_READ.get() {
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
    let mut bytes = Vec::new();
    Read::by_ref(file).take(limit + 1).read_to_end(&mut bytes)?;
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
