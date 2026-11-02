//! The sole sensitive-directory exception is an exact registered Codex worktree.
//! Git metadata proves the leaf's registration; it never expands the exported root.
use super::{current_uid, refused};
use crate::CandidateError;
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

/// Read only bounded Git path metadata, without invoking Git or reading its config.
pub(super) fn verify(project: &Path, home: &Path) -> Result<(), CandidateError> {
    if owned_directory(home)? != home {
        return Err(refused());
    }
    let container = home.join(".codex/worktrees");
    let relative = project.strip_prefix(&container).map_err(|_| refused())?;
    let components: Vec<_> = relative.components().collect();
    if components.len() != 2
        || components
            .iter()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(refused());
    }
    // The exception cannot inherit authority from an unsafe enclosing directory.
    for directory in [
        home.join(".codex"),
        container.clone(),
        container.join(components[0].as_os_str()),
        project.to_path_buf(),
    ] {
        if owned_directory(&directory)? != directory {
            return Err(refused());
        }
    }
    let dotgit = project.join(".git");
    let pointer = metadata_text(&dotgit)?;
    let pointer = pointer.strip_prefix("gitdir: ").ok_or_else(refused)?;
    if pointer.is_empty() {
        return Err(refused());
    }
    let gitdir = owned_directory(&project.join(pointer))?;
    let common = metadata_text(&gitdir.join("commondir"))?;
    let common = owned_directory(&gitdir.join(common))?;
    let registrations = common.join("worktrees");
    owned_directory(&registrations)?;
    // A registration is one immediate directory, not an arbitrary descendant.
    if gitdir.parent() != Some(registrations.as_path())
        || Path::new(&metadata_text(&gitdir.join("gitdir"))?) != dotgit
    {
        return Err(refused());
    }
    Ok(())
}

/// Resolve Git's relative `commondir` while checking components before `..`
/// normalization, so a pointer cannot hide traversal through a symlink.
fn owned_directory(path: &Path) -> Result<PathBuf, CandidateError> {
    if !path.is_absolute() {
        return Err(refused());
    }
    let mut checked = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !checked.pop() {
                    return Err(refused());
                }
            }
            Component::CurDir => {}
            _ => {
                checked.push(component.as_os_str());
                let metadata = fs::symlink_metadata(&checked).map_err(|_| refused())?;
                // System ancestors may be root-owned; only a root-owned sticky
                // temporary directory may be writable by other users.
                let system_temporary = metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
                if !metadata.is_dir()
                    || (metadata.uid() != current_uid() && metadata.uid() != 0)
                    || (metadata.mode() & 0o022 != 0 && !system_temporary)
                {
                    return Err(refused());
                }
            }
        }
    }
    let metadata = fs::symlink_metadata(&checked).map_err(|_| refused())?;
    if !metadata.is_dir()
        || metadata.uid() != current_uid()
        || metadata.mode() & 0o022 != 0
        || fs::canonicalize(&checked).map_err(|_| refused())? != checked
    {
        return Err(refused());
    }
    Ok(checked)
}

fn metadata_text(path: &Path) -> Result<String, CandidateError> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let metadata = file.metadata().map_err(|_| refused())?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() > 4096
        || metadata.uid() != current_uid()
        || metadata.mode() & 0o022 != 0
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() as u64 != metadata.len() {
        return Err(refused());
    }
    let value = String::from_utf8(bytes).map_err(|_| refused())?;
    let value = value.strip_suffix('\n').unwrap_or(&value);
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(refused());
    }
    Ok(value.to_owned())
}
