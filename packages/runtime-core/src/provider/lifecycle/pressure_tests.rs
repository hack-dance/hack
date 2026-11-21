use super::super::Profile;
use super::*;
use admission::{Admission, MemoryPressure};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};

fn report(level: u32) -> Admission {
    const GIB: u64 = 1024 * 1024 * 1024;
    Admission {
        profile: Profile::Development,
        host_supported: true,
        free_memory_bytes: Some(10 * GIB),
        minimum_free_memory_bytes: 10 * GIB,
        free_plus_file_cache_estimate_bytes: Some(10 * GIB),
        memory_budget_basis: "fixture",
        memory_pressure: MemoryPressure::from_level(Some(level)),
        memory_pressure_normal: level == 1,
        disk_free_bytes: Some(58 * GIB),
        minimum_disk_free_bytes: 58 * GIB,
        disk_budget_basis: "fixture",
        one_minute_load: Some(0.0),
        load_ceiling: None,
        thermal_normal: true,
        swapouts: Some(42),
        admitted: true,
        reasons: Vec::new(),
        retained_reserve_refusal: None,
    }
}

#[test]
fn lease_wait_pressure_change_refuses_owner_commit_and_releases_the_mutation_lease() {
    let path = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "hkl-pressure-lease-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            crate::next_test_scratch()
        ));
    struct Remove(std::path::PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _remove = Remove(path.clone());
    state::private_directory(&path).unwrap();
    let held = state::Lock::acquire(&path).unwrap();
    let pressure = Arc::new(AtomicU32::new(2));
    let changed = Arc::clone(&pressure);
    let worker = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        changed.store(4, Ordering::SeqCst);
        drop(held);
    });
    // A clock that sleeps without waiting: the window is this module's contract with
    // `admission`, whose own tests measure it.
    struct Skipping(std::cell::Cell<Duration>);
    impl process::Clock for Skipping {
        fn now(&self) -> Duration {
            self.0.get()
        }
        fn sleep(&self, duration: Duration) {
            self.0.set(self.0.get() + duration);
        }
    }
    let clock = Skipping(std::cell::Cell::new(Duration::ZERO));
    let opened = admission::open(&report(pressure.load(Ordering::SeqCst)), &clock).unwrap();
    let owner = path.join("owner.json");
    let checked = startup_admission_lease(
        &path,
        Duration::from_secs(2),
        Profile::Development,
        Some(opened),
        &clock,
        || {
            // Sampled only once the window has passed, and only under the lease.
            assert!(clock.0.get() >= admission::DEVELOPMENT_WINDOW);
            assert!(
                matches!(state::Lock::acquire(&path), Err(error) if error.code == "provider_busy")
            );
            Ok(report(pressure.load(Ordering::SeqCst)))
        },
    )
    .map(|(_lease, _samples)| fs::write(&owner, b"must-not-create-owner").unwrap());
    worker.join().unwrap();
    assert!(matches!(checked, Err(error) if error.code == "admission_rejected"));
    assert!(!owner.exists());
    // A failed fresh sample does not leave a lease or grant allocation authority.
    assert!(state::Lock::acquire(&path).is_ok());
}

