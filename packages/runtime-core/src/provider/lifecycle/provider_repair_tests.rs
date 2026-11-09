//! HACK-1950: a prepared provider tree changed outside Hack (here, every empty directory
//! pruned) must not block a stopped pool's `status` and `down`, and a supported repair
//! re-prepares it from the retained archive while execution stays refused until then.
use super::*;
use crate::provider::artifact::tree_fixture;
use crate::provider::{NetworkIntent, Profile};
use std::path::PathBuf;

/// A stopped (or otherwise recorded) pool with no live provider. Its short HOME alias
/// lives under `/private/tmp` for the socket path budget and is removed on drop.
struct Pool {
    root: PathBuf,
    candidate: Candidate,
    owner: Owner,
}

impl Pool {
    fn new(phase: &str) -> Self {
        let mut random = [0_u8; 8];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let root = PathBuf::from("/private/tmp").join(format!("hkr-{nonce}"));
        fs::create_dir(&root).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        let mut owner =
            Owner::create(&candidate, Profile::Research, None, NetworkIntent::Isolated).unwrap();
        let data = owner.real_data_dir(&candidate).unwrap();
        state::private_directory(&data).unwrap();
        fs::write(data.join("name"), &owner.machine).unwrap();
        owner.phase = phase.into();
        owner.save(&candidate).unwrap();
        Self {
            root,
            candidate,
            owner,
        }
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.owner.short_home);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn a_stopped_pool_with_a_pruned_provider_tree_goes_down_and_is_repaired() {
    let pool = Pool::new("stopped");
    let candidate = &pool.candidate;
    tree_fixture::prepared_smolvm(candidate);
    let pin = tree_fixture::prepare(candidate, &pool.root);
    let providers = candidate.state_root.join("providers");
    assert!(tree_fixture::prune_empty_directories(&artifact::root(candidate)) >= 6);
    assert!(tree_fixture::prune_empty_directories(&providers.join("test-tree-1.0.0")) >= 6);
    assert_eq!(
        artifact::verify(candidate).unwrap_err().code,
        "artifact_digest_mismatch"
    );

    // The installer's quiescence check: status, down, status, all without the tree.
    for observed in [status(candidate), down(candidate), status(candidate)] {
        let observed = observed.unwrap();
        assert_eq!(observed.phase, "stopped");
        assert_eq!(observed.process_alive, None);
    }
    // Down executed nothing from the tree; execution is still refused.
    assert_eq!(
        artifact::verify(candidate).unwrap_err().code,
        "artifact_digest_mismatch"
    );
    assert!(
        artifact::verify(candidate)
            .unwrap_err()
            .message
            .contains("runtime repair-provider-tree")
    );

    let repaired = repair_trees(candidate, &[pin]).unwrap();
    assert_eq!(repaired.runtime.phase, "stopped");
    assert_eq!(repaired.trees.len(), 1);
    assert!(repaired.trees[0].repaired);
    assert!(repaired.trees[0].retained_changed_tree.is_some());
    // Runtime state is untouched: the same owner and machine remain.
    let after = Owner::load(candidate).unwrap();
    assert_eq!(after.token, pool.owner.token);
    assert_eq!(after.machine, pool.owner.machine);
    assert_eq!(after.phase, "stopped");
    // The pinned SmolVM tree has no retained archive here, so its repair is unavailable
    // and the real executor keeps refusing it.
    assert_eq!(
        repair_provider_trees(candidate).err().unwrap().code,
        "provider_repair_unavailable"
    );
    assert_eq!(
        artifact::verify(candidate).unwrap_err().code,
        "artifact_digest_mismatch"
    );
}

#[test]
fn a_pool_that_is_not_proven_stopped_keeps_verifying_and_refuses_repair() {
    let pool = Pool::new("running");
    let candidate = &pool.candidate;
    tree_fixture::prepared_smolvm(candidate);
    let pin = tree_fixture::prepare(candidate, &pool.root);
    tree_fixture::prune_empty_directories(&artifact::root(candidate));
    tree_fixture::prune_empty_directories(&candidate.state_root.join("providers/test-tree-1.0.0"));
    // Stopping an unproven provider reaches the tree, so down still verifies it first.
    assert_eq!(
        down(candidate).err().unwrap().code,
        "artifact_digest_mismatch"
    );
    assert_eq!(
        repair_trees(candidate, &[pin]).err().unwrap().code,
        "provider_repair_requires_stopped_runtime"
    );
    assert_eq!(Owner::load(candidate).unwrap().phase, "running");
}

#[test]
fn repair_of_a_home_without_prepared_providers_creates_no_state() {
    let mut random = [0_u8; 8];
    File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let root = PathBuf::from("/private/tmp").join(format!("hkr-{nonce}"));
    fs::create_dir(&root).unwrap();
    let candidate = Candidate::discover(&root).unwrap();
    let repaired = repair_provider_trees(&candidate).unwrap();
    assert!(repaired.trees.is_empty());
    assert_eq!(repaired.runtime.phase, "uninitialized");
    assert!(!candidate.state_root.exists());
    fs::remove_dir_all(root).unwrap();
}
