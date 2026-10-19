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
        .into_selection()
        .expect("exact live development ownership");
    selection.reverify(&pool.candidate).unwrap();
    assert!(
        select(&pool.candidate, Profile::Research)
            .unwrap()
            .into_selection()
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
    assert!(
        select(&candidate, Profile::Development)
            .unwrap()
            .into_selection()
            .is_none()
    );
    drop(cleanup);

    for phase in ["stopped", "stopped-before-engine"] {
        let mut pool = Pool::new();
        pool.owner.phase = phase.into();
        pool.save();
        assert!(
            select(&pool.candidate, Profile::Development)
                .unwrap()
                .into_selection()
                .is_none()
        );
    }
    let mut pool = Pool::new();
    pool.owner.profile = Profile::Research;
    pool.save();
    assert!(
        select(&pool.candidate, Profile::Development)
            .unwrap()
            .into_selection()
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
        .into_selection()
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
        .into_selection()
        .unwrap();
    fs::write(pool.data().join("agent.pid"), b"999999\n1\n").unwrap();
    assert!(selection.reverify(&pool.candidate).is_err());

    let pool = Pool::new();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .into_selection()
        .unwrap();
    let path = pool.data().join("overlay.raw");
    fs::rename(&path, pool.data().join("overlay.retained")).unwrap();
    sparse_disk(&path, 10, 2);
    assert!(selection.reverify(&pool.candidate).is_err());
}

/// Tests that run the release probes (`lsof` over the owned disks) run one at a time:
/// concurrent whole-host `lsof` scans on a loaded machine can exceed the probe's bounded
/// wait, which correctly refuses as possibly active but is not what these tests examine.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A pool `down` left exactly clean: provider proven dead after a quiesced engine stop of
/// its last boot, clean-stop marker recorded, retained disks identified, provider
/// configuration audited, VM lock free and no listener or disk handle.
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
    pool.owner.clean_stop = state::CleanStop::of(&pool.owner);
    pool.save();
    quiescence(&pool, BOOT, 4242, 99, "quiesced");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(pool.data().join("vm.lock"))
        .unwrap();
    provider_config(&pool, &pool.owner.token);
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

fn provider_database(pool: &Pool) -> PathBuf {
    pool.candidate
        .state_root
        .join("run/smolvm")
        .join("home")
        .join("Library/Application Support/smolvm/server/smolvm.db")
}

/// The provider's persisted machine record, as `machine create` left it for this pool,
/// labelled with `token`.
fn provider_config(pool: &Pool, token: &str) {
    let database = provider_database(pool);
    fs::create_dir_all(database.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&database);
    let record = serde_json::json!({
        "name": pool.owner.machine, "labels": {"hack-local.owner": token},
        "ssh_agent": false, "network": false, "ports": [], "published_sockets": [],
        "staged_mounts": [], "remote_volumes": [], "init": [], "env": [], "entrypoint": [],
        "cmd": [],
        "mounts": [[artifact::engine_root(&pool.candidate), "/opt/hack-engine", true]],
    });
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute_batch("CREATE TABLE vms(name TEXT PRIMARY KEY, data BLOB NOT NULL)")
        .unwrap();
    connection
        .execute(
            "INSERT INTO vms VALUES (?1, ?2)",
            rusqlite::params![pool.owner.machine, serde_json::to_vec(&record).unwrap()],
        )
        .unwrap();
}

fn lease(pool: &Pool) -> state::Lock {
    state::Lock::acquire(&root(&pool.candidate)).unwrap()
}

/// The closed receipt-level refusal for the current receipt. Selection keeps the fresh
/// budget and reports the same closed code for a created pool.
fn refusal(pool: &Pool) -> StoppedRefusal {
    let owner = Owner::load(&pool.candidate).unwrap();
    let refusal = stopped(&pool.candidate, &owner).unwrap_err();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    assert!(choice.selected().is_none());
    if owner.created {
        assert_eq!(choice.refusal(), Some(refusal));
    }
    refusal
}

/// The closed code of a refusal only the leased release checks establish: the receipt
/// checks select the pool, and the lease-held recheck refuses it.
fn leased_refusal(pool: &Pool) -> &'static str {
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .into_selection()
        .expect("receipt checks pass");
    selection.reverify(&pool.candidate).unwrap();
    let lease = lease(pool);
    selection
        .reverify_leased(&pool.candidate, &lease)
        .unwrap_err()
        .code
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
    let _serial = serial();
    let pool = stopped_pool();
    let receipt = fs::read(root(&pool.candidate).join("owner.json")).unwrap();
    let storage = identity::disk(&pool.data().join("storage.raw")).unwrap();
    let overlay = identity::disk(&pool.data().join("overlay.raw")).unwrap();

    let choice = select(&pool.candidate, Profile::Development).unwrap();
    assert_eq!(choice.refusal(), None);
    let selection = choice
        .into_selection()
        .expect("exact clean stopped development ownership");
    assert!(selection.is_stopped());
    selection.reverify(&pool.candidate).unwrap();
    let lease = lease(&pool);
    selection.reverify_leased(&pool.candidate, &lease).unwrap();
    selection.reverify_leased(&pool.candidate, &lease).unwrap();
    drop(lease);
    assert!(
        select(&pool.candidate, Profile::Research)
            .unwrap()
            .into_selection()
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
            .into_selection()
            .unwrap()
            .is_stopped()
    );
}

