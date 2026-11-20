//! The pool's root files proven by content before the startup lease.
//!
//! A start must wait at least the admission window between its first host sample and the
//! sample under the startup lease (`admission::DEVELOPMENT_WINDOW`). The content proof of
//! the provider and engine trees already runs in that wait. This module lets the content
//! proof of the pool's own root files run there too, beside them, instead of after the
//! lease, where it added its full time to every start of a stopped pool.
//!
//! The proof here is read-only and grants nothing by itself. [`prove`] hashes the root
//! files against the pin in the owner record, bracketed by their metadata digest
//! (`tree_witness::metadata_digest`), exactly as the proof under the lease does.
//!
//! [`recheck`] runs under the lease, straight after the provider and engine trees are
//! rechecked (`leased_trees`): after the sample under the lease and before the admission
//! record, any owner record update or any provider command. It writes nothing. It reads
//! the owner record the lease now fences and recomputes only the metadata digest
//! ([`Early::holds`]). The early proof stands when all of these are true: the marker and
//! the pin are the ones the lease-held owner record names; the root files are on a
//! filesystem qualified for the metadata check; and the digest equals what the proof saw.
//! On a changed marker or pin, an unqualified filesystem or any metadata difference, the
//! root files are proven by content again, there, under the lease, against the lease-held
//! pin. A change that kept the bytes therefore continues, and a changed byte refuses
//! `artifact_digest_mismatch` before any of those effects; the caller's lease is returned
//! as it unwinds.
//!
//! [`Leased`] is what the recheck established. Its metadata digest was taken under the
//! lease, and `prepare_rootfs` hands it to the boot's tree witness in place of a second
//! content proof, only for the marker and the pin the recheck used.
//!
//! Without an early proof there is nothing to recheck: a new home, a missing owner record
//! or pin, an alias, an unreadable entry, or root files that did not match their pin before
//! the lease. The same holds when the lease-held owner record cannot be read or names no
//! pin. `prepare_rootfs` then copies the root files (a new home) and proves them by content
//! under the lease, as before. Doubt never accepts and never refuses by itself.
//!
//! Limits. The metadata check gives up what `tree_witness` lists: a content change that
//! keeps size, times, inode and link count, for the fraction of a second between the early
//! proof and the lease. As for the provider and engine trees (`leased_trees`), the recheck
//! narrows the unfenced interval to the time from the recheck to `machine start`; it does
//! not stop a writer that ignores the lease after the recheck.
use super::{prove_rootfs, root, rootfs_marker};
use crate::provider::state::{Lock, Owner};
use crate::provider::tree_witness;
use crate::{Candidate, CandidateError, reject_aliased_state};
use std::path::Path;

/// What a content proof of the root files saw before the startup lease.
#[derive(Debug)]
pub(super) struct Early {
    marker: String,
    content: String,
    metadata: String,
}

/// Prove an existing pool's root files by content, read-only, without the startup lease.
/// `None` when there is nothing to prove yet (a new home) or on any doubt.
pub(super) fn prove(candidate: &Candidate) -> Option<Early> {
    let owner = Owner::load(candidate).ok()?;
    let content = owner.rootfs_digest.clone()?;
    let destination = root(candidate).join("rootfs");
    reject_aliased_state(&destination).ok()?;
    let marker = rootfs_marker(&owner).ok()?;
    prove_at(&destination, marker, content)
}

fn prove_at(destination: &Path, marker: String, content: String) -> Option<Early> {
    let metadata = prove_rootfs(destination, &marker, Some(&content)).ok()?;
    Some(Early {
        marker,
        content,
        metadata,
    })
}

/// What the recheck under the startup lease established for the root files: a content proof
/// against the pin `content` with the readiness marker `marker`, and the metadata digest
/// the root files had under the lease.
#[derive(Debug)]
pub(super) struct Leased {
    marker: String,
    content: String,
    metadata: String,
}

