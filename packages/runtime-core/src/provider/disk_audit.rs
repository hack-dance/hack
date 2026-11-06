//! Bounded, fresh observation of the owned process's disk descriptors.
#[cfg(target_os = "macos")]
use super::identity;
use super::identity::ProcessIdentity;
use crate::CandidateError;
use std::path::Path;

/// First descriptor-list capacity when the kernel's sizing estimate is unusable.
#[cfg(any(target_os = "macos", test))]
const INITIAL_FDS: usize = 4096;
/// Hard ceiling on listed descriptor records (8 bytes each, so 8 MiB at most).
///
/// The audit proves that the owned provider process holds the expected disk
/// images; every other descriptor is only classified and skipped. A provider that
/// shares a project source holds one host descriptor per guest-open shared file
/// (dev servers, file watchers, `tail -f`), so ordinary projects exceed a few
/// thousand. The listing therefore grows to the process's actual table and only
/// refuses above this ceiling, which is above the default macOS per-process limit
/// (`kern.maxfilesperproc`). A table that cannot be listed completely is refused:
/// a truncated listing is never treated as evidence.
#[cfg(any(target_os = "macos", test))]
const MAX_FDS: usize = 1 << 20;

fn unavailable() -> CandidateError {
    CandidateError::new(
        "unaudited_provider_config",
        "Cannot confirm the provider's disk descriptors.",
    )
}

#[cfg(target_os = "macos")]
pub(super) fn verify(
    process: &ProcessIdentity,
    binary: &Path,
    expected: &[std::path::PathBuf],
) -> Result<(), CandidateError> {
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    // SDK sys/proc_info.h: proc_fileinfo followed by vnode_info_path.
    #[repr(C)]
    struct FileInfo {
        flags: u32,
        status: u32,
        offset: i64,
        kind: i32,
        guard: u32,
    }
    #[repr(C)]
    struct VnodePath {
        file: FileInfo,
        vnode: libc::vnode_info_path,
    }
    const VNODE_PATH_INFO: i32 = 2;
    if expected.is_empty() || expected.len() > 2 {
        return Err(unavailable());
    }
    let uid = unsafe { libc::geteuid() };
    identity::verify(process, &identity::observe(process.pid)?, binary, uid)?;
    let disks = expected
        .iter()
        .map(|path| {
            let metadata = std::fs::symlink_metadata(path).map_err(|_| unavailable())?;
            if !metadata.is_file() || metadata.uid() != uid || metadata.nlink() != 1 {
                return Err(unavailable());
            }
            Ok((metadata.dev(), metadata.ino()))
        })
        .collect::<Result<Vec<_>, CandidateError>>()?;
    let entries = list_descriptors(process.pid)?;
    let mut found = vec![false; expected.len()];
    for entry in &entries {
        if entry.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
            continue;
        }
        let mut info = std::mem::MaybeUninit::<VnodePath>::zeroed();
        // SAFETY: SDK-compatible, aligned writable record; exact size checked before access.
        let read = unsafe {
            libc::proc_pidfdinfo(
                process.pid,
                entry.proc_fd,
                VNODE_PATH_INFO,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<VnodePath>() as i32,
            )
        };
        // A listed unrelated vnode may close while the provider handles an RPC.
        // EBADF proves this descriptor vanished; it is not evidence for a disk.
        // Every expected disk must still be positively observed below.
        let errno = (read <= 0)
            .then(|| std::io::Error::last_os_error().raw_os_error())
            .flatten();
        if !vnode_record_available(read, std::mem::size_of::<VnodePath>(), errno)? {
            continue;
        }
        let info = unsafe { info.assume_init() };
        let bytes: [u8; 1024] = std::array::from_fn(|i| info.vnode.vip_path[i / 32][i % 32] as u8);
        let end = bytes.iter().position(|v| *v == 0).ok_or_else(unavailable)?;
        let path = Path::new(std::ffi::OsStr::from_bytes(&bytes[..end]));
        let canonical = path.canonicalize().ok();
        let stat = info.vnode.vip_vi.vi_stat;
        for (index, expected) in expected.iter().enumerate() {
            if canonical.as_ref() == Some(expected)
                && (u64::from(stat.vst_dev), stat.vst_ino) == disks[index]
            {
                found[index] = true;
            }
        }
    }
    identity::verify(process, &identity::observe(process.pid)?, binary, uid)?;
    for (path, recorded) in expected.iter().zip(disks) {
        let now = std::fs::symlink_metadata(path).map_err(|_| unavailable())?;
        if !now.is_file()
            || now.uid() != uid
            || now.nlink() != 1
            || (now.dev(), now.ino()) != recorded
        {
            return Err(unavailable());
        }
    }
    if found.iter().any(|v| !v) {
        return Err(unavailable());
    }
    Ok(())
}

