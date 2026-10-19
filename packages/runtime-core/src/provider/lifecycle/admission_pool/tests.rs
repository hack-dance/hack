use super::*;
use crate::provider::{NetworkIntent, Profile, artifact, identity, state};
use std::{
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const GIB: u64 = 1024 * 1024 * 1024;

struct Cleanup {
    directory: PathBuf,
    alias: Option<(PathBuf, PathBuf)>,
    child: Option<Child>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some((alias, target)) = &self.alias
            && fs::read_link(alias).ok().as_ref() == Some(target)
        {
            let _ = fs::remove_file(alias);
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn private_directory() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = fs::canonicalize(std::env::temp_dir()).unwrap();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    loop {
        let directory = base.join(format!(
            "hack-admission-pool-{}-{timestamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => return directory,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("cannot create private admission fixture: {error}"),
        }
    }
}

fn sparse_disk(path: &Path, gib: u64, tag: u8) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.set_len(gib * GIB).unwrap();
    file.seek(SeekFrom::Start(1080)).unwrap();
    file.write_all(&[0x53, 0xef]).unwrap();
    file.seek(SeekFrom::Start(1128)).unwrap();
    file.write_all(&[tag; 16]).unwrap();
}

struct Pool {
    candidate: Candidate,
    owner: Owner,
    cleanup: Cleanup,
}

impl Pool {
    fn new() -> Self {
        let directory = private_directory();
        let mut cleanup = Cleanup {
            directory: directory.clone(),
            alias: None,
            child: None,
        };
        let candidate = Candidate::discover(&directory).unwrap();
        let provider = artifact::root(&candidate);
        state::private_directory(&provider).unwrap();
        let binary = provider.join("smolvm-bin");
        crate::provider::test_executable::sleeping_executable(&binary);
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();

        let mut owner = Owner::create(
            &candidate,
            Profile::Development,
            None,
            NetworkIntent::Isolated,
        )
        .unwrap();
        cleanup.alias = Some((
            owner.short_home.clone(),
            candidate.state_root.join("run/smolvm/home"),
        ));
        let data = owner.real_data_dir(&candidate).unwrap();
        state::private_directory(&data).unwrap();
        sparse_disk(&data.join("storage.raw"), 32, 1);
        sparse_disk(&data.join("overlay.raw"), 10, 2);
        fs::write(data.join("name"), &owner.machine).unwrap();

        cleanup.child = Some(Command::new(&binary).arg("120").spawn().unwrap());
        let process = identity::observe(cleanup.child.as_ref().unwrap().id() as i32).unwrap();
        assert_eq!(process.executable, binary);
        fs::write(
            data.join("agent.pid"),
            format!("{}\n{}\n", process.pid, process.start_micros),
        )
        .unwrap();
        owner.process = Some(process);
        owner.created = true;
        owner.phase = "running".into();
        owner.guest_boot_id = Some("11111111-1111-1111-1111-111111111111".into());
        owner.storage = Some(identity::disk(&data.join("storage.raw")).unwrap());
        owner.overlay = Some(identity::disk(&data.join("overlay.raw")).unwrap());
        owner.save(&candidate).unwrap();
        Self {
            candidate,
            owner,
            cleanup,
        }
    }

    fn data(&self) -> PathBuf {
        self.owner.real_data_dir(&self.candidate).unwrap()
    }

    fn save(&self) {
        self.owner.save(&self.candidate).unwrap();
    }
}

#[test]
fn only_a_live_owned_development_pool_selects_the_host_reserve() {
    let pool = Pool::new();
    let receipt = fs::read(root(&pool.candidate).join("owner.json")).unwrap();
    let storage = identity::disk(&pool.data().join("storage.raw")).unwrap();
    let overlay = identity::disk(&pool.data().join("overlay.raw")).unwrap();

    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .expect("exact live development ownership");
    selection.reverify(&pool.candidate).unwrap();
    assert!(
        select(&pool.candidate, Profile::Research)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fs::read(root(&pool.candidate).join("owner.json")).unwrap(),
        receipt
    );
    assert_eq!(
        identity::disk(&pool.data().join("storage.raw")).unwrap(),
        storage
    );
    assert_eq!(
        identity::disk(&pool.data().join("overlay.raw")).unwrap(),
        overlay
    );
}

#[test]
fn absent_or_non_running_owners_do_not_select_the_host_reserve() {
    let directory = private_directory();
    let cleanup = Cleanup {
        directory: directory.clone(),
        alias: None,
        child: None,
    };
    let candidate = Candidate::discover(&directory).unwrap();
    assert!(select(&candidate, Profile::Development).unwrap().is_none());
    drop(cleanup);

    for phase in ["stopped", "stopped-before-engine"] {
        let mut pool = Pool::new();
        pool.owner.phase = phase.into();
        pool.save();
        assert!(
            select(&pool.candidate, Profile::Development)
                .unwrap()
                .is_none()
        );
    }
    let mut pool = Pool::new();
    pool.owner.profile = Profile::Research;
    pool.save();
    assert!(
        select(&pool.candidate, Profile::Development)
            .unwrap()
            .is_none()
    );
}

#[test]
fn incomplete_or_mis_sized_running_capacity_refuses_selection() {
    for missing in ["created", "storage", "overlay", "size"] {
        let mut pool = Pool::new();
        match missing {
            "created" => pool.owner.created = false,
            "storage" => pool.owner.storage = None,
            "overlay" => pool.owner.overlay = None,
            "size" => {
                let path = pool.data().join("overlay.raw");
                OpenOptions::new()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_len(9 * GIB)
                    .unwrap();
                pool.owner.overlay =
                    Some(identity::disk(&pool.data().join("overlay.raw")).unwrap());
            }
            _ => unreachable!(),
        }
        pool.save();
        assert!(
            select(&pool.candidate, Profile::Development).is_err(),
            "{missing}"
        );
    }
}

#[test]
fn stale_or_dead_process_and_replaced_or_missing_disks_refuse_selection() {
    let mut pool = Pool::new();
    pool.owner.process.as_mut().unwrap().start_micros += 1;
    pool.save();
    assert!(select(&pool.candidate, Profile::Development).is_err());

    let mut pool = Pool::new();
    let child = pool.cleanup.child.as_mut().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(select(&pool.candidate, Profile::Development).is_err());

    let pool = Pool::new();
    let path = pool.data().join("storage.raw");
    fs::rename(&path, pool.data().join("storage.retained")).unwrap();
    sparse_disk(&path, 32, 1);
    assert!(select(&pool.candidate, Profile::Development).is_err());

    let pool = Pool::new();
    fs::remove_file(pool.data().join("overlay.raw")).unwrap();
    assert!(select(&pool.candidate, Profile::Development).is_err());
}

#[test]
fn selected_owner_or_provider_changes_refuse_reverification() {
    let mut pool = Pool::new();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    pool.owner.guest_boot_id = Some("22222222-2222-2222-2222-222222222222".into());
    pool.save();
    assert_eq!(
        selection.reverify(&pool.candidate).err().unwrap().code,
        "admission_owner_changed"
    );

    let pool = Pool::new();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    fs::write(pool.data().join("agent.pid"), b"999999\n1\n").unwrap();
    assert!(selection.reverify(&pool.candidate).is_err());

    let pool = Pool::new();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    let path = pool.data().join("overlay.raw");
    fs::rename(&path, pool.data().join("overlay.retained")).unwrap();
    sparse_disk(&path, 10, 2);
    assert!(selection.reverify(&pool.candidate).is_err());
}

/// A pool `down` left exactly clean: provider proven dead after a quiesced engine stop of
/// its last boot, retained disks identified, VM lock free and no listener or disk handle.
fn stopped_pool() -> Pool {
    let mut pool = Pool::new();
    let child = pool.cleanup.child.as_mut().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    pool.cleanup.child = None;
    pool.owner.phase = "stopped".into();
    pool.owner.daemon_pid = Some(4242);
    pool.owner.daemon_start = Some(99);
    pool.owner.rootfs_digest = Some("fixture-rootfs".into());
    pool.save();
    quiescence(&pool, BOOT, 4242, 99, "quiesced");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(pool.data().join("vm.lock"))
        .unwrap();
    pool
}

const BOOT: &str = "11111111-1111-1111-1111-111111111111";

fn quiescence(pool: &Pool, boot: &str, daemon: u32, start: u64, result: &str) {
    state::write(
        &root(&pool.candidate).join("quiescence.json"),
        &serde_json::json!({
            "guest_boot_id": boot, "daemon_pid": daemon, "daemon_start": start, "result": result,
        }),
    )
    .unwrap();
}

/// The closed refusal for the current receipt; every refusal keeps the fresh budget.
fn refusal(pool: &Pool) -> StoppedRefusal {
    let owner = Owner::load(&pool.candidate).unwrap();
    let refusal = stopped(&pool.candidate, &owner).unwrap_err();
    assert!(
        select(&pool.candidate, Profile::Development)
            .unwrap()
            .is_none()
    );
    refusal
}

fn exclusive_lock(path: &Path) -> fs::File {
    use std::os::fd::AsRawFd;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    // SAFETY: the descriptor stays open for this call; the lock ends when `file` drops.
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    file
}

#[test]
fn only_a_clean_stopped_owned_development_pool_selects_the_retained_reserve() {
    let pool = stopped_pool();
    let receipt = fs::read(root(&pool.candidate).join("owner.json")).unwrap();
    let storage = identity::disk(&pool.data().join("storage.raw")).unwrap();
    let overlay = identity::disk(&pool.data().join("overlay.raw")).unwrap();

    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .expect("exact clean stopped development ownership");
    assert!(selection.is_stopped());
    selection.reverify(&pool.candidate).unwrap();
    selection.reverify(&pool.candidate).unwrap();
    assert!(
        select(&pool.candidate, Profile::Research)
            .unwrap()
            .is_none()
    );
    // Selection is read-only: receipt, disks and the provider's VM lock are left as found.
    assert_eq!(
        fs::read(root(&pool.candidate).join("owner.json")).unwrap(),
        receipt
    );
    assert_eq!(
        identity::disk(&pool.data().join("storage.raw")).unwrap(),
        storage
    );
    assert_eq!(
        identity::disk(&pool.data().join("overlay.raw")).unwrap(),
        overlay
    );
    drop(exclusive_lock(&pool.data().join("vm.lock")));

    // A running selection keeps its separate live basis.
    let running = Pool::new();
    assert!(
        !select(&running.candidate, Profile::Development)
            .unwrap()
            .unwrap()
            .is_stopped()
    );
}

#[test]
fn foreign_stopped_owner_refuses_the_retained_reserve() {
    let pool = stopped_pool();
    fs::write(pool.data().join("name"), b"hack-foreign0000").unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Foreign);

    let mut pool = stopped_pool();
    pool.owner.process.as_mut().unwrap().executable = PathBuf::from("/usr/bin/true");
    pool.save();
    assert_eq!(refusal(&pool), StoppedRefusal::Foreign);

    let mut pool = stopped_pool();
    pool.owner.process.as_mut().unwrap().uid += 1;
    pool.save();
    assert_eq!(refusal(&pool), StoppedRefusal::Foreign);

    let pool = stopped_pool();
    fs::hard_link(
        pool.data().join("vm.lock"),
        pool.data().join("vm.lock.alias"),
    )
    .unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Foreign);
    assert_eq!(
        StoppedRefusal::Foreign.code(),
        "retained_reserve_foreign_owner"
    );
}