/// Under the startup `lease`, after the leased sample and the tree recheck: make the early
/// content proof of the root files describe them as they are now, or prove them by content
/// again.
/// `Ok(None)` when there is no early proof to recheck or the lease-held owner record does
/// not name what to prove against; the caller's full content proof then decides
/// (`prepare_rootfs`). Refuses with the content proof's own error when the root files no
/// longer match the pin. Nothing is written here.
pub(super) fn recheck(
    candidate: &Candidate,
    _lease: &Lock,
    early: Option<Early>,
) -> Result<Option<Leased>, CandidateError> {
    let Some(early) = early else {
        return Ok(None);
    };
    let Ok(owner) = Owner::load(candidate) else {
        return Ok(None);
    };
    let (Some(content), Ok(marker)) = (owner.rootfs_digest.clone(), rootfs_marker(&owner)) else {
        return Ok(None);
    };
    let destination = root(candidate).join("rootfs");
    if reject_aliased_state(&destination).is_err() {
        return Ok(None);
    }
    recheck_at(&destination, &early, marker, content).map(Some)
}

fn recheck_at(
    destination: &Path,
    early: &Early,
    marker: String,
    content: String,
) -> Result<Leased, CandidateError> {
    let metadata = match early.holds(destination, &marker, Some(&content)) {
        Some(metadata) => metadata,
        None => prove_rootfs(destination, &marker, Some(&content))?,
    };
    Ok(Leased {
        marker,
        content,
        metadata,
    })
}

impl Leased {
    /// The metadata digest taken under the lease, when `marker` and `expected` are the
    /// marker and the pin the recheck proved against. `None` sends the caller to the full
    /// content proof.
    pub(super) fn stands(&self, marker: &str, expected: Option<&str>) -> Option<String> {
        (self.marker == marker && Some(self.content.as_str()) == expected)
            .then(|| self.metadata.clone())
    }
}