/// Complete descriptor table of `pid`, or a refusal. The buffer starts from the
/// kernel's sizing estimate and doubles while the reply fills it, up to `MAX_FDS`.
#[cfg(target_os = "macos")]
fn list_descriptors(pid: i32) -> Result<Vec<libc::proc_fdinfo>, CandidateError> {
    let size = std::mem::size_of::<libc::proc_fdinfo>();
    // SAFETY: a null buffer with zero size only asks for the kernel's estimate.
    let estimate =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    let mut capacity = initial_capacity(estimate, size);
    loop {
        let mut entries = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0
            };
            capacity
        ];
        let bytes = std::mem::size_of_val(entries.as_slice());
        let bytes_arg = i32::try_from(bytes).map_err(|_| unavailable())?;
        // SAFETY: initialized, aligned buffer holds exactly `capacity` native records.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                entries.as_mut_ptr().cast(),
                bytes_arg,
            )
        };
        match record_count(read, bytes, size)? {
            Some(count) => {
                entries.truncate(count);
                return Ok(entries);
            }
            None => capacity = next_capacity(capacity).ok_or_else(unavailable)?,
        }
    }
}

/// Records for the first listing: the kernel estimate (table size plus slack)
/// with headroom for descriptors opened before the listing, within the bounds.
#[cfg(any(target_os = "macos", test))]
fn initial_capacity(estimate: i32, size: usize) -> usize {
    usize::try_from(estimate)
        .ok()
        .filter(|bytes| *bytes > 0)
        .map_or(INITIAL_FDS, |bytes| bytes / size + 64)
        .clamp(INITIAL_FDS, MAX_FDS)
}

/// Doubled capacity after a full reply, or `None` once the ceiling was listed.
#[cfg(any(target_os = "macos", test))]
fn next_capacity(current: usize) -> Option<usize> {
    (current < MAX_FDS).then(|| current.saturating_mul(2).min(MAX_FDS))
}

#[cfg(not(target_os = "macos"))]
pub(super) fn verify(
    _: &ProcessIdentity,
    _: &Path,
    _: &[std::path::PathBuf],
) -> Result<(), CandidateError> {
    Err(unavailable())
}

/// Complete record count, `None` for a reply that filled the buffer (possibly
/// truncated, so the caller must list again with more room), or a refusal.
#[cfg(any(target_os = "macos", test))]
fn record_count(read: i32, capacity: usize, size: usize) -> Result<Option<usize>, CandidateError> {
    let Some(read) = usize::try_from(read).ok().filter(|read| *read > 0) else {
        return Err(unavailable());
    };
    if read % size != 0 || read > capacity {
        return Err(unavailable());
    }
    if read == capacity {
        return Ok(None);
    }
    Ok(Some(read / size))
}

