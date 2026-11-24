//! Quarantine a single pinned host directory before removing its known entries.
use super::*;
use std::{
    ffi::CString,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::Path,
};

pub(super) type FileId = (u64, u64);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    pub directory: FileId,
    pub lock_directory: FileId,
    pub lock: FileId,
    pub files: BTreeMap<String, FileId>,
}

fn refused() -> CandidateError {
    error(
        "graph_host_root_retirement",
        "Host root ownership or contents changed.",
    )
}

pub(super) fn directory_id(path: &Path) -> Result<FileId, CandidateError> {
    state::check_private_directory(path)?;
    let metadata = fs::symlink_metadata(path).map_err(state::io)?;
    if !metadata.is_dir() {
        return Err(refused());
    }
    Ok((metadata.dev(), metadata.ino()))
}

fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(state::io(e)),
    }
}

fn lock_dir(root: &Path, relay: bool) -> PathBuf {
    if relay {
        root.join("relay-control")
    } else {
        root.into()
    }
}

fn only_entry(path: &Path, name: &str) -> Result<(), CandidateError> {
    for entry in fs::read_dir(path).map_err(state::io)?.take(2) {
        if entry.map_err(state::io)?.file_name() != name {
            return Err(refused());
        }
    }
    Ok(())
}

fn inventory_matches(
    path: &Path,
    lock: bool,
    files: &BTreeMap<String, FileId>,
) -> Result<(), CandidateError> {
    for entry in fs::read_dir(path).map_err(state::io)?.take(files.len() + 2) {
        let entry = entry.map_err(state::io)?;
        if lock && entry.file_name() == "operation.lock" {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| files.get(name)) else {
            return Err(refused());
        };
        let metadata = fs::symlink_metadata(entry.path()).map_err(state::io)?;
        if metadata.nlink() != 1 || (metadata.dev(), metadata.ino()) != *id {
            return Err(refused());
        }
    }
    Ok(())
}

pub(super) fn select(root: &Path, relay: bool) -> Result<(Selection, state::Lock), CandidateError> {
    let directory = directory_id(root)?;
    let locks = lock_dir(root, relay);
    let lock_directory = directory_id(&locks)?;
    let lock = state::Lock::acquire_existing(&locks)?;
    lock.verify_path(&locks)?;
    if relay {
        only_entry(root, "relay-control")?;
    }
    only_entry(&locks, "operation.lock")?;
    if directory_id(root)? != directory || directory_id(&locks)? != lock_directory {
        return Err(refused());
    }
    Ok((
        Selection {
            directory,
            lock_directory,
            lock: lock.identity()?,
            files: BTreeMap::new(),
        },
        lock,
    ))
}

pub(super) fn quarantine(root: &Path) -> PathBuf {
    root.with_extension("pruned")
}

fn write_plan(
    journal: &Path,
    plan: &impl Serialize,
    fault: &dyn Fn(&str) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    state::write_before_rename(journal, plan, &|| fault("before-plan-commit"))?;
    fault("after-plan-commit")
}

fn move_exclusive(root: &Path, target: &Path) -> Result<(), CandidateError> {
    let parent = fs::File::open(root.parent().ok_or_else(refused)?).map_err(state::io)?;
    let name =
        CString::new(root.file_name().ok_or_else(refused)?.as_bytes()).map_err(|_| refused())?;
    let target =
        CString::new(target.file_name().ok_or_else(refused)?.as_bytes()).map_err(|_| refused())?;
    let fd = parent.as_raw_fd();
    // SAFETY: descriptor and NUL-terminated names are held throughout the call.
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renameatx_np(fd, name.as_ptr(), fd, target.as_ptr(), libc::RENAME_EXCL) };
    // SAFETY: descriptor and NUL-terminated names are held throughout the call.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            fd,
            name.as_ptr(),
            fd,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(state::io(std::io::Error::last_os_error()));
    }
    parent.sync_all().map_err(state::io)
}

