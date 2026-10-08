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
    }
}

#[test]
fn lease_wait_pressure_change_refuses_owner_commit_and_releases_the_mutation_lease() {
    let path = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "hkl-pressure-lease-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
    let prelease = [report(pressure.load(Ordering::SeqCst))];
    let owner = path.join("owner.json");
    let checked = startup_admission_lease(
        &path,
        Duration::from_secs(2),
        Profile::Development,
        &prelease,
        || {
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