#[cfg(any(target_os = "macos", test))]
fn vnode_record_available(
    read: i32,
    size: usize,
    errno: Option<i32>,
) -> Result<bool, CandidateError> {
    if read <= 0 && errno == Some(libc::EBADF) {
        return Ok(false);
    }
    if read <= 0 || read as usize != size {
        return Err(unavailable());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_vanished_descriptor_is_skipped_without_disk_evidence() {
        assert!(!vnode_record_available(0, 128, Some(libc::EBADF)).unwrap());
        assert!(!vnode_record_available(-1, 128, Some(libc::EBADF)).unwrap());
        for errno in [
            None,
            Some(libc::EPERM),
            Some(libc::ESRCH),
            Some(libc::EINVAL),
        ] {
            assert!(vnode_record_available(0, 128, errno).is_err());
        }
        assert!(vnode_record_available(64, 128, Some(libc::EBADF)).is_err());
        assert!(vnode_record_available(128, 128, None).unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn closing_a_listed_vnode_returns_the_expected_race_errno() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Child(Command::new("/bin/sh").args(["-c", "exec 3</dev/null; printf 'ready\\n'; read -r first; exec 3<&-; printf 'closed\\n'; read -r last"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap());
        let mut output = BufReader::new(child.0.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line, "ready\n");
        let pid = child.0.id() as i32;
        let mut entries = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0
            };
            4096
        ];
        // SAFETY: initialized writable native-record buffer and owned child PID.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                entries.as_mut_ptr().cast(),
                std::mem::size_of_val(entries.as_slice()) as i32,
            )
        };
        let count = record_count(
            read,
            std::mem::size_of_val(entries.as_slice()),
            std::mem::size_of::<libc::proc_fdinfo>(),
        )
        .unwrap()
        .unwrap();
        assert!(
            entries[..count]
                .iter()
                .any(|entry| entry.proc_fd == 3
                    && entry.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
        );
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"close\n")
            .unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line, "closed\n");
        let mut bytes = [0_u64; 256];
        // SAFETY: aligned oversized writable buffer; owned child acknowledged FD closure.
        let read = unsafe {
            libc::proc_pidfdinfo(
                pid,
                3,
                2,
                bytes.as_mut_ptr().cast(),
                std::mem::size_of_val(&bytes) as i32,
            )
        };
        let errno = std::io::Error::last_os_error().raw_os_error();
        assert!(read <= 0);
        assert_eq!(errno, Some(libc::EBADF));
        assert!(!vnode_record_available(read, 128, errno).unwrap());
    }

    #[test]
    fn incomplete_descriptor_buffers_are_refused_and_full_ones_grow() {
        for read in [-1, 0, 7, 33, 40] {
            assert!(record_count(read, 32, 8).is_err());
        }
        assert_eq!(record_count(24, 32, 8).unwrap(), Some(3));
        // A reply that fills the buffer may be truncated: list again, never trust it.
        assert_eq!(record_count(32, 32, 8).unwrap(), None);
    }

    #[test]
    fn descriptor_capacity_follows_the_table_within_a_hard_ceiling() {
        assert_eq!(initial_capacity(-1, 8), INITIAL_FDS);
        assert_eq!(initial_capacity(0, 8), INITIAL_FDS);
        assert_eq!(initial_capacity(100 * 8, 8), INITIAL_FDS);
        assert_eq!(initial_capacity(5_200 * 8, 8), 5_264);
        assert_eq!(initial_capacity(i32::MAX, 8), MAX_FDS);
        assert_eq!(next_capacity(INITIAL_FDS), Some(2 * INITIAL_FDS));
        assert_eq!(next_capacity(MAX_FDS - 1), Some(MAX_FDS));
        assert_eq!(next_capacity(MAX_FDS), None);
        let mut capacity = INITIAL_FDS;
        let mut listings = 1;
        while let Some(next) = next_capacity(capacity) {
            capacity = next;
            listings += 1;
        }
        assert_eq!(capacity, MAX_FDS);
        assert!(listings <= 9, "growth is bounded");
    }

    /// HACK-1917: a provider sharing a project source holds a host descriptor for
    /// every guest-open file. More than 4,096 unrelated descriptors (here with the
    /// disks opened last, at the highest numbers) must not hide the owned disks.
    #[cfg(target_os = "macos")]
    #[test]
    fn owned_disks_are_found_among_more_than_four_thousand_descriptors() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = std::env::temp_dir().join(format!(
            "hack-audit-many-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let shared = root.join("shared-source-file");
        std::fs::write(&shared, b"source").unwrap();
        let paths = [root.join("storage.raw"), root.join("overlay.raw")];
        for path in &paths {
            std::fs::write(path, b"owned").unwrap();
        }
        let mut child = Child(
            Command::new("/bin/zsh")
                .args([
                    "-fc",
                    "ulimit -n 8192 || exit 3; integer i=0; while (( i < 5000 )); do exec {fd}<\"$1\"; (( i++ )); done; exec {a}<\"$2\" {b}<\"$3\"; print ready; read -r answer",
                    "audit",
                ])
                .arg(&shared)
                .args(&paths)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        BufReader::new(child.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "ready\n");
        let pid = child.0.id() as i32;
        assert!(list_descriptors(pid).unwrap().len() > 5_000);
        let process = identity::observe(pid).unwrap();
        verify(&process, &process.executable, &paths).unwrap();
        let missing = root.join("missing.raw");
        std::fs::write(&missing, b"not open").unwrap();
        assert!(verify(&process, &process.executable, &[missing]).is_err());
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"done\n")
            .unwrap();
        child.0.wait().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn owned_disks_missing_disks_replacement_and_process_identity() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root = std::env::temp_dir().join(format!(
            "hack-audit-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let paths = [root.join("storage.raw"), root.join("overlay.raw")];
        for path in &paths {
            std::fs::write(path, b"owned").unwrap();
        }
        let mut child = Child(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    "exec 3<\"$1\" 4<\"$2\"; printf 'ready\\n'; read -r answer",
                    "audit",
                ])
                .args(&paths)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        BufReader::new(child.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "ready\n");
        let process = identity::observe(child.0.id() as i32).unwrap();
        verify(&process, &process.executable, &paths).unwrap();
        let missing = root.join("missing.raw");
        std::fs::write(&missing, b"not open").unwrap();
        assert!(verify(&process, &process.executable, &[missing]).is_err());
        let mut stale = process.clone();
        stale.start_micros += 1;
        assert!(verify(&stale, &process.executable, &paths).is_err());
        std::fs::rename(&paths[0], root.join("old.raw")).unwrap();
        std::fs::write(&paths[0], b"replacement").unwrap();
        assert!(verify(&process, &process.executable, &paths).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(verify(&process, &process.executable, &paths).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