#[test]
fn receipt_checks_take_no_provider_lock() {
    let _serial = serial();
    // The read-only `runtime probe` and every unleased sample may run while another
    // lifecycle operation hands the VM lock to a provider: they neither take nor need it.
    let pool = stopped_pool();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    choice
        .selected()
        .expect("receipt checks never take the VM lock")
        .reverify(&pool.candidate)
        .unwrap();
    let observed = probe_with(&pool.candidate, &choice, |owned| {
        Ok(sample(owned, true, Some(7)))
    })
    .unwrap();
    assert_eq!(
        observed.disk_budget_basis,
        "verified-stopped-owned-pool-host-reserve"
    );
    drop(held);
}

#[test]
fn foreign_stopped_owner_refuses_the_retained_reserve() {
    let _serial = serial();
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
    assert_eq!(leased_refusal(&pool), "retained_reserve_foreign_owner");

    // The provider's persisted configuration names another owner, or is missing.
    let pool = stopped_pool();
    provider_config(&pool, "00000000000000000000000000000000");
    assert_eq!(leased_refusal(&pool), "retained_reserve_foreign_owner");
    let pool = stopped_pool();
    fs::remove_file(provider_database(&pool)).unwrap();
    assert_eq!(leased_refusal(&pool), "retained_reserve_foreign_owner");
    assert_eq!(
        StoppedRefusal::Foreign.code(),
        "retained_reserve_foreign_owner"
    );
}

#[test]
fn active_stopped_owner_refuses_the_retained_reserve() {
    let _serial = serial();
    // A receipt that says stopped while its recorded provider is still alive.
    let mut pool = Pool::new();
    pool.owner.phase = "stopped".into();
    pool.owner.daemon_pid = Some(4242);
    pool.owner.daemon_start = Some(99);
    pool.owner.rootfs_digest = Some("fixture-rootfs".into());
    pool.owner.clean_stop = state::CleanStop::of(&pool.owner);
    pool.save();
    quiescence(&pool, BOOT, 4242, 99, "quiesced");
    assert_eq!(refusal(&pool), StoppedRefusal::Active);

    let pool = stopped_pool();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    assert_eq!(leased_refusal(&pool), "retained_reserve_active_owner");
    drop(held);

    let pool = stopped_pool();
    let handle = fs::File::open(pool.data().join("storage.raw")).unwrap();
    assert_eq!(leased_refusal(&pool), "retained_reserve_active_owner");
    drop(handle);

    let pool = stopped_pool();
    let listener =
        std::os::unix::net::UnixListener::bind(pool.owner.data_dir().join("agent.sock")).unwrap();
    assert_eq!(leased_refusal(&pool), "retained_reserve_active_owner");
    drop(listener);
    assert_eq!(
        StoppedRefusal::Active.code(),
        "retained_reserve_active_owner"
    );
}

