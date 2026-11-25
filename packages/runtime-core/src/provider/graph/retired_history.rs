//! Bounded history of finished recovery records in one run directory (HACK-2576).
//!
//! A recovery that supersedes an earlier, finished one moves the old record aside
//! as history (`dead-owner-cleanup-retired-*`, `interrupted-start-cleanup-retired-*`).
//! Every pool stop under a running project adds one, so the history used to reach
//! its bound in weeks, and the bound then refused the recovery for ever. Now the
//! oldest records that are proven finished are removed to make room instead.
//!
//! The caller holds the locks the recovery itself holds. A record counts, and may be
//! removed, only when it is a regular file named for its own digest whose contents
//! prove it finished (`finished`). Anything else in the directory, an unreadable
//! record or one that cannot be proven finished, is never removed and never counts,
//! so it cannot block a recovery either. Only the record's own history goes: no
//! receipt, volume or pending journal is read as removable.
use crate::CandidateError;
use crate::provider::state;
use std::{fs, os::unix::fs::MetadataExt, path::Path, time::UNIX_EPOCH};

/// Bound on one record's bytes; a larger file is not proven finished.
const RECORD_LIMIT: u64 = 2 * 1024 * 1024;

/// Before one more record is archived under `prefix`, remove the oldest proven
/// finished records until fewer than `limit` remain. `finished` receives the file
/// name and its bytes.
pub(super) fn make_room(
    root: &Path,
    prefix: &str,
    limit: usize,
    finished: impl Fn(&str, &[u8]) -> bool,
) -> Result<(), CandidateError> {
    let mut proven = Vec::new();
    for entry in fs::read_dir(root).map_err(state::io)? {
        let entry = entry.map_err(state::io)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !(name.starts_with(prefix) && name.ends_with(".json")) {
            continue;
        }
        let path = root.join(&name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > RECORD_LIMIT {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if !finished(&name, &bytes) {
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .unwrap_or_default();
        proven.push((modified, name, metadata.dev(), metadata.ino()));
    }
    // Oldest first: by modification time, then by name for a stable order.
    proven.sort();
    let mut removed = false;
    while proven.len() >= limit.max(1) {
        let (_, name, dev, ino) = proven.remove(0);
        let path = root.join(&name);
        // Remove exactly the file that was read and proven, never a replacement.
        let now = fs::symlink_metadata(&path).map_err(state::io)?;
        if (now.dev(), now.ino()) != (dev, ino) || !now.is_file() {
            return Err(CandidateError::new(
                "graph_recovery_history",
                "A recovery history record changed while it was being pruned; nothing else was changed. Run the same command again.",
            ));
        }
        fs::remove_file(&path).map_err(state::io)?;
        removed = true;
    }
    if removed {
        fs::File::open(root)
            .and_then(|file| file.sync_all())
            .map_err(state::io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-retired-history-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        state::private_directory(&root).unwrap();
        root
    }
    fn write(root: &Path, name: &str, body: &str, age: u64) {
        let path = root.join(name);
        fs::write(&path, body).unwrap();
        let time = SystemTime::now() - std::time::Duration::from_secs(age);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }
    fn names(root: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }
    fn finished(name: &str, bytes: &[u8]) -> bool {
        bytes == b"finished" && name.starts_with("old-")
    }

    #[test]
    fn the_oldest_proven_records_make_room_and_nothing_else_is_touched() {
        let root = root();
        for index in 0..8 {
            write(&root, &format!("old-{index}.json"), "finished", 100 - index);
        }
        // Not proven finished, foreign, or not a record: never removed, never counted.
        write(&root, "old-pending.json", "pending", 1000);
        write(&root, "old-notes.txt", "finished", 1000);
        write(&root, "state.json", "receipt", 1000);
        std::os::unix::fs::symlink(root.join("state.json"), root.join("old-link.json")).unwrap();
        make_room(&root, "old-", 8, finished).unwrap();
        let left = names(&root);
        assert!(!left.contains(&"old-0.json".to_owned()), "{left:?}");
        for kept in [
            "old-1.json",
            "old-7.json",
            "old-pending.json",
            "old-notes.txt",
            "state.json",
            "old-link.json",
        ] {
            assert!(left.contains(&kept.to_owned()), "{kept} in {left:?}");
        }
        // Below the bound nothing goes.
        make_room(&root, "old-", 8, finished).unwrap();
        assert_eq!(names(&root).len(), left.len());
        // Only unprovable records: they never block.
        let stuck = super::tests::root();
        for index in 0..12 {
            write(&stuck, &format!("old-{index}.json"), "unknown", index);
        }
        make_room(&stuck, "old-", 8, finished).unwrap();
        assert_eq!(names(&stuck).len(), 12);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&stuck);
    }
}