impl Early {
    /// Under the startup lease: the metadata digest of the root files when they are still
    /// exactly what the early proof saw, proven against `expected`, the pin the lease-held
    /// owner record names. `None` sends the caller to the full content proof.
    fn holds(&self, destination: &Path, marker: &str, expected: Option<&str>) -> Option<String> {
        if self.marker != marker || Some(self.content.as_str()) != expected {
            return None;
        }
        tree_witness::qualified_digest(destination, Some(marker))
            .ok()
            .flatten()
            .filter(|now| *now == self.metadata)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{artifact, state};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const MARKER: &str = ".smolvm-ready.fixture";

    struct Tree(PathBuf);
    impl Drop for Tree {
        fn drop(&mut self) {
            tree_witness::fake_filesystem_type(None);
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl Tree {
        fn new(name: &str) -> Self {
            let root = crate::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                &format!("hack-rootfs-proof-{name}"),
            );
            state::private_directory(&root).unwrap();
            fs::create_dir_all(root.join("usr/bin")).unwrap();
            fs::write(root.join("usr/bin/agent"), b"agent binary").unwrap();
            fs::write(root.join("etc-release"), b"release").unwrap();
            // The qualification is the host's business; these tests are about the digest.
            tree_witness::fake_filesystem_type(Some("apfs"));
            Self(root)
        }

        fn pin(&self) -> String {
            artifact::rootfs_digest(&self.0, Some(MARKER)).unwrap()
        }

        fn proven(&self) -> Early {
            prove_at(&self.0, MARKER.into(), self.pin()).expect("early proof")
        }

        /// What the start sees under the lease, with the owner record's pin unchanged.
        fn held(&self, early: &Early) -> Option<String> {
            early.holds(&self.0, MARKER, Some(&early.content))
        }

        /// The recheck under the lease, with the owner record's marker and pin unchanged.
        fn rechecked(&self, early: &Early) -> Result<Leased, CandidateError> {
            recheck_at(&self.0, early, MARKER.into(), early.content.clone())
        }
    }

    #[test]
    fn unchanged_root_files_are_accepted_without_a_second_content_proof() {
        let tree = Tree::new("unchanged");
        let before = tree_witness::content_proofs();
        let early = tree.proven();
        assert_eq!(tree_witness::content_proofs() - before, 1);
        assert_eq!(tree.held(&early), Some(early.metadata.clone()));
        assert_eq!(tree_witness::content_proofs() - before, 1);
        // The provider's readiness marker comes and goes without a new proof.
        fs::write(tree.0.join(MARKER), b"ready").unwrap();
        assert_eq!(tree.held(&early), Some(early.metadata.clone()));
    }

    #[test]
    fn a_root_file_changed_between_the_proof_and_the_lease_takes_the_full_proof() {
        // Same size, other bytes: the content differs and the status-change time moves.
        let tree = Tree::new("rewritten");
        let early = tree.proven();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(tree.0.join("usr/bin/agent"), b"agent BINARY").unwrap();
        assert_eq!(tree.held(&early), None);
        // The full proof the caller then runs refuses the changed tree against the pin.
        assert!(prove_rootfs(&tree.0, MARKER, Some(&early.content)).is_err());
    }

    #[test]
    fn a_rewrite_that_puts_the_modification_time_back_still_takes_the_full_proof() {
        // Size and modification time are as the proof saw them; the status-change time,
        // which a writer cannot set back, is not.
        let tree = Tree::new("mtime-restored");
        let agent = tree.0.join("usr/bin/agent");
        let early = tree.proven();
        let modified = fs::metadata(&agent).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&agent, b"agent BINARY").unwrap();
        fs::File::options()
            .write(true)
            .open(&agent)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(fs::metadata(&agent).unwrap().modified().unwrap(), modified);
        assert_eq!(tree.held(&early), None);
    }

    #[test]
    fn every_ordinary_change_between_the_proof_and_the_lease_takes_the_full_proof() {
        for change in 0..5 {
            let tree = Tree::new(&format!("change-{change}"));
            let early = tree.proven();
            let agent = tree.0.join("usr/bin/agent");
            match change {
                // Replaced by a file with the same bytes: another inode.
                0 => {
                    fs::write(tree.0.join("usr/bin/agent.new"), b"agent binary").unwrap();
                    fs::rename(tree.0.join("usr/bin/agent.new"), &agent).unwrap();
                }
                1 => fs::write(tree.0.join("usr/bin/extra"), b"added").unwrap(),
                2 => fs::remove_file(tree.0.join("etc-release")).unwrap(),
                3 => fs::set_permissions(&agent, fs::Permissions::from_mode(0o755)).unwrap(),
                _ => fs::hard_link(&agent, tree.0.join("usr/bin/agent-link")).unwrap(),
            }
            assert_eq!(tree.held(&early), None, "{change}");
        }
    }

    #[test]
    fn another_marker_another_pin_or_an_unqualified_filesystem_takes_the_full_proof() {
        let tree = Tree::new("binding");
        let early = tree.proven();
        let pin = early.content.clone();
        assert!(early.holds(&tree.0, MARKER, Some(&pin)).is_some());
        assert_eq!(
            early.holds(&tree.0, ".smolvm-ready.other", Some(&pin)),
            None
        );
        assert_eq!(early.holds(&tree.0, MARKER, Some(&"0".repeat(64))), None);
        assert_eq!(early.holds(&tree.0, MARKER, None), None);
        assert_eq!(
            early.holds(&tree.0.join("usr"), MARKER, Some(&pin)),
            None,
            "another tree"
        );
        tree_witness::fake_filesystem_type(Some("msdos"));
        assert_eq!(early.holds(&tree.0, MARKER, Some(&pin)), None);
    }

    #[test]
    fn root_files_that_do_not_match_the_pin_or_cannot_be_read_give_no_early_proof() {
        let tree = Tree::new("mismatch");
        assert!(prove_at(&tree.0, MARKER.into(), "0".repeat(64)).is_none());
        assert!(prove_at(&tree.0.join("missing"), MARKER.into(), tree.pin()).is_none());
        // An unsafe readiness marker is refused by the proof itself.
        fs::create_dir(tree.0.join(MARKER)).unwrap();
        assert!(prove_at(&tree.0, MARKER.into(), "0".repeat(64)).is_none());
    }

    #[test]
    fn the_recheck_keeps_an_unchanged_proof_and_hashes_nothing_under_the_lease() {
        let tree = Tree::new("recheck-unchanged");
        let early = tree.proven();
        let before = tree_witness::content_proofs();
        let leased = tree.rechecked(&early).unwrap();
        assert_eq!(tree_witness::content_proofs(), before, "one metadata walk");
        // The boot's witness is the digest taken under the lease, for this marker and pin.
        assert_eq!(
            leased.stands(MARKER, Some(&early.content)),
            Some(tree_witness::metadata_digest(&tree.0, Some(MARKER)).unwrap())
        );
        assert_eq!(leased.metadata, early.metadata);
    }

    #[test]
    fn a_root_file_changed_between_the_proof_and_the_lease_refuses_at_the_recheck() {
        let tree = Tree::new("recheck-rewritten");
        let early = tree.proven();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(tree.0.join("usr/bin/agent"), b"agent BINARY").unwrap();
        let before = tree_witness::content_proofs();
        let refused = tree.rechecked(&early).unwrap_err();
        assert_eq!(refused.code, "artifact_digest_mismatch");
        assert_eq!(tree_witness::content_proofs() - before, 1);
    }

    #[test]
    fn root_files_whose_metadata_changed_but_whose_bytes_did_not_are_proven_again() {
        // Rewritten with the same bytes: the status-change time moves, the content does not.
        let tree = Tree::new("recheck-touched");
        let early = tree.proven();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(tree.0.join("usr/bin/agent"), b"agent binary").unwrap();
        let before = tree_witness::content_proofs();
        let leased = tree.rechecked(&early).unwrap();
        assert_eq!(tree_witness::content_proofs() - before, 1);
        // The witness names the root files as they are under the lease, not the early proof.
        assert_ne!(leased.metadata, early.metadata);
        assert_eq!(
            leased.metadata,
            tree_witness::metadata_digest(&tree.0, Some(MARKER)).unwrap()
        );
    }

    #[test]
    fn off_a_qualified_filesystem_the_root_files_are_proven_again_under_the_lease() {
        let tree = Tree::new("recheck-unqualified");
        let early = tree.proven();
        tree_witness::fake_filesystem_type(Some("msdos"));
        let before = tree_witness::content_proofs();
        let leased = tree.rechecked(&early).unwrap();
        assert_eq!(tree_witness::content_proofs() - before, 1);
        assert_eq!(leased.metadata, early.metadata);
    }

    #[test]
    fn another_marker_or_pin_under_the_lease_is_proven_against_the_lease_held_record() {
        let tree = Tree::new("recheck-binding");
        let early = tree.proven();
        let pin = early.content.clone();
        // Another pin in the lease-held record: these root files do not match it.
        let before = tree_witness::content_proofs();
        let refused = recheck_at(&tree.0, &early, MARKER.into(), "0".repeat(64)).unwrap_err();
        assert_eq!(refused.code, "artifact_digest_mismatch");
        // Another marker: proven again, and the result is bound to that marker.
        let other = ".smolvm-ready.other";
        let leased = recheck_at(&tree.0, &early, other.into(), pin.clone()).unwrap();
        assert_eq!(tree_witness::content_proofs() - before, 2);
        assert!(leased.stands(other, Some(&pin)).is_some());
        // What the recheck established stands for nothing else.
        assert_eq!(leased.stands(MARKER, Some(&pin)), None);
        assert_eq!(leased.stands(other, Some(&"0".repeat(64))), None);
        assert_eq!(leased.stands(other, None), None);
    }

    /// A stopped pool's owner record and root files in a candidate home. No provider runs.
    #[cfg(target_os = "macos")]
    struct Pool {
        directory: PathBuf,
        candidate: Candidate,
        owner: Owner,
    }

    #[cfg(target_os = "macos")]
    impl Drop for Pool {
        fn drop(&mut self) {
            tree_witness::fake_filesystem_type(None);
            let _ = fs::remove_file(&self.owner.short_home);
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[cfg(target_os = "macos")]
    impl Pool {
        fn new(name: &str) -> Self {
            use crate::provider::{NetworkIntent, Profile};
            tree_witness::fake_filesystem_type(Some("apfs"));
            let directory = crate::private_test_root(
                &std::env::temp_dir().canonicalize().unwrap(),
                &format!("hack-rootfs-recheck-{name}"),
            );
            let candidate = Candidate::discover(&directory).unwrap();
            let mut owner = Owner::create(
                &candidate,
                Profile::Development,
                None,
                NetworkIntent::Isolated,
            )
            .unwrap();
            let rootfs = root(&candidate).join("rootfs");
            fs::create_dir_all(rootfs.join("usr/bin")).unwrap();
            fs::write(rootfs.join("usr/bin/agent"), b"agent binary").unwrap();
            let marker = rootfs_marker(&owner).unwrap();
            owner.rootfs_digest = Some(artifact::rootfs_digest(&rootfs, Some(&marker)).unwrap());
            owner.phase = "stopped".into();
            owner.save(&candidate).unwrap();
            Self {
                directory,
                candidate,
                owner,
            }
        }

        /// `start_pool` from the early proof to the recheck under the startup lease.
        fn recheck(&self, early: Option<Early>) -> Result<Option<Leased>, CandidateError> {
            let lease = super::super::startup_lease(
                &root(&self.candidate),
                std::time::Duration::from_secs(2),
            )?;
            recheck(&self.candidate, &lease, early)
        }

        fn record(&self) -> Vec<u8> {
            fs::read(root(&self.candidate).join("owner.json")).unwrap()
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_recheck_reads_the_lease_held_owner_record_and_writes_nothing() {
        let pool = Pool::new("leased");
        let candidate = &pool.candidate;
        let mut owner = Owner::load(candidate).unwrap();
        let marker = rootfs_marker(&pool.owner).unwrap();
        let pin = pool.owner.rootfs_digest.clone().unwrap();
        let record = pool.record();
        let before = tree_witness::content_proofs();
        let early = prove(candidate).expect("a stopped pool's root files are proven early");
        assert_eq!(tree_witness::content_proofs() - before, 1);
        let leased = pool
            .recheck(Some(early))
            .unwrap()
            .expect("the proof stands");
        assert_eq!(tree_witness::content_proofs() - before, 1);
        assert!(leased.stands(&marker, Some(&pin)).is_some());
        // Nothing to recheck without an early proof: the full proof under the lease decides.
        assert!(pool.recheck(None).unwrap().is_none());
        // A root file changed after the early proof refuses under the lease, and the
        // recheck leaves the owner record as it was and writes no admission record.
        let early = prove(candidate).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(
            root(candidate).join("rootfs/usr/bin/agent"),
            b"agent BINARY",
        )
        .unwrap();
        let refused = pool.recheck(Some(early)).unwrap_err();
        assert_eq!(refused.code, "artifact_digest_mismatch");
        assert_eq!(pool.record(), record);
        assert!(!root(candidate).join("admission.json").exists());
        // The lease is the caller's: it is free again once the caller lets go of it.
        assert!(state::Lock::acquire(&root(candidate)).is_ok());
        // The pin the lease-held record names is the one proven against: the early proof
        // of the old pin does not stand for a record that names the changed bytes.
        fs::write(
            root(candidate).join("rootfs/usr/bin/agent"),
            b"agent binary",
        )
        .unwrap();
        let early = prove(candidate).unwrap();
        fs::write(
            root(candidate).join("rootfs/usr/bin/agent"),
            b"agent BINARY",
        )
        .unwrap();
        owner.rootfs_digest =
            Some(artifact::rootfs_digest(&root(candidate).join("rootfs"), Some(&marker)).unwrap());
        owner.save(candidate).unwrap();
        let leased = pool.recheck(Some(early)).unwrap().expect("proven again");
        assert_eq!(leased.stands(&marker, Some(&pin)), None);
        assert!(
            leased
                .stands(&marker, owner.rootfs_digest.as_deref())
                .is_some()
        );
        // A lease-held record without a pin, or no record, leaves the decision to the
        // full proof and the owner checks that follow.
        let early = prove(candidate).unwrap();
        owner.rootfs_digest = None;
        owner.save(candidate).unwrap();
        assert!(pool.recheck(Some(early)).unwrap().is_none());
    }
}