#[test]
fn dirty_stopped_owner_refuses_the_retained_reserve() {
    let _serial = serial();
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

    // A quiesced engine whose `down` never completed, or completed for another boot.
    let mut pool = stopped_pool();
    pool.owner.clean_stop = None;
    pool.save();
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);
    for (boot, daemon, start) in [
        ("22222222-2222-2222-2222-222222222222", 4242, 99),
        (BOOT, 4243, 99),
        (BOOT, 4242, 98),
    ] {
        let mut pool = stopped_pool();
        pool.owner.clean_stop = Some(state::CleanStop {
            guest_boot_id: boot.into(),
            daemon_pid: daemon,
            daemon_start: start,
        });
        pool.save();
        assert_eq!(
            refusal(&pool),
            StoppedRefusal::Dirty,
            "{boot} {daemon} {start}"
        );
    }

    let pool = stopped_pool();
    fs::write(root(&pool.candidate).join("owner.pending"), b"{}").unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);
    assert_eq!(StoppedRefusal::Dirty.code(), "retained_reserve_dirty_owner");
}

/// The relabelling path: a later boot's `down` quiesced the engine and then failed
/// (`stop_uncertain`), `recover` recorded `recovered-unclean`, and a start refused before
/// boot rewrote the phase to `stopped`. The quiescence receipt and the boot identity still
/// match, but the stop was never completed, so the pool never qualifies.
#[test]
fn an_uncertain_stop_rewritten_to_stopped_never_qualifies() {
    let _serial = serial();
    const LATER: &str = "22222222-2222-2222-2222-222222222222";
    let pool = stopped_pool();
    let candidate = &pool.candidate;
    let mut owner = Owner::load(candidate).unwrap();
    // A later boot: `start_pool` begins it and the engine identity is recorded.
    owner.begin_boot();
    assert_eq!(owner.clean_stop, None);
    super::super::phase(candidate, &mut owner, "booting").unwrap();
    owner.guest_boot_id = Some(LATER.into());
    owner.daemon_pid = Some(5151);
    owner.daemon_start = Some(123);
    super::super::phase(candidate, &mut owner, "running").unwrap();
    // `down` quiesces that boot and then cannot prove the guest flushed and shut down.
    super::super::phase(candidate, &mut owner, "quiescing").unwrap();
    quiescence(&pool, LATER, 5151, 123, "quiesced");
    super::super::phase(candidate, &mut owner, "stopping").unwrap();
    // `recover` proves the provider dead and records an unclean stop.
    super::super::finish_stopped(candidate, &mut owner, "recovered-unclean").unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);
    // A start refused before boot rewrites the phase to `stopped`.
    let mut owner = Owner::load(candidate).unwrap();
    super::super::phase(candidate, &mut owner, "stopped").unwrap();
    assert_eq!(owner.clean_stop, None);
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);

    // The same rewrite after an unclean label on the clean boot itself, with no new boot.
    for unclean in ["recovered-unclean", "stopped-before-engine"] {
        let pool = stopped_pool();
        let mut owner = Owner::load(&pool.candidate).unwrap();
        if unclean == "recovered-unclean" {
            super::super::finish_stopped(&pool.candidate, &mut owner, unclean).unwrap();
        } else {
            super::super::phase(&pool.candidate, &mut owner, unclean).unwrap();
        }
        super::super::phase(&pool.candidate, &mut owner, "stopped").unwrap();
        assert_eq!(refusal(&pool), StoppedRefusal::Dirty, "{unclean}");
    }
}

#[test]
fn a_start_refused_before_boot_keeps_a_clean_stop_clean() {
    let _serial = serial();
    // Nothing booted since `down`, so the retained disks are exactly as it left them.
    let pool = stopped_pool();
    let mut owner = Owner::load(&pool.candidate).unwrap();
    super::super::phase(&pool.candidate, &mut owner, "stopped").unwrap();
    assert!(
        select(&pool.candidate, Profile::Development)
            .unwrap()
            .into_selection()
            .unwrap()
            .is_stopped()
    );
}

