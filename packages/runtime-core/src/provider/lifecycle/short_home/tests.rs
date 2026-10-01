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

#[test]
fn explicit_recovery_restores_only_missing_alias_and_preserves_disk_bytes() {
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