#[test]
fn active_stopped_owner_refuses_the_retained_reserve() {
    // A receipt that says stopped while its recorded provider is still alive.
    let mut pool = Pool::new();
    pool.owner.phase = "stopped".into();
    pool.owner.daemon_pid = Some(4242);
    pool.owner.daemon_start = Some(99);
    pool.owner.rootfs_digest = Some("fixture-rootfs".into());
    pool.save();
    quiescence(&pool, BOOT, 4242, 99, "quiesced");
    assert_eq!(refusal(&pool), StoppedRefusal::Active);

    let pool = stopped_pool();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    assert_eq!(refusal(&pool), StoppedRefusal::Active);
    drop(held);

    let pool = stopped_pool();
    let handle = fs::File::open(pool.data().join("storage.raw")).unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Active);
    drop(handle);

    let pool = stopped_pool();
    let listener =
        std::os::unix::net::UnixListener::bind(pool.owner.data_dir().join("agent.sock")).unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Active);
    drop(listener);
    assert_eq!(
        StoppedRefusal::Active.code(),
        "retained_reserve_active_owner"
    );
}

#[test]
fn dirty_stopped_owner_refuses_the_retained_reserve() {
    for phase in [
        "recovered-unclean",
        "stopped-before-engine",
        "stopped-after-engine-failure",
        "failed-boot-stopped",
        "stopping",
        "quiescing",
        "booting",
        "creating",
        "initializing",
    ] {
        let mut pool = stopped_pool();
        pool.owner.phase = phase.into();
        pool.save();
        assert_eq!(refusal(&pool), StoppedRefusal::Dirty, "{phase}");
    }

    // A phase rewritten to stopped without a quiesced stop of the last boot.
    let pool = stopped_pool();
    fs::remove_file(root(&pool.candidate).join("quiescence.json")).unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);
    for (boot, daemon, start, result) in [
        ("22222222-2222-2222-2222-222222222222", 4242, 99, "quiesced"),
        (BOOT, 4243, 99, "quiesced"),
        (BOOT, 4242, 98, "quiesced"),
        (BOOT, 4242, 99, "timeout"),
    ] {
        let pool = stopped_pool();
        quiescence(&pool, boot, daemon, start, result);
        assert_eq!(
            refusal(&pool),
            StoppedRefusal::Dirty,
            "{boot} {daemon} {start} {result}"
        );
    }

    let pool = stopped_pool();
    fs::write(root(&pool.candidate).join("owner.pending"), b"{}").unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);
    assert_eq!(StoppedRefusal::Dirty.code(), "retained_reserve_dirty_owner");
}