#[test]
fn only_a_completed_quiesced_down_records_a_clean_stop() {
    let _serial = serial();
    // `down` reached `stopping` for the clean boot; the provider has exited.
    let unfinished = || {
        let mut pool = stopped_pool();
        pool.owner.clean_stop = None;
        pool.owner.phase = "stopping".into();
        pool.save();
        pool
    };
    let pool = unfinished();
    let mut owner = Owner::load(&pool.candidate).unwrap();
    super::super::finish_quiesced_stop(&pool.candidate, &mut owner).unwrap();
    assert!(owner.clean_stop.is_some());
    assert_eq!(owner.clean_stop, state::CleanStop::of(&owner));
    assert!(
        select(&pool.candidate, Profile::Development)
            .unwrap()
            .into_selection()
            .unwrap()
            .is_stopped()
    );

    // Recording `stopped` by any other route leaves the stop unproven.
    let pool = unfinished();
    let mut owner = Owner::load(&pool.candidate).unwrap();
    super::super::finish_stopped(&pool.candidate, &mut owner, "stopped").unwrap();
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);

    // When the provider's release cannot be proven, nothing is recorded.
    let pool = unfinished();
    let receipt = fs::read(root(&pool.candidate).join("owner.json")).unwrap();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    let mut owner = Owner::load(&pool.candidate).unwrap();
    assert!(super::super::finish_quiesced_stop(&pool.candidate, &mut owner).is_err());
    drop(held);
    assert_eq!(
        fs::read(root(&pool.candidate).join("owner.json")).unwrap(),
        receipt
    );
    assert_eq!(refusal(&pool), StoppedRefusal::Dirty);
}

#[test]
fn stale_or_unknown_stopped_owner_refuses_the_retained_reserve() {
    let _serial = serial();
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
    assert_eq!(leased_refusal(&pool), "retained_reserve_stale_owner");
    assert_eq!(StoppedRefusal::Stale.code(), "retained_reserve_stale_owner");
}

#[test]
fn selected_stopped_owner_drift_refuses_reverification() {
    let _serial = serial();
    let mut pool = stopped_pool();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .into_selection()
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
        .into_selection()
        .unwrap();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    let lease = lease(&pool);
    assert_eq!(
        selection
            .reverify_leased(&pool.candidate, &lease)
            .err()
            .unwrap()
            .code,
        "retained_reserve_active_owner"
    );
    drop(held);
    selection.reverify_leased(&pool.candidate, &lease).unwrap();
    drop(lease);

    let pool = stopped_pool();
    let selection = select(&pool.candidate, Profile::Development)
        .unwrap()
        .into_selection()
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
        .into_selection()
        .unwrap();
    fs::remove_file(root(&pool.candidate).join("quiescence.json")).unwrap();
    assert_eq!(
        selection.reverify(&pool.candidate).err().unwrap().code,
        "retained_reserve_dirty_owner"
    );
}

/// A fixture host sample on `owned`'s disk basis, as the admission module reports it.
fn sample(
    owned: admission::OwnedPool,
    admitted: bool,
    swapouts: Option<u64>,
) -> admission::Admission {
    let (minimum_disk_free_bytes, disk_budget_basis) = match owned {
        admission::OwnedPool::Fresh => (58 * GIB, "new-pool-storage-overlay-host-reserve"),
        admission::OwnedPool::Running => (16 * GIB, "verified-live-owned-pool-host-reserve"),
        admission::OwnedPool::Stopped => (16 * GIB, "verified-stopped-owned-pool-host-reserve"),
    };
    admission::Admission {
        profile: Profile::Development,
        host_supported: true,
        free_memory_bytes: Some(10 * GIB),
        minimum_free_memory_bytes: 10 * GIB,
        free_plus_file_cache_estimate_bytes: Some(10 * GIB),
        memory_budget_basis: "fixture",
        memory_pressure: admission::MemoryPressure::from_level(Some(1)),
        memory_pressure_normal: true,
        disk_free_bytes: Some(30 * GIB),
        minimum_disk_free_bytes,
        disk_budget_basis,
        one_minute_load: Some(0.0),
        load_ceiling: None,
        thermal_normal: true,
        swapouts,
        admitted,
        reasons: if admitted {
            Vec::new()
        } else {
            vec!["Free disk is below the development VM storage and host reserve budget.".into()]
        },
        retained_reserve_refusal: None,
    }
}

