//! A public generation fence, not a credential or authentication boundary.
use crate::CandidateError;
use std::{ffi::OsString, os::unix::process::CommandExt, path::Path, process::Command};

fn refused() -> CandidateError {
    CandidateError::new("relay_guest_barrier", "Guest startup release refused.")
}
pub(super) fn valid(args: &[OsString]) -> bool {
    args.len() >= 4
        && matches!(
            args[0].to_str(),
            Some("--await-release" | "--check-release")
        )
        && args[1].to_str().is_some_and(|generation| {
            generation.len() == 32
                && generation
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        && args[2] == "--"
        && Path::new(&args[3]).is_absolute()
}
pub(super) fn run(args: &[OsString]) -> Result<(), CandidateError> {
    if !valid(args) {
        return Err(refused());
    }
    let generation = args[1].to_str().ok_or_else(refused)?;
    wait(generation, args[0] == "--await-release")?;
    // No uid, environment, signal or stdio changes: exec replaces this exact process.
    // All observation descriptors have already closed before reaching this point.
    let _error = Command::new(&args[3]).args(&args[4..]).exec();
    Err(refused())
}
#[cfg(not(target_os = "linux"))]
fn wait(_: &str, _: bool) -> Result<(), CandidateError> {
    Err(refused())
}
#[cfg(target_os = "linux")]
fn wait(generation: &str, should_wait: bool) -> Result<(), CandidateError> {
    use std::{
        fs::{File, OpenOptions},
        io::{self, Read},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        time::{Duration, Instant},
    };
    const DIRECTORY: &str = "/run/hack-startup";
    let deadline = Instant::now() + Duration::from_secs(120);
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(DIRECTORY)
        .map_err(|_| refused())?;
    let original = directory.metadata().map_err(|_| refused())?;
    let directory_valid = |metadata: &std::fs::Metadata| {
        metadata.is_dir()
            && metadata.uid() == 0
            && metadata.mode() & 0o7777 == 0o555
            && metadata.dev() == original.dev()
            && metadata.ino() == original.ino()
    };
    if !directory_valid(&original) {
        return Err(refused());
    }
    // SAFETY: no pointer arguments; the returned owned descriptor is adopted once.
    let raw = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
    if raw < 0 {
        return Err(refused());
    }
    // SAFETY: successful inotify_init1 transfers ownership of a fresh descriptor.
    let notify = unsafe { OwnedFd::from_raw_fd(raw) };
    // Resolve the watch through the already validated directory FD, not a second
    // pathname lookup. Following this procfs FD link is intentional.
    let path = std::ffi::CString::new(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .map_err(|_| refused())?;
    // SAFETY: path is NUL terminated and both descriptors remain owned here.
    if unsafe {
        libc::inotify_add_watch(
            notify.as_raw_fd(),
            path.as_ptr(),
            libc::IN_CREATE
                | libc::IN_MOVED_TO
                | libc::IN_CLOSE_WRITE
                | libc::IN_ATTRIB
                | libc::IN_DELETE
                | libc::IN_DELETE_SELF
                | libc::IN_MOVE_SELF
                | libc::IN_ONLYDIR,
        )
    } < 0
    {
        return Err(refused());
    }
    // Install watch before checking, so publication cannot fall between check and wait.
    loop {
        if Instant::now() >= deadline {
            return Err(refused());
        }
        let current = std::fs::symlink_metadata(DIRECTORY).map_err(|_| refused())?;
        if !directory_valid(&current)
            || !directory_valid(&directory.metadata().map_err(|_| refused())?)
        {
            return Err(refused());
        }
        // SAFETY: constant NUL-terminated child name and live directory FD. NONBLOCK
        // avoids blocking on a malicious FIFO before regular-file validation.
        let raw = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                c"release".as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if raw >= 0 {
            // SAFETY: successful openat transfers this fresh descriptor exactly once.
            let mut marker = unsafe { File::from_raw_fd(raw) };
            let before = marker.metadata().map_err(|_| refused())?;
            if !before.is_file()
                || before.uid() != 0
                || before.nlink() != 1
                || before.mode() & 0o7777 != 0o444
                || before.len() != 33
            {
                return Err(refused());
            }
            let mut bytes = Vec::with_capacity(34);
            (&mut marker)
                .take(34)
                .read_to_end(&mut bytes)
                .map_err(|_| refused())?;
            let after = marker.metadata().map_err(|_| refused())?;
            if after.mode() != before.mode()
                || after.uid() != 0
                || after.nlink() != 1
                || after.len() != 33
                || after.mtime() != before.mtime()
                || after.mtime_nsec() != before.mtime_nsec()
                || after.ctime() != before.ctime()
                || after.ctime_nsec() != before.ctime_nsec()
                || bytes.len() != 33
                || &bytes[..32] != generation.as_bytes()
                || bytes[32] != b'\n'
            {
                return Err(refused());
            }
            return Ok(());
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) || !should_wait {
            return Err(refused());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(refused());
        }
        let timeout = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd: notify.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: writable single pollfd and owned inotify descriptor remain live.
        let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(refused());
        }
        if ready == 0 || poll.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            return Err(refused());
        }
        let mut events = [0u8; 4096];
        // SAFETY: read writes at most this buffer's length into live storage. One
        // bounded batch per turn prevents event floods from extending the deadline.
        let count =
            unsafe { libc::read(notify.as_raw_fd(), events.as_mut_ptr().cast(), events.len()) };
        if count <= 0
            && (count == 0
                || !matches!(
                    io::Error::last_os_error().kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ))
        {
            return Err(refused());
        }
    }
}
