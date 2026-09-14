use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

#[derive(Serialize)]
pub struct Export {
    pub run: String,
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: usize,
    pub files: usize,
    pub original_retained: bool,
}

/// Export private, bounded archive evidence without deleting the consumed attempt reservation.
pub fn export(candidate: &Candidate, run: &str) -> Result<Export, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let root = archive::path(candidate, run)?;
    state::check_private_directory(&root)?;
    let receipt: Receipt = state::read(&root.join("state.json"))?;
    if receipt.version != 1
        || receipt.run != run
        || receipt.phase != "removed"
        || receipt.owner != engine.guest().incarnation()
    {
        return Err(error(
            "graph_export_identity",
            "Archive identity differs from the owned removed attempt.",
        ));
    }
    let mut files = BTreeMap::new();
    collect(&root, &root, 0, &mut files, &mut 0, &mut 128)?;
    let mut tar = tar::Builder::new(Vec::new());
    for (name, bytes) in &files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_mtime(0);
        header.set_cksum();
        tar.append_data(&mut header, name, bytes.as_slice())
            .map_err(state::io)?;
    }
    let bytes = tar.into_inner().map_err(state::io)?;
    let parent = candidate.state_root.join("exports/graphs");
    state::private_directory(&parent)?;
    let path = parent.join(format!("{run}.tar"));
    let pending = parent.join(format!("{run}.pending"));
    if path.exists() || path.is_symlink() {
        return Err(error(
            "graph_export_exists",
            "Export already exists and will not be overwritten.",
        ));
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .map_err(state::io)?;
    output.write_all(&bytes).map_err(state::io)?;
    output.sync_all().map_err(state::io)?;
    fs::rename(&pending, &path).map_err(state::io)?;
    fs::File::open(&parent)
        .map_err(state::io)?
        .sync_all()
        .map_err(state::io)?;
    Ok(Export {
        run: run.into(),
        path,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len(),
        files: files.len(),
        original_retained: true,
    })
}

fn collect(
    root: &Path,
    directory: &Path,
    depth: usize,
    files: &mut BTreeMap<PathBuf, Vec<u8>>,
    total: &mut usize,
    remaining: &mut usize,
) -> Result<(), CandidateError> {
    state::check_private_directory(directory)?;
    if depth > 3 {
        return Err(error(
            "graph_export_budget",
            "Archive nesting exceeds the export budget.",
        ));
    }
    let entries = fs::read_dir(directory)
        .map_err(state::io)?
        .take(129)
        .collect::<Result<Vec<_>, _>>()
        .map_err(state::io)?;
    if entries.len() > *remaining {
        return Err(error(
            "graph_export_budget",
            "Archive directory exceeds the export budget.",
        ));
    }
    *remaining -= entries.len();
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(state::io)?;
        if metadata.is_dir() {
            collect(root, &path, depth + 1, files, total, remaining)?;
            continue;
        }
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
            .map_err(state::io)?;
        let opened = file.metadata().map_err(state::io)?;
        if !opened.is_file()
            || opened.nlink() != 1
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
            || opened.dev() != metadata.dev()
            || opened.ino() != metadata.ino()
            || opened.len() > 1024 * 1024
        {
            return Err(error(
                "graph_export_file",
                "Archive contains an unsafe or oversized evidence file.",
            ));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(state::io)?;
        let after = fs::symlink_metadata(&path).map_err(state::io)?;
        if bytes.len() as u64 != opened.len()
            || after.dev() != opened.dev()
            || after.ino() != opened.ino()
            || after.nlink() != 1
            || after.len() != opened.len()
            || after.modified().ok() != opened.modified().ok()
            || files.len() >= 128
            || *total + bytes.len() > 16 * 1024 * 1024
        {
            return Err(error(
                "graph_export_budget",
                "Archive changed or exceeds 128 files / 16 MiB.",
            ));
        }
        *total += bytes.len();
        files.insert(
            path.strip_prefix(root)
                .expect("archive child")
                .to_path_buf(),
            bytes,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn collector_preserves_bytes_and_refuses_aliases_and_oversize() {
        let fixture = super::super::tests::Fixture::new();
        let path = fixture.0.join("evidence");
        fs::write(&path, b"{partial journal").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut files = BTreeMap::new();
        collect(&fixture.0, &fixture.0, 0, &mut files, &mut 0, &mut 128).unwrap();
        assert_eq!(files[Path::new("evidence")], b"{partial journal");
        let alias = fixture.0.join("alias");
        symlink(&path, &alias).unwrap();
        assert!(
            collect(
                &fixture.0,
                &fixture.0,
                0,
                &mut BTreeMap::new(),
                &mut 0,
                &mut 128
            )
            .is_err()
        );
        fs::remove_file(&alias).unwrap();
        fs::hard_link(&path, &alias).unwrap();
        assert!(
            collect(
                &fixture.0,
                &fixture.0,
                0,
                &mut BTreeMap::new(),
                &mut 0,
                &mut 128
            )
            .is_err()
        );
        fs::remove_file(&alias).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(1024 * 1024 + 1)
            .unwrap();
        assert!(
            collect(
                &fixture.0,
                &fixture.0,
                0,
                &mut BTreeMap::new(),
                &mut 0,
                &mut 128
            )
            .is_err()
        );
    }
}