#[test]
fn a_fresh_budget_beside_a_created_stopped_pool_reports_why_the_reserve_did_not_apply() {
    let _serial = serial();
    let mut pool = stopped_pool();
    pool.owner.phase = "recovered-unclean".into();
    pool.save();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    let observed = probe_with(&pool.candidate, &choice, |owned| {
        assert_eq!(owned, admission::OwnedPool::Fresh);
        Ok(sample(owned, false, Some(7)))
    })
    .unwrap();
    assert_eq!(
        observed.retained_reserve_refusal,
        Some("retained_reserve_dirty_owner")
    );
    assert_eq!(
        serde_json::to_value(&observed).unwrap()["retained_reserve_refusal"],
        "retained_reserve_dirty_owner"
    );

    // No retained disks exist yet, so a fresh allocation needs no explanation.
    let mut pool = stopped_pool();
    pool.owner.phase = "initializing".into();
    pool.owner.created = false;
    pool.save();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    let observed = probe_with(&pool.candidate, &choice, |owned| {
        Ok(sample(owned, true, Some(7)))
    })
    .unwrap();
    assert_eq!(observed.retained_reserve_refusal, None);
    assert!(
        serde_json::to_value(&observed)
            .unwrap()
            .get("retained_reserve_refusal")
            .is_none()
    );
}

#[test]
fn the_boot_gate_samples_the_qualifying_basis_and_its_swapouts() {
    let _serial = serial();
    // A clean stopped selection is sampled on its reserve basis, not the fresh floor.
    let pool = stopped_pool();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    let mut asked = None;
    let gate = admit_boot_with(&pool.candidate, &choice, Some(7), |owned| {
        asked = Some(owned);
        Ok(sample(owned, true, Some(7)))
    })
    .unwrap();
    assert_eq!(asked, Some(admission::OwnedPool::Stopped));
    assert!(matches!(gate, BootGate::Admitted(_)));

    // Without a selection the unchanged fresh budget decides; a live selection keeps its own.
    let fresh = Choice {
        selection: None,
        refusal: None,
    };
    let mut asked = None;
    admit_boot_with(&pool.candidate, &fresh, Some(7), |owned| {
        asked = Some(owned);
        Ok(sample(owned, true, Some(7)))
    })
    .unwrap();
    assert_eq!(asked, Some(admission::OwnedPool::Fresh));
    let running = Pool::new();
    let choice = select(&running.candidate, Profile::Development).unwrap();
    let mut asked = None;
    admit_boot_with(&running.candidate, &choice, Some(7), |owned| {
        asked = Some(owned);
        Ok(sample(owned, true, Some(7)))
    })
    .unwrap();
    assert_eq!(asked, Some(admission::OwnedPool::Running));

    // Refused samples and swapout change since qualification refuse the boot.
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    for (admitted, swapouts) in [(false, Some(7)), (true, Some(8)), (true, None)] {
        let gate = admit_boot_with(&pool.candidate, &choice, Some(7), |owned| {
            Ok(sample(owned, admitted, swapouts))
        })
        .unwrap();
        let BootGate::Refused(error) = gate else {
            panic!("{admitted} {swapouts:?} must refuse");
        };
        assert_eq!(error.code, "admission_rejected");
    }
}

