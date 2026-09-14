//! Preserve interrupted bytes without trusting them as authority for runtime effects.
use super::{CandidateError, error, state};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) fn retain(root: &Path) -> Result<Option<PathBuf>, CandidateError> {
    retain_file(root, "state.pending", "recovery", 1024 * 1024)
}

pub(super) fn retain_file(
    root: &Path,
    name: &str,
    prefix: &str,
    limit: u64,
) -> Result<Option<PathBuf>, CandidateError> {
    state::check_private_directory(root)?;
    let pending = root.join(name);
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&pending)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !pending.is_symlink() => {
            return Ok(None);
        }
        Err(e) => return Err(state::io(e)),
    };
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > limit
    {
        return Err(error(
            "graph_journal_unsafe",
            "Interrupted graph journal must be a bounded private singly linked regular file.",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    let current = fs::symlink_metadata(&pending).map_err(state::io)?;
    if bytes.len() as u64 != metadata.len()
        || current.dev() != metadata.dev()
        || current.ino() != metadata.ino()
        || current.nlink() != 1
    {
        return Err(error(
            "graph_journal_changed",
            "Interrupted journal identity changed during inspection.",
        ));
    }
    file.sync_all().map_err(state::io)?;
    let mut selected = None;
    for index in 1..=8 {
        let directory = root.join(format!("{prefix}-{index}"));
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {
                selected = Some(directory);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(state::io(e)),
        }
    }
    let selected = selected.ok_or_else(|| {
        error(
            "graph_recovery_retention",
            "Eight recovery slots are retained; no journal was overwritten or deleted.",
        )
    })?;
    File::open(root)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    fs::rename(&pending, selected.join("interrupted.pending")).map_err(state::io)?;
    File::open(&selected)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    File::open(root)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    state::write(
        &selected.join("retention.json"),
        &serde_json::json!({"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"policy":"retained bytes are evidence only; never publication authority"}),
    )?;
    Ok(Some(selected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn partial_journal_is_preserved_and_retention_is_bounded() {
        let fixture = super::super::tests::Fixture::new();
        let pending = fixture.0.join("state.pending");
        fs::write(&pending, b"{partial journal").unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        let retained = retain(&fixture.0).unwrap().unwrap();
        assert_eq!(
            fs::read(retained.join("interrupted.pending")).unwrap(),
            b"{partial journal"
        );
        assert!(!pending.exists());
        assert!(retain(&fixture.0).unwrap().is_none());
        for index in 2..=8 {
            fs::create_dir(fixture.0.join(format!("recovery-{index}"))).unwrap();
        }
        fs::write(&pending, b"next partial").unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            retain(&fixture.0).unwrap_err().code,
            "graph_recovery_retention"
        );
        assert_eq!(fs::read(&pending).unwrap(), b"next partial");
    }
    #[test]
    fn journal_aliases_and_public_files_are_refused() {
        let fixture = super::super::tests::Fixture::new();
        let original = fixture.0.join("original");
        let pending = fixture.0.join("state.pending");
        fs::write(&original, b"retained").unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&original, &pending).unwrap();
        assert!(retain(&fixture.0).is_err());
        fs::remove_file(&pending).unwrap();
        fs::hard_link(&original, &pending).unwrap();
        assert!(retain(&fixture.0).is_err());
        fs::remove_file(&pending).unwrap();
        fs::rename(&original, &pending).unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(retain(&fixture.0).is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"retained");
    }
}
