use super::*;
use crate::provider::{NetworkIntent, Profile};
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, MetadataExt},
            net::UnixListener,
        },
    },
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_POOL: AtomicU64 = AtomicU64::new(0);

fn pool_directory(timestamp: u128) -> PathBuf {
    fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "hack-home-recovery-{}-{timestamp}-{}",
            std::process::id(),
            NEXT_POOL.fetch_add(1, Ordering::Relaxed)
        ))
}

fn create_pool_directory(path: &std::path::Path) -> std::io::Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[test]
fn parallel_pool_roots_are_unique_at_the_same_timestamp_and_never_adopt() {
    let paths: Vec<_> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..16)
            .map(|_| {
                scope.spawn(|| {
                    let path = pool_directory(123);
                    create_pool_directory(&path).unwrap();
                    path
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect()
    });
    assert_eq!(
        paths
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        16
    );
    for path in paths {
        let before = fs::symlink_metadata(&path).unwrap();
        assert_eq!(before.mode() & 0o777, 0o700);
        fs::write(path.join("marker"), b"owned fixture").unwrap();
        assert_eq!(
            create_pool_directory(&path).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), before.ino());
        assert_eq!(fs::read(path.join("marker")).unwrap(), b"owned fixture");
        fs::remove_file(path.join("marker")).unwrap();
        fs::remove_dir(path).unwrap();
    }
}