#[test]
fn the_boot_gate_rechecks_the_selection_around_its_sample() {
    let _serial = serial();
    let pool = stopped_pool();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    let result = admit_boot_with(&pool.candidate, &choice, Some(7), |owned| {
        // The receipt drifts while the host is sampled.
        fs::write(root(&pool.candidate).join("owner.pending"), b"{}").unwrap();
        Ok(sample(owned, true, Some(7)))
    });
    assert_eq!(result.err().unwrap().code, "retained_reserve_dirty_owner");

    let mut pool = stopped_pool();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    pool.owner.phase = "recovered-unclean".into();
    pool.save();
    let result = admit_boot_with(&pool.candidate, &choice, Some(7), |_| {
        panic!("a drifted selection is never sampled")
    });
    assert_eq!(result.err().unwrap().code, "admission_owner_changed");
}

#[test]
fn machine_start_needs_a_final_leased_recheck_of_the_selection() {
    let _serial = serial();
    let pool = stopped_pool();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    let admitted = || match admit_boot_with(&pool.candidate, &choice, Some(7), |owned| {
        Ok(sample(owned, true, Some(7)))
    })
    .unwrap()
    {
        BootGate::Admitted(boot) => boot,
        BootGate::Refused(error) => panic!("{}", error.code),
    };
    let lease = lease(&pool);
    // After the pre-boot sample, a provider takes the VM lock or opens a disk.
    let boot = admitted();
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    assert_eq!(
        boot.release(&pool.candidate, &lease).err().unwrap().code,
        "retained_reserve_active_owner"
    );
    drop(held);
    let boot = admitted();
    let handle = fs::File::open(pool.data().join("overlay.raw")).unwrap();
    assert_eq!(
        boot.release(&pool.candidate, &lease).err().unwrap().code,
        "retained_reserve_active_owner"
    );
    drop(handle);
    // Or the receipt changes.
    let boot = admitted();
    fs::write(root(&pool.candidate).join("owner.pending"), b"{}").unwrap();
    assert_eq!(
        boot.release(&pool.candidate, &lease).err().unwrap().code,
        "retained_reserve_dirty_owner"
    );
    fs::remove_file(root(&pool.candidate).join("owner.pending")).unwrap();
    admitted().release(&pool.candidate, &lease).unwrap();
}

#[test]
fn a_reserve_selection_only_restarts_and_never_creates() {
    let _serial = serial();
    let pool = stopped_pool();
    let choice = select(&pool.candidate, Profile::Development).unwrap();
    let lease = lease(&pool);
    let owner = Owner::load(&pool.candidate).unwrap();
    restart_only(&pool.candidate, &choice, &owner, &lease).unwrap();
    assert_eq!(
        fresh_create(&choice).err().unwrap().code,
        "admission_owner_changed"
    );
    // The owner the start holds must be the selected, created pool.
    let mut uncreated = owner.clone();
    uncreated.created = false;
    assert_eq!(
        restart_only(&pool.candidate, &choice, &uncreated, &lease)
            .err()
            .unwrap()
            .code,
        "admission_owner_changed"
    );
    let mut other = owner.clone();
    other.guest_boot_id = None;
    assert_eq!(
        restart_only(&pool.candidate, &choice, &other, &lease)
            .err()
            .unwrap()
            .code,
        "admission_owner_changed"
    );
    // The provider's release is proven under the lease before any restart effect.
    let held = exclusive_lock(&pool.data().join("vm.lock"));
    assert_eq!(
        restart_only(&pool.candidate, &choice, &owner, &lease)
            .err()
            .unwrap()
            .code,
        "retained_reserve_active_owner"
    );
    drop(held);
    drop(lease);

    // A live selection never restarts or creates.
    let running = Pool::new();
    let choice = select(&running.candidate, Profile::Development).unwrap();
    let lease = state::Lock::acquire(&root(&running.candidate)).unwrap();
    let owner = Owner::load(&running.candidate).unwrap();
    assert_eq!(
        restart_only(&running.candidate, &choice, &owner, &lease)
            .err()
            .unwrap()
            .code,
        "admission_owner_changed"
    );
    assert!(fresh_create(&choice).is_err());

    // Without a selection, the unchanged fresh path may create.
    let fresh = Choice {
        selection: None,
        refusal: None,
    };
    restart_only(&running.candidate, &fresh, &owner, &lease).unwrap();
    fresh_create(&fresh).unwrap();
}