#[test]
fn stale_or_unknown_stopped_owner_refuses_the_retained_reserve() {
    for missing in [
        "created", "storage", "overlay", "rootfs", "boot", "daemon", "process",
    ] {
        let mut pool = stopped_pool();
        match missing {
            "created" => pool.owner.created = false,
            "storage" => pool.owner.storage = None,
            "overlay" => pool.owner.overlay = None,
            "rootfs" => pool.owner.rootfs_digest = None,
            "boot" => pool.owner.guest_boot_id = None,
            "daemon" => pool.owner.daemon_start = None,
            "process" => pool.owner.process = None,
            _ => unreachable!(),
        }
        pool.save();
        assert_eq!(refusal(&pool), StoppedRefusal::Stale, "{missing}");
    }

    let pool = stopped_pool();
    let path = pool.data().join("storage.raw");
    fs::rename(&path, pool.data().join("storage.retained")).unwrap();
    sparse_disk(&path, 32, 1);
    assert_eq!(refusal(&pool), StoppedRefusal::Stale);

    let pool = stopped_pool();
    fs::remove_file(pool.data().join("overlay.raw")).unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Stale);

    let mut pool = stopped_pool();
    let path = pool.data().join("overlay.raw");
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(9 * GIB)
        .unwrap();
    pool.owner.overlay = Some(identity::disk(&path).unwrap());
    pool.save();
    assert_eq!(refusal(&pool), StoppedRefusal::Stale);

    let pool = stopped_pool();
    fs::remove_file(pool.data().join("vm.lock")).unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Stale);
    assert_eq!(StoppedRefusal::Stale.code(), "retained_reserve_stale_owner");
}

#[test]
fn selected_stopped_owner_drift_refuses_reverification() {
    let mut pool = stopped_pool();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    pool.owner.phase = "booting".into();
    pool.save();
    assert_eq!(
        selection.reverify(&pool.candidate).err().unwrap().code,
        "admission_owner_changed"
    );

    let pool = stopped_pool();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    assert_eq!(
        selection.reverify(&pool.candidate).err().unwrap().code,
        "retained_reserve_active_owner"
    );
    drop(held);
    selection.reverify(&pool.candidate).unwrap();

    let pool = stopped_pool();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    let path = pool.data().join("overlay.raw");
    fs::rename(&path, pool.data().join("overlay.retained")).unwrap();
    sparse_disk(&path, 10, 2);
    assert_eq!(
        selection.reverify(&pool.candidate).err().unwrap().code,
        "retained_reserve_stale_owner"
    );

    let pool = stopped_pool();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .unwrap();
    fs::remove_file(root(&pool.candidate).join("quiescence.json")).unwrap();
    assert_eq!(
        selection.reverify(&pool.candidate).err().unwrap().code,
        "retained_reserve_dirty_owner"
    );
}