/// Ties `start_pool` to the step order of `tests/models/tla/pool-start-admission/PoolStart.tla`
/// in both configurations that describe the code: `root-before-lease` (a cleanly stopped
/// pool: root files proven in the window, rechecked under the lease and compared again
/// where their digest is used) and `positive` (no early proof: root files proven under the
/// lease). In both the trees are rechecked under the lease. It reads source order only;
/// what each step does is covered by the tests that model's `COVERAGE.md` names.
#[test]
fn start_pool_takes_its_admission_steps_in_the_modelled_order() {
    let source = include_str!("../lifecycle.rs");
    let start = source.find("\nfn start_pool(").unwrap();
    let wrapper = &source[start..start + source[start..].find("\n}\n").unwrap()];
    assert!(wrapper.contains("start_pool_observed("));
    let start = source.find("\nfn start_pool_observed(").unwrap();
    let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
    let at = |step: &str| {
        body.find(step)
            .unwrap_or_else(|| panic!("start_pool_observed no longer contains `{step}`"))
    };
    // Model action, then the call that performs it.
    let steps = [
        (
            "RestoreAliasBeforeUse",
            "restore_released_short_home_before_use(candidate)?;",
        ),
        (
            "ResumeRunning",
            "running_start::select(candidate, profile)?",
        ),
        (
            "Open: selection",
            "admission_pool::select(candidate, profile)?",
        ),
        (
            "Open: first sample",
            "admission_pool::probe(candidate, profile, &admission_owner)?",
        ),
        (
            "Open: window",
            "admission::open(&admission, &admission_clock)?",
        ),
        ("ResearchSample", "admission::sample_with(profile, ||"),
        (
            "ProveRootEarly, on a thread beside ProveTrees",
            "rootfs_proof::early_beside(candidate, ||",
        ),
        (
            "ProveTrees",
            "artifact::verify_witnessed(candidate, &artifact::SMOLVM)?",
        ),
        (
            "ProveTrees",
            "artifact::verify_witnessed(candidate, &artifact::ENGINE)?",
        ),
        (
            "RefuseTree: a failed tree proof returns before the lease",
            "let mut proven_trees = proven_trees?;",
        ),
        ("AcquireLease, Recheck, Qualify", "startup_admission_lease("),
        (
            "RefuseTreeRecheck, the tree guard of Settle and ObserveRunning",
            "leased_trees::recheck(candidate, &lock, &mut proven_trees)?;",
        ),
        (
            "RecheckRoot and its RefuseRoot",
            "rootfs_proof::recheck(candidate, &lock, early_rootfs)?;",
        ),
        (
            "RestoreAliasLeased",
            "restore_released_short_home(candidate)?;",
        ),
        (
            "Settle",
            "admission_pool::settle(candidate, &mut admission_owner, &lock, &mut samples)?",
        ),
        (
            "ProveRoot, or the digest RecheckRoot took under the lease",
            "prepare_rootfs(candidate, &mut owner, leased_rootfs.as_ref())?",
        ),
        ("AdmitBoot", "admission_pool::admit_boot("),
        ("Start: final recheck", "boot.release(candidate, &lock)?"),
        (
            "Start",
            "start_machine(&SmolvmCli::new(candidate, &owner), permit)?",
        ),
    ];
    for pair in steps.windows(2) {
        assert!(
            at(pair[0].1) < at(pair[1].1),
            "{} must come before {}",
            pair[0].0,
            pair[1].0
        );
    }
    // One clock opens the window and judges it under the lease.
    assert_eq!(body.matches("process::MonotonicClock::new()").count(), 1);
    let lease = &body[at("startup_admission_lease(")..];
    assert!(lease[..lease.find(")?;").unwrap()].contains("&admission_clock,"));
    // The pre-boot check is handed the last qualifying sample's swapout count, and nothing
    // but the sample under the lease is added to the samples after the first window.
    let gate = &body[at("admission_pool::admit_boot(")..];
    assert!(
        gate[..gate.find(")? {").unwrap()]
            .contains("samples.last().and_then(|sample| sample.swapouts)")
    );
    assert_eq!(body.matches("samples.extend(").count(), 1);
    assert_eq!(body.matches("samples.push(").count(), 0);
    // The tree recheck is the first use of the lease after the sample: between recording
    // the leased sample and the recheck the source holds comments only, so nothing is
    // written and no provider command runs there. The model's `ObserveRunning` branch and
    // every read of a tree come after it.
    let recheck = at("leased_trees::recheck(candidate, &lock, &mut proven_trees)?;");
    let sampled = "samples.extend(fresh_samples);";
    let between = &body[at(sampled) + sampled.len()..recheck];
    for line in between.lines().map(str::trim) {
        assert!(
            line.is_empty() || line.starts_with("//"),
            "only comments may sit between the leased sample and the tree recheck, found `{line}`"
        );
    }
    for later in [
        "interrupted::before_boot(",
        "Owner::create_with_project_share(",
        "state::write(&root(candidate).join(\"admission.json\")",
        "if owner.phase == \"running\" {",
        "agent::require_engine_names_unshadowed(",
        "create_machine(&SmolvmCli::new(candidate, &owner), &spec, fresh)?;",
    ] {
        assert!(
            recheck < at(later),
            "the tree recheck must come before `{later}`"
        );
    }
    // The root files recheck is the step after the tree recheck: between the two nothing is
    // written and no provider command runs, and the same later steps come after it.
    let tree_recheck = "leased_trees::recheck(candidate, &lock, &mut proven_trees)?;";
    let root_recheck = at("let leased_rootfs = rootfs_proof::recheck(");
    assert!(
        body[recheck + tree_recheck.len()..root_recheck]
            .lines()
            .all(|line| line.trim().is_empty() || line.trim().starts_with("//")),
        "nothing runs between the tree recheck and the root files recheck"
    );
    for later in [
        "restore_released_short_home(candidate)?;",
        "interrupted::before_boot(",
        "Owner::create_with_project_share(",
        "state::write(&root(candidate).join(\"admission.json\")",
        "if owner.phase == \"running\" {",
        "enable_amd64_emulation(",
        "create_machine(&SmolvmCli::new(candidate, &owner), &spec, fresh)?;",
    ] {
        assert!(
            root_recheck < at(later),
            "the root files recheck must come before `{later}`"
        );
    }
    // The root files are compared once more where the recheck's digest is used. That point,
    // `prepare_rootfs`, comes after the provider command a start can run before it
    // (`machine update --rosetta`, in `enable_amd64_emulation`); from it to `machine start`
    // the only provider command is `machine create`, which a pool with an early proof never
    // reaches. Inside `prepare_rootfs` the walk decides before the content proof it falls
    // back to, which is the function's last expression.
    let used = at("let rootfs_metadata = prepare_rootfs(");
    let started = at("start_machine(&SmolvmCli::new(candidate, &owner), permit)?");
    assert!(at("enable_amd64_emulation(") < used);
    assert_eq!(body.matches("enable_amd64_emulation(").count(), 1);
    // Provider commands go through the typed backend (`SmolvmCli`); none is invoked directly.
    assert!(!body[used..started].contains("invoke("));
    assert_eq!(body[used..started].matches("SmolvmCli::new(").count(), 1);
    assert_eq!(body.matches("create_machine(").count(), 1);
    let create = at("create_machine(&SmolvmCli::new(candidate, &owner), &spec, fresh)?;");
    assert!(used < at("if !owner.created {") && at("if !owner.created {") < create);
    assert!(create < started);
    let prepare = source.find("\nfn prepare_rootfs(").unwrap();
    let prepare = &source[prepare..prepare + source[prepare..].find("\n}\n").unwrap()];
    let walk = prepare
        .find("leased.stands(&destination, &marker, owner.rootfs_digest.as_deref())")
        .expect("prepare_rootfs compares the root files again before it uses the digest");
    let proof = "\n    prove_rootfs(&destination, &marker, owner.rootfs_digest.as_deref())";
    assert!(walk < prepare.rfind(proof).unwrap());
    assert!(prepare.ends_with(proof));
    // The boot's witness is the rechecked proofs, with the root files proof added to them:
    // the digest of that last walk, or of the full proof `prepare_rootfs` ran.
    let root = &body[at("let rootfs_metadata = prepare_rootfs(")..];
    let root = &root[..root.find("if !owner.created {").unwrap()];
    assert!(root.contains("leased_rootfs.as_ref()") && root.contains("metadata: rootfs_metadata,"));
    let witness = &body[at("tree_witness::record_boot(")..];
    assert!(witness[..witness.find(");").unwrap()].contains("proven_trees,"));
    assert_eq!(body.matches("let mut proven_trees").count(), 1);
}