struct Pool {
    candidate: Candidate,
    owner: Owner,
    directory: PathBuf,
}
impl Pool {
    fn new() -> Self {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut process = identity::observe(child.id() as i32).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        let directory = pool_directory(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        );
        create_pool_directory(&directory).unwrap();
        let candidate = Candidate::discover(&directory).unwrap();
        let operation = state::Lock::acquire(&root(&candidate)).unwrap();
        let mut owner = Owner::create(
            &candidate,
            Profile::Development,
            None,
            NetworkIntent::Isolated,
        )
        .unwrap();
        let data = owner.real_data_dir(&candidate).unwrap();
        state::private_directory(&data).unwrap();
        for (name, tag) in [("storage.raw", 1u8), ("overlay.raw", 2)] {
            let mut bytes = vec![0u8; 4096];
            bytes[1080..1082].copy_from_slice(&[0x53, 0xef]);
            bytes[1128..1144].fill(tag);
            bytes[2048..2059].copy_from_slice(b"data-marker");
            fs::write(data.join(name), bytes).unwrap();
        }
        fs::write(data.join("vm.lock"), b"").unwrap();
        fs::write(data.join("name"), &owner.machine).unwrap();
        process.executable = binary(&candidate);
        owner.process = Some(process);
        owner.created = true;
        owner.phase = "running".into();
        owner.storage = Some(identity::disk(&data.join("storage.raw")).unwrap());
        owner.overlay = Some(identity::disk(&data.join("overlay.raw")).unwrap());
        owner.save(&candidate).unwrap();
        drop(operation);
        Self {
            candidate,
            owner,
            directory,
        }
    }
    fn remove_alias(&self) {
        fs::remove_file(&self.owner.short_home).unwrap();
    }
    fn receipt(&self) -> Vec<u8> {
        fs::read(root(&self.candidate).join("owner.json")).unwrap()
    }
    fn data(&self) -> PathBuf {
        self.owner.real_data_dir(&self.candidate).unwrap()
    }
    fn unchanged(&self, before: &[u8]) {
        assert_eq!(self.receipt(), before);
        assert!(self.owner.short_home.symlink_metadata().is_err());
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.owner.short_home);
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

/// Run one ignored recovery fixture of this module alone in a child test process.
///
/// Recovery must find the pool's disks, VM lock and sockets released before it changes the
/// receipt. In the shared parallel test process, an unrelated test's pre-exec fork
/// (`process::clean_command`) holds a copy of every descriptor open at the fork until it
/// execs, so a disk this test just read or a listener it just dropped can still show up to
/// the host-wide `lsof` scan or accept a connection, and recovery correctly refuses as
/// `stop_uncertain`. Every test that expects those release checks to pass runs isolated.
fn isolated(child: &str) {
    use crate::provider::test_executable::{ISOLATED_HANG_GUARD, run_isolated};
    run_isolated(
        &format!("provider::lifecycle::short_home::tests::{child}"),
        ISOLATED_HANG_GUARD,
    );
}

#[test]
fn explicit_recovery_restores_only_missing_alias_and_preserves_disk_bytes() {
    isolated("explicit_recovery_child");
}

#[test]
#[ignore = "isolated release-check fixture launched by explicit_recovery_restores_only_missing_alias_and_preserves_disk_bytes"]
fn explicit_recovery_child() {
    let pool = Pool::new();
    let storage = fs::read(pool.data().join("storage.raw")).unwrap();
    let overlay = fs::read(pool.data().join("overlay.raw")).unwrap();
    pool.remove_alias();
    assert_eq!(
        status(&pool.candidate).unwrap_err().code,
        "provider_home_missing"
    );
    let recovered = crate::provider::recover(&pool.candidate).unwrap();
    assert_eq!(recovered.phase, "recovered-unclean");
    assert_eq!(recovered.process_alive, Some(false));
    assert_eq!(
        fs::read_link(&pool.owner.short_home).unwrap(),
        root(&pool.candidate).join("home")
    );
    assert_eq!(fs::read(pool.data().join("storage.raw")).unwrap(), storage);
    assert_eq!(fs::read(pool.data().join("overlay.raw")).unwrap(), overlay);
    assert_eq!(
        Owner::load(&pool.candidate).unwrap().storage,
        pool.owner.storage
    );
}

#[test]
fn live_or_reused_pid_and_missing_disk_identity_refuse_without_alias_effect() {
    for case in 0..3 {
        let mut pool = Pool::new();
        if case < 2 {
            let p = pool.owner.process.as_mut().unwrap();
            p.pid = std::process::id() as i32;
            p.start_micros = if case == 0 {
                identity::observe(p.pid).unwrap().start_micros
            } else {
                1
            };
        } else {
            pool.owner.overlay = None;
        }
        pool.owner.save(&pool.candidate).unwrap();
        pool.remove_alias();
        let before = pool.receipt();
        assert_eq!(
            crate::provider::recover(&pool.candidate).unwrap_err().code,
            "recovery_required"
        );
        pool.unchanged(&before);
    }
}

#[test]
fn changed_disk_held_vm_lock_and_open_disk_refuse_before_alias_creation() {
    for case in 0..3 {
        let pool = Pool::new();
        pool.remove_alias();
        let before = pool.receipt();
        let mut held = None;
        if case == 0 {
            fs::write(pool.data().join("overlay.raw"), b"changed disk").unwrap();
        }
        if case == 1 {
            let f = fs::File::open(pool.data().join("vm.lock")).unwrap();
            assert_eq!(
                unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            held = Some(f);
        }
        if case == 2 {
            held = Some(fs::File::open(pool.data().join("storage.raw")).unwrap());
        }
        assert!(crate::provider::recover(&pool.candidate).is_err());
        pool.unchanged(&before);
        drop(held);
    }
}

#[test]
fn existing_file_directory_and_foreign_symlink_are_never_replaced() {
    isolated("foreign_alias_child");
}

#[test]
#[ignore = "isolated release-check fixture launched by existing_file_directory_and_foreign_symlink_are_never_replaced"]
fn foreign_alias_child() {
    for case in 0..3 {
        let pool = Pool::new();
        pool.remove_alias();
        let before = pool.receipt();
        if case == 0 {
            fs::write(&pool.owner.short_home, b"foreign marker").unwrap();
        }
        if case == 1 {
            fs::create_dir(&pool.owner.short_home).unwrap();
        }
        if case == 2 {
            std::os::unix::fs::symlink(&pool.directory, &pool.owner.short_home).unwrap();
        }
        let inode = fs::symlink_metadata(&pool.owner.short_home).unwrap().ino();
        assert_eq!(
            crate::provider::recover(&pool.candidate).unwrap_err().code,
            "foreign_state"
        );
        assert_eq!(pool.receipt(), before);
        assert_eq!(
            fs::symlink_metadata(&pool.owner.short_home).unwrap().ino(),
            inode
        );
        if case == 1 {
            fs::remove_dir(&pool.owner.short_home).unwrap();
        }
    }
}

#[test]
fn active_socket_leaves_explicit_incomplete_recovery_then_retry_finishes() {
    isolated("active_socket_retry_child");
}

#[test]
#[ignore = "isolated release-check fixture launched by active_socket_leaves_explicit_incomplete_recovery_then_retry_finishes"]
fn active_socket_retry_child() {
    let pool = Pool::new();
    let listener = UnixListener::bind(pool.owner.data_dir().join("agent.sock")).unwrap();
    pool.remove_alias();
    let before = pool.receipt();
    let error = crate::provider::recover(&pool.candidate).unwrap_err();
    assert_eq!(error.code, "provider_home_restored_recovery_incomplete");
    assert!(error.message.contains("stop_uncertain"));
    assert_eq!(pool.receipt(), before);
    assert_eq!(
        fs::read_link(&pool.owner.short_home).unwrap(),
        root(&pool.candidate).join("home")
    );
    drop(listener);
    assert_eq!(
        crate::provider::recover(&pool.candidate).unwrap().phase,
        "recovered-unclean"
    );
}

#[test]
fn receipt_change_and_concurrent_alias_creation_refuse_exclusive_repair() {
    let mut pool = Pool::new();
    pool.remove_alias();
    let observed = Owner::load_for_short_home_recovery(&pool.candidate).unwrap();
    pool.owner.phase = "stopped".into();
    pool.owner.save(&pool.candidate).unwrap();
    let before = pool.receipt();
    assert_eq!(
        observed
            .restore_missing_short_home(&pool.candidate)
            .unwrap_err()
            .code,
        "foreign_state"
    );
    pool.unchanged(&before);
    std::os::unix::fs::symlink(root(&pool.candidate).join("home"), &pool.owner.short_home).unwrap();
    let inode = fs::symlink_metadata(&pool.owner.short_home).unwrap().ino();
    assert_eq!(
        pool.owner
            .restore_missing_short_home(&pool.candidate)
            .unwrap_err()
            .code,
        "socket_alias_collision"
    );
    assert_eq!(
        fs::symlink_metadata(&pool.owner.short_home).unwrap().ino(),
        inode
    );
    assert_eq!(pool.receipt(), before);
}

#[test]
fn pending_owner_update_is_preserved_and_refuses_alias_repair() {
    let pool = Pool::new();
    pool.remove_alias();
    let before = pool.receipt();
    let pending = root(&pool.candidate).join("owner.pending");
    fs::write(&pending, b"interrupted update").unwrap();
    assert_eq!(
        crate::provider::recover(&pool.candidate).unwrap_err().code,
        "recovery_required"
    );
    pool.unchanged(&before);
    assert_eq!(fs::read(&pending).unwrap(), b"interrupted update");
}

#[test]
fn vm_lock_releases_on_success_and_error_even_with_an_inherited_descriptor() {
    isolated("vm_lock_release_child");
}

#[test]
#[ignore = "isolated release-check fixture launched by vm_lock_releases_on_success_and_error_even_with_an_inherited_descriptor"]
fn vm_lock_release_child() {
    for fail in [false, true] {
        let pool = Pool::new();
        let listener =
            fail.then(|| UnixListener::bind(pool.owner.data_dir().join("agent.sock")).unwrap());
        let before = pool.receipt();
        let guard = lock_absent_disks(&pool.candidate, &pool.owner).unwrap();
        // A dup shares the open-file description, exactly as an inherited fork FD does.
        let inherited = guard.try_clone().unwrap();
        let independent = fs::File::open(pool.data().join("vm.lock")).unwrap();
        assert_ne!(
            unsafe { libc::flock(independent.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let mut owner = pool.owner.clone();
        let result = finish_absent_locked(
            &pool.candidate,
            &mut owner,
            "recovered-unclean",
            false,
            &guard,
        );
        if fail {
            assert_eq!(result.unwrap_err().code, "stop_uncertain");
            assert_eq!(pool.receipt(), before);
        } else {
            result.unwrap();
            assert_eq!(
                Owner::load(&pool.candidate).unwrap().phase,
                "recovered-unclean"
            );
        }
        drop(guard);
        assert!(inherited.metadata().is_ok());
        assert_eq!(
            unsafe { libc::flock(independent.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert_eq!(
            unsafe { libc::flock(independent.as_raw_fd(), libc::LOCK_UN) },
            0
        );
        drop(inherited);
        drop(listener);
    }
}

/// HACK-1916: a clean `down` releases the temporary HOME alias, so a stopped pool leaves
/// nothing under `/private/tmp`, and the next mutating operation restores it exactly.
impl Pool {
    /// The receipt `down` writes after a quiesced stop: `stopped` plus the clean-stop marker.
    fn cleanly_stopped(mut self) -> Self {
        self.owner.guest_boot_id = Some("00000000-0000-0000-0000-000000000000".into());
        self.owner.daemon_pid = Some(1);
        self.owner.daemon_start = Some(1);
        self.owner.phase = "stopped".into();
        self.owner.clean_stop = state::CleanStop::of(&self.owner);
        assert!(self.owner.short_home_releasable());
        self.owner.save(&self.candidate).unwrap();
        self
    }
    fn alias_absent(&self) -> bool {
        matches!(
            fs::symlink_metadata(&self.owner.short_home),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        )
    }
}

#[test]
fn clean_stop_releases_the_alias_and_the_next_mutation_restores_it_exactly() {
    let pool = Pool::new().cleanly_stopped();
    let before = pool.receipt();
    pool.owner.release_short_home(&pool.candidate).unwrap();
    assert!(pool.alias_absent());
    assert_eq!(pool.receipt(), before);
    // Observation accepts the released alias and creates nothing.
    assert_eq!(Owner::load(&pool.candidate).unwrap(), pool.owner);
    assert_eq!(status(&pool.candidate).unwrap().phase, "stopped");
    assert!(pool.alias_absent());
    // Releasing again is a no-op.
    pool.owner.release_short_home(&pool.candidate).unwrap();
    assert!(pool.alias_absent());

    let lock = state::Lock::acquire(&root(&pool.candidate)).unwrap();
    super::super::restore_released_short_home(&pool.candidate).unwrap();
    assert_eq!(
        fs::read_link(&pool.owner.short_home).unwrap(),
        root(&pool.candidate).join("home")
    );
    let inode = fs::symlink_metadata(&pool.owner.short_home).unwrap().ino();
    // A present exact alias is checked, never replaced.
    super::super::restore_released_short_home(&pool.candidate).unwrap();
    assert_eq!(
        fs::symlink_metadata(&pool.owner.short_home).unwrap().ino(),
        inode
    );
    assert_eq!(pool.receipt(), before);
    drop(lock);
}

#[test]
fn only_a_clean_stop_may_lack_its_alias() {
    // Every other phase keeps the strict missing-HOME refusal and explicit recovery.
    // `stopped` without the clean-stop marker is an unclean or uncertain stop.
    for phase in ["stopped", "running", "stopping", "recovered-unclean"] {
        let mut pool = Pool::new();
        pool.owner.phase = phase.into();
        pool.owner.save(&pool.candidate).unwrap();
        assert_eq!(
            pool.owner
                .release_short_home(&pool.candidate)
                .unwrap_err()
                .code,
            "recovery_required"
        );
        assert!(!pool.alias_absent());
        pool.remove_alias();
        let before = pool.receipt();
        assert_eq!(
            Owner::load(&pool.candidate).unwrap_err().code,
            "provider_home_missing"
        );
        let lock = state::Lock::acquire(&root(&pool.candidate)).unwrap();
        assert_eq!(
            super::super::restore_released_short_home(&pool.candidate)
                .unwrap_err()
                .code,
            "provider_home_missing"
        );
        drop(lock);
        pool.unchanged(&before);
    }
    // A pending owner update keeps even a clean stop strict.
    let pool = Pool::new().cleanly_stopped();
    pool.owner.release_short_home(&pool.candidate).unwrap();
    let pending = root(&pool.candidate).join("owner.pending");
    fs::write(&pending, b"interrupted update").unwrap();
    assert_eq!(
        Owner::load(&pool.candidate).unwrap_err().code,
        "provider_home_missing"
    );
    assert!(pool.alias_absent());
    assert_eq!(fs::read(&pending).unwrap(), b"interrupted update");
}

#[test]
fn a_released_alias_path_taken_by_anything_else_is_never_adopted_or_replaced() {
    let pool = Pool::new().cleanly_stopped();
    pool.owner.release_short_home(&pool.candidate).unwrap();
    let before = pool.receipt();
    let foreign = pool.directory.join("foreign");
    state::private_directory(&foreign).unwrap();
    std::os::unix::fs::symlink(&foreign, &pool.owner.short_home).unwrap();
    assert_eq!(
        Owner::load(&pool.candidate).unwrap_err().code,
        "foreign_state"
    );
    assert_eq!(
        pool.owner
            .restore_released_short_home(&pool.candidate)
            .unwrap_err()
            .code,
        "foreign_state"
    );
    assert_eq!(
        pool.owner
            .release_short_home(&pool.candidate)
            .unwrap_err()
            .code,
        "foreign_state"
    );
    assert_eq!(fs::read_link(&pool.owner.short_home).unwrap(), foreign);
    assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
    assert_eq!(pool.receipt(), before);
    fs::remove_file(&pool.owner.short_home).unwrap();

    // A receipt that changed after it was observed restores nothing.
    let observed = pool.owner.clone();
    let mut changed = pool.owner.clone();
    changed.phase = "recovered-unclean".into();
    changed.clean_stop = None;
    changed.save(&pool.candidate).unwrap();
    let changed_receipt = pool.receipt();
    assert_eq!(
        observed
            .restore_released_short_home(&pool.candidate)
            .unwrap_err()
            .code,
        "provider_home_missing"
    );
    assert!(pool.alias_absent());
    assert_eq!(pool.receipt(), changed_receipt);
}

#[test]
fn recovery_of_a_released_clean_stop_restores_the_alias_first() {
    isolated("released_recovery_child");
}

#[test]
#[ignore = "isolated release-check fixture launched by recovery_of_a_released_clean_stop_restores_the_alias_first"]
fn released_recovery_child() {
    let pool = Pool::new().cleanly_stopped();
    pool.owner.release_short_home(&pool.candidate).unwrap();
    let recovered = crate::provider::recover(&pool.candidate).unwrap();
    assert_eq!(recovered.phase, "recovered-unclean");
    assert_eq!(
        fs::read_link(&pool.owner.short_home).unwrap(),
        root(&pool.candidate).join("home")
    );
    // The recovered receipt needs its alias, and has it.
    assert_eq!(
        Owner::load(&pool.candidate).unwrap().phase,
        "recovered-unclean"
    );
}
