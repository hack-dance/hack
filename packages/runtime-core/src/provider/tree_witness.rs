//! Boot-scoped witness of the prepared trees a running pool was booted from.
//!
//! A cold start (and `runtime repair-provider-tree`) proves each prepared tree by content:
//! SHA-256 over every file of the SmolVM tree and the Docker engine tree against the
//! preparation record, and the pool's guest rootfs copy against its pin. That is about
//! 317 MB of hashing, so repeating it on every later command of a running pool costs
//! about 1.85 s per command.
//!
//! When a boot that ran that full proof succeeds, it records a witness bound to the provider
//! process it started: for each tree, a SHA-256 over the tree's *metadata* (see
//! [`metadata_digest`]) observed immediately before and after the content proof. Later
//! commands of the same running pool recompute only the metadata digest and accept the tree
//! when it equals the witness recorded for that exact process. Any difference, a missing or
//! unreadable witness, or a witness for another process takes the full content proof again.
//! A pool that is not running always takes the full proof.
//!
//! Threat model. The full proof catches any byte that differs from the verified tree. The
//! metadata check catches every change made through the filesystem by an unprivileged
//! process: writing or truncating a file changes its size or status-change time (ctime),
//! which a user cannot set; replacing or renaming changes the inode; adding, removing or
//! re-linking entries changes the entry list, link counts or types; `chmod`/`chown` change
//! the mode, owner and ctime; a retargeted symlink changes its target. It gives up content
//! changes that leave all of that metadata intact, which needs privileges this design
//! already trusts (root writing the block device or changing the clock to forge a ctime)
//! or silent media corruption. Status-change times come from the kernel's file timestamp
//! clock, which can be coarse (a few milliseconds on Linux): a rewrite in the same tick as
//! the previous legitimate write of that file could keep its ctime. Prepared trees are
//! written at preparation, long before a boot witnesses them, so any later tampering lands on
//! a later tick. That is acceptable only while the verified boot is still the
//! running one: its provider and guest were started from the proven bytes, the witness is
//! bound to that provider's PID, start time, executable and user, and the next boot proves
//! the trees by content again. It is not a substitute for the content proof before a boot.
use super::{identity::ProcessIdentity, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Names of the witnessed trees.
pub(super) const SMOLVM: &str = "smolvm";
pub(super) const ENGINE: &str = "engine";
pub(super) const ROOTFS: &str = "rootfs";

const DOMAIN: &[u8] = b"hack.provider-tree.metadata.v1\0";
const VERSION: u32 = 1;
/// Bounds a walk so a foreign tree cannot make the cheap check unbounded.
const MAX_ENTRIES: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Witness {
    version: u32,
    process: ProcessIdentity,
    trees: BTreeMap<String, String>,
}

fn path(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm/provider-trees.json")
}

fn invalid(message: &'static str) -> CandidateError {
    CandidateError::new("artifact_digest_mismatch", message)
}

/// SHA-256 over the metadata of every entry under `root`, in name order: relative path,
/// type, permission bits, owner, device, inode and link count; for files also size,
/// modification and status-change times; for symlinks the target. Directory times are left
/// out, so creating or removing an excluded entry (the provider's readiness `marker` at the
/// top level) does not change the digest. File contents are never read.
pub(super) fn metadata_digest(root: &Path, marker: Option<&str>) -> Result<String, CandidateError> {
    fn visit(
        base: &Path,
        path: &Path,
        hash: &mut Sha256,
        marker: Option<&str>,
        count: &mut usize,
    ) -> Result<(), CandidateError> {
        let mut entries = fs::read_dir(path)
            .map_err(state::io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(state::io)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            *count += 1;
            if *count > MAX_ENTRIES {
                return Err(invalid("Prepared tree has too many entries to witness."));
            }
            let path = entry.path();
            let relative = path.strip_prefix(base).expect("tree child");
            let text = relative
                .to_str()
                .ok_or_else(|| invalid("Non-UTF8 prepared tree path."))?;
            if marker == Some(text) {
                continue;
            }
            let m = fs::symlink_metadata(&path).map_err(state::io)?;
            hash.update((text.len() as u64).to_le_bytes());
            hash.update(text.as_bytes());
            for value in [
                u64::from(m.mode()),
                u64::from(m.uid()),
                u64::from(m.gid()),
                m.dev(),
                m.ino(),
                m.nlink(),
            ] {
                hash.update(value.to_le_bytes());
            }
            if m.is_dir() {
                hash.update(b"directory");
                visit(base, &path, hash, marker, count)?;
            } else if m.is_file() {
                hash.update(b"file");
                hash.update(m.len().to_le_bytes());
                for value in [m.mtime(), m.mtime_nsec(), m.ctime(), m.ctime_nsec()] {
                    hash.update(value.to_le_bytes());
                }
            } else if m.file_type().is_symlink() {
                hash.update(b"symlink");
                let target = fs::read_link(&path).map_err(state::io)?;
                hash.update(target.as_os_str().as_encoded_bytes());
            } else {
                return Err(invalid("Unexpected special file in a prepared tree."));
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    hash.update(DOMAIN);
    let mut count = 0;
    visit(root, root, &mut hash, marker, &mut count)?;
    Ok(format!("{:x}", hash.finalize()))
}

/// The digest witnessed for `tree` by the boot of exactly `process`, if one was recorded.
/// A missing, unreadable or foreign witness is no witness: the caller proves by content.
pub(super) fn witnessed(
    candidate: &Candidate,
    process: &ProcessIdentity,
    tree: &str,
) -> Option<String> {
    let witness: Witness = state::read(&path(candidate)).ok()?;
    (witness.version == VERSION && witness.process == *process)
        .then(|| witness.trees.get(tree).cloned())
        .flatten()
}

/// Whether `current` is the digest the boot of `process` witnessed for `tree`.
pub(super) fn matches(
    candidate: &Candidate,
    process: &ProcessIdentity,
    tree: &str,
    current: &str,
) -> bool {
    witnessed(candidate, process, tree).as_deref() == Some(current)
}

/// Record the digests a content proof just witnessed for the running `process`. Callers hold
/// the pool's lifecycle lock and call this only after every tree in `trees` was proven by
/// content for this process's boot, or proven again while it runs.
pub(super) fn record(
    candidate: &Candidate,
    process: &ProcessIdentity,
    trees: BTreeMap<String, String>,
) -> Result<(), CandidateError> {
    let target = path(candidate);
    match fs::symlink_metadata(&target) {
        Ok(_) => fs::remove_file(&target).map_err(state::io)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    state::write(
        &target,
        &Witness {
            version: VERSION,
            process: process.clone(),
            trees,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    struct Tree(PathBuf);
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    impl Tree {
        fn new(name: &str) -> Self {
            let root = crate::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                &format!("hack-tree-witness-{name}"),
            );
            state::private_directory(&root).unwrap();
            fs::create_dir_all(root.join("lib/empty")).unwrap();
            fs::write(root.join("smolvm-bin"), b"binary").unwrap();
            fs::write(root.join("lib/libfixture.dylib"), b"library").unwrap();
            symlink("libfixture.dylib", root.join("lib/libalias.dylib")).unwrap();
            Self(root)
        }
        fn digest(&self) -> String {
            metadata_digest(&self.0, Some(".smolvm-ready.fixture")).unwrap()
        }
    }

    fn process(pid: i32) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            start_micros: 1_700_000_000_000_000,
            uid: unsafe { libc::geteuid() },
            executable: PathBuf::from("/fixture/smolvm-bin"),
        }
    }

    #[test]
    fn every_filesystem_change_an_unprivileged_writer_can_make_changes_the_digest() {
        type Change = fn(&Path);
        let changes: [(&str, Change); 9] = [
            ("rewrite same size", |r| {
                fs::write(r.join("smolvm-bin"), b"BINARY").unwrap()
            }),
            ("append", |r| {
                fs::write(r.join("lib/libfixture.dylib"), b"library+").unwrap()
            }),
            ("replace by rename", |r| {
                fs::write(r.join("new"), b"binary").unwrap();
                fs::rename(r.join("new"), r.join("smolvm-bin")).unwrap();
            }),
            ("add a file", |r| {
                fs::write(r.join("lib/extra"), b"").unwrap()
            }),
            ("remove an empty directory", |r| {
                fs::remove_dir(r.join("lib/empty")).unwrap()
            }),
            ("chmod", |r| {
                fs::set_permissions(r.join("smolvm-bin"), fs::Permissions::from_mode(0o755))
                    .unwrap()
            }),
            ("retarget a symlink", |r| {
                fs::remove_file(r.join("lib/libalias.dylib")).unwrap();
                symlink("smolvm-bin", r.join("lib/libalias.dylib")).unwrap();
            }),
            ("add a hard link", |r| {
                fs::hard_link(r.join("smolvm-bin"), r.join("lib/linked")).unwrap()
            }),
            ("restore mtime after a write", |r| {
                let path = r.join("smolvm-bin");
                let before = fs::metadata(&path).unwrap().modified().unwrap();
                fs::write(&path, b"forged").unwrap();
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(before)
                    .unwrap();
            }),
        ];
        for (name, change) in changes {
            let tree = Tree::new("change");
            let before = tree.digest();
            assert_eq!(tree.digest(), before, "stable before {name}");
            // A change is visible one status-change clock tick after the previous write;
            // prepared trees are written long before any boot witnesses them.
            std::thread::sleep(std::time::Duration::from_millis(20));
            change(&tree.0);
            assert_ne!(tree.digest(), before, "{name}");
        }
    }

    #[test]
    fn the_readiness_marker_and_reads_leave_the_digest_unchanged() {
        let tree = Tree::new("marker");
        let before = tree.digest();
        fs::write(tree.0.join(".smolvm-ready.fixture"), b"ready").unwrap();
        let _ = fs::read(tree.0.join("smolvm-bin")).unwrap();
        assert_eq!(tree.digest(), before);
        fs::remove_file(tree.0.join(".smolvm-ready.fixture")).unwrap();
        assert_eq!(tree.digest(), before);
        // Another top-level name is not the marker.
        fs::write(tree.0.join(".smolvm-ready.other"), b"ready").unwrap();
        assert_ne!(tree.digest(), before);
    }

    #[test]
    fn a_witness_counts_only_for_the_exact_process_that_recorded_it() {
        let home = Tree::new("witness");
        let candidate = Candidate::discover(&home.0).unwrap();
        state::private_directory(&candidate.state_root.join("run/smolvm")).unwrap();
        let booted = process(41);
        assert!(witnessed(&candidate, &booted, SMOLVM).is_none());
        record(
            &candidate,
            &booted,
            BTreeMap::from([(SMOLVM.to_owned(), "a".repeat(64))]),
        )
        .unwrap();
        assert!(matches(&candidate, &booted, SMOLVM, &"a".repeat(64)));
        assert!(!matches(&candidate, &booted, SMOLVM, &"b".repeat(64)));
        assert!(!matches(&candidate, &booted, ENGINE, &"a".repeat(64)));
        assert!(!matches(&candidate, &process(42), SMOLVM, &"a".repeat(64)));
        let mut restarted = booted.clone();
        restarted.start_micros += 1;
        assert!(!matches(&candidate, &restarted, SMOLVM, &"a".repeat(64)));
        // A rewrite replaces the witness; a damaged one is no witness.
        record(
            &candidate,
            &booted,
            BTreeMap::from([(SMOLVM.to_owned(), "c".repeat(64))]),
        )
        .unwrap();
        assert!(matches(&candidate, &booted, SMOLVM, &"c".repeat(64)));
        fs::remove_file(path(&candidate)).unwrap();
        fs::write(path(&candidate), b"{").unwrap();
        fs::set_permissions(path(&candidate), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(witnessed(&candidate, &booted, SMOLVM).is_none());
    }
}
