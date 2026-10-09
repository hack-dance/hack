//! Fixed Linux filesystem boundary. Every ancestor is opened without following
//! symlinks and retained until completion. Fresh canonical traversal and each
//! retained FD must still identify the original directory chain at every check.
use super::*;
use std::{
    ffi::CString,
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::fs::MetadataExt,
    },
};

pub(super) struct Directory {
    components: Vec<String>,
    files: Vec<File>,
    roots: Vec<Root>,
}
pub(super) struct Linux;
fn root(file: &File) -> Result<Root, CandidateError> {
    let info = file.metadata().map_err(|_| refused())?;
    if !info.is_dir() || info.ino() == 0 {
        return Err(refused());
    }
    Ok(Root {
        device: info.dev(),
        inode: info.ino(),
        uid: info.uid(),
        gid: info.gid(),
    })
}
fn open(volume: &str) -> Result<Directory, CandidateError> {
    if !volume_valid(volume) {
        return Err(refused());
    }
    open_components(&["var", "lib", "docker", "volumes", volume, "_data"])
}
fn open_components(components: &[&str]) -> Result<Directory, CandidateError> {
    if components.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.contains('/')
            || part.contains('\0')
    }) {
        return Err(refused());
    }
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: a fixed NUL-terminated root path and read-only directory flags.
    let first = unsafe { libc::open(c"/".as_ptr(), flags) };
    if first < 0 {
        return Err(refused());
    }
    // SAFETY: successful open returned one new owned FD, adopted exactly once.
    let mut files = vec![unsafe { File::from_raw_fd(first) }];
    let mut roots = vec![root(&files[0])?];
    for component in components {
        let name = CString::new(*component).map_err(|_| refused())?;
        // SAFETY: live retained parent FD and exact single validated component.
        let fd = unsafe {
            libc::openat(
                files.last().ok_or_else(refused)?.as_raw_fd(),
                name.as_ptr(),
                flags,
            )
        };
        if fd < 0 {
            return Err(refused());
        }
        // SAFETY: successful openat returned one new owned FD, adopted once.
        let child = unsafe { File::from_raw_fd(fd) };
        // SAFETY: F_GETFD only observes flags on this live owned FD.
        let fd_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if fd_flags < 0 || fd_flags & libc::FD_CLOEXEC == 0 {
            return Err(refused());
        }
        roots.push(root(&child)?);
        files.push(child);
    }
    Ok(Directory {
        components: components.iter().map(|part| (*part).into()).collect(),
        files,
        roots,
    })
}
fn close(held: Directory) -> Result<(), CandidateError> {
    let mut failed = false;
    for file in held.files.into_iter().rev() {
        let fd = file.into_raw_fd();
        // SAFETY: into_raw_fd transferred the owned FD; close is called once.
        // A failed close is uncertain. Never retry an FD that could be reused.
        if unsafe { libc::close(fd) } != 0 {
            failed = true;
        }
    }
    if failed { Err(refused()) } else { Ok(()) }
}
fn selected(held: &Directory) -> Result<&File, CandidateError> {
    held.files.last().ok_or_else(refused)
}
fn name(witness: &Witness) -> Result<CString, CandidateError> {
    let mut bytes = b"user.hack.storage.".to_vec();
    bytes.extend_from_slice(&witness.name);
    CString::new(bytes).map_err(|_| refused())
}
impl Kernel for Linux {
    type Directory = Directory;
    fn open(&mut self, volume: &str) -> Result<Directory, CandidateError> {
        open(volume)
    }
    fn check(&mut self, held: &Directory) -> Result<Root, CandidateError> {
        let before = held.files.iter().map(root).collect::<Result<Vec<_>, _>>()?;
        if before != held.roots {
            return Err(refused());
        }
        let components: Vec<_> = held.components.iter().map(String::as_str).collect();
        let current = open_components(&components)?;
        let same = current.roots == held.roots;
        close(current)?;
        let after = held.files.iter().map(root).collect::<Result<Vec<_>, _>>()?;
        if !same || after != held.roots {
            return Err(refused());
        }
        root(selected(held)?)
    }
    fn effective_identity(&self) -> (u32, u32) {
        // SAFETY: these functions only read the calling process credentials.
        unsafe { (libc::geteuid(), libc::getegid()) }
    }
    fn create(&mut self, held: &Directory, witness: &Witness) -> Result<(), CandidateError> {
        let name = name(witness)?;
        // SAFETY: borrowed live root FD, NUL-terminated name, exact32 initialized
        // bytes. XATTR_CREATE refuses an existing name; no replace operation exists.
        let result = unsafe {
            libc::fsetxattr(
                selected(held)?.as_raw_fd(),
                name.as_ptr(),
                witness.value.as_ptr().cast(),
                witness.value.len(),
                libc::XATTR_CREATE,
            )
        };
        if result == 0 { Ok(()) } else { Err(refused()) }
    }
    fn sync(&mut self, held: &Directory) -> Result<(), CandidateError> {
        selected(held)?.sync_all().map_err(|_| refused())
    }
    fn read(&mut self, held: &Directory, witness: &Witness) -> Result<[u8; 32], CandidateError> {
        let name = name(witness)?;
        let mut value = [0_u8; 32];
        // SAFETY: borrowed live FD/name and exact writable32-byte output buffer.
        // Missing, shorter and oversized xattrs all refuse; no partial result passes.
        let count = unsafe {
            libc::fgetxattr(
                selected(held)?.as_raw_fd(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        if count != value.len() as isize {
            value.zeroize();
            return Err(refused());
        }
        Ok(value)
    }
    fn close(&mut self, held: Directory) -> Result<(), CandidateError> {
        close(held)
    }
}

#[cfg(test)]
#[path = "linux/tests.rs"]
mod tests;
