//! Bounded, fresh observation of the owned process's disk descriptors.
use super::identity::{self, ProcessIdentity};
use crate::CandidateError;
use std::path::Path;

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
    const MAX_FDS: usize = 4096;
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
    let mut entries = vec![
        libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0
        };
        MAX_FDS
    ];
    let bytes = std::mem::size_of_val(entries.as_slice());
    // SAFETY: initialized, aligned buffer holds exactly MAX_FDS native records.
    let read = unsafe {
        libc::proc_pidinfo(
            process.pid,
            libc::PROC_PIDLISTFDS,
            0,
            entries.as_mut_ptr().cast(),
            bytes as i32,
        )
    };
    let count = record_count(read, bytes, std::mem::size_of::<libc::proc_fdinfo>())?;
    let mut found = vec![false; expected.len()];
    for entry in &entries[..count] {
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
        if read as usize != std::mem::size_of::<VnodePath>() {
            return Err(unavailable());
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

#[cfg(not(target_os = "macos"))]
pub(super) fn verify(
    _: &ProcessIdentity,
    _: &Path,
    _: &[std::path::PathBuf],
) -> Result<(), CandidateError> {
    Err(unavailable())
}

#[cfg(any(target_os = "macos", test))]
fn record_count(read: i32, capacity: usize, size: usize) -> Result<usize, CandidateError> {
    if read <= 0 || read as usize >= capacity || read as usize % size != 0 {
        return Err(unavailable());
    }
    Ok(read as usize / size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_or_full_descriptor_buffers_are_refused() {
        for read in [-1, 0, 7, 32, 40] {
            assert!(record_count(read, 32, 8).is_err());
        }
        assert_eq!(record_count(24, 32, 8).unwrap(), 3);
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
            "hack-audit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
