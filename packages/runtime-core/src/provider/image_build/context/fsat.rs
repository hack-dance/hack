//! Descriptor-anchored access beneath one opened directory.
//!
//! The build context may be shared with running containers that can rename entries
//! and plant symlinks at any time. Every traversal of it therefore holds a directory
//! descriptor and works one path component at a time relative to it: directories are
//! entered with `openat(O_DIRECTORY | O_NOFOLLOW)`, entries are listed from the opened
//! directory itself (`fdopendir` on a duplicate), examined with
//! `fstatat(AT_SYMLINK_NOFOLLOW)`, opened with `openat(O_NOFOLLOW)` and read as links
//! with `readlinkat`. A renamed directory keeps being read through its descriptor, and a
//! symlink swapped in for a component fails to open (`ELOOP` or `ENOTDIR`), so nothing
//! outside the opened root is ever reached. Destinations are created the same way
//! (`mkdirat`, `openat(O_CREAT | O_EXCL | O_NOFOLLOW)`, `symlinkat`).
//!
//! Only functions present on Linux (glibc and musl) and macOS are used.
use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

const DIRECTORY: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
/// The longest symlink target read; longer targets refuse.
const MAX_LINK: usize = 64 * 1024;

/// An owned descriptor of one opened directory.
#[derive(Debug)]
pub(super) struct Dir(OwnedFd);

/// What `fstatat` reports for one entry, in platform-neutral types.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Status {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mode: u32,
    pub nlink: u64,
    pub mtime: (i64, i64),
    pub ctime: (i64, i64),
}

// `st_dev`, `st_mode` and the `S_IF*` constants are narrower than `u64`/`u32` on macOS
// and equal to them on Linux, so these casts are needed on one platform only.
#[allow(clippy::unnecessary_cast)]
impl Status {
    fn of(raw: &libc::stat) -> Self {
        Self {
            dev: raw.st_dev as u64,
            ino: raw.st_ino as u64,
            size: u64::try_from(raw.st_size).unwrap_or(0),
            mode: raw.st_mode as u32,
            nlink: raw.st_nlink as u64,
            mtime: (raw.st_mtime as i64, raw.st_mtime_nsec as i64),
            ctime: (raw.st_ctime as i64, raw.st_ctime_nsec as i64),
        }
    }
    pub(super) fn kind(&self) -> u32 {
        self.mode & (libc::S_IFMT as u32)
    }
    pub(super) fn is_dir(&self) -> bool {
        self.kind() == libc::S_IFDIR as u32
    }
    pub(super) fn is_file(&self) -> bool {
        self.kind() == libc::S_IFREG as u32
    }
    pub(super) fn is_symlink(&self) -> bool {
        self.kind() == libc::S_IFLNK as u32
    }
}

fn name(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn owned(fd: libc::c_int) -> io::Result<OwnedFd> {
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel just returned this descriptor to us and nothing else owns it.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn check(result: libc::c_int) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// `fstat` of an owned descriptor.
pub(super) fn status(fd: &impl AsRawFd) -> io::Result<Status> {
    let mut raw = MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: a live descriptor and a buffer of the right size for the call.
    check(unsafe { libc::fstat(fd.as_raw_fd(), raw.as_mut_ptr()) })?;
    // SAFETY: fstat succeeded, so the buffer is initialized.
    Ok(Status::of(&unsafe { raw.assume_init() }))
}

#[cfg(target_os = "macos")]
fn clear_errno() {
    // SAFETY: the thread's errno location is always valid to write.
    unsafe { *libc::__error() = 0 };
}
#[cfg(not(target_os = "macos"))]
fn clear_errno() {
    // SAFETY: the thread's errno location is always valid to write.
    unsafe { *libc::__errno_location() = 0 };
}

/// A directory stream; closing it closes the descriptor it owns.
struct Stream(*mut libc::DIR);
impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: a stream fdopendir returned, closed exactly once here.
        unsafe { libc::closedir(self.0) };
    }
}

