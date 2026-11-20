//! Linux: holds read from `/proc`, as `lsof` reads them.
//!
//! For each process: every entry of `/proc/<pid>/fd`, by the status of the open file the
//! entry leads to, and every file-backed line of `/proc/<pid>/maps`. The kernel lets a user
//! read these for the user's own processes only; another user's process, or one that made
//! itself undumpable, answers `EACCES`.
use super::{Disk, Ended, Hold, Holder, Method};
use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

/// How an error about one process ends that process's inspection. A vanished entry means
/// the process, or the descriptor asked about, is gone.
fn ended(what: &str, error: &io::Error) -> Ended {
    match error.raw_os_error() {
        Some(libc::ENOENT | libc::ESRCH) => Ended::Exited,
        Some(libc::EACCES | libc::EPERM) => Ended::NotInspectable,
        _ => Ended::Unknown(format!("{what}: {error}")),
    }
}

/// One file-backed line of `/proc/<pid>/maps`:
/// `start-end perms offset major:minor inode   name`.
#[derive(Debug, PartialEq, Eq)]
struct Mapped<'a> {
    major: u32,
    minor: u32,
    inode: u64,
    /// The mapped file's name as the kernel prints it, or empty.
    name: &'a [u8],
}

impl<'a> Mapped<'a> {
    /// `None` for a line that is not in the format above.
    fn parse(line: &'a [u8]) -> Option<Self> {
        let mut fields = line.splitn(6, |byte| *byte == b' ');
        let (_range, _permissions, _offset) = (fields.next()?, fields.next()?, fields.next()?);
        let device = std::str::from_utf8(fields.next()?).ok()?;
        let (major, minor) = device.split_once(':')?;
        let inode = std::str::from_utf8(fields.next()?).ok()?;
        let name = fields.next().unwrap_or_default();
        let padding = name.iter().take_while(|byte| **byte == b' ').count();
        Some(Self {
            major: u32::from_str_radix(major, 16).ok()?,
            minor: u32::from_str_radix(minor, 16).ok()?,
            inode: inode.parse().ok()?,
            name: &name[padding..],
        })
    }
}

/// Every scan runs in this process: it reads only documented `/proc` files, so there is no
/// undeclared query to test first.
pub(super) fn method() -> Method {
    Method::InProcess
}

/// Every process `/proc` lists. `Err` says why the list could not be read.
pub(super) fn processes() -> Result<Vec<i32>, String> {
    let unknown = |error: io::Error| format!("process list: {error}");
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc").map_err(unknown)? {
        let name = entry.map_err(unknown)?.file_name();
        if let Some(pid) = name.to_str().and_then(|name| name.parse::<i32>().ok())
            && pid > 0
        {
            pids.push(pid);
        }
    }
    if pids.is_empty() {
        return Err("process list: empty".into());
    }
    Ok(pids)
}

/// Reads one process at a time.
pub(super) struct Inspector;

impl Inspector {
    pub(super) fn new() -> Self {
        Self
    }

    /// Record every hold `pid` has on `disks`.
    pub(super) fn inspect(
        &mut self,
        pid: i32,
        disks: &[Disk],
        holders: &mut Vec<Holder>,
    ) -> Result<(), Ended> {
        descriptors(pid, disks, holders)?;
        mappings(pid, disks, holders)
    }
}

fn descriptors(pid: i32, disks: &[Disk], holders: &mut Vec<Holder>) -> Result<(), Ended> {
    let listing = |error: io::Error| ended("descriptor list", &error);
    for entry in std::fs::read_dir(format!("/proc/{pid}/fd")).map_err(listing)? {
        let link = entry.map_err(listing)?.path();
        // Following the entry reads the status of the open file itself, whatever name it
        // has now and even when it has none.
        let open = match std::fs::metadata(&link) {
            Ok(open) => open,
            Err(error) => match ended("descriptor", &error) {
                // Closed since it was listed, or not this user's to read: not a hold this
                // scan may see.
                Ended::Exited | Ended::NotInspectable => continue,
                unknown => return Err(unknown),
            },
        };
        let held = disks
            .iter()
            .find(|disk| disk.device == open.dev() && disk.inode == open.ino());
        if let Some(disk) = held {
            Holder::record(holders, pid, Hold::Descriptor, disk, || {
                std::fs::read_link(&link).ok()
            });
        }
    }
    Ok(())
}

fn mappings(pid: i32, disks: &[Disk], holders: &mut Vec<Holder>) -> Result<(), Ended> {
    let maps = std::fs::read(format!("/proc/{pid}/maps"))
        .map_err(|error| ended("mapping list", &error))?;
    for line in maps.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Some(mapped) = Mapped::parse(line) else {
            return Err(Ended::Unknown("mapping list: unreadable line".into()));
        };
        for disk in disks.iter().filter(|disk| disk.inode == mapped.inode) {
            if maps_disk(pid, &mapped, disk)? {
                Holder::record(holders, pid, Hold::Mapping, disk, || {
                    (!mapped.name.is_empty()).then(|| PathBuf::from(OsStr::from_bytes(mapped.name)))
                });
            }
        }
    }
    Ok(())
}

/// Whether a mapping with a disk's inode number maps that disk.
///
/// With the same device it does. Some filesystems (btrfs subvolumes, overlays) print one
/// device in `maps` and report another in a file's status, where the disk's identity comes
/// from, so a different device does not rule the disk out. The status of the mapped name,
/// as the process sees it, settles that case; a name that cannot be read leaves it unknown.
fn maps_disk(pid: i32, mapped: &Mapped<'_>, disk: &Disk) -> Result<bool, Ended> {
    let device = disk.device as libc::dev_t;
    if (libc::major(device), libc::minor(device)) == (mapped.major, mapped.minor) {
        return Ok(true);
    }
    let mut seen = PathBuf::from(format!("/proc/{pid}/root"));
    seen.as_mut_os_string().push(OsStr::from_bytes(mapped.name));
    match std::fs::metadata(&seen) {
        Ok(file) => Ok(file.dev() == disk.device && file.ino() == disk.inode),
        Err(error) => Err(Ended::Unknown(format!(
            "mapping: a file with an owned disk's inode number on another device: {error}"
        ))),
    }
}

#[cfg(test)]
mod tests;