pub(super) fn lock_selection(
    root: &Path,
    relay: bool,
    selection: &Selection,
) -> Result<Option<state::Lock>, CandidateError> {
    let target = quarantine(root);
    if !absent(&target)? {
        if directory_id(&target)? != selection.directory {
            return Err(refused());
        }
        let locks = lock_dir(&target, relay);
        if absent(&locks.join("operation.lock"))? {
            return Ok(None);
        }
        return Ok(Some(state::Lock::acquire_existing(&locks)?));
    }
    if absent(root)? {
        return Ok(None);
    }
    let locks = lock_dir(root, relay);
    let lock = state::Lock::acquire_existing(&locks)?;
    lock.verify_path(&locks)?;
    if directory_id(root)? != selection.directory
        || directory_id(&locks)? != selection.lock_directory
        || lock.identity()? != selection.lock
    {
        return Err(refused());
    }
    inventory_matches(&locks, true, &selection.files)?;
    Ok(Some(lock))
}

pub(super) fn retire(
    root: &Path,
    relay: bool,
    selection: &Selection,
    lock: Option<&state::Lock>,
    fault: &dyn Fn(&str) -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let target = quarantine(root);
    if absent(&target)? {
        if absent(root)? {
            return Ok(());
        }
        let locks = lock_dir(root, relay);
        let lock = lock.ok_or_else(refused)?;
        lock.verify_path(&locks)?;
        if directory_id(root)? != selection.directory
            || directory_id(&locks)? != selection.lock_directory
            || lock.identity()? != selection.lock
        {
            return Err(refused());
        }
        if relay {
            only_entry(root, "relay-control")?;
        }
        inventory_matches(&locks, true, &selection.files)?;
        fault("before-move")?;
        move_exclusive(root, &target)?;
        fault("after-move")?;
    }
    if directory_id(&target)? != selection.directory {
        return Err(refused());
    }
    let locks = lock_dir(&target, relay);
    if relay {
        only_entry(&target, "relay-control")?;
    }
    if !absent(&locks)? {
        if directory_id(&locks)? != selection.lock_directory {
            return Err(refused());
        }
        inventory_matches(&locks, true, &selection.files)?;
        for (name, expected) in &selection.files {
            if std::path::Path::new(name)
                .file_name()
                .and_then(|n| n.to_str())
                != Some(name)
            {
                return Err(refused());
            }
            let file = locks.join(name);
            if absent(&file)? {
                continue;
            }
            let metadata = fs::symlink_metadata(&file).map_err(state::io)?;
            if metadata.nlink() != 1 || (metadata.dev(), metadata.ino()) != *expected {
                return Err(refused());
            }
            fs::remove_file(&file).map_err(state::io)?;
            fault("after-evidence-unlink")?;
        }
        let lock_path = locks.join("operation.lock");
        if !absent(&lock_path)? {
            let lock = lock.ok_or_else(refused)?;
            lock.verify_path(&locks)?;
            if lock.identity()? != selection.lock {
                return Err(refused());
            }
            fs::remove_file(lock_path).map_err(state::io)?;
            fault("after-lock-unlink")?;
        }
        if relay {
            fs::remove_dir(&locks).map_err(state::io)?;
            fault("after-control-rmdir")?;
        }
    }
    fs::remove_dir(&target).map_err(state::io)?;
    fs::File::open(target.parent().ok_or_else(refused)?)
        .and_then(|directory| directory.sync_all())
        .map_err(state::io)?;
    fault("after-remove")
}

