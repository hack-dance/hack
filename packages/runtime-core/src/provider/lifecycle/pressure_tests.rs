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
/// in its `positive` configuration (root files proven under the lease). It reads source
/// order only; what each step does is covered by the tests that model's `COVERAGE.md` names.
#[test]
fn start_pool_takes_its_admission_steps_in_the_modelled_order() {
    let source = include_str!("../lifecycle.rs");
    let start = source.find("\nfn start_pool(").unwrap();
    let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
    let at = |step: &str| {
        body.find(step)
            .unwrap_or_else(|| panic!("start_pool no longer contains `{step}`"))
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
            "ProveTrees",
            "artifact::verify_witnessed(candidate, &artifact::SMOLVM)?",
        ),
        (
            "ProveTrees",
            "artifact::verify_witnessed(candidate, &artifact::ENGINE)?",
        ),
        ("AcquireLease, Recheck, Qualify", "startup_admission_lease("),
        (
            "RestoreAliasLeased",
            "restore_released_short_home(candidate)?;",
        ),
        (
            "Settle",
            "admission_pool::settle(candidate, &mut admission_owner, &lock, &mut samples)?",
        ),
        ("ProveRoot", "prepare_rootfs(candidate, &mut owner)?"),
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
}
