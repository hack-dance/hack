//! Recovery runs only while the native launcher holds the stable OS lease.
use serde::Deserialize;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    dev: String,
    ino: String,
}
impl Identity {
    fn matches(&self, m: &Metadata) -> bool {
        self.dev == m.dev().to_string() && self.ino == m.ino().to_string()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    directory: Identity,
    lease: Identity,
    claim: Identity,
    socket: Identity,
}
fn uncertain() -> io::Error {
    io::Error::other("MCP stale ownership is uncertain; preserve socket, claim and receipt")
}
fn optional(path: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) fn recover(
    directory: &Path,
    parent: &Metadata,
    lease: &Metadata,
    uid: u32,
) -> io::Result<()> {
    let receipt_path = directory.join(".mcp-receipt.json");
    let claim_path = directory.join(".mcp-owner");
    let socket_path = directory.join("mcp.sock");
    let Some(_) = optional(&receipt_path)? else {
        if optional(&claim_path)?.is_some() || optional(&socket_path)?.is_some() {
            return Err(uncertain());
        }
        return Ok(());
    };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&receipt_path)?;
    let witness = file.metadata()?;
    if !witness.is_file()
        || witness.nlink() != 1
        || witness.uid() != uid
        || witness.mode() & 0o077 != 0
        || witness.len() > 4096
    {
        return Err(uncertain());
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(uncertain());
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| uncertain())?;
    if receipt.version != 1 || !receipt.directory.matches(parent) || !receipt.lease.matches(lease) {
        return Err(uncertain());
    }
    let claim = optional(&claim_path)?;
    let socket = optional(&socket_path)?;
    if let Some(m) = &claim {
        if !m.is_dir()
            || m.uid() != uid
            || m.mode() & 0o077 != 0
            || !receipt.claim.matches(m)
            || fs::read_dir(&claim_path)?.next().is_some()
        {
            return Err(uncertain());
        }
    }
    if let Some(m) = &socket {
        if claim.is_none()
            || !m.file_type().is_socket()
            || m.uid() != uid
            || m.mode() & 0o077 != 0
            || !receipt.socket.matches(m)
        {
            return Err(uncertain());
        }
    }
    // Receipt is removed last, so a process killed after either removal can retry.
    // Recheck every surviving identity immediately before changing its path.
    for (path, expected) in [
        (&socket_path, socket.as_ref()),
        (&claim_path, claim.as_ref()),
        (&receipt_path, Some(&witness)),
    ] {
        let Some(expected) = expected else {
            continue;
        };
        let current = fs::symlink_metadata(path)?;
        let root = fs::symlink_metadata(directory)?;
        let lock = fs::symlink_metadata(directory.join(".mcp-lease"))?;
        if current.dev() != expected.dev()
            || current.ino() != expected.ino()
            || root.dev() != parent.dev()
            || root.ino() != parent.ino()
            || lock.dev() != lease.dev()
            || lock.ino() != lease.ino()
        {
            return Err(uncertain());
        }
        if path == &claim_path {
            fs::remove_dir(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
