use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

/// A candidate home with prepared SmolVM and engine trees under the executor's real pins and
/// a pool directory to lease. No pool, provider or VM exists.
struct Home {
    directory: PathBuf,
    candidate: Candidate,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

type Proofs = BTreeMap<String, tree_witness::Proven>;

fn tree(path: &Path, files: &[(&str, &[u8])]) {
    for (name, bytes) in files {
        let file = path.join(name);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
}

fn record(candidate: &Candidate, name: &str, version: &str, archive: &str, tree: &Path) {
    let path = candidate.state_root.join("providers").join(name);
    let _ = fs::remove_file(&path);
    state::write(
        &path,
        &artifact::Artifact {
            version: version.into(),
            archive_sha256: archive.into(),
            tree_sha256: artifact::rootfs_digest(tree, None).unwrap(),
        },
    )
    .unwrap();
}

/// Let a status-change clock tick pass, so the next change is visible in the metadata.
fn tick() {
    std::thread::sleep(Duration::from_millis(20));
}

impl Home {
    fn new(name: &str) -> Self {
        // Metadata is trusted only on a qualified filesystem: this thread's tests report APFS
        // at the statfs boundary (set per thread, so tests do not interfere).
        tree_witness::fake_filesystem_type(Some("apfs"));
        let directory = crate::private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            &format!("hack-leased-trees-{name}"),
        );
        let candidate = Candidate::discover(&directory).unwrap();
        state::private_directory(&candidate.state_root.join("providers")).unwrap();
        state::private_directory(&root(&candidate)).unwrap();
        tree(
            &artifact::root(&candidate),
            &[("smolvm-bin", b"provider"), ("lib/libkrun.dylib", b"vmm")],
        );
        tree(
            &artifact::engine_root(&candidate),
            &[("dockerd", b"engine"), ("runc", b"runtime")],
        );
        record(
            &candidate,
            "smolvm.json",
            artifact::VERSION,
            artifact::ARCHIVE_SHA256,
            &artifact::root(&candidate),
        );
        record(
            &candidate,
            "docker.json",
            artifact::ENGINE_VERSION,
            artifact::ENGINE_SHA256,
            &artifact::engine_root(&candidate),
        );
        Self {
            directory,
            candidate,
        }
    }

    /// The content proofs `start_pool` takes before the lease.
    fn prove(&self) -> Proofs {
        BTreeMap::from([
            (
                tree_witness::SMOLVM.to_owned(),
                artifact::verify_witnessed(&self.candidate, &artifact::SMOLVM).unwrap(),
            ),
            (
                tree_witness::ENGINE.to_owned(),
                artifact::verify_witnessed(&self.candidate, &artifact::ENGINE).unwrap(),
            ),
        ])
    }

    /// `start_pool` from the lease to its first effect: the startup lease, the recheck and
    /// then the owner record. Returns the recheck's result and the content proofs it ran.
    fn lease_and_recheck(&self, proven: &mut Proofs) -> (Result<(), CandidateError>, usize) {
        let before = tree_witness::content_proofs();
        let result = startup_lease(&root(&self.candidate), Duration::from_secs(2))
            .and_then(|lease| recheck(&self.candidate, &lease, proven).map(|()| lease))
            .map(|_lease| fs::write(self.owner(), b"first effect after the recheck").unwrap());
        (result, tree_witness::content_proofs() - before)
    }

    fn owner(&self) -> PathBuf {
        root(&self.candidate).join("owner.json")
    }

    fn metadata(&self, pin: &artifact::TreePin) -> String {
        artifact::tree_metadata(&self.candidate, pin).unwrap()
    }

    /// Change a file's status-change time without changing its bytes or mode.
    fn touch(&self, file: &Path) {
        let mode = fs::metadata(file).unwrap().permissions();
        tick();
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(file, mode).unwrap();
    }
}

#[test]
fn unchanged_trees_keep_their_proofs_and_hash_nothing_under_the_lease() {
    let home = Home::new("unchanged");
    let mut proven = home.prove();
    let before = proven.clone();
    let (result, proofs) = home.lease_and_recheck(&mut proven);
    result.unwrap();
    assert_eq!(proofs, 0, "two metadata walks, no content hash");
    assert_eq!(proven, before);
    assert!(home.owner().exists(), "the start continues");
    // The lease is the caller's: it is free again once the caller lets go of it.
    assert!(state::Lock::acquire(&root(&home.candidate)).is_ok());
}

#[test]
fn a_tree_changed_between_its_proof_and_the_lease_refuses_before_any_effect() {
    for label in ["provider", "engine"] {
        let home = Home::new("changed");
        let mut proven = home.prove();
        let file = if label == "provider" {
            artifact::root(&home.candidate).join("lib/libkrun.dylib")
        } else {
            artifact::engine_root(&home.candidate).join("runc")
        };
        tick();
        fs::write(file, b"tampered").unwrap();
        let (result, proofs) = home.lease_and_recheck(&mut proven);
        assert_eq!(
            result.unwrap_err().code,
            "artifact_digest_mismatch",
            "{label}"
        );
        assert_eq!(proofs, 1, "{label}: only the changed tree is hashed again");
        // Nothing after the recheck ran, and the refusal returned the lease.
        assert!(!home.owner().exists(), "{label}");
        assert!(
            state::Lock::acquire(&root(&home.candidate)).is_ok(),
            "{label}"
        );
    }
}

#[test]
fn a_tree_whose_metadata_changed_but_whose_bytes_did_not_is_proven_again_and_continues() {
    let home = Home::new("touched");
    let mut proven = home.prove();
    let before = proven.clone();
    home.touch(&artifact::root(&home.candidate).join("smolvm-bin"));
    let (result, proofs) = home.lease_and_recheck(&mut proven);
    result.unwrap();
    // Only the touched tree is hashed again.
    assert_eq!(proofs, 1);
    assert_eq!(proven[tree_witness::ENGINE], before[tree_witness::ENGINE]);
    let (after, earlier) = (&proven[tree_witness::SMOLVM], &before[tree_witness::SMOLVM]);
    assert_ne!(after.metadata, earlier.metadata);
    assert_eq!(after.content, earlier.content);
    assert_eq!(after.metadata, home.metadata(&artifact::SMOLVM));
    assert!(home.owner().exists(), "the start continues");
}

#[test]
fn a_tree_reinstalled_with_its_recorded_content_is_proven_again_and_continues() {
    // What a repair between the proof and the lease leaves: the same bytes in new files.
    let home = Home::new("reinstalled");
    let mut proven = home.prove();
    let binary = artifact::engine_root(&home.candidate).join("dockerd");
    let replacement = binary.with_extension("new");
    tick();
    fs::write(&replacement, b"engine").unwrap();
    fs::set_permissions(&replacement, fs::metadata(&binary).unwrap().permissions()).unwrap();
    fs::rename(&replacement, &binary).unwrap();
    let (result, proofs) = home.lease_and_recheck(&mut proven);
    result.unwrap();
    assert_eq!(proofs, 1);
    assert_eq!(
        proven[tree_witness::ENGINE].metadata,
        home.metadata(&artifact::ENGINE)
    );
}

#[test]
fn the_recorded_witness_names_what_was_verified_under_the_lease() {
    let home = Home::new("witness");
    let mut proven = home.prove();
    let before_lease = proven[tree_witness::SMOLVM].metadata.clone();
    home.touch(&artifact::root(&home.candidate).join("lib/libkrun.dylib"));
    let lease = startup_lease(&root(&home.candidate), Duration::from_secs(2)).unwrap();
    recheck(&home.candidate, &lease, &mut proven).unwrap();
    let process = identity::ProcessIdentity {
        pid: 4242,
        start_micros: 1_700_000_000_000_000,
        uid: unsafe { libc::geteuid() },
        executable: PathBuf::from("/fixture/smolvm-bin"),
    };
    // As `start_pool` records a successful boot: the rechecked proofs, under the same lease.
    tree_witness::record_boot(&home.candidate, &lease, true, Some(&process), proven);
    for (name, pin) in [
        (tree_witness::SMOLVM, &artifact::SMOLVM),
        (tree_witness::ENGINE, &artifact::ENGINE),
    ] {
        let anchor = artifact::verify_record(&home.candidate, pin)
            .unwrap()
            .tree_sha256;
        // The next command's cheap check accepts exactly the trees as they are now.
        assert!(
            tree_witness::matches(
                &home.candidate,
                &process,
                name,
                &home.metadata(pin),
                &anchor
            ),
            "{name}"
        );
    }
    // The metadata the proof before the lease saw is not what the witness names.
    let anchor = artifact::verify_record(&home.candidate, &artifact::SMOLVM)
        .unwrap()
        .tree_sha256;
    assert!(!tree_witness::matches(
        &home.candidate,
        &process,
        tree_witness::SMOLVM,
        &before_lease,
        &anchor
    ));
}

#[test]
fn off_a_qualified_filesystem_both_trees_are_proven_again_under_the_lease() {
    let home = Home::new("unqualified");
    let mut proven = home.prove();
    for name in [Some("nfs"), Some("msdos")] {
        tree_witness::fake_filesystem_type(name);
        let _ = fs::remove_file(home.owner());
        let (result, proofs) = home.lease_and_recheck(&mut proven);
        result.unwrap();
        assert_eq!(proofs, 2, "{name:?}");
    }
    // A changed tree is still refused there, by the content proof.
    tick();
    fs::write(
        artifact::engine_root(&home.candidate).join("runc"),
        b"tampered",
    )
    .unwrap();
    let _ = fs::remove_file(home.owner());
    let (result, _) = home.lease_and_recheck(&mut proven);
    assert_eq!(result.unwrap_err().code, "artifact_digest_mismatch");
    assert!(!home.owner().exists());
}

#[test]
fn a_rewritten_record_or_an_aliased_tree_is_refused_under_the_lease() {
    // The content anchor changed after the proof: the proof no longer stands, and the tree
    // does not match the new anchor.
    let home = Home::new("anchor");
    let mut proven = home.prove();
    let path = home.candidate.state_root.join("providers/smolvm.json");
    let mut rewritten: artifact::Artifact = state::read(&path).unwrap();
    rewritten.tree_sha256 = "0".repeat(64);
    fs::remove_file(&path).unwrap();
    state::write(&path, &rewritten).unwrap();
    let (result, proofs) = home.lease_and_recheck(&mut proven);
    assert_eq!(result.unwrap_err().code, "artifact_digest_mismatch");
    assert_eq!(proofs, 1);

    // The record names another pin: refused with that diagnostic, before any walk or hash.
    let home = Home::new("pin");
    let mut proven = home.prove();
    record(
        &home.candidate,
        "docker.json",
        "0.9.0",
        artifact::ENGINE_SHA256,
        &artifact::engine_root(&home.candidate),
    );
    let (result, proofs) = home.lease_and_recheck(&mut proven);
    assert_eq!(result.unwrap_err().code, "provider_pin_changed");
    assert_eq!(proofs, 0);

    // The tree became an alias: refused without following it.
    let home = Home::new("alias");
    let mut proven = home.prove();
    let tree = artifact::tree_root(&home.candidate, &artifact::SMOLVM);
    let moved = tree.with_extension("original");
    fs::rename(&tree, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &tree).unwrap();
    let (result, proofs) = home.lease_and_recheck(&mut proven);
    assert_eq!(result.unwrap_err().code, "aliased_state");
    assert_eq!(proofs, 0);
    assert!(!home.owner().exists());
}

/// Bench, not a check: the time of one metadata walk, which is what the recheck adds to a
/// start per tree. Run with `--ignored --nocapture`. The fixture has the entry counts of the
/// pinned SmolVM tree (130 directories, 422 files, 384 symlinks); file sizes do not matter,
/// because the walk reads no file. `HACK_TREE_WALK_BENCH_ROOTS` may name prepared trees
/// (colon-separated directories) to time as well; they are only read.
#[test]
#[ignore = "bench: prints the time of one metadata walk"]
fn bench_one_metadata_walk_of_a_prepared_tree() {
    fn time(label: &str, root: &Path) {
        const RUNS: usize = 21;
        // One untimed walk first, so every timed walk finds the directory entries cached,
        // as the recheck does right after the content proof read them.
        let entries = walk_entries(root);
        tree_witness::qualified_digest(root, None).unwrap();
        let mut samples: Vec<Duration> = (0..RUNS)
            .map(|_| {
                let started = Instant::now();
                let digest = tree_witness::qualified_digest(root, None).unwrap();
                let elapsed = started.elapsed();
                std::hint::black_box(digest);
                elapsed
            })
            .collect();
        samples.sort();
        println!(
            "metadata walk, {label}: {entries} entries, median {:?}, min {:?}, max {:?} over {RUNS} walks",
            samples[RUNS / 2],
            samples[0],
            samples[RUNS - 1],
        );
    }
    fn walk_entries(root: &Path) -> usize {
        fs::read_dir(root)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                1 + if entry.file_type().unwrap().is_dir() {
                    walk_entries(&entry.path())
                } else {
                    0
                }
            })
            .sum()
    }
    let directory = crate::private_test_root(
        &std::env::temp_dir().canonicalize().unwrap(),
        "hack-leased-trees-bench",
    );
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _remove = Remove(directory.clone());
    let fixture = directory.join("tree");
    let mut files = 0;
    let mut links = 0;
    for index in 0..130 {
        let branch = fixture.join(format!("lib-{index:03}"));
        fs::create_dir_all(&branch).unwrap();
        while files < 422 * (index + 1) / 130 {
            fs::write(branch.join(format!("file-{files:03}")), b"fixture").unwrap();
            files += 1;
        }
        while links < 384 * (index + 1) / 130 {
            std::os::unix::fs::symlink("file-000", branch.join(format!("link-{links:03}")))
                .unwrap();
            links += 1;
        }
    }
    time("fixture", &fixture);
    if let Some(roots) = std::env::var_os("HACK_TREE_WALK_BENCH_ROOTS") {
        for root in std::env::split_paths(&roots) {
            let name = root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
            time(name.as_deref().unwrap_or("named tree"), &root);
        }
    }
}