impl Dir {
    /// Open the directory at `path` itself, refusing a final symlink.
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        let path = name(path.as_os_str().as_bytes())?;
        // SAFETY: a NUL-terminated path that outlives the call.
        owned(unsafe { libc::open(path.as_ptr(), DIRECTORY) }).map(Self)
    }

    /// Enter the child directory `child` (one component), never through a symlink.
    pub(super) fn dir(&self, child: &[u8]) -> io::Result<Self> {
        let child = name(child)?;
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        owned(unsafe { libc::openat(self.0.as_raw_fd(), child.as_ptr(), DIRECTORY) }).map(Self)
    }

    /// Open the regular file `child` for reading, never through a symlink and without
    /// blocking on a FIFO swapped in for it.
    pub(super) fn file(&self, child: &[u8]) -> io::Result<File> {
        let child = name(child)?;
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        owned(unsafe { libc::openat(self.0.as_raw_fd(), child.as_ptr(), flags) }).map(File::from)
    }

    /// Create the new file `child` (never an existing one, never through a symlink).
    pub(super) fn create(&self, child: &[u8], mode: libc::mode_t) -> io::Result<File> {
        let child = name(child)?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // `mode_t` is `u16` on macOS and `u32` on Linux; the variadic argument is `c_uint`.
        #[allow(clippy::unnecessary_cast)]
        let mode = mode as libc::c_uint;
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        owned(unsafe { libc::openat(self.0.as_raw_fd(), child.as_ptr(), flags, mode) })
            .map(File::from)
    }

    /// Create the directory `child`.
    pub(super) fn mkdir(&self, child: &[u8], mode: libc::mode_t) -> io::Result<()> {
        let child = name(child)?;
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        check(unsafe { libc::mkdirat(self.0.as_raw_fd(), child.as_ptr(), mode) })
    }

    /// Create the symlink `child` with exactly `target`.
    pub(super) fn symlink(&self, target: &[u8], child: &[u8]) -> io::Result<()> {
        let (target, child) = (name(target)?, name(child)?);
        // SAFETY: two NUL-terminated strings and a live directory descriptor.
        check(unsafe { libc::symlinkat(target.as_ptr(), self.0.as_raw_fd(), child.as_ptr()) })
    }

    /// `fstatat(AT_SYMLINK_NOFOLLOW)` of `child`.
    pub(super) fn stat(&self, child: &[u8]) -> io::Result<Status> {
        let child = name(child)?;
        let mut raw = MaybeUninit::<libc::stat>::zeroed();
        // SAFETY: a live directory descriptor, a NUL-terminated name and a buffer of the
        // right size.
        check(unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                child.as_ptr(),
                raw.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        })?;
        // SAFETY: fstatat succeeded, so the buffer is initialized.
        Ok(Status::of(&unsafe { raw.assume_init() }))
    }

    /// The target bytes of the symlink `child`.
    pub(super) fn read_link(&self, child: &[u8]) -> io::Result<Vec<u8>> {
        let child = name(child)?;
        let mut buffer = vec![0_u8; 256];
        loop {
            // SAFETY: a live directory descriptor, a NUL-terminated name and a writable
            // buffer of exactly `buffer.len()` bytes.
            let read = unsafe {
                libc::readlinkat(
                    self.0.as_raw_fd(),
                    child.as_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            let read = usize::try_from(read).map_err(|_| io::Error::last_os_error())?;
            if read < buffer.len() {
                buffer.truncate(read);
                return Ok(buffer);
            }
            if buffer.len() >= MAX_LINK {
                return Err(io::Error::from(io::ErrorKind::InvalidData));
            }
            buffer.resize(buffer.len() * 2, 0);
        }
    }

    /// `fstat` of this directory.
    pub(super) fn status(&self) -> io::Result<Status> {
        status(&self.0)
    }

    /// A second descriptor of this directory.
    pub(super) fn duplicate(&self) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    /// A second handle to this directory, for `fchmod` and `futimens` through `File`.
    pub(super) fn handle(&self) -> io::Result<File> {
        self.0.try_clone().map(File::from)
    }

    /// The names in this directory (without `.` and `..`), read from the opened
    /// directory itself. `each` runs before every name is kept and may stop the listing.
    pub(super) fn names<E>(
        &self,
        mut each: impl FnMut() -> Result<(), E>,
        failed: impl Fn(io::Error) -> E,
    ) -> Result<Vec<Vec<u8>>, E> {
        let duplicate = self.0.try_clone().map_err(&failed)?.into_raw_fd();
        // SAFETY: `duplicate` is a live descriptor we own; on success the stream owns it.
        let raw = unsafe { libc::fdopendir(duplicate) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir failed, so the descriptor is still ours to close.
            unsafe { libc::close(duplicate) };
            return Err(failed(error));
        }
        let stream = Stream(raw);
        // A duplicate shares the file offset; always read from the start.
        // SAFETY: a live stream.
        unsafe { libc::rewinddir(stream.0) };
        let mut names = Vec::new();
        loop {
            clear_errno();
            // SAFETY: a live stream; the entry stays valid until the next readdir.
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(0) {
                    return Err(failed(error));
                }
                return Ok(names);
            }
            // SAFETY: readdir returned a live entry that stays valid until the next
            // readdir. Its record may be shorter than the declared `d_name` array, so
            // only the field's address is formed (never a reference to the array);
            // the kernel NUL-terminates the name within the record.
            let name = unsafe { std::ptr::addr_of!((*entry).d_name) }.cast::<libc::c_char>();
            // SAFETY: `name` points at the NUL-terminated name of the live entry.
            let child = unsafe { CStr::from_ptr(name) }.to_bytes();
            if child == b"." || child == b".." {
                continue;
            }
            each()?;
            names.push(child.to_vec());
        }
    }
}