#[cfg(target_os = "macos")]
mod entry;
#[cfg(target_os = "macos")]
pub(super) use entry::record_relay;
#[cfg(target_os = "macos")]
pub use entry::retire_pruned;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_at_each_filesystem_boundary() {
        for boundary in [
            "before-move",
            "after-move",
            "after-lock-unlink",
            "after-control-rmdir",
            "after-remove",
        ] {
            let fixture = crate::provider::graph::tests::Fixture::new();
            let root = fixture.0.join("relay");
            let directory = lock_dir(&root, true);
            let (selected, lock) = {
                let initial = state::Lock::acquire(&directory).unwrap();
                drop(initial);
                select(&root, true).unwrap()
            };
            assert!(
                retire(&root, true, &selected, Some(&lock), &|point| {
                    if point == boundary {
                        Err(refused())
                    } else {
                        Ok(())
                    }
                })
                .is_err(),
                "{boundary}"
            );
            drop(lock);
            let resumed = lock_selection(&root, true, &selected).unwrap();
            retire(&root, true, &selected, resumed.as_ref(), &|_| Ok(())).unwrap();
            assert!(!root.exists() && !quarantine(&root).exists());
        }
    }

    #[test]
    fn interrupted_decision_leaves_the_original_and_a_retryable_plan() {
        for point in ["before-plan-commit", "after-plan-commit"] {
            let fixture = crate::provider::graph::tests::Fixture::new();
            let root = fixture.0.join("foreground");
            let journal = fixture.0.join("selection.json");
            drop(state::Lock::acquire(&root).unwrap());
            let (selection, lock) = select(&root, false).unwrap();
            assert!(
                write_plan(&journal, &selection, &|phase| {
                    if phase == point {
                        Err(refused())
                    } else {
                        Ok(())
                    }
                })
                .is_err()
            );
            assert!(root.exists());
            assert!(!quarantine(&root).exists());
            drop(lock);
            if !journal.exists() {
                super::super::journal::retain_file(
                    &fixture.0,
                    "selection.pending",
                    "recovery",
                    8192,
                )
                .unwrap();
                write_plan(&journal, &selection, &|_| Ok(())).unwrap();
            }
            let durable: Selection = state::read(&journal).unwrap();
            let lock = lock_selection(&root, false, &durable).unwrap();
            retire(&root, false, &durable, lock.as_ref(), &|_| Ok(())).unwrap();
            assert!(!root.exists());
        }
    }

    #[test]
    fn partial_evidence_unlink_retries_against_the_same_inventory() {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let root = fixture.0.join("foreground");
        drop(state::Lock::acquire(&root).unwrap());
        let (mut selection, lock) = select(&root, false).unwrap();
        for name in ["owner-a.retired.json", "retirement-a.json"] {
            let path = root.join(name);
            fs::write(&path, "fixture").unwrap();
            let metadata = fs::symlink_metadata(path).unwrap();
            selection
                .files
                .insert(name.into(), (metadata.dev(), metadata.ino()));
        }
        assert!(
            retire(&root, false, &selection, Some(&lock), &|phase| {
                if phase == "after-evidence-unlink" {
                    Err(refused())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        drop(lock);
        let lock = lock_selection(&root, false, &selection).unwrap();
        retire(&root, false, &selection, lock.as_ref(), &|_| Ok(())).unwrap();
        assert!(!quarantine(&root).exists());
    }

    #[test]
    fn held_lock_and_unknown_contents_refuse_selection() {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let root = fixture.0.join("foreground");
        let lock = state::Lock::acquire(&root).unwrap();
        assert!(select(&root, false).is_err());
        drop(lock);
        fs::write(root.join("owner.json"), "retain").unwrap();
        assert!(select(&root, false).is_err());
        assert_eq!(fs::read(root.join("owner.json")).unwrap(), b"retain");
    }

    #[test]
    fn replacement_at_original_or_quarantine_survives() {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let root = fixture.0.join("foreground");
        drop(state::Lock::acquire(&root).unwrap());
        let (selected, lock) = select(&root, false).unwrap();
        drop(lock);
        fs::rename(&root, fixture.0.join("original")).unwrap();
        drop(state::Lock::acquire(&root).unwrap());
        assert!(lock_selection(&root, false, &selected).is_err());
        fs::create_dir(quarantine(&root)).unwrap();
        fs::write(quarantine(&root).join("control"), "preserve").unwrap();
        assert!(lock_selection(&root, false, &selected).is_err());
        assert!(root.join("operation.lock").exists());
        assert!(quarantine(&root).join("control").exists());
    }
}
