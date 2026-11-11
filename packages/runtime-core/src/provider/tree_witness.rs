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
//! when it, and the content anchor the proof used, equal the witness recorded for that exact
//! process. Any difference, a missing or
//! unreadable witness, or a witness for another process takes the full content proof again.
//! A pool that is not running always takes the full proof.
//!
//! Threat model. Both proofs defend against drift: accidental damage, partial or interrupted
//! writers, cleanup or backup tools, and changes made without knowledge of this scheme. Neither
//! defends against a same-user adversary who knows it: the content proof's anchors (the
//! preparation records' `tree_sha256` and the receipt's rootfs pin) are themselves writable by
//! the same user, and so is this witness. Within that scope:
//!
//! - The content proof catches any byte that differs from the proven tree.
//! - The metadata check catches ordinary filesystem changes: `write`/`truncate` change the size
//!   or the status-change time (ctime), which user space cannot set directly; a replace or
//!   rename changes the inode; added, removed or re-linked entries change the entry list or
//!   link counts; `chmod`/`chown` change mode, owner and ctime; a retargeted symlink changes
//!   its target; a rewritten anchor no longer matches the content digest the witness names.
//! - It gives up content changes that keep all of that metadata: writing the block device or
//!   moving the clock (root), silent media corruption, stores through a shared writable mapping
//!   that the kernel has not yet reflected in ctime, a filesystem that keeps coarse or no
//!   ctime (FAT, some network filesystems), and a rewrite within the same kernel timestamp
//!   tick (milliseconds on Linux) as the file's previous write. Prepared trees are written at
//!   preparation, long before a boot witnesses them, and candidate homes live on the local
//!   system volume (APFS on macOS, nanosecond ctime).
//!
//! That is acceptable only while the proven boot is still the running one: its provider and
//! guest were started from the proven bytes, the witness is bound to that provider's PID,
//! start time, executable and user, and the next boot proves the trees by content again. It is
//! not a substitute for the content proof before a boot.
use super::{identity::ProcessIdentity, state};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[cfg(test)]
thread_local! {
    /// Content proofs this thread ran, so tests can tell the cheap path from a proof.
    static CONTENT_PROOFS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Count one content proof (tests only).
pub(super) fn note_content_proof() {
    #[cfg(test)]
    CONTENT_PROOFS.with(|count| count.set(count.get() + 1));
}

#[cfg(test)]
pub(super) fn content_proofs() -> usize {
    CONTENT_PROOFS.with(std::cell::Cell::get)
}

/// Names of the witnessed trees.
pub(super) const SMOLVM: &str = "smolvm";
pub(super) const ENGINE: &str = "engine";
pub(super) const ROOTFS: &str = "rootfs";

const DOMAIN: &[u8] = b"hack.provider-tree.metadata.v1\0";
const VERSION: u32 = 1;
/// Bounds a walk so a foreign tree cannot make the cheap check unbounded.
const MAX_ENTRIES: usize = 200_000;

/// One tree as a content proof saw it: its metadata digest, taken around the proof, and the
/// content digest (the tree's anchor: the preparation record's `tree_sha256`, or the pool's
/// rootfs pin) it was proven against. A witness is accepted only while both still hold, so
/// rewriting the anchor sends the tree back to a content proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Proven {
    pub(super) metadata: String,
    pub(super) content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Witness {
    version: u32,
    process: ProcessIdentity,
    trees: BTreeMap<String, Proven>,
}

fn path(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/smolvm/provider-trees.json")
}

fn invalid(message: &'static str) -> CandidateError {
    CandidateError::new("artifact_invalid", message)
}

/// SHA-256 over the metadata of every entry under `root`, in name order: relative path,
/// type, permission bits, owner, device, inode and link count; for files also size,
/// modification and status-change times; for symlinks the target. Directory times are left
/// out, so creating or removing an excluded entry (the provider's readiness `marker` at the
/// top level) does not change the digest. A present marker must pass the checks the content
/// proof applies (`artifact::rootfs_digest`): a small, singly linked regular file owned by
/// this user. File contents are never read.
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
                let m = fs::symlink_metadata(&path).map_err(state::io)?;
                if !m.is_file()
                    || m.nlink() != 1
                    || m.len() > 1024
                    || m.uid() != unsafe { libc::geteuid() }
                {
                    return Err(invalid("Unsafe readiness marker."));
                }
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

/// What the boot of exactly `process` witnessed for `tree`, if anything was recorded.
/// A missing, unreadable or foreign witness is no witness: the caller proves by content.
pub(super) fn witnessed(
    candidate: &Candidate,
    process: &ProcessIdentity,
    tree: &str,
) -> Option<Proven> {
    let witness: Witness = state::read(&path(candidate)).ok()?;
    (witness.version == VERSION && witness.process == *process)
        .then(|| witness.trees.get(tree).cloned())
        .flatten()
}

/// Whether the boot of `process` witnessed `tree` with exactly this metadata digest, proven
/// against exactly this content anchor.
pub(super) fn matches(
    candidate: &Candidate,
    process: &ProcessIdentity,
    tree: &str,
    metadata: &str,
    content: &str,
) -> bool {
    witnessed(candidate, process, tree)
        .is_some_and(|proven| proven.metadata == metadata && proven.content == content)
}

/// After a boot under `lease`: record what its content proofs witnessed, only when the boot
/// succeeded and recorded its provider. Best effort: without a witness the next command
/// proves the trees by content.
pub(super) fn record_boot(
    candidate: &Candidate,
    lease: &state::Lock,
    booted: bool,
    process: Option<&ProcessIdentity>,
    trees: BTreeMap<String, Proven>,
) {
    if booted && let Some(process) = process {
        let _ = record(candidate, lease, process, trees);
    }
}

/// Record what content proofs just witnessed for the running `process`, under the pool's
/// lifecycle `lease`. Callers record only trees proven by content for this process's boot,
/// or proven again while it runs.
pub(super) fn record(
    candidate: &Candidate,
    _lease: &state::Lock,
    process: &ProcessIdentity,
    trees: BTreeMap<String, Proven>,
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

    fn proven(metadata: char, content: char) -> Proven {
        Proven {
            metadata: metadata.to_string().repeat(64),
            content: content.to_string().repeat(64),
        }
    }

    fn home(name: &str) -> (Tree, Candidate, state::Lock) {
        let home = Tree::new(name);
        let candidate = Candidate::discover(&home.0).unwrap();
        state::private_directory(&candidate.state_root.join("run/smolvm")).unwrap();
        let lease = state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
        (home, candidate, lease)
    }

    #[test]
    fn a_witness_counts_only_for_the_exact_process_and_content_anchor_that_recorded_it() {
        let (_home, candidate, lease) = home("witness");
        let booted = process(41);
        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        assert!(witnessed(&candidate, &booted, SMOLVM).is_none());
        record(
            &candidate,
            &lease,
            &booted,
            BTreeMap::from([(SMOLVM.to_owned(), proven('a', 'c'))]),
        )
        .unwrap();
        assert!(matches(&candidate, &booted, SMOLVM, &a, &c));
        // Other metadata, another content anchor, another tree or another process: no match.
        assert!(!matches(&candidate, &booted, SMOLVM, &b, &c));
        assert!(!matches(&candidate, &booted, SMOLVM, &a, &b));
        assert!(!matches(&candidate, &booted, ENGINE, &a, &c));
        assert!(!matches(&candidate, &process(42), SMOLVM, &a, &c));
        let mut restarted = booted.clone();
        restarted.start_micros += 1;
        assert!(!matches(&candidate, &restarted, SMOLVM, &a, &c));
        // A rewrite replaces the witness; a damaged one is no witness.
        record(
            &candidate,
            &lease,
            &booted,
            BTreeMap::from([(SMOLVM.to_owned(), proven('b', 'c'))]),
        )
        .unwrap();
        assert!(matches(&candidate, &booted, SMOLVM, &b, &c));
        fs::remove_file(path(&candidate)).unwrap();
        fs::write(path(&candidate), b"{").unwrap();
        fs::set_permissions(path(&candidate), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(witnessed(&candidate, &booted, SMOLVM).is_none());
    }

    #[test]
    fn only_a_successful_boot_with_a_recorded_provider_records_a_witness() {
        let (_home, candidate, lease) = home("boot");
        let trees = || BTreeMap::from([(SMOLVM.to_owned(), proven('a', 'c'))]);
        let booted = process(41);
        record_boot(&candidate, &lease, false, Some(&booted), trees());
        assert!(witnessed(&candidate, &booted, SMOLVM).is_none());
        record_boot(&candidate, &lease, true, None, trees());
        assert!(!path(&candidate).exists());
        record_boot(&candidate, &lease, true, Some(&booted), trees());
        assert_eq!(
            witnessed(&candidate, &booted, SMOLVM),
            Some(proven('a', 'c'))
        );
        // A later failed boot leaves the earlier witness, which names another process.
        record_boot(&candidate, &lease, false, Some(&process(43)), trees());
        assert!(witnessed(&candidate, &process(43), SMOLVM).is_none());
    }

    #[test]
    fn an_unsafe_readiness_marker_is_refused_as_the_content_proof_refuses_it() {
        let tree = Tree::new("unsafe-marker");
        let marker = tree.0.join(".smolvm-ready.fixture");
        symlink("smolvm-bin", &marker).unwrap();
        let refused = metadata_digest(&tree.0, Some(".smolvm-ready.fixture")).unwrap_err();
        assert_eq!(refused.code, "artifact_invalid");
        fs::remove_file(&marker).unwrap();
        fs::hard_link(tree.0.join("smolvm-bin"), &marker).unwrap();
        assert!(metadata_digest(&tree.0, Some(".smolvm-ready.fixture")).is_err());
        fs::remove_file(&marker).unwrap();
        fs::write(&marker, vec![b'x'; 2048]).unwrap();
        assert!(metadata_digest(&tree.0, Some(".smolvm-ready.fixture")).is_err());
        fs::write(&marker, b"ready").unwrap();
        metadata_digest(&tree.0, Some(".smolvm-ready.fixture")).unwrap();
    }
}
