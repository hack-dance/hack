//! Immutable, bounded socket receipts. Recovery never signals a recorded process.
use super::super::{identity, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};
fn error() -> CandidateError {
    CandidateError::new(
        "authority_ownership",
        "Authority identity is uncertain; preserve socket and receipt.",
    )
}
fn receipt(socket: &Path) -> PathBuf {
    let mut name = socket.as_os_str().to_os_string();
    name.push(".identity");
    name.into()
}
fn present(path: &Path) -> bool {
    path.exists() || path.is_symlink()
}
fn parent(socket: &Path) -> Result<fs::Metadata, CandidateError> {
    if !socket.is_absolute() || socket.as_os_str().len() > 100 {
        return Err(error());
    }
    let parent = socket.parent().ok_or_else(error)?;
    state::check_private_directory(parent)?;
    let m = fs::symlink_metadata(parent).map_err(state::io)?;
    if !m.is_dir() {
        return Err(error());
    }
    Ok(m)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    checkout: PathBuf,
    process: identity::ProcessIdentity,
    socket: PathBuf,
    parent: (u64, u64),
    endpoint: (u64, u64),
}
pub(super) struct Owner {
    socket: PathBuf,
    device: u64,
    inode: u64,
    receipt: Option<(u64, u64)>,
}
impl Owner {
    pub(super) fn absent(socket: &Path) -> Result<(), CandidateError> {
        parent(socket)?;
        if present(&receipt(socket)) {
            Err(error())
        } else {
            Ok(())
        }
    }
    pub(super) fn new(socket: &Path, m: &fs::Metadata) -> Self {
        Self {
            socket: socket.into(),
            device: m.dev(),
            inode: m.ino(),
            receipt: None,
        }
    }
    pub(super) fn record(&mut self, c: &Candidate) -> Result<(), CandidateError> {
        let directory = parent(&self.socket)?;
        let value = Receipt {
            version: 1,
            checkout: c.checkout.clone(),
            process: identity::observe(std::process::id() as i32)?,
            socket: self.socket.clone(),
            parent: (directory.dev(), directory.ino()),
            endpoint: (self.device, self.inode),
        };
        let bytes = serde_json::to_vec(&value).map_err(|_| error())?;
        if bytes.len() > 4096 {
            return Err(error());
        }
        let path = receipt(&self.socket);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(state::io)?;
        let m = file.metadata().map_err(state::io)?;
        self.receipt = Some((m.dev(), m.ino()));
        file.write_all(&bytes).map_err(state::io)?;
        file.sync_all().map_err(state::io)?;
        File::open(self.socket.parent().ok_or_else(error)?)
            .map_err(state::io)?
            .sync_all()
            .map_err(state::io)
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        match fs::symlink_metadata(&self.socket) {
            Ok(m)
                if m.file_type().is_socket() && m.dev() == self.device && m.ino() == self.inode =>
            {
                if fs::remove_file(&self.socket).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return,
        }
        if let Some((device, inode)) = self.receipt {
            let path = receipt(&self.socket);
            if let Ok(m) = fs::symlink_metadata(&path)
                && m.is_file()
                && m.dev() == device
                && m.ino() == inode
            {
                let _ = fs::remove_file(path);
            }
        }
        if let Some(p) = self.socket.parent()
            && let Ok(file) = File::open(p)
        {
            let _ = file.sync_all();
        }
    }
}
struct ReadReceipt {
    file: File,
    metadata: fs::Metadata,
    bytes: Vec<u8>,
    value: Receipt,
}
fn read(c: &Candidate, socket: &Path) -> Result<ReadReceipt, CandidateError> {
    let directory = parent(socket)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(receipt(socket))
        .map_err(state::io)?;
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 4096
    {
        return Err(error());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() > 4096 {
        return Err(error());
    }
    let value: Receipt = serde_json::from_slice(&bytes).map_err(|_| error())?;
    if value.version != 1
        || value.checkout != c.checkout
        || value.socket != socket
        || value.parent != (directory.dev(), directory.ino())
        || value.endpoint.1 == 0
        || value.process.pid <= 1
        || value.process.start_micros == 0
        || value.process.uid != unsafe { libc::geteuid() }
        || !value.process.executable.is_absolute()
    {
        return Err(error());
    }
    Ok(ReadReceipt {
        file,
        metadata,
        bytes,
        value,
    })
}
pub fn inspect(c: &Candidate, socket: &Path) -> Result<serde_json::Value, CandidateError> {
    parent(socket)?;
    if !present(&receipt(socket)) {
        if present(socket) {
            return Err(error());
        }
        return Ok(serde_json::json!({"present":false}));
    }
    let read = read(c, socket)?;
    Ok(
        serde_json::json!({"present":true,"sha256":format!("{:x}",Sha256::digest(&read.bytes)),"process_present":identity::alive(read.value.process.pid)?,"socket_present":present(socket)}),
    )
}
pub fn recover(
    c: &Candidate,
    socket: &Path,
    expected: &str,
) -> Result<serde_json::Value, CandidateError> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error());
    }
    parent(socket)?;
    if !present(&receipt(socket)) {
        if present(socket) {
            return Err(error());
        }
        return Ok(serde_json::json!({"recovered":true,"already_absent":true}));
    }
    let original = read(c, socket)?;
    if unsafe { libc::flock(original.file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(error());
    }
    if format!("{:x}", Sha256::digest(&original.bytes)) != expected
        || identity::alive(original.value.process.pid)?
    {
        return Err(error());
    }
    let current = read(c, socket)?;
    if current.bytes != original.bytes
        || current.metadata.dev() != original.metadata.dev()
        || current.metadata.ino() != original.metadata.ino()
    {
        return Err(error());
    }
    if present(socket) {
        let m = fs::symlink_metadata(socket).map_err(state::io)?;
        if !m.file_type().is_socket()
            || m.uid() != original.value.process.uid
            || m.mode() & 0o077 != 0
            || m.nlink() != 1
            || (m.dev(), m.ino()) != original.value.endpoint
        {
            return Err(error());
        }
        fs::remove_file(socket).map_err(state::io)?;
    }
    fs::remove_file(receipt(socket)).map_err(state::io)?;
    File::open(socket.parent().ok_or_else(error)?)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    Ok(serde_json::json!({"recovered":true,"already_absent":false}))
}
